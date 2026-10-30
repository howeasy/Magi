// The remote end of a headless worker on another machine (src/remote.mjs is
// the near end). `magi worker <harness> <payload>` builds the launch with this
// machine's own adapter code and binaries, prints one handshake line, then
// relays stdio between ssh and the CLI. It owns the CLI's cleanup on every
// platform, so nothing depends on SIGHUP or process groups, which Windows
// lacks: when its stdin ends or closes (the channel finished, or the ssh
// session dropped) the CLI gets the near end's own finish grace and then its
// tree is killed; when its stdout breaks (nobody reads) or it is signalled,
// the tree is killed at once.
// `magi workspace <payload>` makes and reads the worktree the worker runs in.
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { spawnCli, killTree } from './exec.mjs';
import { REMOTE_PROTOCOL, decodePayload } from './remote.mjs';
import { CHUNK_BYTES, assertFilesEnabled, blobPath, filesBlock, hasBlob, putBlob, readChunk } from './artifacts.mjs';
import { magiHome } from './state.mjs';
import { FINISH_GRACE_MS } from './worker-channel.mjs';
import { connectCodexDaemon } from './codex-daemon-proxy.mjs';
import { steerLoadedThread, adviseSteerFailure } from './codex-daemon.mjs';

const isWin = platform() === 'win32';
const HARNESSES = new Set(['claude', 'codex', 'omp']);
// After stdin ends the CLI has nothing left to answer; it gets as long to exit
// as a worker here would, never less. The variable is for the tests.
const exitGraceMs = () => Number(process.env.MAGI_REMOTE_EXIT_GRACE_MS) || FINISH_GRACE_MS;
// ponytail: worktrees are swept by age only; a sweep keyed to closed cards
// would need the orchestrator's ledger, which lives on the other machine.
const WORK_RETENTION_MS = 7 * 24 * 3600 * 1000;
const IDENTITY = { GIT_AUTHOR_NAME: 'magi', GIT_AUTHOR_EMAIL: 'magi@localhost', GIT_COMMITTER_NAME: 'magi', GIT_COMMITTER_EMAIL: 'magi@localhost' };

const expand = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
function applyPath(dirs) {
  if (Array.isArray(dirs) && dirs.length) process.env.PATH = [...dirs.map(expand), process.env.PATH ?? ''].join(delimiter);
}
const git = (cwd, args, env) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const remoteRoot = () => join(magiHome(), 'remote');
const failure = (code, message) => Object.assign(new Error(message), { code });

function decode(raw) {
  let o;
  try { o = decodePayload(raw); } catch { throw failure('REMOTE_VERSION', 'the payload could not be read; the two machines run different Magi versions'); }
  if (o.protocol !== REMOTE_PROTOCOL) throw failure('REMOTE_VERSION', `the caller speaks remote protocol ${o.protocol}, this Magi ${REMOTE_PROTOCOL}; bring both machines to the same Magi`);
  applyPath(o.path);
  // Read by magiHome() at each call, so setting it before any state is touched is enough.
  if (o.home) process.env.MAGI_HOME = expand(o.home);
  return o;
}

// --- magi workspace ---------------------------------------------------------

// A card's age here is the last time it was used here: a marker file per
// card, under its repository, touched when its tree is prepared, while its
// worker runs and when it is collected. A commit's date says nothing about
// that (a clean tree's snapshot is the sender's HEAD, perhaps months old),
// nor does a folder's mtime (a worker editing deep in it never changes it).
// Markers live per repository, so one repository's sweep never ages out
// another's card while leaving that card's refs behind.
const repoKeyOf = (repo) => basename(String(repo ?? '')).replace(/\.git$/, '');
const markers = (repoKey) => join(remoteRoot(), 'tasks', repoKey);
const PLAIN = /^[A-Za-z0-9._-]+$/;
function touchTask(repoKey, taskId) {
  if (!PLAIN.test(String(repoKey ?? '')) || !/^[A-Za-z0-9-]+$/.test(String(taskId ?? ''))) return;
  try { mkdirSync(markers(repoKey), { recursive: true }); writeFileSync(join(markers(repoKey), taskId), ''); } catch { /* adopted by the next sweep */ }
}
const IN_USE_TOUCH_MS = 3600 * 1000;
// How old an object no ref keeps must be before git removes it. Not "now": a
// push to the same repository for another card may be landing objects that
// no ref names yet. The variable is for the tests.
const pruneGraceMs = () => (process.env.MAGI_REMOTE_PRUNE_EXPIRE === 'now' ? 0 : 3600 * 1000);
// Object cleanup owed to a repository, kept until a gc has run after the
// grace: a gc that failed, or one that ran while a swept card's objects were
// still inside the grace (a recent repack refreshes their time), is run again
// on a later prepare, whether or not anything else expires. Each debt is its
// own file, `.gc-pending-<generation>`, written by the sweep that expired a
// card and removed only by a gc that read it before it ran, so no sweep can
// clear a debt recorded after its gc began.
const GC_PENDING = '.gc-pending-';
const GC_EVERY_MS = 10 * 60 * 1000;
// One sweep of a repository at a time; a prepare that finds another sweeping
// skips its own (the next prepare sweeps). A lock is taken over only when its
// process died, or when the file is older than any sweep by its own time; a
// lock just created and not yet written is live. A sweep removes only its own
// lock. ponytail: two prepares taking over the same dead lock in the same
// instant can both sweep; each still removes only debt files it read.
const SWEEP_LOCK = '.sweep-lock';
const SWEEP_LOCK_STALE_MS = 30 * 60 * 1000;
const isCard = (name) => name !== SWEEP_LOCK && !name.startsWith(GC_PENDING);

function withSweepLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SWEEP_LOCK);
  const mine = randomUUID();
  let fd;
  try { fd = openSync(path, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') return;
    let stale = false;
    try {
      stale = Date.now() - statSync(path).mtimeMs > SWEEP_LOCK_STALE_MS;
      const held = JSON.parse(readFileSync(path, 'utf8'));
      try { process.kill(held.pid, 0); } catch (k) { if (k.code === 'ESRCH') stale = true; }
    } catch { /* not written yet, or gone: live unless old by its own time */ }
    if (!stale) return;
    try { rmSync(path, { force: true }); fd = openSync(path, 'wx'); } catch { return; }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), owner: mine }));
    closeSync(fd);
    fn();
  } finally {
    // Ours to remove only while it still says so: one taken over as stale is the taker's.
    try { if (JSON.parse(readFileSync(path, 'utf8')).owner === mine) rmSync(path, { force: true }); } catch { /* stale by age for the next sweep */ }
  }
}

function sweepWork(repo, repoKey) {
  const dir = markers(repoKey);
  withSweepLock(dir, () => sweepLocked(repo, repoKey, dir));
}

function sweepLocked(repo, repoKey, dir) {
  const work = join(remoteRoot(), 'work');
  let refs = [];
  try { refs = git(repo, ['for-each-ref', '--format=%(refname)', 'refs/magi/']).split('\n').filter(Boolean); } catch { /* an empty repository */ }
  const ids = new Set([
    ...readdirSync(dir).filter(isCard),
    ...refs.map((ref) => ref.split('/')[2]),
  ]);
  // A debt that could not be written stops the sweep before anything goes:
  // the card's marker, its worktree and its refs stay, and are swept again.
  const owe = () => {
    try { writeFileSync(join(dir, `${GC_PENDING}${randomUUID()}`), JSON.stringify({ sweptAt: Date.now(), gcAt: 0 })); return true; }
    catch { return false; }
  };
  for (const id of ids) {
    const marker = join(dir, id);
    let at;
    try { at = statSync(marker).mtimeMs; } catch {
      // Refs with no marker (left before markers, or a touch that failed): aged from now.
      touchTask(repoKey, id);
      continue;
    }
    if (Date.now() - at <= WORK_RETENTION_MS) continue;
    // The debt is written before anything goes, and the marker goes last,
    // only once the worktree and every ref are gone: a deletion that failed
    // (a file held open on Windows) leaves the card expired, swept again.
    if (!owe()) return;
    let gone = true;
    try { rmSync(join(work, id), { recursive: true, force: true }); } catch { gone = false; }
    for (const ref of refs.filter((r) => r.split('/')[2] === id)) {
      try { git(repo, ['update-ref', '-d', ref]); } catch { gone = false; }
    }
    if (gone) { try { rmSync(marker, { force: true }); } catch { /* swept again; nothing left to remove */ } }
  }
  // The debts as they stand before this gc; one written later is not touched.
  const debts = [];
  for (const name of readdirSync(dir).filter((n) => n.startsWith(GC_PENDING))) {
    try { debts.push({ path: join(dir, name), ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }); }
    catch { debts.push({ path: join(dir, name), sweptAt: Date.now(), gcAt: 0 }); }
  }
  if (!debts.length) return;
  if (Date.now() - Math.max(...debts.map((d) => d.gcAt ?? 0)) < GC_EVERY_MS) return;
  // Then the objects only a swept card kept, which a copied secret would
  // otherwise outlive: packed ones too, which `git prune` alone leaves.
  try {
    git(repo, ['worktree', 'prune']);
    git(repo, ['gc', '--quiet', `--prune=${pruneGraceMs() ? '1.hour.ago' : 'now'}`]);
  } catch {
    return; // still owed; the next prepare runs it again
  }
  // A debt is paid once a gc has run with all its objects past the grace.
  const now = Date.now();
  for (const d of debts) {
    try {
      if (now - d.sweptAt > pruneGraceMs()) rmSync(d.path, { force: true });
      else writeFileSync(d.path, JSON.stringify({ sweptAt: d.sweptAt, gcAt: now }));
    } catch { /* run once more */ }
  }
}

export function workspace(raw) {
  const o = decode(raw);
  if (o.op === 'prepare') {
    if (!/^[A-Za-z0-9._-]+$/.test(o.repoKey ?? '') || !/^[A-Za-z0-9-]+$/.test(o.taskId ?? '')) throw failure('BAD_REQUEST', 'prepare needs a plain repoKey and taskId');
    const repo = join(remoteRoot(), 'repos', `${o.repoKey}.git`);
    if (!existsSync(repo)) {
      mkdirSync(repo, { recursive: true });
      git(repo, ['init', '--bare', '--quiet']);
    }
    touchTask(o.repoKey, o.taskId);
    sweepWork(repo, o.repoKey);
    return { ok: true, repo, work: join(remoteRoot(), 'work', o.taskId) };
  }
  if (o.op === 'collect') {
    const { repo, work, taskId } = o;
    if (!existsSync(work)) throw failure('REMOTE_FAILED', `the worktree ${work} is gone (swept, or the worker never started)`);
    touchTask(repoKeyOf(repo), taskId);
    const base = git(repo, ['rev-parse', `refs/magi/${taskId}/base`]);
    git(work, ['add', '-A']);
    let staged = false;
    try { git(work, ['diff', '--cached', '--quiet']); } catch { staged = true; }
    if (staged) git(work, ['commit', '--quiet', '--no-verify', '-m', `magi ${taskId} round ${o.round ?? 1}`], IDENTITY);
    const head = git(work, ['rev-parse', 'HEAD']);
    // Measured from the first round's base: later rounds keep the worktree, so
    // the branch carries the card's whole change.
    const files = head === base ? [] : git(work, ['diff', '--name-only', base, head]).split('\n').filter(Boolean);
    git(repo, ['update-ref', `refs/magi/${taskId}/result`, head]);
    return { ok: true, changed: files.length > 0, commit: head, base, files };
  }
  throw failure('BAD_REQUEST', `unknown workspace op "${o.op}"`);
}

// --- magi worker --------------------------------------------------------------

function hello(o) {
  process.stdout.write(JSON.stringify({ type: 'magi_worker', protocol: REMOTE_PROTOCOL, ...o }) + '\n');
}

export async function worker(harness, raw) {
  let o;
  let child;
  let overlay = null;
  try {
    o = decode(raw);
    if (!HARNESSES.has(harness)) throw failure('BAD_REQUEST', `no harness "${harness}"; use claude, codex or omp`);
    const { adapter } = await import(`./${harness}-adapter.mjs`);
    let cwd = o.cwd ?? process.cwd();
    if (o.workspace) {
      const { repo, work, taskId } = o.workspace;
      // A continuation finds the worktree it left, with the worker's own edits.
      // The snapshot it starts from becomes the card's base, which every
      // later collect measures against; a later round's snapshot is unused.
      if (!existsSync(work)) {
        mkdirSync(join(work, '..'), { recursive: true });
        git(repo, ['worktree', 'add', '--quiet', '--detach', work, `refs/magi/${taskId}/snapshot`]);
        git(repo, ['update-ref', `refs/magi/${taskId}/base`, `refs/magi/${taskId}/snapshot`]);
      }
      // Where in the tree the request was made: a relative path inside the copy.
      const rel = String(o.workspace.rel ?? '');
      if (rel && (isAbsolute(rel) || rel.split(/[\\/]/).includes('..'))) throw failure('BAD_REQUEST', `the worker's directory ${rel} is not inside its copy`);
      cwd = rel ? join(work, rel) : work;
    }
    if (adapter.advisor) overlay = await adapter.advisor.overlay(o.advisorModel ?? null, { cwd });
    const args = adapter.headless.args({ allowWrites: Boolean(o.allowWrites), allowCommands: false, resumeThreadId: o.resumeThreadId ?? undefined, cwd, model: o.model ?? undefined, advisor: Boolean(o.advisorModel && adapter.advisor), advisorConfig: overlay?.path });
    child = spawnCli(adapter.headless.bin, args, { cwd, env: { ...process.env, PEER_DEPTH: '1', PEER_ROLE: 'peer' }, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin });
    hello({ ok: true, harness, cwd, pid: child.pid });
  } catch (e) {
    try { overlay?.cleanup(); } catch { /* sweep */ }
    hello({ ok: false, code: e.code ?? 'REMOTE_FAILED', message: String(e.message) });
    process.exitCode = 1;
    return;
  }

  // A worker still running is never swept, however long it runs.
  let inUse = null;
  if (o.workspace) {
    const touch = () => touchTask(repoKeyOf(o.workspace.repo), o.workspace.taskId);
    touch();
    inUse = setInterval(touch, IN_USE_TOUCH_MS);
    inUse.unref();
  }
  let graceTimer = null;
  let done = false;
  const stopChild = () => { if (!done) killTree(child); };
  const graceThenStop = () => { if (!done) graceTimer ??= setTimeout(stopChild, exitGraceMs()); };
  process.stdin.pipe(child.stdin);
  // `close` too: a stdin destroyed without an `end` still means nobody writes.
  for (const ev of ['end', 'close', 'error']) process.stdin.on(ev, graceThenStop);
  child.stdin.on('error', () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  // ssh is gone: nobody will read another line.
  process.stdout.on('error', stopChild);
  for (const sig of isWin ? ['SIGINT', 'SIGBREAK'] : ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, () => { stopChild(); process.exitCode = 1; });

  await new Promise((resolve) => {
    child.on('error', (e) => { process.stderr.write(`[magi] ${harness} could not run: ${e.message}\n`); resolve(1); });
    child.on('close', (code) => resolve(code));
  }).then((code) => {
    done = true;
    clearTimeout(graceTimer);
    clearInterval(inUse);
    try { overlay?.cleanup(); } catch { /* sweep */ }
    process.exitCode = code ?? 1;
    process.stdin.unpipe(child.stdin);
    process.stdin.destroy();
    // Piped stdout drains on its own; this only stops a stray handle holding the process.
    setTimeout(() => process.exit(), 2000).unref();
  });
}

// --- magi relay -------------------------------------------------------------

// What a delivery receipt may say across machines. The rest of a receipt (a
// transcript marker, a session file) names paths here that mean nothing
// there; its later confirmation is this side's to make, so it stays here.
const RECEIPT = ['via', 'label', 'deliveryStatus', 'statusText', 'warning', 'messageId', 'threadId', 'clientId', 'turnId'];
// What a listing of this machine's sessions says to the other machine.
const LISTED = ['name', 'id', 'cwd', 'branch', 'lastActive', 'state', 'idleMs', 'waitingFor', 'stateText', 'kind', 'detail'];
// With the identity fields the card's own checks compare: an omp session's
// aliases (it switched sessions) and a process's birth time. Never words.
const PICKED = [...LISTED, 'agent', 'sessionId', 'pid', 'sessionAliases', 'processStartedAt'];
// The most card states one `state` call answers; the near end sends them in batches this size.
export const STATE_BATCH = 50;
// What the relay delivers: card traffic, as Magi composes it.
const DELIVERED = new Set(['request', 'note', 'clarify_answer']);
const FRAME = /^PEER (REQUEST|TURN|NOTE|CLARIFICATION) magi\/1\b/;
const idOf = (s) => s?.sessionId ?? s?.id ?? (s?.pid != null ? String(s.pid) : s?.name ?? null);

// Only this card's state crosses the relay; the daemon's history and notifications stay here.
function daemonState(status) {
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const waitingFor = flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'input' : null;
    return { live: true, state: waitingFor ? 'blocked' : 'working', waitingFor };
  }
  if (status?.type === 'idle') return { live: true, state: 'idle', waitingFor: null };
  if (status?.type === 'systemError') return { live: false, state: 'unknown', waitingFor: null };
  return null;
}

async function steerCodex(target, text, beforeSend = () => {}) {
  const daemon = await connectCodexDaemon();
  if (!daemon) throw Object.assign(failure('DAEMON_UNAVAILABLE', 'the shared Codex daemon is unavailable; send this as a note instead with delivery:"live". No message was queued'), { dispatchUncertain: false });
  try {
    const { threadId, turnId, clientId } = await steerLoadedThread(daemon, target?.id ?? target?.sessionId, text, beforeSend);
    return {
      via: `steer:${threadId}`, label: target.name ?? threadId, threadId, turnId,
      clientId, messageId: clientId, deliveryStatus: 'accepted',
      statusText: 'The remote Codex daemon accepted the steer; model receipt is unconfirmed. Do not resend it.',
    };
  } catch (e) {
    throw adviseSteerFailure(e);
  } finally {
    daemon.close();
  }
}

/**
 * The far end of a live worker on this machine for an orchestrator on another
 * (src/relay.mjs). It lists and picks this machine's sessions, delivers card
 * traffic into them after mirroring the card here, and pushes the outbox
 * events addressed to the orchestrator's machine. Only those operations: a
 * transcript, a spawn or free text into a session are not among them.
 */
export async function relay(raw) {
  const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
  let o;
  try {
    o = decode(raw);
    if (typeof o.as !== 'string' || !o.as) throw failure('BAD_REQUEST', 'the relay needs the orchestrator machine address');
  } catch (e) {
    out({ type: 'magi_relay', protocol: REMOTE_PROTOCOL, ok: false, code: e.code ?? 'REMOTE_FAILED', message: String(e.message) });
    process.exitCode = 1;
    return;
  }
  const { makePickDelivery, listPeerRows, peerState, describeState, isLive } = await import('./serve.mjs');
  const { mirrorRound, rollbackMirrorRound, putRequestBody, readTask, sameSession } = await import('./state.mjs');
  const { claimRelayEvents, ackRelayEvents, releaseRelayEvents } = await import('./relay.mjs');
  const adapters = new Map();
  const adapterOf = async (harness) => {
    if (!HARNESSES.has(harness)) throw failure('BAD_REQUEST', `no harness "${harness}"; use claude, codex or omp`);
    if (!adapters.has(harness)) adapters.set(harness, (await import(`./${harness}-adapter.mjs`)).adapter);
    return adapters.get(harness);
  };
  // A session picked by name or id, fresh at each use: a Claude inbox socket
  // moves when its session resumes.
  const pick = async (adapter, target, kind) => (await makePickDelivery(adapter)({ delivery: 'live', target, cwd: undefined, kind })).target;

  const ops = {
    // Who is there and in what state; what each said or was first asked stays here.
    // A session's `needs` is its user's prose (it can quote a command), so it
    // stays here, out of the label too.
    async peers(m) {
      const rows = await listPeerRows(await adapterOf(m.harness), {});
      return rows.map((r) => Object.fromEntries(LISTED.filter((k) => r[k] !== undefined).map((k) => [k, k === 'stateText' ? describeState({ ...r, needs: undefined }) : r[k]])));
    },
    // How each named card's worker here stands, for the machine that runs the
    // card (its `magi status`). Only cards mirrored here for that machine, and
    // only their round's own worker. An observation, not a delivery: the
    // sessions are listed strictly (a failed lookup gives no answer, so the
    // last one lapses into "not seen", never "gone"), the worker is the one
    // session matching its whole recorded identity (aliases, pid and birth;
    // never a name), and live means what it means here (isLive: a saved
    // conversation is not). State and what it waits on, never words or `needs`.
    async state(m) {
      const out = [];
      const listed = new Map(); // harness -> sessions, or null when the lookup failed
      let daemon;
      try {
        for (const taskId of (Array.isArray(m.tasks) ? m.tasks : []).slice(0, STATE_BATCH)) {
          const card = typeof taskId === 'string' ? readTask(taskId) : null;
          if (!card?.mirror || card.orchestratorTarget?.remote !== o.as) continue;
          const entry = card.rounds.at(-1);
          const worker = entry && Object.hasOwn(entry, 'peerTarget') ? entry.peerTarget : card.peerTarget;
          if (!worker || !HARNESSES.has(card.peer)) continue;
          if (card.peer === 'codex') {
            // One connection per state call, and never resume a thread merely to observe it.
            if (daemon === undefined) daemon = await connectCodexDaemon();
            const id = worker.id ?? worker.sessionId;
            if (daemon && typeof id === 'string' && id) {
              try {
                const state = daemonState((await daemon.findThread({ id })).status);
                if (state) { out.push({ taskId, round: entry.round, ...state }); continue; }
              } catch { /* No daemon observation: keep the strict registry path below. */ }
            }
          }
          if (!listed.has(card.peer)) {
            // strict for Codex, observe for the registry readers: either way a read that fails throws.
            try { listed.set(card.peer, await (await adapterOf(card.peer)).sessions({ strict: true, observe: true })); }
            catch { listed.set(card.peer, null); }
          }
          const sessions = listed.get(card.peer);
          if (!sessions) continue;
          // One worker, or no answer. Shared aliases are resolved by the recorded pid and birth.
          const matches = sessions.filter((s) => sameSession({ agent: card.peer, ...worker }, { agent: card.peer, ...s }) === true);
          const sameProcess = worker.pid != null && worker.processStartedAt != null
            ? matches.filter((s) => s.pid === worker.pid && s.processStartedAt === worker.processStartedAt) : [];
          const chosen = sameProcess.length === 1 ? sameProcess : matches;
          if (chosen.length > 1) continue;
          const session = chosen[0] ?? null;
          const st = session ? peerState(session) : null;
          out.push({ taskId, round: entry.round, live: Boolean(st) && isLive(card.peer, st), state: st?.state ?? 'gone', waitingFor: st?.state === 'blocked' ? st.waitingFor : null });
        }
        return out;
      } finally {
        daemon?.close();
      }
    },
    // The session chosen, as the listing shows it and by the handles that pick
    // it again; never what it was asked or said.
    async pick(m) {
      const adapter = await adapterOf(m.harness);
      const d = await makePickDelivery(adapter)({ delivery: 'live', target: m.target, cwd: undefined, kind: m.kind ?? 'request' });
      return { target: Object.fromEntries(PICKED.filter((k) => d.target?.[k] !== undefined).map((k) => [k, d.target[k]])), warning: d.warning ?? null };
    },
    // Files cross before the message that names them: `has` says which this
    // machine lacks, `put` takes one in order by offset and keeps it only
    // when its hash matches, `get` hands one back for the other machine.
    // Every file op is behind this machine's switch: asked what it holds (to take a
    // file in, cached or not), sent a piece, or asked for one.
    async has(m) {
      assertFilesEnabled();
      return { paths: Object.fromEntries((m.shas ?? []).map((sha) => [sha, hasBlob(sha) ? blobPath(sha) : null])) };
    },
    async put(m) {
      assertFilesEnabled();
      const part = `${blobPath(m.sha256)}.part`;
      const chunk = Buffer.from(m.data ?? '', 'base64');
      const have = existsSync(part) ? statSync(part).size : 0;
      if (m.offset === 0) writeFileSync(part, chunk);
      else if (m.offset === have) appendFileSync(part, chunk);
      else throw failure('FILE_CORRUPT', `a piece of ${m.sha256.slice(0, 12)} arrived at offset ${m.offset}, but ${have} bytes are here; send the file again from the start`);
      if (m.offset + chunk.length < m.size) return { received: m.offset + chunk.length };
      try { return { path: putBlob(m.sha256, readFileSync(part)) }; }
      finally { rmSync(part, { force: true }); }
    },
    async get(m) {
      // Turned off after a reply was filed with files: they stay here.
      assertFilesEnabled();
      const size = statSync(blobPath(m.sha256)).size;
      return { size, data: readChunk(m.sha256, m.offset ?? 0, CHUNK_BYTES).toString('base64') };
    },
    async deliver(m) {
      // Card traffic only: one of its kinds, on a card, as one of Magi's frames.
      if (!DELIVERED.has(m.kind) || typeof m.taskId !== 'string' || !m.taskId || !FRAME.test(String(m.text ?? ''))) {
        throw failure('BAD_REQUEST', 'the relay delivers only card traffic: a request, note or answer on a card, as a Magi frame');
      }
      const steer = m.delivery === 'steer';
      if (steer && m.harness !== 'codex') throw failure('BAD_REQUEST', 'only a Codex worker on another machine supports steer; send a note with delivery:"live" instead');
      const adapter = await adapterOf(m.harness);
      const bound = (t) => `card ${m.taskId} is not one ${o.as} runs with a ${m.harness} worker here`;
      let target;
      if (m.kind === 'request') {
        // The card it carries is the one the envelope names, run by the
        // machine this relay serves, for the harness it delivers to.
        const c = m.mirror;
        if (!c) throw failure('BAD_REQUEST', 'a request arrives with its card');
        if (c.taskId !== m.taskId || c.round !== m.round || c.peer !== m.harness || c.orchestratorTarget?.remote !== o.as) {
          throw failure('BAD_REQUEST', `the card sent with this request is not ${m.taskId} round ${m.round} from ${o.as} for ${m.harness}`);
        }
        // A steer is addressed by the id already selected there, never by a name substitution.
        target = steer ? { agent: 'codex', id: m.target?.id ?? m.target?.sessionId, name: m.target?.name, cwd: m.target?.cwd }
          : await pick(adapter, idOf(m.target), 'request');
      } else {
        // A note or an answer goes to the worker of a card mirrored here for
        // this machine, and only to that worker: the round's own.
        const card = readTask(m.taskId);
        if (!card?.mirror || card.orchestratorTarget?.remote !== o.as || card.peer !== m.harness) throw failure('ROLE_VIOLATION', bound());
        const entry = (m.round != null ? card.rounds.find((r) => r.round === m.round) : null) ?? card.rounds.at(-1);
        const worker = entry && Object.hasOwn(entry, 'peerTarget') ? entry.peerTarget : card.peerTarget;
        if (!worker) throw failure('ROLE_VIOLATION', bound());
        target = steer ? worker : await pick(adapter, idOf(worker), 'note');
      }
      if (m.files?.length) assertFilesEnabled();
      // A message names its files by this machine's copies, which must be here by now.
      const missing = (m.files ?? []).filter((f) => !hasBlob(f.sha256));
      if (missing.length) throw failure('FILE_MISSING', `${missing.map((f) => f.name).join(', ')} did not arrive here before the message; send it again`);
      const attemptId = randomUUID();
      let createdMirror = false;
      const mirror = () => {
        if (m.kind !== 'request') return;
        const rec = mirrorRound({ ...m.mirror, peerTarget: target, attemptId });
        const entry = rec.rounds.find((r) => r.round === m.round);
        createdMirror = entry?.mirrorAttemptId === attemptId;
        const same = entry?.peerTarget ? sameSession(entry.peerTarget, target) : true;
        if (same === false || (same == null && idOf(entry.peerTarget) !== idOf(target))) {
          throw failure('CARD_FIXED', `round ${m.round} of ${m.taskId} went to ${entry.peerTarget.name ?? idOf(entry.peerTarget)} here; it is not sent again to another session`);
        }
      };
      try {
        let used;
        // Validate the daemon/thread/turn before creating a mirror; only the
        // actual mutation and its possible turn race happen after mirroring.
        if (steer) used = await steerCodex(target, m.text + filesBlock(m.files), mirror);
        else {
          mirror();
          used = await adapter.deliverLive({ text: m.text + filesBlock(m.files), target, taskId: m.taskId ?? null, round: m.round ?? null, cwd: target.cwd, putRequestBody, sender: m.sender ?? null, delivery: m.delivery ?? 'live', kind: m.kind === 'request' ? undefined : m.kind });
        }
        return Object.fromEntries(RECEIPT.filter((k) => used?.[k] !== undefined).map((k) => [k, used[k]]));
      } catch (e) {
        if (createdMirror && e.dispatchUncertain === false &&
          !rollbackMirrorRound({ taskId: m.taskId, round: m.round, attemptId })) {
          // A concurrent attempt/reply now owns the round: keep both ledgers
          // until the operator inspects it, even though this send was refused.
          e.dispatchUncertain = true;
          e.message += ' This mirror has concurrent activity; inspect the card and history before retrying.';
        }
        throw e;
      }
    },
    async ack(m) {
      ackRelayEvents(m.ids);
      return { acked: (m.ids ?? []).length };
    },
    async release(m) {
      releaseRelayEvents(m.ids);
      return { released: (m.ids ?? []).length };
    },
  };

  out({ type: 'magi_relay', protocol: REMOTE_PROTOCOL, ok: true });
  const owner = { pid: process.pid };
  // The outbox is written by this machine's own Magi servers, so it is read
  // here by poll, at the frames inbox's rate.
  const poll = setInterval(() => {
    try { for (const ev of claimRelayEvents(o.as, owner)) out({ event: ev }); }
    catch { /* the ledger is busy; the next poll tries again */ }
  }, 750);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const op = ops[m?.op];
      Promise.resolve()
        .then(() => (op ? op(m) : Promise.reject(failure('BAD_REQUEST', `no relay operation "${m?.op}"`))))
        .then((result) => out({ id: m.id, ok: true, result }), (e) => out({ id: m.id, ok: false, error: {
          code: e.code ?? 'REMOTE_FAILED', message: String(e.message),
          ...(typeof e.dispatchUncertain === 'boolean' ? { dispatchUncertain: e.dispatchUncertain } : {}),
        } }));
    }
  });
  await new Promise((resolve) => process.stdin.on('close', resolve));
  clearInterval(poll);
  setTimeout(() => process.exit(), 2000).unref();
}
