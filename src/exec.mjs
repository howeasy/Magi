// Headless fallback: spawn a fresh peer when no live session is reachable.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const isWin = platform() === 'win32';

export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_CHARS = 80000;
const DEFAULT_TIMEOUT_MS = 2400000; // 40 min

export class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// --- binary discovery ------------------------------------------------------

function pathCandidates(name) {
  const out = [];
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    for (const ext of exts) out.push(join(d, name + ext));
  }
  return out;
}

function knownCandidates(name) {
  const home = homedir();
  if (name === 'codex') {
    const out = [];
    const binRoot = join(home, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
    try {
      for (const d of readdirSync(binRoot)) out.push(join(binRoot, d, 'codex.exe'));
    } catch {
      /* not installed here */
    }
    out.push(join(home, '.local', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex');
    return out;
  }
  if (name === 'claude') {
    return [
      join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'),
      join(home, '.claude', 'local', isWin ? 'claude.exe' : 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
  }
  if (name === 'omp') {
    // Oh My Pi installs a single binary; its installer puts it here on Windows,
    // and `bun install -g` under Bun's global bin (the route the Mac took).
    return [join(home, 'AppData', 'Local', 'omp', 'omp.exe'), join(home, '.local', 'bin', 'omp'), join(home, '.bun', 'bin', isWin ? 'omp.exe' : 'omp'), '/usr/local/bin/omp', '/opt/homebrew/bin/omp'];
  }
  return [];
}

// The CLI paths `magi install` pinned into the harness configs, kept beside
// the state too (<MAGI_HOME>/bins.json), so a process no harness started (an
// ssh command: `magi worker`, `magi relay`, `magi doctor`) finds a CLI that is
// off its short non-interactive PATH, as an npm or Bun global usually is.
export const BINS_FILE = 'bins.json';
function recordedBin(envKey) {
  const home = process.env.MAGI_HOME || join(homedir(), '.magi');
  try {
    const path = JSON.parse(readFileSync(join(home, BINS_FILE), 'utf8'))?.[envKey];
    return typeof path === 'string' && path && existsSync(path) ? path : null;
  } catch { return null; }
}

const searched = new Map();

export function resolveBin(name) {
  const envKey = `${name.toUpperCase()}_BIN`;
  const override = process.env[envKey];
  if (override) {
    if (existsSync(override)) return override;
    throw new BridgeError('CLI_NOT_FOUND', `${envKey} points at ${override}, which does not exist. Correct the path or unset ${envKey}.`);
  }
  const tried = [];
  const recorded = recordedBin(envKey);
  for (const c of [...pathCandidates(name), ...(recorded ? [recorded] : []), ...knownCandidates(name)]) {
    tried.push(c);
    try {
      if (statSync(c).isFile()) return c;
    } catch (e) {
      // A Store app's execution alias (wt.exe under WindowsApps) is a reparse
      // point that stat (and so existsSync) refuses with EACCES; it launches.
      if (isWin && e.code === 'EACCES') {
        try {
          if (lstatSync(c).isSymbolicLink()) return c;
        } catch {
          /* not that either */
        }
      }
    }
  }
  searched.set(name, tried);
  throw new BridgeError(
    'CLI_NOT_FOUND',
    `Could not find the "${name}" executable. Install it, put it on PATH, or set ${envKey} to its full path.`,
    { searchedCount: tried.length, examples: tried.slice(0, 3) },
  );
}

// --- spawning --------------------------------------------------------------

const children = new Set();
export function killTrackedChildren() {
  for (const child of children) killTree(child);
}

export function killTree(child) {
  if (!isWin) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

const CMD_META = /([()\[\]%!^"`<>&|;, *?])/g;

function cmdText(arg) {
  const s = String(arg);
  if (/[%!\r\n\0]/.test(s)) {
    throw new BridgeError('CMD_UNSAFE_ARGUMENT', 'Windows .cmd arguments cannot contain %, ! or newlines. Pass message text through stdin or a file; use a native executable for shell-sensitive paths or names.');
  }
  return s;
}

// Escape for the native argv parser, then both cmd parses (launch and shim
// forwarding %*). Bodies still belong on stdin or in a file: percent
// expansion and multiline text cannot be quoted reliably.
export function quoteForCmd(arg) {
  const body = cmdText(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${body}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

const AUTH_RE =
  /not logged in|login required|unauthorized|invalid[ _-]?api[ _-]?key|authentication (failed|required)|failed to authenticate|oauth session expired|could not be refreshed|session expired|\b401\b/i;

// An auth failure does not always arrive on stderr with a non-zero exit: both
// CLIs can report it as an ordinary message on stdout. Checking the parsed body
// too is what stops it being handed back as though it were the peer's opinion.
export function looksLikeAuthFailure(text) {
  return AUTH_RE.test(text ?? '');
}

// Each harness signs in its own way, and a remedy for the wrong one sends the
// user to fix an account that was never the problem. omp: `omp login [PROVIDER]`
// and the provider's own key variable (omp 18.4.4, `omp login --help`).
const AUTH_FIX = {
  claude: 'Run "claude" once and sign in, or set ANTHROPIC_API_KEY.',
  codex: 'Run "codex login".',
  omp: 'Run "omp login" (or "omp login <provider>") for the provider its model uses, or set that provider\'s API key variable; "omp --help" lists them.',
};

export function authError(name, detail) {
  const fix = AUTH_FIX[String(name).replace(/\.exe$/i, '').split(/[\\/]/).pop()] ?? `Sign in to ${name} with its own login command.`;
  return new BridgeError('AUTH_REQUIRED', `${name} is not authenticated. ${fix}`, { detail: (detail ?? '').slice(0, 400) });
}

// omp prints one of these per MCP server the peer cannot start, on every
// headless run (the bridge's own servers exit inside a peer on purpose), so on
// a failed run they are all stderr holds and say nothing about why it failed.
const BENIGN_STDERR_RE = /^Warning: MCP server ".*" failed to connect: .*its tools are unavailable for this run\.?$/;

// `errors` is what the parser read out of the harness's own output (omp's
// error events, Claude's result envelope). It is the cause; stderr is the
// noise around it, so a run that failed with only the known warnings on
// stderr reports the parsed cause, or says that the cause was not captured.
export function classifyFailure(name, { stderr, exitCode, errors = [] }) {
  const lines = (stderr ?? '').split(/\r?\n/);
  const noise = (l) => BENIGN_STDERR_RE.test(l.trim());
  const kept = lines.filter((l) => !noise(l)).join('\n').trim();
  const dropped = lines.filter(noise).length;
  const text = [...errors, kept].filter(Boolean).join('; ');
  if (AUTH_RE.test(text)) return authError(name, text);
  const none = dropped ? `no error output beyond ${dropped} MCP "failed to connect" warning(s); the cause was not captured, re-run with the harness's own CLI to see it` : 'no stderr output';
  return new BridgeError('PEER_FAILED', `${name} exited with code ${exitCode}: ${text.slice(0, 800) || none}`);
}

export const HEARTBEAT_MS = 10000;

export function cancelledError(name) {
  return new BridgeError('CANCELLED', `${name} was cancelled and stopped. Check any partial work before sending a new request.`);
}

// The orchestrator asked for this worker to stop (kind "close" with stop). Not a
// failure of the worker: the round is closed by that request, so nothing reports it.
export function stoppedError(name) {
  return new BridgeError('STOPPED_BY_ORCHESTRATOR', `${name} was stopped at the orchestrator's request. Check any partial work before sending a new request.`);
}

export function timeoutError(name, limit) {
  return new BridgeError('TIMEOUT', `${name} did not finish within ${limit}ms and was stopped. Narrow the task, or raise timeoutMs (cap 60 minutes), and look at any partial work before retrying.`);
}

export function timeoutLimit(timeoutMs) {
  const limit = timeoutMs ?? Number(process.env.MAGI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(limit) || limit <= 0) throw new BridgeError('BAD_REQUEST', 'The CLI timeout must be a positive finite number.');
  return limit;
}

export function spawnCli(name, args, options = {}) {
  return spawnFile(resolveBin(name), args, options);
}

// Spawns a file by path. A .cmd or .bat on Windows goes through cmd.exe with
// the command line quoted for both of its parses; a node script (install
// records codex.js behind fnm's per-shell link) under this server's node,
// which needs neither a shebang nor node on PATH; anything else directly.
export function spawnFile(bin, args, options = {}) {
  if (/\.[cm]?js$/i.test(bin)) return spawn(process.execPath, [bin, ...args], { ...options, windowsHide: true });
  const viaCmd = isWin && /\.(cmd|bat)$/i.test(bin);
  const file = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const command = viaCmd ? [cmdText(bin).replace(CMD_META, '^$1'), ...args.map(quoteForCmd)].join(' ') : null;
  const argv = viaCmd ? ['/d', '/v:off', '/s', '/c', `"${command}"`] : args;
  return spawn(file, argv, { ...options, windowsHide: true, windowsVerbatimArguments: viaCmd });
}

// The worker's command as a launch wrapper must run it: an absolute file and
// its arguments, needing no shell and no PATH. A CLI that is really a node
// script (codex.js behind npm's shim or a `#!/usr/bin/env node` link) runs
// under this server's node, since a sandbox may have no node on its PATH. A
// Windows .cmd that is not npm's shim is passed as it is; the wrapper must be
// able to start a .cmd.
export function workerArgv(name, args) {
  const bin = resolveBin(name);
  const script = scriptBehind(bin);
  return script && runsUnderNode(script) ? [process.execPath, script, ...args] : [bin, ...args];
}

// A .js file is a node script unless its own `#!` line names another
// runtime: omp's cli.js is `#!/usr/bin/env bun` (it calls Bun.spawn), and
// node running it died at once on every wrapped omp run on the Mac
// (2026-10-23). Such a file starts as it resolved, as it does unwrapped, and
// the OS reads its `#!` line. A .cmd shim's script has none and stays node.
function runsUnderNode(script) {
  let first = '';
  try { first = readFileSync(script, 'utf8').slice(0, 200).split(/\r?\n/, 1)[0]; } catch { return true; }
  if (!first.startsWith('#!')) return true;
  const words = first.slice(2).trim().split(/\s+/);
  const prog = (words[0]?.split('/').pop() === 'env' ? words.find((w, i) => i > 0 && !w.startsWith('-')) : words[0]) ?? '';
  return /^node(js)?$/i.test(prog.split('/').pop());
}

function scriptBehind(bin) {
  let real = bin;
  try { real = realpathSync(bin); } catch { /* the path as resolved */ }
  if (/\.[cm]?js$/i.test(real)) return real;
  if (!isWin || !/\.(cmd|bat)$/i.test(bin)) return null;
  try {
    // npm writes `"%dp0%\node_modules\<pkg>\<bin>.js" %*` (older npm: %~dp0).
    const m = /"%~?dp0%?\\([^"]+?\.[cm]?js)"/i.exec(readFileSync(bin, 'utf8'));
    const script = m ? join(dirname(bin), m[1]) : null;
    return script && existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

// `<wrapper argv...> -- <worker argv...>`, spawned like any CLI.
function spawnWrapped(wrapper, name, args, options) {
  return spawnFile(wrapper[0], [...wrapper.slice(1), '--', ...workerArgv(name, args)], options);
}

// `wrapper`, an operator's launch wrapper argv (MAGI_WORKER_WRAPPER), puts
// the process under it: see spawnWrapped.
export function runCli(name, args, { cwd, stdin, timeoutMs, env, onStderr, onProgress, signal, wrapper, onSpawn } = {}) {
  const cancellation = () => cancelledError(name);
  if (signal?.aborted) return Promise.reject(cancellation());
  const bin = resolveBin(name);
  const limit = timeoutLimit(timeoutMs);
  return new Promise((resolve, reject) => {
    let child;
    try {
      // npm-installed CLIs on Windows are .cmd shims, which cannot be spawned
      // directly. cmd.exe re-parses whatever it is given, so the command line is
      // quoted here and handed over verbatim; otherwise a path with a space in
      // it splits into two arguments.
      const options = {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWin,
      };
      child = wrapper ? spawnWrapped(wrapper, name, args, options) : spawnCli(name, args, options);
    } catch (e) {
      reject(e instanceof BridgeError ? e : new BridgeError('CLI_NOT_FOUND', `Could not start ${name}: ${e.message}`));
      return;
    }

    children.add(child);
    // A caller that records the worker learns its pid; a throw there is not this run's failure.
    try { if (child.pid) onSpawn?.(child.pid); } catch { /* the record is best effort */ }
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let out = '';
    let err = '';
    let bytes = 0;
    let timedOut = false;
    let overflowed = false;
    let cancelled = false;
    const abort = () => { cancelled = true; killTree(child); };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, limit);

    // MCP clients abort a tool call that goes quiet (Claude Code defaults to
    // about a minute), and a real peer routinely thinks for longer than that.
    // A periodic progress notification is what keeps the call alive.
    const started = Date.now();
    const heartbeat = onProgress
      ? setInterval(() => onProgress(`${name} still working (${Math.round((Date.now() - started) / 1000)}s)`), HEARTBEAT_MS)
      : null;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
    };

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > MAX_STDOUT_BYTES) {
        overflowed = true;
        killTree(child);
        return;
      }
      out += stdoutDecoder.write(d);
    });
    child.stderr.on('data', (d) => {
      bytes += d.length;
      if (bytes > MAX_STDOUT_BYTES) {
        overflowed = true;
        killTree(child);
        return;
      }
      const text = stderrDecoder.write(d);
      err += text;
      if (onStderr && text) onStderr(text);
    });
    child.on('error', (e) => {
      children.delete(child);
      clearTimeout(timer);
      stopHeartbeat();
      reject(
        e.code === 'ENOENT'
          ? new BridgeError('CLI_NOT_FOUND', `"${name}" could not be executed at ${bin}.`)
          : new BridgeError('PROCESS_ERROR', `${name} failed to run: ${e.message}`),
      );
    });
    child.on('close', (code) => {
      children.delete(child);
      out += stdoutDecoder.end();
      const lastError = stderrDecoder.end();
      err += lastError;
      if (onStderr && lastError) onStderr(lastError);
      clearTimeout(timer);
      stopHeartbeat();
      if (cancelled) {
        reject(cancellation());
        return;
      }
      if (overflowed) {
        reject(new BridgeError('OUTPUT_TOO_LARGE', `${name} produced more than ${MAX_STDOUT_BYTES} bytes and was stopped.`));
        return;
      }
      if (timedOut) {
        reject(timeoutError(name, limit));
        return;
      }
      resolve({ stdout: out, stderr: err, exitCode: code ?? 1 });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* peer closed stdin early */
      });
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

// A peer held on a pipe for the length of its run, spoken to in JSON lines
// both ways, so a note can reach it while it works. stdout is handled a line
// at a time and nothing accumulates across lines; one line is still capped,
// because a child that never writes a newline would otherwise grow it without
// bound. Writes queue behind 'drain' rather than piling into the pipe buffer.
const MAX_STDERR_KEPT = 1024 * 1024;
// ponytail: how long stdout may stay open after the child itself has exited.
// A descendant that inherited the pipe would otherwise hold the run open until
// its timeout; raise it if a harness is seen flushing later than this.
const EXIT_DRAIN_MS = 2000;

// `onJunk(line)` hears a stdout line that is not JSON; without it such a line
// (a warning printed to stdout) is skipped.
export function spawnChannel(name, args, { cwd, env, onLine, onJunk, wrapper } = {}) {
  const bin = resolveBin(name);
  let child;
  try {
    // Its own process group either way, so killTree takes the wrapper and the worker under it.
    const options = { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin };
    child = wrapper ? spawnWrapped(wrapper, name, args, options) : spawnCli(name, args, options);
  } catch (e) {
    throw e instanceof BridgeError ? e : new BridgeError('CLI_NOT_FOUND', `Could not start ${name}: ${e.message}`);
  }
  children.add(child);
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  let partial = '';
  let stderr = '';
  let failure = null;
  let accepting = true;
  let queue = Promise.resolve();
  const closed = () => new BridgeError('WORKER_CLOSED', `${name}'s input is closed; nothing more can be sent to this run.`);
  const stop = (error) => {
    failure ??= error;
    killTree(child);
  };
  const deliver = (line) => {
    if (!line.trim()) return;
    let frame;
    // A throw in either handler would surface in a stream handler and take the server down.
    try { frame = JSON.parse(line); }
    catch {
      try { onJunk?.(line); }
      catch (e) { stop(new BridgeError('PROTOCOL_ERROR', `${name} wrote output the bridge could not handle (${e.message}) and was stopped.`)); }
      return;
    }
    try { onLine?.(frame); }
    catch (e) { stop(new BridgeError('PROTOCOL_ERROR', `${name} sent a frame the bridge could not handle (${e.message}) and was stopped.`)); }
  };
  child.stdout.on('data', (d) => {
    const lines = (partial + outDecoder.write(d)).split('\n');
    partial = lines.pop();
    for (const line of lines) deliver(line);
    if (partial.length > MAX_STDOUT_BYTES) {
      partial = '';
      stop(new BridgeError('OUTPUT_TOO_LARGE', `${name} wrote more than ${MAX_STDOUT_BYTES} bytes without a newline and was stopped.`));
    }
  });
  child.stderr.on('data', (d) => {
    const text = errDecoder.write(d);
    if (stderr.length < MAX_STDERR_KEPT) stderr += text.slice(0, MAX_STDERR_KEPT - stderr.length);
  });
  child.stdin.on('error', () => { accepting = false; });
  child.on('exit', () => {
    setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, EXIT_DRAIN_MS).unref();
  });

  const exited = new Promise((resolve, reject) => {
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      accepting = false;
      children.delete(child);
      reject(e.code === 'ENOENT'
        ? new BridgeError('CLI_NOT_FOUND', `"${name}" could not be executed at ${bin}.`)
        : new BridgeError('PROCESS_ERROR', `${name} failed to run: ${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      accepting = false;
      children.delete(child);
      const rest = partial + outDecoder.end();
      partial = '';
      for (const line of rest.split('\n')) deliver(line);
      stderr += errDecoder.end();
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? 1, stderr });
    });
  });

  const write = (line, onWrite) => new Promise((resolve, reject) => {
    if (child.stdin.destroyed || !child.stdin.writable) return reject(closed());
    const onDrain = () => { child.stdin.off('close', onClose); resolve(); };
    const onClose = () => { child.stdin.off('drain', onDrain); reject(closed()); };
    // Once a write is attempted, a later pipe error cannot prove the child
    // received nothing. Queued or closed-input refusals never reach this hook.
    onWrite?.();
    if (child.stdin.write(line)) return resolve();
    child.stdin.once('drain', onDrain);
    child.stdin.once('close', onClose);
  });

  return {
    pid: child.pid,
    // Resolves once the line is in the pipe, which is not proof the child read it.
    send(obj, { onWrite } = {}) {
      if (!accepting) return Promise.reject(closed());
      const line = JSON.stringify(obj) + '\n';
      const sent = queue.then(() => write(line, onWrite));
      queue = sent.catch(() => {});
      return sent;
    },
    // Closes stdin after whatever is already queued.
    end() {
      if (!accepting) return;
      accepting = false;
      queue.then(() => { try { child.stdin.end(); } catch { /* already closed */ } });
    },
    kill() {
      killTree(child);
    },
    exited,
  };
}

// --- output parsing --------------------------------------------------------

export function parseClaudeJson(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { message: '', sessionId: null, errors: ['Claude produced no output.'] };
  let v;
  try {
    v = JSON.parse(trimmed);
  } catch {
    return { message: '', sessionId: null, errors: ['Claude returned malformed JSON.'] };
  }
  return claudeResult(v);
}

// One Claude result envelope, however it arrived: `--output-format json`
// prints exactly one, and stream-json ends every turn with one.
export function claudeResult(v) {
  const r = { message: '', sessionId: null, errors: [] };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    r.errors.push('Claude returned a non-object result.');
    return r;
  }
  const f = v.result;
  if (typeof f === 'string') r.message = f;
  else if (f && Array.isArray(f.content)) {
    r.message = f.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  if (!r.message) r.message = v.message ?? v.text ?? v.output ?? '';
  r.sessionId = v.session_id ?? v.sessionId ?? null;
  // What the run cost, as `claude -p --output-format json` reports it (2.1.263):
  // total_cost_usd, duration_ms, num_turns, usage, and modelUsage keyed by model.
  if (v.usage || v.total_cost_usd != null) {
    const u = v.usage ?? {};
    r.usage = {
      costUsd: typeof v.total_cost_usd === 'number' ? v.total_cost_usd : null,
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) || null,
      outputTokens: u.output_tokens ?? null,
      durationMs: v.duration_ms ?? null,
      turns: v.num_turns ?? null,
      model: v.modelUsage && typeof v.modelUsage === 'object' ? Object.keys(v.modelUsage)[0] ?? null : null,
    };
  }
  if (v.error) r.errors.push(typeof v.error === 'string' ? v.error : (v.error.message ?? JSON.stringify(v.error)));
  if (v.is_error || (typeof v.subtype === 'string' && v.subtype.startsWith('error'))) {
    r.errors.push(...(Array.isArray(v.errors) && v.errors.length ? v.errors.map(String) : [(typeof f === 'string' && f.trim()) || v.subtype || 'Claude reported a failed result.']));
  }
  return r;
}

// `claude -p --input-format stream-json` reads SDK user messages, one per
// line, for as long as stdin stays open, and ends each turn with a `result`.
// Every message carries a uuid: --replay-user-messages echoes it back once
// Claude has taken the message, and each result lists the uuids its turn
// consumed (user_message_uuids). The run is done when every uuid sent has been
// consumed; the reply, usage and session are the last result's. Flags checked
// on Claude Code 2.1.290 (`claude --help`) and run live on 2.1.310; the frame fields are docs/transport-recon.md's.
export function claudeStreamSession({ send, finish, receipt }) {
  const request = randomUUID();
  const sent = new Set([request]);
  const consumed = new Set();
  const notes = new Set();
  let last = null;
  let sessionId = null;
  let finished = false;
  const user = (text, uuid, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid, ...extra });
  const settle = () => {
    if (finished || ![...sent].every((u) => consumed.has(u))) return;
    finished = true;
    finish();
  };
  return {
    get finished() { return finished; },
    // A failed write surfaces as the run's exit; nothing else reads it.
    start(prompt) { send(user(prompt, request)).catch(() => {}); },
    // 'next' lands the note at the next step boundary of the running turn.
    note(text) {
      const uuid = randomUUID();
      sent.add(uuid);
      notes.add(uuid);
      const written = send(user(text, uuid, { priority: 'next' })).catch((e) => {
        sent.delete(uuid);
        settle();
        throw e;
      });
      return { id: uuid, sent: written };
    },
    line(ev) {
      if (typeof ev.session_id === 'string' && ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'user' && notes.has(ev.uuid)) receipt(ev.uuid, 'queued_unread');
      else if (ev.type === 'result') {
        last = ev;
        // ponytail: a result without user_message_uuids (an older Claude) is
        // taken to consume everything outstanding, so the run cannot hang on
        // it; a note's receipt is then a guess. Drop this once 2.1.290 is the floor.
        const turn = Array.isArray(ev.user_message_uuids) ? ev.user_message_uuids : [...sent].filter((u) => !consumed.has(u));
        for (const uuid of turn) {
          consumed.add(uuid);
          if (notes.has(uuid)) receipt(uuid, turn.includes(request) ? 'received_mid_turn' : 'received');
        }
        settle();
      }
    },
    result() {
      if (!last) return { message: '', sessionId, errors: ['Claude produced no result.'] };
      const r = claudeResult(last);
      r.sessionId ??= sessionId;
      return r;
    },
  };
}

export function cap(text) {
  const t = text ?? '';
  return t.length <= MAX_RESPONSE_CHARS ? t : t.slice(0, MAX_RESPONSE_CHARS) + '\n\n...[truncated by magi]';
}
