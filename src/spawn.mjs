// Start a live, named peer session the user can see and other agents can
// address. The bridge owns no terminal. Two surfaces per harness:
//
// - a terminal: Claude as a background session (`claude --bg --name`, 2.1.263:
//   it registers in the session registry within seconds and outlives any
//   terminal) attached in a Windows Terminal tab of one window named "magi";
//   Codex and omp directly as a tab (no background mode), refused without wt;
// - the harness's desktop app (`app: true`): the app's own URL scheme opens a
//   new session on the folder with the bootstrap prompt prefilled; the human
//   sends it. Claude desktop 2.110 (`claude://code/new?folder&q`) and Codex
//   desktop 26.908 (`codex://threads/new?path&prompt`), docs/transport-recon.md.
//
// A session the bridge opened is claimed only by correlation: every prompt
// starts with a marker, and a candidate is the session whose first human
// message carries it. Nothing is claimed for being new. A launch that is not
// correlated by the deadline is a pending result, not an error; `spawnId`
// on a later call claims it without launching anything.
// ponytail: Windows Terminal only for tabs; macOS/Linux launchers when
// someone runs this there.
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, resolveBin, runCli, spawnCli } from './exec.mjs';
import { listCodexThreads, nameCodexThread, claudeTranscriptPath, claudeAppLink } from './transport.mjs';
import { firstUserMessage } from './session-tail.mjs';
import { codexFirstUserMessage } from './codex-history.mjs';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WINDOW = 'magi';
export const REGISTER_TIMEOUT_MS = 20_000;
// The app never sends on its own (Step 0, 2026-09-16: both apps prefill and
// wait), so an app launch waits only long enough for a human who is right
// there to press Enter; past that the answer is pending, not a longer wait.
export const APP_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const MARKER = 'magi-spawn:';

// The command each harness starts with, as an interactive session in cwd.
// `permissionMode` and `model` are the user's choices passed through
// verbatim: Claude's --permission-mode / --model, omp's --approval-mode /
// --model, Codex's -m and, for the mode, -s for a sandbox word or -a for an
// approval policy. The bridge adds no --dangerously-* flag, ever. Codex
// takes the bootstrap prompt as its [PROMPT] positional so a tab thread is
// correlated like an app one.
export function spawnCommand({ harness, name, permissionMode, model, prompt }) {
  const mode = permissionMode ? [permissionMode] : [];
  const m = model ? [model] : [];
  if (harness === 'claude') return ['claude', '--name', name, ...(mode.length ? ['--permission-mode', ...mode] : []), ...(m.length ? ['--model', ...m] : [])];
  if (harness === 'codex') {
    const sandbox = ['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode);
    return ['codex', ...(mode.length ? [sandbox ? '-s' : '-a', ...mode] : []), ...(m.length ? ['-m', ...m] : []), ...(prompt ? [prompt] : [])];
  }
  if (harness === 'omp') return ['omp', ...(mode.length ? ['--approval-mode', ...mode] : []), ...(m.length ? ['--model', ...m] : [])];
  throw new BridgeError('BAD_REQUEST', `Cannot spawn "${harness}". Use claude, codex or omp.`);
}

// The bootstrap prompt: the marker first, then one line. The folder is never
// in it; that is the URL's own parameter.
export function bootstrapPrompt(spawnId, name) {
  return `${MARKER}${spawnId} You are the Magi peer "${name}". Wait for PEER REQUEST or PEER TURN messages and answer them; do not start work on your own.`;
}

// The deep link each app opens a new session with. Built with URLSearchParams
// so a space, an ampersand or a non-ASCII character in the folder or the
// prompt arrives intact (checked live 2026-09-16, both apps).
export function appUrl({ harness, cwd, prompt }) {
  if (harness === 'claude') {
    const u = new URL('claude://code/new');
    u.searchParams.set('folder', cwd);
    u.searchParams.set('q', prompt);
    return u.toString();
  }
  if (harness === 'codex') {
    const u = new URL('codex://threads/new');
    u.searchParams.set('path', cwd);
    u.searchParams.set('prompt', prompt);
    return u.toString();
  }
  throw new BridgeError('SPAWN_UNSUPPORTED', `${harness} has no desktop app to open a session in; spawn it without app.`);
}

// Hand a URL to the OS: the scheme's registered handler opens it. Resolves
// when the launcher exits 0, which says the OS took the URL and no more;
// whether the app accepted the route is only ever established by
// correlation. Windows uses rundll32's FileProtocolHandler, no shell in
// between: `cmd /c start` splits a URL at every `&` and expands `%x%`
// (found in Step 0, 2026-09-16, when the app received only the part of the
// URL before the first `&`).
export function openUrl(url) {
  const p = platform();
  const [cmd, args] = p === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : p === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => rej(new BridgeError('SPAWN_FAILED', `The URL launcher (${cmd}) did not start: ${e.message}. Open it yourself: ${url}`)));
    // The launcher returns as soon as the handler is invoked; the app is not
    // our child. Stay referenced until then, or the event loop drains first.
    child.on('exit', (code) => (code === 0 ? res() : rej(new BridgeError('SPAWN_FAILED', `The URL launcher (${cmd}) exited ${code}; no app took ${url.split('?')[0]}. Is the app installed? Open it yourself: ${url}`))));
  });
}

function hasWt() {
  // WT_BIN names one explicitly (tests, or a non-standard install); otherwise
  // only Windows is searched.
  if (platform() !== 'win32' && !process.env.WT_BIN) return false;
  try {
    resolveBin('wt');
    return true;
  } catch {
    return false;
  }
}

// A directory that does not exist yet is a new project: make it and init git
// so the first request has a repo to snapshot.
function ensureProject(cwd) {
  if (!existsSync(cwd)) {
    mkdirSync(cwd, { recursive: true });
    try {
      execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore', windowsHide: true });
    } catch {
      /* no git: the peer still starts, reviews just have no diff to pin */
    }
    return true;
  }
  return false;
}

// A tab in the magi window running cmd in cwd. wt hands the tab to the
// terminal and returns; it is not detached, because a detached cmd.exe on
// Windows has no console and silently does nothing.
function openTab({ title, cwd, cmd }) {
  const [bin, ...args] = cmd;
  // wt reads an unescaped `;` anywhere in its command line as the start of
  // another wt command: the bootstrap prompt arrived cut at its first one, and
  // a model or mode value holding one would run as a command (checked against
  // wt on Windows 11, 2026-11-10). `\;` is wt's own escape for a literal one.
  const literal = (arg) => String(arg).replace(/;/g, '\\;');
  const child = spawnCli('wt', ['-w', WINDOW, 'new-tab', '--title', literal(title), '-d', literal(cwd), literal(resolveBin(bin)), ...args.map(literal)], { stdio: 'ignore' });
  child.unref();
  return `tab "${title}" in the ${WINDOW} window`;
}

// 2.1.263 prints "backgrounded · <short id> · <name> (idle ...)"; the
// registry carries the same id as `jobId`.
async function startBackground({ cwd, cmd }) {
  const [bin, ...args] = cmd;
  const res = await runCli(bin, ['--bg', ...args], { cwd, timeoutMs: 30_000 });
  if (res.exitCode !== 0) throw new BridgeError('SPAWN_FAILED', `${bin} --bg exited ${res.exitCode}: ${res.stderr || res.stdout}`.trim());
  return /backgrounded\s+\S+\s+([0-9a-f]{6,})/.exec(res.stdout)?.[1] ?? null;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// The session's directory is the folder, or a worktree the app made under
// it: Claude desktop starts a new session in `<folder>/.claude/worktrees/<slug>`
// by default (observed 2026-09-16), and that worktree is where the peer works.
export function underDir(cwd, folder) {
  const a = norm(cwd);
  const b = norm(folder);
  return Boolean(a && b) && (a === b || a.startsWith(`${b}/.claude/worktrees/`));
}

const appLinkOf = (harness, s) => (harness === 'claude' ? claudeAppLink({ ...s, sessionId: s.sessionId ?? s.id }) : harness === 'codex' && s.id ? `codex://threads/${s.id}` : null);

// Codex is reached through the app-server and its history db; tests hand in
// fakes of the three calls, the real ones are the default.
export const codexIo = { list: (o) => listCodexThreads(o), name: (id, n) => nameCodexThread(id, n), first: (id) => codexFirstUserMessage(id) };

// Read the candidate's first human message; { ok, unreadable } where
// `unreadable` names a reason polling will not fix.
async function carries(harness, s, marker, codex) {
  const first = harness === 'codex' ? await codex.first(s.id) : firstUserMessage(claudeTranscriptPath({ sessionId: s.sessionId ?? s.id, cwd: s.cwd }) ?? '');
  if (first.text) return { ok: first.text.startsWith(marker) };
  return { ok: false, unreadable: first.reason === 'none' ? null : first.reason };
}

// One look at the candidates: the sessions in (or in a worktree under) cwd
// that were not there before the launch, then the one whose first human
// message carries the marker. Terminal Claude and omp are matched by name.
async function look({ harness, name, cwd, sessions, before, marker, codex }) {
  if (!marker) {
    const live = await sessions({ cwd });
    const hit = live.find((s) => s.name === name);
    return hit ? { hit: { id: hit.sessionId ?? hit.id ?? null, name: hit.name ?? null, pid: hit.pid ?? null, cwd: hit.cwd, jobId: hit.jobId ?? null } } : { hit: null };
  }
  let rows;
  try {
    rows = harness === 'codex' ? await codex.list({}) : await sessions({});
  } catch {
    return { hit: null };
  }
  const candidates = rows.filter((s) => underDir(s.cwd, cwd) && (harness !== 'claude' || s.entrypoint === 'claude-desktop') && !before?.has(s.id ?? s.sessionId));
  const hits = [];
  const unreadable = [];
  for (const s of candidates) {
    const c = await carries(harness, s, marker, codex);
    if (c.ok) hits.push(s);
    else if (c.unreadable) unreadable.push(`${s.id ?? s.sessionId} (${c.unreadable})`);
  }
  if (hits.length > 1) throw new BridgeError('SPAWN_AMBIGUOUS', `${hits.length} ${harness} sessions carry the marker ${marker}: ${hits.map((s) => s.id ?? s.sessionId).join(', ')}. Address the one you mean by id; nothing was named.`);
  if (!hits.length) return { hit: null, unreadable };
  const s = hits[0];
  return { hit: { id: s.id ?? s.sessionId ?? null, name: s.name ?? null, pid: s.pid ?? null, cwd: s.cwd, jobId: s.jobId ?? null, appLink: appLinkOf(harness, s) } };
}

// Name a claimed Codex thread; the observed name comes back whatever happens.
async function nameThread(hit, name, cwd, exceptId, codex) {
  const others = (await codex.list({}).catch(() => [])).filter((t) => t.id !== exceptId && underDir(t.cwd, cwd));
  if (others.some((t) => t.name === name)) throw new BridgeError('NAME_TAKEN', `Another codex thread in ${cwd} already answers to "${name}"; the one you opened is ${hit.id}. Address it by id, or resume with a different --name.`);
  try {
    await codex.name(hit.id, name);
    return name;
  } catch {
    return hit.name ?? null; // addressable by id either way; never the requested name as if it were set
  }
}

function pendingText({ harness, name, cwd, spawnId, unreadable }) {
  if (!spawnId) return `${harness} "${name}" has not registered yet. kind:"peers" lists it by name once it has.`;
  const resume = `magi spawn ${harness} --name ${name} --cwd "${cwd}" --resume ${spawnId} (or kind:"spawn" with spawnId and workingDirectory)`;
  if (unreadable?.length) return `A ${harness} session in ${cwd} could not be read for the marker: ${unreadable.join('; ')}. Retrying will not fix that; address it by id if it is yours.`;
  return `If the bootstrap prompt is still in the composer, send it. Then ${resume} claims it. Do not launch another session.`;
}

// Poll `look` until the deadline.
async function awaitRegistration({ deadlineMs, ...args }) {
  const deadline = Date.now() + deadlineMs;
  let last = { hit: null };
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    last = await look(args);
    if (last.hit) return last;
  }
  return last;
}

// Ready: { pending: false, spawnId?, harness, id, name, requestedName, cwd, where, appLink?, created, jobId? }
// Pending: { pending: true, spawnId?, harness, requestedName, cwd, where, next }
// Recovery (spawnId given): the ready shape without the launch-only fields, plus recovered: true.
export async function spawnPeer({ harness, name, cwd, permissionMode, model, app = false, spawnId, sessions, deadlineMs, openUrl: launch = openUrl, codex = codexIo }) {
  if (!NAME_RE.test(name ?? '')) throw new BridgeError('BAD_REQUEST', 'A peer name is 1-64 characters of a-z, 0-9, "_" or "-", starting with a letter or digit.');
  if (!['claude', 'codex', 'omp'].includes(harness)) throw new BridgeError('BAD_REQUEST', `Cannot spawn "${harness}". Use claude, codex or omp.`);
  cwd = resolve(cwd || process.cwd());

  // Recovery: claim a launch by its marker; nothing is started.
  if (spawnId) {
    if (harness === 'omp') throw new BridgeError('SPAWN_UNSUPPORTED', 'omp sessions carry no marker; find it with kind:"peers" by name.');
    const marker = `${MARKER}${spawnId}`;
    const { hit, unreadable } = await look({ harness, name, cwd, sessions, before: null, marker, codex });
    if (!hit) return { pending: true, spawnId, harness, requestedName: name, cwd, next: pendingText({ harness, name, cwd, spawnId, unreadable }) };
    const observed = harness === 'codex' ? await nameThread(hit, name, cwd, hit.id, codex) : hit.name;
    return { pending: false, spawnId, harness, id: hit.id, name: observed, requestedName: name, cwd: hit.cwd, appLink: hit.appLink ?? null, recovered: true };
  }

  // Validation order: surface, then settings, then the name, then launch.
  if (app && harness === 'omp') throw new BridgeError('SPAWN_UNSUPPORTED', 'omp has no desktop app; spawn it without app.');
  if (app && (permissionMode || model)) throw new BridgeError('BAD_REQUEST', `permissionMode and model cannot be passed through a desktop app's URL; the app applies its own. Drop them, or spawn ${harness} without app.`);
  const taken = harness === 'codex' ? (await codex.list({ cwd }).catch(() => [])).some((t) => t.name === name) : (await sessions({ cwd })).some((s) => s.name === name);
  if (taken) throw new BridgeError('NAME_TAKEN', `A live ${harness} session already answers to "${name}". Address it with peer:"${name}", or pick another name.`);
  const created = ensureProject(cwd);

  // Marker paths: the app for either harness, and a Codex tab (its prompt
  // positional). Terminal Claude is named at start; omp registers by name.
  const marked = app || harness === 'codex';
  const id = marked ? randomUUID() : null;
  const prompt = marked ? bootstrapPrompt(id, name) : null;
  const marker = marked ? `${MARKER}${id}` : null;
  const before = new Set((harness === 'codex' ? (await codex.list({}).catch(() => [])) : marked ? await sessions({}) : []).map((s) => s.id ?? s.sessionId));

  let where;
  let bgId = null;
  let command = null;
  if (app) {
    await launch(appUrl({ harness, cwd, prompt }));
    where = harness === 'claude' ? 'the Claude Code app' : 'the Codex app';
  } else {
    const cmd = spawnCommand({ harness, name, permissionMode, model, prompt });
    command = cmd.join(' ');
    const title = `${harness}:${name}`;
    if (harness === 'claude') {
      bgId = await startBackground({ cwd, cmd });
      where = hasWt() && bgId ? openTab({ title, cwd, cmd: ['claude', 'attach', bgId] }) : `background session ${bgId ?? ''}; open it with "claude attach ${bgId ?? '<id>'}"`;
    } else if (hasWt()) {
      where = openTab({ title, cwd, cmd });
    } else {
      throw new BridgeError('SPAWN_UNSUPPORTED', `Spawning ${harness} needs Windows Terminal (wt.exe) on PATH to open it in. Start it yourself: in ${cwd}, run "${cmd.join(' ')}"${harness === 'codex' ? ' and name the thread' : ''}.`);
    }
  }

  const { hit, unreadable } = await awaitRegistration({ deadlineMs: deadlineMs ?? (app ? APP_TIMEOUT_MS : REGISTER_TIMEOUT_MS), harness, name, cwd, sessions, before, marker, codex });
  if (!hit) return { pending: true, spawnId: id, harness, requestedName: name, cwd, where, created, next: pendingText({ harness, name, cwd, spawnId: id, unreadable }) };
  const observed = harness === 'codex' ? await nameThread(hit, name, cwd, hit.id, codex) : hit.name;
  return { pending: false, spawnId: id, harness, id: hit.id, name: observed, requestedName: name, pid: hit.pid ?? null, cwd: hit.cwd, where, appLink: hit.appLink ?? null, created, jobId: hit.jobId ?? null, bgId: hit.jobId ?? bgId, command };
}
