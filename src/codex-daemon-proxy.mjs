// Own only this app-server proxy, never the shared daemon behind it.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBin, spawnFile } from './exec.mjs';
import { openCodexDaemon, steerLoadedThread, adviseSteerFailure } from './codex-daemon.mjs';

let clientVersion = '0.0.0';
try {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (typeof version === 'string' && version) clientVersion = version;
} catch { /* A packaged installation may not retain package metadata. */ }

const STDOUT_DRAIN_GRACE_MS = 1000;
const CLEANUP_GRACE_MS = 1000;

// Cleanup has its own grace, never part of the connection's setup deadline.
function terminateProxy(child, hasExited) {
  const running = () => !hasExited() && child.pid && child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch {
      try { if (running()) child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    return;
  }
  let helper;
  let timer;
  let finished = false;
  function finish(fallback = false, cancel = false) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    child.off('exit', onExit);
    if (cancel) {
      try { helper?.kill(); } catch { /* already gone */ }
    }
    // The child handle is a last resort if taskkill fails or stalls. Never
    // schedule another pid-based command after the original child has exited.
    if (fallback && running()) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
  const onExit = () => finish(false, true);
  child.once('exit', onExit);
  try {
    helper = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    helper.once('error', () => finish(true));
    helper.once('exit', (code) => finish(code !== 0));
    helper.unref();
    timer = setTimeout(() => finish(true, true), CLEANUP_GRACE_MS);
    timer.unref();
    if (!running()) finish(false, true);
  } catch { finish(true, true); }
}

// Stdin can terminate before exit or stdout EOF. Keep write-side terminal
// events and failures behind buffered replies, with a bounded drain grace.
function drainingProxyInput(child, startDrain) {
  const input = new EventEmitter();
  const waiting = [];
  const deliver = (callback) => {
    if (!child.stdout.readableEnded && !child.stdout.closed && !child.stdout.destroyed) {
      startDrain();
      waiting.push(callback);
    } else callback();
  };
  const flush = () => { for (const callback of waiting.splice(0)) callback(); };
  child.stdout.once('end', flush);
  child.stdout.once('close', flush);
  for (const event of ['error', 'close', 'finish']) {
    child.stdin.on(event, (...args) => deliver(() => input.emit(event, ...args)));
  }
  input.write = (bytes, callback) => {
    try {
      return child.stdin.write(bytes, (cause) => {
        if (cause) deliver(() => callback?.(cause));
        else callback?.();
      });
    } catch (cause) {
      deliver(() => callback?.(cause));
      return false;
    }
  };
  input.end = (...args) => child.stdin.end(...args);
  input.destroy = (...args) => child.stdin.destroy(...args);
  Object.defineProperties(input, {
    destroyed: { get: () => child.stdin.destroyed },
    writableEnded: { get: () => child.stdin.writableEnded },
    closed: { get: () => child.stdin.closed },
  });
  return input;
}

export async function connectCodexDaemon({ timeoutMs = 2000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return null;
  let child;
  let client;
  let stopped = false;
  let exited = false;
  let timer;
  let drainTimer;
  let rejectFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearTimeout(drainTimer);
    client?.close();
    // Defer process cleanup off the caller's response path. Re-check liveness
    // inside the callback: even this event-loop turn can outlive the proxy.
    if (child) setImmediate(() => terminateProxy(child, () => exited)).unref();
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  }
  function startDrain() {
    if (stopped || drainTimer || child.stdout.readableEnded || child.stdout.closed || child.stdout.destroyed) return;
    drainTimer = setTimeout(() => fail(new Error('Codex proxy stdout did not drain after stdin termination or exit')), STDOUT_DRAIN_GRACE_MS);
    drainTimer.unref();
  }
  function fail(cause) {
    if (stopped) return;
    rejectFailure(cause);
    cleanup();
  }
  try {
    timer = setTimeout(() => fail(new Error('Codex proxy setup timed out')), timeoutMs);
    child = spawnFile(resolveBin('codex'), ['app-server', 'proxy'], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    child.once('exit', () => {
      exited = true;
      // exit precedes stdout EOF: successful replies can still be in its pipe.
      startDrain();
    });
    child.once('close', () => fail(new Error('Codex proxy closed')));
    const input = drainingProxyInput(child, startDrain);
    child.stdout.once('end', () => clearTimeout(drainTimer));
    child.stdout.once('close', () => clearTimeout(drainTimer));
    child.once('error', fail);
    for (const stream of [input, child.stdout, child.stderr]) stream.on('error', fail);
    child.stderr.resume();
    const opening = openCodexDaemon({ readable: child.stdout, writable: input, clientVersion, timeoutMs }).then((opened) => {
      client = opened;
      if (stopped) { opened.close(); throw new Error('Codex proxy setup ended'); }
      return opened;
    });
    await Promise.race([opening, failed]);
    clearTimeout(timer);
    const close = client.close.bind(client);
    client.close = () => { close(); cleanup(); };
    client.onClose(cleanup);
    return client;
  } catch {
    cleanup();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The daemon's control socket, as `codex app-server daemon version` reports
// it (0.163.0 on Windows). No socket, no daemon: nothing is spawned to find out.
// ponytail: the path is checked on Windows only; elsewhere a moved socket
// means the desktop route, as before. Read socketPath from `daemon version`
// if it ever differs.
export function codexDaemonSocket() {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}

// A live AF_UNIX socket on Windows is a reparse point that lstat refuses with
// EACCES (Node 24.20, 2026-10-18), so existsSync reads it as absent. Only
// "not there" means not there.
function socketPresent(path) {
  try { lstatSync(path); return true; }
  catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
}

// Steer a thread this machine's shared daemon holds: a terminal Codex runs
// its threads there (codex-cli 0.163.0, plain `codex` and `--remote unix://`
// alike). Null when there is no daemon or it does not hold the thread, so the
// caller can try the desktop; any other refusal is the answer.
export async function steerLocalDaemon({ thread, text }, connect = connectCodexDaemon) {
  if (!socketPresent(codexDaemonSocket())) return null;
  const daemon = await connect();
  if (!daemon) return null;
  try {
    return await steerLoadedThread(daemon, thread, text);
  } catch (e) {
    if (e.code === 'THREAD_NOT_LOADED') return null;
    throw adviseSteerFailure(e);
  } finally {
    daemon.close();
  }
}
