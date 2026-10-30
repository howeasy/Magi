// Live delivery into an already-running Claude Code or Codex session.
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, fstatSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveBin, runCli, spawnCli, killTree } from './exec.mjs';
import { codexCaller } from './mcp-caller.mjs';
import { magiHome } from './state.mjs';
import { ompPermissionClass } from './omp-launch.mjs';
import { tailLines, headLines, titleFrom, lastRecordAt } from './session-tail.mjs';
import { processStartedAt } from '../omp/process-identity.js';
import { deliveryCursor } from './delivery-confirm.mjs';
import { codexThreadCursor } from './codex-history.mjs';
import { steerLocalDaemon } from './codex-daemon-proxy.mjs';
import { statement, transaction, removeRecord } from './store.mjs';
import { redact } from './protocol.mjs';

const isWin = platform() === 'win32';

// --- Claude Code side ------------------------------------------------------

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function sessionsDir() {
  return join(claudeConfigDir(), 'sessions');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A bridge's launch ancestry is immutable; registry contents are not.
let cachedCallerAncestors;
function callerAncestors() {
  return cachedCallerAncestors ??= discoverCallerAncestors();
}

// The nearest registry ancestor owns a stdio server, even behind a CLI shim.
function discoverCallerAncestors() {
  const first = process.ppid;
  if (isWin) {
    try {
      const script = `$rows=Get-CimInstance Win32_Process; $n=${first}; $seen=@{}; while ($n -gt 0 -and !$seen.ContainsKey($n)) { $n; $seen[$n]=$true; $r=$rows | Where-Object ProcessId -eq $n | Select-Object -First 1; if (!$r) { break }; $n=[int]$r.ParentProcessId }`;
      const rows = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return [...new Set([first, ...rows.trim().split(/\s+/).map(Number).filter((pid) => pid > 0)])];
    } catch { return [first]; }
  }
  const out = [];
  let pid = first;
  while (pid > 0 && !out.includes(pid)) {
    out.push(pid);
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim()); }
    catch { break; }
  }
  return out;
}

// Each session publishes <pid>.json plus a sibling <pid>.<64hex>.key holding the
// token a poster must present. See docs/transport-recon.md for the frame contract.
function peerTokenFor(pid) {
  let names;
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return null;
  }
  const re = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`);
  for (const n of names) {
    if (!re.test(n)) continue;
    try {
      const v = JSON.parse(readFileSync(join(sessionsDir(), n), 'utf-8'));
      if (typeof v.peerToken === 'string') return v.peerToken;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// `observe`: an observation, not a delivery. A registry that cannot be read is
// an error, not an empty listing, so nobody concludes a session is gone from
// a read that failed. A folder or file that is not there is still absence (a
// session that exited removes its own file).
export function listClaudeSessions({ includeDead = false, includeUnaddressable = false, observe = false } = {}) {
  let names;
  try {
    names = readdirSync(sessionsDir());
  } catch (e) {
    if (observe && e.code !== 'ENOENT') throw e;
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let d;
    try {
      d = JSON.parse(readFileSync(join(sessionsDir(), n), 'utf-8'));
    } catch (e) {
      if (observe && e.code !== 'ENOENT') throw e;
      continue;
    }
    if (!d || (!d.messagingSocketPath && !(includeUnaddressable && d.sessionId))) continue;
    const live = alive(d.pid);
    if (!live && !includeDead) continue;
    out.push({
      agent: 'claude',
      name: d.name ?? null,
      sessionId: d.sessionId ?? null,
      pid: d.pid,
      cwd: d.cwd ?? null,
      socket: d.messagingSocketPath,
      hostSessionId: d.hostSessionId ?? null,
      kind: d.kind ?? null,
      // A `claude --bg` session's short id, what `claude attach` takes.
      jobId: typeof d.jobId === 'string' ? d.jobId : null,
      // Where the session was started: "claude-desktop" for the app (2.1.271),
      // which is what makes it linkable back into the app.
      entrypoint: typeof d.entrypoint === 'string' ? d.entrypoint : null,
      startedAt: typeof d.startedAt === 'number' ? d.startedAt : null,
      live,
      // Claude keeps its own activity in the registry: `status` is one of
      // busy / shell / idle / waiting, and `waitingFor` says what a waiting
      // session waits on ("permission prompt", "dialog open", "input needed").
      // Pinned private format; verified in claude.exe 2.1.263 and 2.1.270.
      status: typeof d.status === 'string' ? d.status : null,
      waitingFor: typeof d.waitingFor === 'string' ? d.waitingFor : null,
      // What it needs from its user, in words ("choose: allow or deny the
      // computer-use action"); 2.1.290 and 2.1.302 (REA 2026-10-16). It can
      // quote a command, so it is clipped and redacted before anyone sees it.
      needs: typeof d.needs === 'string' && d.needs.trim() ? redact(d.needs.trim()).text.slice(0, 160) : null,
      statusAt: d.statusUpdatedAt ?? d.updatedAt ?? null,
    });
  }
  return out;
}

// A Claude session that runs somewhere else. The desktop app can run a
// session in the cloud: no local process, no registry row, no inbox socket,
// yet its transcript (and its subagents' transcripts) keep arriving under
// ~/.claude/projects exactly as a local session's do. Observed 2026-09-20:
// session 5f6d5ca5 writing 11 subagent files at once with no claude.exe for
// it on the machine. It is listed for the board and for `peers` as
// kind "remote", live while its transcript is fresh, and is never a
// delivery target: there is nothing here to deliver to.
export const REMOTE_BUSY_MS = 2 * 60_000;
// ponytail: a paused local session (the app drops its registry row) looks
// the same as a quiet remote one; ten minutes of silence and either is gone.
export const REMOTE_SEEN_MS = 10 * 60_000;
export function remoteClaudeSessions({ known = listClaudeSessions() } = {}) {
  const local = new Set(known.map((s) => s.sessionId));
  // An id the app has moved on from (/clear, a continuation) still gets
  // writes for a while; it is the same session as the one registered.
  claudeAppSessionIndex();
  const prior = appIndex.prior;
  const root = join(claudeConfigDir(), 'projects');
  let slugs;
  try {
    slugs = readdirSync(root);
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const slug of slugs) {
    let names;
    try {
      names = readdirSync(join(root, slug));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
      const id = n.slice(0, -6);
      if (local.has(id) || prior.has(id)) continue;
      const file = join(root, slug, n);
      let mtime;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > REMOTE_SEEN_MS) continue; // untouched: not it
      // When it last moved, by its records' clock, not the file's: the app
      // rewrites old transcripts wholesale. Its subagents write their own
      // files while the main transcript waits on them, so theirs count.
      let lastAt = lastRecordAt(tailLines(file, 64 * 1024).lines) ?? 0;
      try {
        const sub = join(root, slug, id, 'subagents');
        for (const f of readdirSync(sub)) {
          if (!f.endsWith('.jsonl') || now - statSync(join(sub, f)).mtimeMs > REMOTE_SEEN_MS) continue;
          lastAt = Math.max(lastAt, lastRecordAt(tailLines(join(sub, f), 64 * 1024).lines) ?? 0);
        }
      } catch {
        /* no subagents */
      }
      if (now - lastAt > REMOTE_SEEN_MS) continue;
      // The first records carry cwd and entrypoint; the first line can be
      // longer than any sensible read, so the fields are picked out raw.
      let head = '';
      try {
        const fd = openSync(file, 'r');
        try {
          const buf = Buffer.alloc(16384);
          head = buf.subarray(0, readSync(fd, buf, 0, 16384, 0)).toString('utf-8');
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const field = (k) => {
        const m = new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*")`).exec(head);
        try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
      };
      out.push({
        agent: 'claude',
        name: null,
        sessionId: id,
        pid: null,
        cwd: field('cwd'),
        transcript: file,
        socket: null,
        kind: 'remote',
        jobId: null,
        entrypoint: field('entrypoint'),
        startedAt: null,
        live: true,
        remote: true,
        status: now - lastAt < REMOTE_BUSY_MS ? 'busy' : 'idle',
        waitingFor: null,
        statusAt: lastAt,
      });
    }
  }
  return out;
}

// The Claude Code desktop app's own session records: one JSON per app
// session under <app data>/Claude/claude-code-sessions/<account>/<org>/
// local_<appId>.json with `cliSessionId` (the CLI session it runs now) and
// `priorCliSessionIds` (after /clear or a resume). The app id is NOT always
// `local_<cliSessionId>`: it is for a session that was never cleared, and
// differs after one, so the record is the only honest mapping. Private
// format, Claude desktop 2.110.0.0 (docs/transport-recon.md). Read once per
// 10 s; a missing store maps nothing, and nothing is guessed.
const APP_INDEX_TTL_MS = 10_000;
let appIndex = { at: 0, key: null, map: new Map(), prior: new Set() };
export function claudeAppSessionIndex(now = Date.now()) {
  const key = process.env.CLAUDE_APP_SESSIONS_DIR ?? '';
  if (appIndex.key === key && now - appIndex.at < APP_INDEX_TTL_MS) return appIndex.map;
  const map = new Map();
  const prior = new Set();
  const roots = [join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code-sessions')];
  const packages = join(homedir(), 'AppData', 'Local', 'Packages');
  try {
    for (const d of readdirSync(packages)) if (d.startsWith('Claude_')) roots.push(join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
  } catch {
    /* not Windows, or no packages dir */
  }
  if (process.env.CLAUDE_APP_SESSIONS_DIR) roots.push(process.env.CLAUDE_APP_SESSIONS_DIR);
  for (const root of roots) {
    let accounts = [];
    try { accounts = readdirSync(root); } catch { continue; }
    for (const acct of accounts) {
      let orgs = [];
      try { orgs = readdirSync(join(root, acct)); } catch { continue; }
      for (const org of orgs) {
        let files = [];
        try { files = readdirSync(join(root, acct, org)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
          try {
            const rec = JSON.parse(readFileSync(join(root, acct, org, f), 'utf-8'));
            const appId = rec.sessionId ?? f.slice(0, -5);
            for (const id of [rec.cliSessionId, ...(Array.isArray(rec.priorCliSessionIds) ? rec.priorCliSessionIds : [])]) if (typeof id === 'string') map.set(id, appId);
            if (Array.isArray(rec.priorCliSessionIds)) for (const id of rec.priorCliSessionIds) if (typeof id === 'string') prior.add(id);
          } catch {
            /* a record mid-write */
          }
        }
      }
    }
  }
  appIndex = { at: now, key, map, prior };
  return map;
}

// The claude:// link that opens a desktop session in the app, or null when
// the app's records do not name it (a terminal session, or an app store
// that could not be read).
export function claudeAppLink(session) {
  if (session?.entrypoint !== 'claude-desktop' || !session.sessionId) return null;
  const appId = claudeAppSessionIndex().get(session.sessionId);
  return appId ? `claude://claude.ai/epitaxy/${appId}` : null;
}

// The transcript a Claude session writes for itself, keyed by its cwd and id.
export function claudeTranscriptPath(session) {
  if (!session?.sessionId || !session.cwd) return null;
  const slug = session.cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(claudeConfigDir(), 'projects', slug, `${session.sessionId}.jsonl`);
}

// What a Claude session is working on. The registry has only a name, but the
// session's transcript carries the title the user gave it ("custom-title")
// and the first prompt. Only the head of the file is read.
export function claudeSessionPurpose(session) {
  const path = claudeTranscriptPath(session);
  if (!path) return null;
  let head;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let title = null;
  let prompt = null;
  for (const line of head.split(/\r?\n/)) {
    if (!title && line.includes('"custom-title"')) {
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title' && typeof o.customTitle === 'string') title = o.customTitle;
      } catch {
        /* partial tail line */
      }
    } else if (!prompt && line.includes('"type":"user"') && !line.includes('"toolUseResult"')) {
      try {
        const o = JSON.parse(line);
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
        const first = text.split(/\r?\n/).find((l) => l.trim());
        if (first && !first.startsWith('<')) prompt = first.length > 140 ? `${first.slice(0, 140)}…` : first;
      } catch {
        /* ignore */
      }
    }
    if (title && prompt) break;
  }
  return title && prompt ? `${title}: ${prompt}` : title ?? prompt;
}

export function ownClaudeInbox() {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  return socket ? { socket, token: token ?? null } : null;
}

// --- Claude peer envelope ---------------------------------------------------
//
// Claude Code reads the sender's identity and permission class out of the
// message BODY, not out of frame fields. This is the grammar its inbox parses
// (claude.exe 2.1.263, functions Lz/Cse/gce; tag name d4="cross-session-message"):
//
//   <cross-session-message from="uds:.." from-session=".." hop-chain="a,b" from-name=".." from-mode="bypass|prompting">
//   body
//   </cross-session-message>
//
// Attributes are optional but their ORDER is fixed, and the receiver
// re-serialises what it parsed and drops the message if the bytes differ, so
// the writer below mirrors gce()/f1e() exactly. `from-mode` decides whether a
// bypass-class receiver delivers immediately (same class) or holds for the
// user's approval (cross-class or no class asserted). `from-name` is what the
// receiving user sees as "Message from @<name>" and what its model is told.
export const CLAUDE_ENVELOPE_TAG = 'cross-session-message';
const ENVELOPE_FROM_CHARS = /^[A-Za-z0-9%:_/.\\-]{1,200}$/;
// 80, as the receiver checks it (2.1.290 and 2.1.302; docs/evidence REA
// Claude): a longer one is dropped there, and the re-serialised envelope then
// no longer matches, so the whole envelope is refused. Left out instead.
const ENVELOPE_SESSION_CHARS = /^[A-Za-z0-9_-]{1,80}$/;
const ENVELOPE_PLUGIN_CHARS = /^[A-Za-z0-9@._/:-]{1,200}$/;
const ENVELOPE_MODES = new Set(['bypass', 'prompting']);

// $E in the binary: strip Cc/Cf/Cs/Zl/Zp, trim, cap at 64 code points.
function envelopeName(name) {
  const t = String(name ?? '')
    .replace(/["<>]/g, '')
    .replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '')
    .trim();
  const cp = [...t];
  return cp.length > 64 ? `${cp.slice(0, 64).join('')}…` : t;
}

// GCe in the binary: a nested opening or closing tag is neutralised to "<\".
function envelopeBody(body) {
  return String(body ?? '').replace(new RegExp(`</?${CLAUDE_ENVELOPE_TAG}`, 'g'), '<\\');
}

export function wrapForClaude({ from, fromSession, hopChain, fromName, fromMode, fromPlugin, body }) {
  const attrs = [];
  if (from && ENVELOPE_FROM_CHARS.test(from)) attrs.push(`from="${from}"`);
  if (fromSession && ENVELOPE_SESSION_CHARS.test(fromSession)) attrs.push(`from-session="${fromSession}"`);
  if (Array.isArray(hopChain) && hopChain.length) attrs.push(`hop-chain="${hopChain.join(',')}"`);
  const name = envelopeName(fromName);
  if (name) attrs.push(`from-name="${name}"`);
  if (ENVELOPE_MODES.has(fromMode)) attrs.push(`from-mode="${fromMode}"`);
  // Written by native senders from a plugin; Magi never claims one, but reads it.
  if (fromPlugin && ENVELOPE_PLUGIN_CHARS.test(fromPlugin)) attrs.push(`from-plugin="${fromPlugin}"`);
  const head = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `<${CLAUDE_ENVELOPE_TAG}${head}>\n${envelopeBody(body)}\n</${CLAUDE_ENVELOPE_TAG}>`;
}

// The receiver's parse, kept here so a test can prove the writer round-trips.
export function parseClaudeEnvelope(text) {
  const re = new RegExp(
    `^<${CLAUDE_ENVELOPE_TAG}(?: from="([A-Za-z0-9%:_/.\\\\-]+)")?(?: from-session="([A-Za-z0-9_-]+)")?(?: hop-chain="([^"]+)")?(?: from-name="([^"<>\\n\\r]+)")?(?: from-mode="(bypass|prompting)")?(?: from-plugin="([^"<>\\n\\r]+)")?>\\n([\\s\\S]*)\\n</${CLAUDE_ENVELOPE_TAG}>$`,
  );
  const m = re.exec(text ?? '');
  if (!m) return null;
  const parsed = { from: m[1], fromSession: m[2], hopChain: m[3]?.split(','), fromName: m[4], fromMode: m[5], fromPlugin: m[6], body: m[7] };
  return wrapForClaude(parsed) === text ? parsed : null;
}

// A sender description -> envelope attributes. `mode` is asserted only when it
// was actually established (see codexPermissionClass); an unknown class is left
// unasserted, which a bypass receiver will hold, and that is the honest result.
export function envelopeFor(sender, { from } = {}) {
  if (!sender) return { from };
  const id = sender.id ?? sender.sessionId ?? null;
  return {
    from,
    fromSession: id ?? undefined,
    fromName: `${sender.agent ?? 'peer'}:${sender.name ?? id ?? 'unknown'}`,
    fromMode: sender.mode,
  };
}

// Fire-and-forget: the inbox never writes anything back on the connection.
// Each frame gets a fresh UUID `msg_id` with `msgV: 1`, as Claude's own
// senders supply them: the receiver keeps a `msg_id` only when it is a UUID
// (2.1.290 and 2.1.302; REA 2026-10-16), so its hold, drop and expiry
// notices can name this message. Magi also uses the same UUID as the frame's
// `uuid`, its own choice (native senders draw that separately). Resolves with
// that id once the frame is written and the socket closed (dispatch, not
// receipt).
export function postToClaude({ socket, token, sessionId, text, from }) {
  const msgId = randomUUID();
  return new Promise((resolve, reject) => {
    let c;
    try { c = net.connect(socket); }
    catch (error) { error.dispatchUncertain = false; reject(error); return; }
    let settled = false;
    let dispatchUncertain = false;
    const fail = (code, msg) => {
      if (settled) return;
      settled = true;
      const e = new Error(msg);
      e.code = code;
      e.dispatchUncertain = dispatchUncertain;
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      reject(e);
    };
    const timer = setTimeout(() => fail('DELIVERY_TIMEOUT', `Timed out writing to the Claude inbox at ${socket}.`), 15000);

    c.on('connect', () => {
      if (token) c.write(JSON.stringify({ type: 'auth', token }) + '\n');
      const frame = { type: 'user', message: { content: text }, uuid: msgId, msg_id: msgId, msgV: 1 };
      if (sessionId) frame.session_id = sessionId;
      if (from) frame.from = from;
      const line = JSON.stringify(frame) + '\n';
      // Once the application frame write is attempted, an error is not proof
      // that the receiver did not read it.
      dispatchUncertain = true;
      c.write(line);
      c.end();
    });
    c.on('error', (e) =>
      fail(
        'DELIVERY_FAILED',
        `Could not reach the Claude session inbox at ${socket}: ${e.message}. ` +
          'The session may have exited, or it is running under a different user or container.',
      ),
    );
    c.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(msgId);
      }
    });
  });
}

// `sender` is who the message is from ({agent, id, name, cwd, mode?}); it becomes
// the envelope so the receiver sees a name and a permission class instead of
// "unknown". A Codex sender's class is read from its own thread when not given.
export async function deliverToClaude({ target, text, from, sender }) {
  const token = peerTokenFor(target.pid);
  if (!token && isWin) {
    const e = new Error(
      `No peer key found for Claude session ${target.name ?? target.pid}. On Windows the inbox requires the auth line, ` +
        'so delivery cannot proceed. Confirm the session is still running.',
    );
    e.code = 'NO_PEER_KEY';
    e.dispatchUncertain = false;
    // The session is gone or unreachable, so a fresh headless peer is the
    // right answer when the caller left the choice open.
    e.fallback = true;
    throw e;
  }
  // The sender's real permission class, never a claim made to pass the gate:
  // Codex's from its rollout, omp's from its actual launch/session approval
  // mode. Headless launch provenance overrides any inferred class; unknown
  // stays unasserted, which a bypass receiver holds.
  let who = sender;
  if (who && (who.agent === 'codex' || who.agent === 'omp') && (!who.mode || (who.agent === 'omp' && who.headless))) {
    try {
      who = { ...who, mode: who.agent === 'codex' ? await codexPermissionClass(who) : await ompPermissionClass(who) };
    } catch {
      /* class stays unasserted */
    }
  }
  const marker = `magi-delivery:${randomUUID()}`;
  const transcriptPath = target.transcript ?? claudeTranscriptPath(target);
  const body = wrapForClaude({ ...envelopeFor(who, { from }), body: `${text}\n<!-- ${marker} -->` });
  const cursor = deliveryCursor(transcriptPath);
  // The frame's id names it to Claude; the marker is what confirmation reads
  // (delivery-confirm.mjs), so the two stay separate. A receipt written
  // before this change keeps its old `magi-…` id, opaque as ever.
  const msgId = await postToClaude({ socket: target.socket, token, sessionId: target.sessionId, text: body, from });
  return { target, via: `live:${target.name ?? target.sessionId ?? target.pid}`, messageId: msgId, msgId, marker, cursor, transcriptPath, deliveryStatus: 'unconfirmed' };
}

// --- Codex side ------------------------------------------------------------

async function runCodex(args, { timeoutMs = 60000 } = {}) {
  const result = await runCli('codex', args, { timeoutMs });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`codex ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`), {
      code: 'CODEX_CLI_FAILED', stderr: result.stderr,
    });
  }
  return result;
}

// JSON-RPC as `codex app-server` speaks it on stdio: one object per line, no
// "jsonrpc" member. A message with `method` and `id` is a request from the
// server, `method` alone a notification, `id` alone the response to one of
// ours. Carries no transport: the shared client below writes to its own pipe,
// a headless worker (`codexAppServerSession`, src/codex-launch.mjs) to its
// channel. A server request is answered with whatever `onRequest` returns
// ({result} or {error}); with no handler, or one that throws, it is declined,
// so the server is never left waiting on an answer nobody will send.
export function appServerRpc({ write, onNotification, onRequest } = {}) {
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  const decline = (m, why) => ({ error: { code: -32601, message: `magi does not handle ${m.method}${why ? ` (${why})` : ''}.` } });
  const take = (id) => {
    const waiter = pending.get(id);
    pending.delete(id);
    return waiter;
  };
  return {
    // Resolves with the whole response, {id, result} or {id, error}.
    request(method, params, { timeoutMs, onTimeout } = {}) {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => take(id)?.reject(onTimeout?.() ?? new Error(`${method} got no response in ${timeoutMs}ms.`)), timeoutMs) : null;
        pending.set(id, {
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        Promise.resolve().then(() => write({ method, id, params })).catch((e) => take(id)?.reject(e));
      });
    },
    notify(method, params) {
      return Promise.resolve().then(() => write({ method, params }));
    },
    // One parsed line from the server.
    handle(m) {
      if (!m || typeof m !== 'object') return;
      if (typeof m.method === 'string') {
        if (m.id === undefined || m.id === null) {
          onNotification?.(m);
          return;
        }
        let answer = null;
        try { answer = onRequest?.(m) ?? null; } catch (e) { answer = decline(m, e.message); }
        Promise.resolve().then(() => write({ id: m.id, ...(answer ?? decline(m)) })).catch(() => { /* the server is gone */ });
        return;
      }
      take(m.id)?.resolve(m);
    },
    fail(error) {
      failure ??= error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  };
}

// How every app-server Magi starts is launched and introduced: the shared
// client below and each headless worker.
export const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'];
export const APP_SERVER_INITIALIZE = {
  clientInfo: { name: 'magi', title: 'Magi', version: '0.1.0' },
  // experimentalApi unlocks thread/queue/list for pending-row inspection;
  // exact consumption evidence comes from the thread history reader.
  capabilities: { experimentalApi: true },
};

// Minimal JSON-RPC client over `codex app-server` stdio.
//
// One process per bridge process, spawned on first use and reused. Every call
// used to spawn, initialise and kill its own app-server, and a note or a `peers`
// listing is several calls, which is where the multi-second latency came from.
// A process that exits is replaced on the next call, so a crashed server or a
// one-shot test double costs one respawn rather than a stuck client. Its stderr
// tail travels with any failure, because "exited (code 1)" on its own has
// proved undiagnosable. It reads and lists only: it never starts a turn, and it
// is never a headless worker's server (that one runs with PEER_DEPTH=1 and the
// bridge disabled; src/codex-launch.mjs).
const APPSERVER_STDERR_KEEP = 4096;
let sharedAppServer = null;

function spawnAppServer() {
  const p = spawnCli('codex', APP_SERVER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = { p, stderr: '', dead: false, ready: null };
  const rpc = appServerRpc({ write: (m) => { p.stdin.write(JSON.stringify(m) + '\n'); } });
  let buf = '';

  const fail = (error) => {
    client.dead = true;
    if (sharedAppServer === client) sharedAppServer = null;
    rpc.fail(error);
  };
  const withStderr = (msg) => (client.stderr.trim() ? `${msg}: ${client.stderr.trim()}` : msg);

  p.stderr.on('data', (d) => {
    client.stderr = (client.stderr + d.toString()).slice(-APPSERVER_STDERR_KEEP);
  });
  p.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      rpc.handle(m);
    }
  });
  p.on('error', (e) => fail(Object.assign(new Error(`Could not start codex app-server: ${e.message}`), { code: 'CLI_NOT_FOUND' })));
  p.stdin.on('error', (e) => fail(Object.assign(new Error(withStderr(`codex app-server input failed: ${e.message}`)), { code: 'APPSERVER_ERROR', stderr: client.stderr })));
  p.on('exit', (code) => fail(Object.assign(new Error(withStderr(`codex app-server exited (code ${code})`)), { code: 'APPSERVER_ERROR', stderr: client.stderr })));

  // A CLI invocation must still exit when its work is done: nothing here may
  // hold the event loop open. A call in flight holds it through its own timer.
  p.unref();
  for (const s of [p.stdin, p.stdout, p.stderr]) s.unref?.();

  client.send = (method, params, timeoutMs) => {
    if (client.dead) return Promise.reject(Object.assign(new Error(withStderr('codex app-server is not running')), { code: 'APPSERVER_ERROR' }));
    return rpc.request(method, params, {
      timeoutMs,
      onTimeout: () => Object.assign(new Error('codex app-server did not respond in time.'), { code: 'APPSERVER_TIMEOUT' }),
    });
  };

  client.ready = (async () => {
    const initialized = await client.send('initialize', APP_SERVER_INITIALIZE, 60000);
    if (initialized.error) throw Object.assign(new Error(JSON.stringify(initialized.error)), { code: 'APPSERVER_ERROR' });
    await rpc.notify('initialized', {});
  })();
  client.ready.catch(() => {
    client.dead = true;
    if (sharedAppServer === client) sharedAppServer = null;
    stopAppServer(p);
  });
  return client;
}

// On Windows `codex` is usually a .cmd shim: p.kill() ends cmd.exe and leaves
// the app-server it started running, so the tree is killed instead.
function stopAppServer(p) {
  try { if (isWin) killTree(p); else p.kill(); } catch { /* already gone */ }
}

function appServerClient() {
  if (!sharedAppServer || sharedAppServer.dead) sharedAppServer = spawnAppServer();
  return sharedAppServer;
}

process.on('exit', () => {
  if (sharedAppServer) stopAppServer(sharedAppServer.p);
});

export async function appServer(calls, { timeoutMs = 60000 } = {}) {
  const client = appServerClient();
  await client.ready;
  const results = [];
  for (const c of calls) results.push(await client.send(c.method, c.params, timeoutMs));
  return results;
}

export async function listCodexThreads({ cwd, limit = 40 } = {}) {
  const params = { limit, archived: false };
  if (cwd) params.cwd = cwd;
  const [res] = await appServer([{ method: 'thread/list', params }]);
  if (res?.error) throw Object.assign(new Error(JSON.stringify(res.error)), { code: 'APPSERVER_ERROR' });
  const data = res?.result?.data ?? [];
  return data
    .map((t) => ({
      agent: 'codex',
      id: t.id,
      name: t.name ?? null,
      cwd: t.cwd ?? null,
      status: t.status?.type ?? null,
      canAcceptDirectInput: t.canAcceptDirectInput ?? null,
      updatedAt: t.updatedAt ?? null,
      // What the thread is about: Codex keeps the first user message as
      // `preview`, plus the branch it is on and any nickname/role from the
      // native multi-agent feature. The rollout path is what the permission
      // class is read from.
      preview: t.preview ?? null,
      branch: t.gitInfo?.branch ?? null,
      model: t.model ?? null,
      source: t.source ?? null,
      recencyAt: t.recencyAt ?? t.updatedAt ?? null,
      agentNickname: t.agentNickname ?? null,
      agentRole: t.agentRole ?? null,
      // Set on a thread Codex's multi-agent feature started from another:
      // the board nests it under that one (thread/list, Codex 0.153.4).
      parentThreadId: t.parentThreadId ?? null,
      path: t.path ?? null,
    }))
    .sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0));
}

// Every Codex-originated call reads its own thread once to learn the caller's
// name and rollout path. Neither changes often enough to fetch each time; a
// rename shows up within the TTL.
const THREAD_CACHE_TTL_MS = 5 * 60 * 1000;
const threadCache = new Map(); // threadId -> { at, value }

export async function readCodexThread(threadId) {
  const hit = threadCache.get(threadId);
  if (hit && Date.now() - hit.at < THREAD_CACHE_TTL_MS) return hit.value;
  const [res] = await appServer([{ method: 'thread/read', params: { threadId, includeTurns: false } }]);
  if (res?.error) throw Object.assign(new Error(JSON.stringify(res.error)), { code: 'APPSERVER_ERROR' });
  const t = res?.result?.thread;
  const value = t ? { id: t.id, name: t.name ?? null, cwd: t.cwd ?? null, preview: t.preview ?? null, path: t.path ?? null, branch: t.gitInfo?.branch ?? null } : null;
  if (value) threadCache.set(threadId, { at: Date.now(), value });
  return value;
}

// Messages still waiting, not consumption evidence: deletion and replacement
// also remove rows. Receipt confirmation reads the exact history clientId.
export async function codexQueueList(threadId) {
  const rows = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const [res] = await appServer([{ method: 'thread/queue/list', params: { threadId, limit: 100, ...(cursor ? { cursor } : {}) } }]);
    if (res?.error || !Array.isArray(res?.result?.data)) throw Object.assign(new Error('Could not inspect the Codex queue.'), { code: 'QUEUE_LOOKUP_FAILED' });
    rows.push(...res.result.data);
    cursor = res.result.nextCursor;
    if (cursor == null) return rows;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw Object.assign(new Error('Queue lookup did not finish; no partial-list cleanup is safe.'), { code: 'QUEUE_LOOKUP_FAILED' });
}

export async function codexQueueAdd({ threadId, text, clientId }) {
  const [res] = await appServer([{ method: 'thread/queue/add', params: { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text, text_elements: [] }] } }]);
  const item = res?.result?.queuedSubmission;
  if (res?.error || typeof item?.id !== 'string' || item.clientUserMessageId !== clientId) throw Object.assign(new Error('Queue add was not confirmed; do not resend automatically.'), { code: 'DELIVERY_UNCONFIRMED', dispatchUncertain: true });
  return { messageId: item.id, threadId, clientId };
}

export async function codexQueueDelete({ threadId, messageId }) {
  const [res] = await appServer([{ method: 'thread/queue/delete', params: { threadId, queuedSubmissionId: messageId } }]);
  if (res?.error || typeof res?.result?.deleted !== 'boolean') throw Object.assign(new Error('Queue deletion was not confirmed.'), { code: 'QUEUE_DELETE_FAILED' });
  return res.result.deleted;
}

// The permission class Claude Code's inbox gate understands, read from the
// thread's own latest turn_context in its rollout file: prompts never AND no
// sandbox is "bypass" (Claude's bypassPermissions); anything else prompts or is
// sandboxed, which Claude groups as "prompting". Unknown stays null.
export async function codexPermissionClass(thread) {
  let path = thread?.path ?? null;
  if (!path && thread?.id) path = (await readCodexThread(thread.id))?.path ?? null;
  if (!path) return null;
  const ctx = await lastTurnContext(path);
  if (!ctx) return null;
  const approval = ctx.approval_policy;
  const sandbox = ctx.sandbox_policy?.type;
  // Only values whose meaning is known map to a class; anything else stays
  // unknown rather than being called "prompting" by default.
  const APPROVALS = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
  const SANDBOXES = new Set(['danger-full-access', 'workspace-write', 'read-only', 'external-sandbox']);
  if (!APPROVALS.has(approval) || !SANDBOXES.has(sandbox)) return null;
  return approval === 'never' && sandbox === 'danger-full-access' ? 'bypass' : 'prompting';
}

// The most recent complete turn_context in a rollout, scanning backward in
// chunks: a long active turn can append megabytes after it, so a fixed tail is
// not enough. Reads only as much of the end of the file as it takes.
async function lastTurnContext(path) {
  const CHUNK = 256 * 1024;
  const MAX = 64 * 1024 * 1024;
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let end = size;
    let carry = ''; // the (possibly partial) first line of the previous chunk
    while (end > 0 && size - end < MAX) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, end - start, start);
      const text = buf.toString('utf-8') + carry;
      const lines = text.split(/\r?\n/);
      // The first line may be cut at `start`; keep it for the next chunk.
      carry = start > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"turn_context"')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'turn_context' && ev.payload) return ev.payload;
        } catch {
          /* not a complete line; keep scanning */
        }
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export async function nameCodexThread(threadId, name) {
  const [res] = await appServer([{ method: 'thread/name/set', params: { threadId, name } }]);
  if (res?.error) {
    throw Object.assign(new Error(`Could not name thread ${threadId}: ${JSON.stringify(res.error)}`), { code: 'APPSERVER_ERROR' });
  }
  return true;
}

// libuv quotes native Windows argv: embedded quotes and adjacent/trailing
// backslashes expand on the command line. Count UTF-16 units, not code points.
function windowsArgumentLength(value) {
  const arg = String(value);
  let length = arg.length + 2;
  let slashes = 0;
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] === '\\') {
      slashes++;
      continue;
    }
    if (arg[i] === '"') length += slashes + 1;
    slashes = 0;
  }
  return length + slashes;
}

// `codex queue` injects a user turn into a live session: immediately when it is
// idle, otherwise once the current turn finishes.
export async function deliverToCodex({ thread, text, recoverClientId = true }) {
  // queue has no stdin/file input flag. A shim therefore gets only a fixed
  // read-file notice; the peer reads the exact body without cmd expansion.
  // Keep the file after the CLI exits: the target may still be mid-turn.
  const bin = resolveBin('codex');
  const viaCmd = isWin && /\.(cmd|bat)$/i.test(bin);
  const oversized = isWin
    ? [bin, 'queue', '--thread', thread, '--message', text].reduce((size, arg) => size + windowsArgumentLength(arg) + 1, 0) > MAX_QUEUE_INLINE
    : text.length > MAX_QUEUE_INLINE;
  if (viaCmd || oversized) {
    const dir = join(magiHome(), 'spill');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.queue.md`);
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    text = `Read the complete peer message from this file: ${path}`;
  }
  try {
    // The CLI receipt proves persistence, not consumption. Its public output
    // omits clientId; recover it from the acknowledged queue row when readable.
    const { stdout } = await runCodex(['queue', '--thread', thread, '--message', text]);
    const m = /Queued message (\S+?) for thread (\S+?)\./.exec(stdout ?? '');
    if (!m) throw Object.assign(new Error('codex queue returned no recognized receipt; delivery is unconfirmed.'), { code: 'DELIVERY_UNCONFIRMED', dispatchUncertain: true });
    const receipt = { messageId: m[1], threadId: m[2] };
    // Replies return the write receipt immediately; only requests opt into lookup.
    if (!recoverClientId) return receipt;
    let timer;
    try {
      const rows = await Promise.race([
        codexQueueList(receipt.threadId),
        new Promise((resolve) => { timer = setTimeout(() => resolve([]), 3000); }),
      ]);
      const item = rows.find((row) => row.id === receipt.messageId);
      if (typeof item?.clientUserMessageId === 'string' && item.clientUserMessageId) receipt.clientId = item.clientUserMessageId;
    } catch { /* A persisted message must never be resent after a lookup failure. */ }
    finally { clearTimeout(timer); }
    return receipt;
  } catch (e) {
    if (/No active session found/i.test(e.stderr ?? e.message ?? '')) {
      throw Object.assign(
        new Error(
          `No live Codex session named "${thread}". Open one and name it, or run "magi peers" to see what is reachable. ` +
            'Falling back to a headless Codex peer loses the session context.',
        ),
        { code: 'NO_LIVE_PEER', fallback: true, dispatchUncertain: false },
      );
    }
    throw e;
  }
}

// Argv has hard length limits on Windows; oversized bodies go via a file.
export const MAX_QUEUE_INLINE = 24000;

// --- override delivery into a live Codex thread ------------------------------
//
// `codex queue` writes a row the target picks up only when it next goes idle.
// The user needs the opposite: reach a thread that is mid-turn, the way Codex's
// own agent-to-agent send does. The only external channel that does this is the
// desktop app's `codex_app` MCP tool `send_message_to_thread`, which injects the
// message into the running turn as a <codex_delegation> item. Verified 2026-09-08:
// two sends landed inside an active turn with no queue row created.
//
// Cost, and why this is opt-in only:
//  - It exists only while the Codex DESKTOP app is running; the pipe is a random
//    per-instance name with no config entry, so it is discovered by reading the
//    app-server process's own command line. CLI-only Codex has no such channel.
//  - The tool requires an existing thread id as the caller (`_meta`), so at the
//    protocol level the message is delegation from a Codex thread. We claim the
//    target itself (self-delegation), the least-borrowed identity; the honest
//    magi sender stays in the body text.
//  - The pipe trusts the claimed caller, so it is spoofable by any local process.
//    Magi runs as the same user, so it grants itself nothing new, but nothing
//    here should be read as an authenticated identity.

// Parse pipe path, plugin cwd and node path out of a codex app-server command
// line. Exported pure so the parser is testable without a live desktop app.
export function parseAppToolsEnv(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.includes('mcp_servers.codex_app=')) return null;
  const grab = (key) => {
    const m = new RegExp(`${key}\\\\"=\\\\"(.*?)\\\\"`).exec(commandLine);
    return m ? m[1].replace(/\\\\/g, '\\') : null;
  };
  const pipe = grab('CODEX_APP_TOOLS_PIPE_PATH');
  const cwd = grab('cwd');
  if (!pipe || !cwd) return null;
  return { pipe, cwd, node: grab('CODEX_MCP_NODE_PATH') };
}

// Find the running desktop app-server and return its app-tools launch config.
const DISCOVERY_TIMEOUT_MS = 5000;

export async function findAppTools() {
  // Process enumeration must be bounded: a hung ps/powershell would stall the
  // whole steer before the send timer ever starts. Kill it after a few seconds.
  const common = { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, timeout: DISCOVERY_TIMEOUT_MS, windowsHide: true };
  let lines = [];
  try {
    const out = isWin
      ? execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mcp_servers.codex_app=*' } | ForEach-Object { $_.CommandLine }"], common)
      : execFileSync('ps', ['-eww', '-o', 'args='], common);
    lines = out.split(/\r?\n/);
  } catch {
    // A timeout, a missing enumerator, or a spawn error all mean the channel
    // could not be discovered; the caller turns this into NO_STEER_CHANNEL.
    return null;
  }
  for (const line of lines) {
    const env = parseAppToolsEnv(line);
    if (env) return env;
  }
  return isWin ? probeAppToolsPipe() : null;
}

// Desktop 26.915 (app-server with pluginMcpConfigOverrides) no longer inlines
// the config: it enables the bundled codex-app-tools plugin by flag and passes
// the pipe only in the app-server's environment. On Windows 26.915 names that
// pipe with its browser-use prefix, `\\.\pipe\codex-browser-use-<uuid>`, beside
// real browser-use pipes; 26.1023 gives it a directory of its own,
// `\\.\pipe\codex-app-tools` (read in its main bundle, not seen live: the
// desktop was not running). So both prefixes are candidates, each is asked for
// its tool list, and the one offering the steer tool wins. The plugin's own
// server.mjs does the talking, as before. ponytail: macOS names it
// `<dir>/<uuid>.sock` and is not probed; read the env var off the app-server
// there if it is ever needed.
export const APP_TOOLS_PIPE_PREFIXES = ['codex-app-tools-', 'codex-browser-use-'];

export async function probeAppToolsPipe() {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  let cwd, pipes;
  try {
    const ver = readdirSync(root).filter((v) => existsSync(join(root, v, 'server.mjs'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (!ver) return null;
    cwd = join(root, ver);
    pipes = readdirSync('\\\\.\\pipe\\').filter((n) => APP_TOOLS_PIPE_PREFIXES.some((prefix) => n.startsWith(prefix))).map((n) => `\\\\.\\pipe\\${n}`);
  } catch {
    return null;
  }
  const hits = await Promise.all(pipes.map((pipe) => appToolListsSteer({ node: null, cwd, pipe })));
  const pipe = pipes.find((_, i) => hits[i]);
  return pipe ? { pipe, cwd, node: null } : null;
}

// The one desktop tool this adapter is ever allowed to call. Keeping it a
// constant, not a parameter, is deliberate: the pipe exposes 35 tools including
// archive, fork and handoff, and nothing here should reach past messaging.
const STEER_TOOL = 'send_message_to_thread';
const STEER_MAX_STDOUT = 4 * 1024 * 1024;

// One `send_message_to_thread` call to the desktop app-tools server over its
// pipe. Bounds output and time; surfaces a start failure, an early exit, a
// JSON-RPC error, and an MCP tool-result isError alike, so a failure is never
// read as success.
export function appToolSend(env, args, meta, opts) {
  return appToolSession(
    env,
    async (send) => {
      const r = await send('tools/call', { name: STEER_TOOL, arguments: args, _meta: meta });
      if (r.error) throw Object.assign(new Error(r.error.message ?? JSON.stringify(r.error)), { code: 'STEER_FAILED' });
      // An MCP tool can report failure in the result, not only as a JSON-RPC
      // error; a fake server proved this can look like success otherwise.
      if (r.result?.isError) {
        const t = (r.result.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 300);
        throw Object.assign(new Error(`desktop app-tools reported an error: ${t || 'isError'}`), { code: 'STEER_FAILED' });
      }
      // A valid MCP tool result is an object with a content array. A missing,
      // null or malformed result must not resolve as if the send succeeded.
      if (!r.result || !Array.isArray(r.result.content)) {
        throw Object.assign(new Error('desktop app-tools returned no valid tool result.'), { code: 'STEER_FAILED' });
      }
      return r.result;
    },
    opts,
  );
}

// Does this pipe carry the steer tool? A read-only tools/list, used only for
// discovery; any failure means "not this pipe".
export function appToolListsSteer(env, { timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  return appToolSession(env, async (send) => (await send('tools/list', {})).result?.tools?.some((t) => t.name === STEER_TOOL) === true, { timeoutMs }).catch(() => false);
}

// Start the plugin's own server.mjs against `pipe`, initialize, then hand
// `step` a request function; its return value resolves the session.
function appToolSession({ node, cwd, pipe }, step, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    (() => {
      let p;
      try {
        p = spawn(node ?? process.execPath, [join(cwd, 'server.mjs')], {
          cwd,
          env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipe },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch (e) {
        reject(Object.assign(new Error(`Could not start desktop app-tools: ${e.message}`), { code: 'NO_STEER_CHANNEL', dispatchUncertain: false }));
        return;
      }
      const pending = new Map();
      let buf = '';
      let bytes = 0;
      let id = 0;
      let settled = false;
      let dispatchUncertain = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        if (fn === reject) v.dispatchUncertain = dispatchUncertain;
        clearTimeout(timer);
        try {
          p.kill();
        } catch {
          /* already gone */
        }
        fn(v);
      };
      const fail = (code, msg) => done(reject, Object.assign(new Error(msg), { code }));
      const timer = setTimeout(() => fail('STEER_TIMEOUT', 'desktop app-tools did not respond in time.'), timeoutMs);
      const send = (method, params) =>
        new Promise((res) => {
          const myId = ++id;
          pending.set(myId, res);
          const line = JSON.stringify({ jsonrpc: '2.0', method, id: myId, params }) + '\n';
          if (method === 'tools/call') dispatchUncertain = true;
          p.stdin.write(line);
        });
      p.on('error', (e) => fail('NO_STEER_CHANNEL', `Could not start desktop app-tools: ${e.message}`));
      p.stdin.on('error', () => fail('STEER_FAILED', 'desktop app-tools closed its input.'));
      p.on('exit', (code) => {
        if (pending.size) fail('STEER_FAILED', `desktop app-tools exited before replying (code ${code}).`);
      });
      p.stdout.on('data', (d) => {
        bytes += d.length;
        if (bytes > STEER_MAX_STDOUT) {
          fail('STEER_FAILED', 'desktop app-tools produced too much output.');
          return;
        }
        buf += d.toString();
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id !== undefined && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        }
      });
      (async () => {
        const init = await send('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'magi', version: '0.1.0' }, capabilities: {} });
        if (init.error) throw Object.assign(new Error(JSON.stringify(init.error)), { code: 'NO_STEER_CHANNEL' });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        done(resolve, await step(send));
      })().catch((e) => done(reject, e));
    })();
  });
}

// Deliver into a live Codex thread mid-turn, bypassing the queue. `thread` must
// be a thread id (the desktop tool addresses by id, not name). Throws
// NO_STEER_CHANNEL when the desktop app is not running; the caller decides
// whether to surface that or, only for an implicit auto path, fall back. An
// explicit steer never silently downgrades.
//
// The caller is always the recipient itself (self-relay). No arbitrary source
// thread is accepted: borrowing another thread's id would neither authenticate
// Claude nor be honest. The real sender is named in the message body.
//
// The tool answers only {threadId} (desktop 26.930, docs/transport-recon.md),
// so the receipt is a per-send marker in the text plus the thread's
// rollout_ordinal from before the send; codexSteerState finds it afterwards.
// The marker is a bare token: the stored copy is XML-escaped, which would
// break an HTML comment around it.
export async function deliverToCodexSteer({ thread, text }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread)) {
    throw Object.assign(new Error('Override delivery needs the target thread id (a uuid), not a name.'), { code: 'STEER_NEEDS_ID', dispatchUncertain: false });
  }
  const env = await findAppTools();
  if (!env) {
    throw Object.assign(new Error('No Codex desktop app-tools channel found; override needs the Codex desktop app running.'), { code: 'NO_STEER_CHANNEL', dispatchUncertain: false });
  }
  const marker = `magi-delivery:${randomUUID()}`;
  const cursor = await codexThreadCursor(thread);
  await appToolSend(env, { threadId: thread, prompt: `${text}\n\n${marker}` }, { threadId: thread });
  return { messageId: null, threadId: thread, target: thread, marker, cursor, via: 'steer', deliveryStatus: 'accepted' };
}

// Every Codex steer: `turn/steer` through this machine's shared app-server
// daemon when it holds the thread (a terminal Codex runs there at 0.163.0),
// else the desktop tool above. The daemon receipt carries the
// clientUserMessageId the history records, which confirmCodex joins on like a
// queued message's.
export async function steerCodexThread({ thread, text }, { daemon = steerLocalDaemon, desktop = deliverToCodexSteer } = {}) {
  const loaded = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread) ? await daemon({ thread, text }) : null;
  if (loaded) return { messageId: loaded.clientId, threadId: loaded.threadId, target: loaded.threadId, turnId: loaded.turnId, clientId: loaded.clientId, via: 'steer:daemon', deliveryStatus: 'accepted' };
  try {
    return await desktop({ thread, text });
  } catch (e) {
    if (e.code === 'NO_STEER_CHANNEL') e.message += ' This machine\'s Codex app-server daemon does not hold the thread either. Send it with delivery:"live" instead.';
    throw e;
  }
}

// --- Shim agents: registry and inbox in the shared SQLite database ----------
// The installed extension owns records/agents rows and claims queued frames.

// Heartbeat age is diagnostic, not proof that a live process exited.
export const HEARTBEAT_STALE_MS = 30_000;


// `observe`: a registry that cannot be read is an error, not an empty listing
// (see listClaudeSessions).
export function listAgentSessions(agent, { includeDead = false, includeHelpers = false, observe = false } = {}) {
  let rows;
  try { rows = statement(magiHome(), "SELECT key,value,updated_at FROM records WHERE namespace='agents'").all(); }
  catch (e) { if (observe) throw e; return []; }
  const out = [];
  for (const row of rows) {
    let d;
    try { d = JSON.parse(row.value); } catch { continue; }
    if (!d || (agent && d.agent !== agent) || !Number.isInteger(d.pid)) continue;
    // The signal check is free; the birth-time read is a process spawn
    // (PowerShell on Windows), worth paying only for a pid that is running.
    const running = alive(d.pid);
    const birth = running ? processStartedAt(d.pid) : null;
    // A running process whose birth time could not be read just now (ps or
    // PowerShell timed out) is not known to have exited: an observer gets an
    // error, not a listing without it, and its row is left alone.
    if (observe && running && typeof d.processStartedAt === 'string' && birth === null) {
      throw Object.assign(new Error(`could not read the start time of pid ${d.pid}; its session is neither confirmed nor gone`), { code: 'IDENTITY_UNAVAILABLE' });
    }
    const live = running && typeof d.processStartedAt === 'string' && birth !== null && birth === d.processStartedAt;
    const heartbeatStale = Boolean(d.heartbeat) && Date.now() - row.updated_at >= HEARTBEAT_STALE_MS;
    if (!live) {
      // An exited process, mismatched birth marker or unverifiable legacy row
      // cannot own an inbox. A running extension will republish its own row.
      if (!includeDead) {
        try { removeRecord(magiHome(), 'agents', row.key); } catch { /* another reader got it */ }
        continue;
      }
    }
    const tail = d.agent === 'omp' && d.name == null && d.sessionFile ? tailLines(d.sessionFile, 256 * 1024).lines : [];
    const head = d.agent === 'omp' && d.name == null && d.sessionFile ? headLines(d.sessionFile).lines : [];
    out.push({
      agent: d.agent,
      pid: d.pid,
      processStartedAt: d.processStartedAt ?? null,
      sessionId: d.sessionId ?? null,
      sessionAliases: Array.isArray(d.sessionAliases) ? d.sessionAliases : [],
      parentSession: d.parentSession ?? null,
      name: d.name ?? titleFrom(tail) ?? titleFrom(head),
      sessionFile: d.sessionFile ?? null,
      cwd: d.cwd ?? null,
      approvalMode: d.approvalMode ?? null,
      startedAt: d.startedAt ?? null,
      live,
      heartbeatStale,
      // A shim that reports busy/idle writes them itself; an older one leaves
      // them unset and reads as unknown.
      status: typeof d.status === 'string' ? d.status : null,
      // What it waits on while a tool waits on its user's approval (the omp
      // extension's tool_approval_* handlers); peerState reads it as blocked.
      waitingFor: typeof d.waitingFor === 'string' && d.waitingFor ? d.waitingFor : null,
      statusAt: d.statusUpdatedAt ?? null,
    });
  }
  return includeHelpers ? out : out.filter((s) => !s.parentSession);
}

// Written to the session's inbox; the extension inside it turns the frame into
// a user turn. `deliverAs` follows omp's own vocabulary: "aside" lands at the
// next step boundary without cancelling the running tool, "steer" interrupts.
let inboxSeq = 0;
export function deliverToAgentInbox({ target, text, deliverAs = 'aside', sender }) {
  if (!alive(target.pid) || !target.processStartedAt || processStartedAt(target.pid) !== target.processStartedAt) {
    throw Object.assign(new Error(`The ${target.agent} session (pid ${target.pid}) is no longer the registered process. Refresh kind:"peers" and select a live session.`), { code: 'NO_LIVE_PEER', dispatchUncertain: false });
  }
  // created_at and id preserve sender order, including same-millisecond writes.
  const id = `${Date.now().toString(36)}-${(inboxSeq++).toString(36).padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
  const frame = { id, text, deliverAs, from: sender ? { agent: sender.agent, id: sender.id ?? sender.sessionId ?? null, name: sender.name ?? null } : null, at: Date.now() };
  try {
    transaction(magiHome(), () => statement(magiHome(), "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)")
      .run(target.pid, id, JSON.stringify(frame), frame.at));
  } catch (error) {
    error.dispatchUncertain = false;
    throw error;
  }
  return { messageId: id, pid: target.pid };
}

// Codex core attaches the calling thread to every MCP tool call as request
// metadata (core/src/mcp_tool_call.rs: `threadId`, `callId`, and
// "X-Codex-Turn-Metadata" = {thread_id, turn_id}); its own desktop tools read
// the same keys. That is the native, model-independent answer to "who called".
// One parser for the caller metadata (src/mcp-caller.mjs): every alias Codex
// uses must agree, and two different ids fail closed with ORIGIN_MISMATCH.
export function codexThreadFromMeta(meta) {
  return codexCaller(meta).threadId;
}

export function ownAgentSession(agent, sessions = listAgentSessions(agent, { includeHelpers: true })) {
  return sessions.find((s) => s.pid === process.ppid)
    ?? (sessions.length ? callerAncestors().map((pid) => sessions.find((s) => s.pid === pid)).find(Boolean) : null);
}

export async function resolveOrigin(agent, { from, cwd, meta } = {}) {
  const result = (target, replyTo, source) => ({
    target: { ...target, identityVerified: source !== 'model_claim', identitySource: source },
    replyTo, identityVerified: source !== 'model_claim', identitySource: source,
  });
  const mismatch = () => { throw Object.assign(new Error(`from="${from}" is not the calling ${agent} session. Omit from; replies go to the runtime caller.`), { code: 'ORIGIN_MISMATCH' }); };
  if (agent === 'codex') {
    const caller = codexCaller(meta);
    const native = caller.threadId;
    let detail = null;
    if (native) {
      // Root identity legitimately differs for a subagent; it is only a reply fallback.
      if (from && from !== native) {
        try { detail = await readCodexThread(native); } catch { /* compare exact id */ }
        if (from !== detail?.name) mismatch();
      }
      return result({ agent, id: native, rootSessionId: caller.sessionId, cwd, name: detail?.name ?? null }, `codex:${native}`, 'mcp_request_meta');
    }
    if (!from) return null;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(from)) {
      let matches = [];
      try { matches = (await listCodexThreads({ cwd })).filter((t) => t.id === from || t.name === from); }
      catch { /* a name without runtime metadata remains an unverified claim */ }
      if (matches.length > 1) throw Object.assign(new Error(`Sender "${from}" resolves to ${matches.length} Codex tasks; pass an exact id or omit from.`), { code: 'AMBIGUOUS_ORIGIN' });
      detail = matches[0] ?? null;
    }
    const id = detail?.id ?? from;
    return result({ ...detail, agent, id, cwd }, `codex:${id}`, 'model_claim');
  }
  if (agent !== 'claude') {
    const sessions = listAgentSessions(agent, { includeHelpers: true });
    const parent = ownAgentSession(agent, sessions);
    const matches = (s) => s.sessionId === from || s.sessionAliases.includes(from) || s.name === from || String(s.pid) === from;
    if (parent) {
      if (from && !matches(parent)) mismatch();
      return result({ ...parent, id: parent.sessionId ?? String(parent.pid), cwd: parent.cwd ?? cwd }, `${agent}:${parent.pid}`, 'pid_registry');
    }
    if (!from) return null;
    const claims = sessions.filter(matches);
    if (claims.length > 1) throw Object.assign(new Error(`Sender "${from}" is ambiguous; omit from.`), { code: 'AMBIGUOUS_ORIGIN' });
    const target = claims[0] ?? { agent, id: from, sessionId: from, cwd };
    return result(target, target.pid ? `${agent}:${target.pid}` : null, 'model_claim');
  }
  const sessions = listClaudeSessions({ includeUnaddressable: true });
  const own = ownClaudeInbox();
  const socketCandidate = own && sessions.find((s) => s.socket === own.socket);
  const direct = sessions.find((s) => s.pid === process.ppid);
  const ancestors = !sessions.length ? [] : (socketCandidate && socketCandidate.pid !== process.ppid) || !direct ? callerAncestors() : [process.ppid];
  const socketRow = socketCandidate && ancestors.includes(socketCandidate.pid) ? socketCandidate : null;
  const parentRow = direct ?? ancestors.map((pid) => sessions.find((s) => s.pid === pid)).find(Boolean);
  const spawnId = process.env.CLAUDE_CODE_SESSION_ID;
  const target = socketRow ?? parentRow ?? (spawnId ? { agent, sessionId: spawnId, spawnSessionId: spawnId, cwd } : null);
  if (target) {
    if (from && ![target.sessionId, target.name, String(target.pid)].includes(from)) mismatch();
    return result({ ...target, id: target.sessionId }, target.socket ? `uds:${target.socket}` : null, socketRow ? 'messaging_socket_registry' : parentRow ? 'pid_registry' : 'spawn_session_env');
  }
  if (!from) return null;
  const claims = sessions.filter((s) => s.sessionId === from || s.name === from || String(s.pid) === from);
  if (claims.length > 1) throw Object.assign(new Error(`Sender "${from}" is ambiguous; omit from.`), { code: 'AMBIGUOUS_ORIGIN' });
  const claim = claims[0] ?? { agent, sessionId: from, cwd };
  return result({ ...claim, id: claim.sessionId }, claim.socket ? `uds:${claim.socket}` : null, 'model_claim');
}

// --- one route, one dispatch ------------------------------------------------
//
// A target is a session description with an `agent` field: a Claude session
// (`sessionId`, `socket`), a Codex thread (`id`, or `name`), or a shim-agent
// registry entry (`pid`). It is what `resolveOrigin` returns as `target`, what
// the ledger stores as `orchestratorTarget` and `peerTarget`, and the one
// thing anything that wants to reach a session hands to `deliverTo`.

// The recorded origin of a task, as a target. Tasks written before the origin
// was recorded as an object carry only a `replyTo` string; it still resolves.
export function originOf(task) {
  const o = task.orchestratorTarget;
  if (o) return o.agent === task.orchestrator ? o : null;
  const r = typeof task.replyTo === 'string' ? task.replyTo : '';
  if (task.orchestrator === 'codex' && r.startsWith('codex:')) return { agent: 'codex', id: r.slice(6) };
  if (task.orchestrator === 'claude' && r.startsWith('uds:')) return { agent: 'claude', socket: r.slice(4) };
  const m = /^([a-z][a-z0-9_-]*):(\d+)$/.exec(r);
  if (m && m[1] === task.orchestrator) return { agent: m[1], pid: Number(m[2]) };
  return null;
}

// Reach a target now, by whatever its harness accepts. A Claude session is
// re-read from the registry so a stale socket is refused rather than written
// to; a shim agent likewise. A Codex thread is addressed by id or name and the
// queue arbitrates. Throws NO_REPLY_ROUTE when the session is gone.
// `steer` reaches the session mid-turn instead of at its next idle or step
// boundary: the shared daemon or desktop app-tools pipe for Codex, a steer frame for a shim
// agent. A Claude session has no such channel and is refused, not queued.
export async function deliverTo(target, text, { sender, deliverAs, steer = false } = {}) {
  if (!target?.agent) throw Object.assign(new Error('The originating session address is missing; the reply stays in the mailbox.'), { code: 'NO_REPLY_ROUTE' });
  // The human at a pane has no session to write into: the mailbox the reply
  // was just filed in is where they read it.
  if (target.agent === 'codex') {
    const thread = target.id ?? target.name;
    if (!thread) throw Object.assign(new Error('The originating Codex thread has no id; the reply stays in the mailbox.'), { code: 'NO_REPLY_ROUTE' });
    try {
      // Replies never wait on confirmation; the fleet poll upgrades the state.
      if (steer) return await steerCodexThread({ thread, text });
      const receipt = await deliverToCodex({ thread, text, recoverClientId: false });
      return { ...receipt, target: receipt.threadId, deliveryStatus: receipt.clientId ? 'queued_unread' : 'unconfirmed' };
    } catch (error) {
      if (error.code !== 'NO_LIVE_PEER' || !target.rootSessionId || target.rootSessionId === thread) throw error;
      if (steer) return steerCodexThread({ thread: target.rootSessionId, text });
      const receipt = await deliverToCodex({ thread: target.rootSessionId, text, recoverClientId: false });
      return { ...receipt, target: receipt.threadId, deliveryStatus: receipt.clientId ? 'queued_unread' : 'unconfirmed' };
    }
  }
  if (target.agent === 'claude') {
    if (steer) throw Object.assign(new Error('A Claude session has no steer channel; its inbox already lands at the next step boundary. Send without steer.'), { code: 'STEER_UNSUPPORTED' });
    const live = listClaudeSessions().find((s) => s.socket && (target.sessionId ? s.sessionId === target.sessionId : s.socket === target.socket));
    if (!live) throw Object.assign(new Error('The originating Claude session is unavailable; the reply stays in the mailbox.'), { code: 'NO_REPLY_ROUTE' });
    return deliverToClaude({ target: live, text, from: null, sender });
  }
  const ids = [target.sessionId, target.id !== String(target.pid) ? target.id : null, ...(target.sessionAliases ?? [])].filter(Boolean);
  const live = listAgentSessions(target.agent, { includeHelpers: true }).find((s) => ids.length
    ? [s.sessionId, ...s.sessionAliases].some((id) => ids.includes(id))
    : s.pid === target.pid && (!target.processStartedAt || s.processStartedAt === target.processStartedAt));
  if (!live) throw Object.assign(new Error(`The originating ${target.agent} session has exited; the reply stays in the mailbox.`), { code: 'NO_REPLY_ROUTE' });
  const marker = `magi-delivery:${randomUUID()}`;
  const sessionFile = live.sessionFile;
  const cursor = deliveryCursor(sessionFile);
  const receipt = deliverToAgentInbox({ target: live, text: `${text}\n<!-- ${marker} -->`, deliverAs: steer ? 'steer' : deliverAs, sender });
  return { ...receipt, target: live, marker, cursor, sessionFile, deliveryStatus: 'queued_unread' };
}

// Both the MCP reply and the CLI fallback return to the recorded origin.
// Never substitute another session merely because it shares a directory.
export async function deliverReplyToOrigin({ text, task, sender, steer = false }) {
  // The replying peer, so the orchestrator's user sees "Message from
  // @codex:<thread>" rather than "unknown".
  const pt = task.peerTarget;
  const who = sender ?? { agent: task.peer, name: typeof pt === 'string' ? pt : pt?.name ?? null };
  return deliverTo(originOf(task), text, { sender: who, steer });
}

// Turning off the reverse bridge in a spawned Codex peer.
//
// `-c mcp_servers.<name>.enabled=false` MERGES into the config, so naming a
// server that is not defined creates a table with no command and Codex then
// refuses to start with "invalid transport". The override is therefore emitted
// only for sections that actually exist. `-c mcp_servers={}` does not help: it
// merges too, and leaves every server enabled.
// `claude` is the pre-rename server name, kept for configs that still have it.
export function codexDisableBridgeFlags(serverNames = ['magi', 'magi-omp', 'claude']) {
  const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const flags = [];
  for (const name of serverNames) {
    if (new RegExp(`^\\s*\\[mcp_servers\\.${name}\\]`, 'm').test(text)) {
      flags.push('-c', `mcp_servers.${name}.enabled=false`);
    }
  }
  return flags;
}
