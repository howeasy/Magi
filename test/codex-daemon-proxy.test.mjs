import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCodexDaemon } from '../src/codex-daemon-proxy.mjs';
import { ROOT, makeWorkspace, makeFakeBins, fakeEnv, readCalls } from './helpers/harness.mjs';

function fixture(t, daemon) {
  const dir = makeWorkspace('daemon proxy');
  const { paths } = makeFakeBins(dir, ['codex']);
  const { env, logFile } = fakeEnv(dir);
  const values = { ...env, CODEX_BIN: paths.codex, FAKE_CODEX_DAEMON: daemon === undefined ? undefined : JSON.stringify(daemon) };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, logFile };
}

async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'owned proxy did not terminate');
    await delay(20);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
const thread = { id: 'thread-1', name: 'Proxy peer', cwd: '/fake', status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn-1', status: 'inProgress' }] };

test('proxy operations use app-server proxy and close the owned child without answering approvals', async (t) => {
  const { logFile } = fixture(t, { threads: [thread], reverseApproval: true });
  const client = await connectCodexDaemon({ timeoutMs: 5000 });
  assert.ok(client);
  t.after(() => client.close());
  assert.equal((await client.findThread({ name: thread.name })).id, thread.id);
  assert.equal((await client.findThread({ id: thread.id })).turns, undefined);
  assert.deepEqual(await client.loadedIds(), [thread.id]);
  assert.equal(await client.activeTurnId(thread.id), 'turn-1');
  assert.equal((await client.steer(thread.id, 'turn-1', 'Please focus', 'message-1')).turnId, 'turn-1');
  assert.equal(client.unansweredRequests().count, 1);
  const calls = readCalls(logFile);
  const rpc = calls.filter((row) => row.daemon && row.rpc);
  for (const row of rpc) assert.deepEqual(row.args, ['app-server', 'proxy']);
  assert.equal(calls.some((row) => row.daemonResponse), false);
  const pid = rpc[0].pid;
  assert.ok(alive(pid));
  client.close();
  client.close();
  await eventually(() => !alive(pid));
  assert.equal(readCalls(logFile).some((row) => row.daemonResponse), false);
});

test('an absent daemon returns null without falling back to a normal CLI scenario', async (t) => {
  fixture(t);
  assert.equal(await connectCodexDaemon({ timeoutMs: 2000 }), null);
});

test('a hung initialization returns null and kills its proxy', async (t) => {
  const { logFile } = fixture(t, { threads: [], hangInitialize: true });
  assert.equal(await connectCodexDaemon({ timeoutMs: 2000 }), null);
  const request = readCalls(logFile).find((row) => row.rpc === 'initialize');
  assert.ok(request, 'fixture reached initialization');
  await eventually(() => !alive(request.pid));
});

test('one deadline bounds upgrade plus initialize, rather than restarting per stage', async (t) => {
  // Each stage fits the deadline alone, together they do not. The upgrade is
  // short so a loaded machine's process start (seconds on Windows under the
  // full suite) cannot use up the margin before initialize is logged.
  const { logFile } = fixture(t, { threads: [], upgradeDelayMs: 1200, initializeDelayMs: 3500 });
  assert.equal(await connectCodexDaemon({ timeoutMs: 4000 }), null);
  const request = readCalls(logFile).find((row) => row.rpc === 'initialize');
  assert.ok(request, 'upgrade completed before the overall deadline');
  await eventually(() => !alive(request.pid));
});

test('missing and unlaunchable executable overrides return null', async (t) => {
  const { dir } = fixture(t);
  process.env.CODEX_BIN = join(dir, 'does-not-exist');
  assert.equal(await connectCodexDaemon(), null);
  const bad = join(dir, 'invalid executable');
  writeFileSync(bad, 'not an executable');
  process.env.CODEX_BIN = bad;
  assert.equal(await connectCodexDaemon({ timeoutMs: 1000 }), null);
});

test('a Node script executable override is launched through the current Node', async (t) => {
  const { dir } = fixture(t, { threads: [thread] });
  const script = join(dir, 'codex entry.cjs');
  writeFileSync(script, `process.env.FAKE_CLI_NAME = 'codex'; require(${JSON.stringify(join(ROOT, 'test', 'helpers', 'fake-cli.cjs'))});`);
  process.env.CODEX_BIN = script;
  const client = await connectCodexDaemon({ timeoutMs: 5000 });
  assert.ok(client);
  t.after(() => client.close());
  assert.deepEqual(await client.loadedIds(), [thread.id]);
  client.close();
});

test('a peer Close also kills its still-running owned proxy', async (t) => {
  const { logFile } = fixture(t, { threads: [], disconnectAfterInitializedMs: 100 });
  const client = await connectCodexDaemon({ timeoutMs: 5000 });
  assert.ok(client);
  t.after(() => client.close());
  const pid = readCalls(logFile).find((row) => row.rpc === 'initialize').pid;
  await eventually(() => !alive(pid));
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

function responseFrame(id, result) {
  const payload = Buffer.from(JSON.stringify({ id, result }));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = payload.length < 126 ? payload.length : 126;
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

// Keep exit and stdout EOF independently controllable, as they are for real pipes.
function processFixture(t, handler = () => {}, { hangInitialize = false } = {}) {
  fixture(t);
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 987654321, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const signals = [];
  const cleanupCalls = [];
  const groupSignals = [];
  const messages = [];
  const exit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => { signals.push(signal); exit(null, signal); return true; };
  let input = Buffer.alloc(0);
  let upgraded = false;
  child.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    if (!upgraded) {
      const end = input.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /^Sec-WebSocket-Key: (.+)\r$/mi.exec(input.subarray(0, end + 4).toString())[1];
      input = input.subarray(end + 4);
      upgraded = true;
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      child.stdout.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    }
    while (input.length >= 2) {
      const marker = input[1] & 127;
      const extended = marker === 126 ? 2 : marker === 127 ? 8 : 0;
      const header = 2 + extended + 4;
      if (input.length < header) return;
      const length = extended === 8 ? Number(input.readBigUInt64BE(2)) : extended === 2 ? input.readUInt16BE(2) : marker;
      if (input.length < header + length) return;
      const opcode = input[0] & 15;
      const payload = Buffer.from(input.subarray(header, header + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= input[2 + extended + index % 4];
      input = input.subarray(header + length);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      messages.push(message);
      if (message.method === 'initialize' && !hangInitialize) {
        child.stdout.write(responseFrame(message.id, { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' }));
      } else handler(message, { child, exit });
    }
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.mock.method(process, 'kill', (...args) => { groupSignals.push(args); return true; });
  t.mock.method(childProcess, 'execFileSync', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    throw new Error('simulated stalled synchronous cleanup');
  });
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    if (file !== 'taskkill') return child;
    const helper = new EventEmitter();
    helper.signals = [];
    helper.unref = () => { helper.unreferenced = true; };
    helper.kill = (signal = 'SIGTERM') => { helper.signals.push(signal); return true; };
    cleanupCalls.push({ file, args, options, helper });
    return helper; // Never closes: cleanup must supply its own deadline.
  });
  syncBuiltinESMExports();
  t.after(() => {
    exit();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { child, exit, signals, cleanupCalls, groupSignals, messages };
}

test('a successful steer buffered past child exit is delivered before stdout EOF', async (t) => {
  const peer = processFixture(t, (message, { child, exit }) => {
    if (message.method !== 'turn/steer') return;
    const response = responseFrame(message.id, { turnId: 'turn-1' });
    exit();
    assert.equal(child.stdout.destroyed, false, 'exit must not discard buffered stdout');
    child.stdin.destroy();
    child.stdin.emit('error', new Error('write side ended after exit'));
    setImmediate(() => child.stdout.end(response));
  });
  const client = await connectCodexDaemon({ timeoutMs: 2000 });
  assert.ok(client);
  t.after(() => client.close());
  const closed = new Promise((resolve) => client.onClose(resolve));
  assert.deepEqual(await client.steer('thread-1', 'turn-1', 'Focus', 'message-1'), { turnId: 'turn-1' });
  await closed;
  await tick();
  assert.deepEqual(peer.signals, []);
  assert.deepEqual(peer.cleanupCalls, []);
  assert.deepEqual(peer.groupSignals, []);
});

const inputTerminals = ['close', 'error', 'finish', 'failed callback', 'synchronous throw'];

function terminalInputWrite(t, child, terminal) {
  const write = child.stdin.write.bind(child.stdin);
  t.mock.method(child.stdin, 'write', (bytes, callback) => {
    const callbackFails = terminal === 'failed callback' || terminal === 'synchronous throw';
    const written = write(bytes, callbackFails ? undefined : callback);
    const cause = new Error(`stdin ${terminal} before exit`);
    if (terminal === 'close') child.stdin.destroy();
    else if (terminal === 'error') child.stdin.destroy(cause);
    else if (terminal === 'finish') child.stdin.end();
    else if (terminal === 'failed callback') callback(cause);
    else throw cause;
    return written;
  });
}

for (const terminal of inputTerminals) {
  test(`a successful steer survives stdin ${terminal} before child exit and stdout EOF`, async (t) => {
    const peer = processFixture(t);
    const client = await connectCodexDaemon({ timeoutMs: 5000 });
    assert.ok(client);
    t.after(() => client.close());
    terminalInputWrite(t, peer.child, terminal);
    const closed = new Promise((resolve) => client.onClose(resolve));
    const steering = client.steer('thread-1', 'turn-1', 'Focus', 'message-1');
    let settled = false;
    steering.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    const request = peer.messages.find((message) => message.method === 'turn/steer');
    assert.ok(request, 'the steer reached the proxy before stdin terminated');
    assert.equal(settled, false, 'stdin termination must wait for stdout even before exit');
    peer.exit();
    await tick();
    assert.equal(settled, false, 'child exit must still allow stdout to drain');
    peer.child.stdout.end(responseFrame(request.id, { turnId: 'turn-1' }));
    assert.deepEqual(await steering, { turnId: 'turn-1' });
    await closed;
    await tick();
    assert.deepEqual(peer.signals, []);
    assert.deepEqual(peer.cleanupCalls, []);
    assert.deepEqual(peer.groupSignals, []);
  });

  test(`stdin ${terminal} bounds non-draining stdout without any child exit notification`, async (t) => {
    const peer = processFixture(t);
    const client = await connectCodexDaemon({ timeoutMs: 5000 });
    assert.ok(client);
    t.after(() => client.close());
    t.mock.timers.enable({ apis: ['setTimeout'] });
    terminalInputWrite(t, peer.child, terminal);
    const steering = client.steer('thread-1', 'turn-1', 'Focus', 'message-1');
    let settled = false;
    steering.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(settled, false, 'stdin termination must allow the drain grace');
    t.mock.timers.tick(750);
    peer.child.stdin.emit('error', new Error('a later write-side terminal condition'));
    t.mock.timers.tick(249);
    await tick();
    assert.equal(settled, false, 'the first terminal condition allows a full one-second grace');
    t.mock.timers.tick(1);
    await tick();
    assert.equal(settled, true, 'later stdin events cannot restart the one-second grace');
    await assert.rejects(steering, { code: 'DAEMON_CLOSED', dispatchUncertain: true });
    assert.equal(peer.child.stdout.destroyed, true, 'stdout closes at the grace, not the 5000 ms RPC deadline');
    await tick();
  });
}

test('a later child exit cannot restart a drain grace already started by stdin', async (t) => {
  const peer = processFixture(t);
  const client = await connectCodexDaemon({ timeoutMs: 5000 });
  assert.ok(client);
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  terminalInputWrite(t, peer.child, 'close');
  const steering = client.steer('thread-1', 'turn-1', 'Focus', 'message-1');
  let settled = false;
  steering.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  t.mock.timers.tick(750);
  peer.exit();
  t.mock.timers.tick(249);
  await tick();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(settled, true, 'exit cannot restart the one-second grace');
  await assert.rejects(steering, { code: 'DAEMON_CLOSED', dispatchUncertain: true });
  assert.equal(peer.child.stdout.destroyed, true);
  await tick();
  assert.deepEqual(peer.cleanupCalls, []);
  assert.deepEqual(peer.signals, []);
});

test('an exited proxy with inherited stdout is closed after a separate bounded drain grace', async (t) => {
  const peer = processFixture(t, (message, { exit }) => { if (message.method === 'turn/steer') exit(); });
  const client = await connectCodexDaemon({ timeoutMs: 5000 });
  assert.ok(client);
  t.after(() => client.close());
  const started = Date.now();
  await assert.rejects(client.steer('thread-1', 'turn-1', 'Focus', 'message-1'), { code: 'DAEMON_CLOSED', dispatchUncertain: true });
  assert.ok(Date.now() - started < 2500, 'draining must not wait for the 5000 ms RPC deadline');
  assert.equal(peer.child.stdout.destroyed, true);
  assert.deepEqual(peer.cleanupCalls, []);
  assert.deepEqual(peer.signals, []);
});

test('stalled Windows cleanup cannot extend setup timeout and is itself bounded', async (t) => {
  const peer = processFixture(t, () => {}, { hangInitialize: true });
  const started = Date.now();
  assert.equal(await connectCodexDaemon({ timeoutMs: 100 }), null);
  assert.ok(Date.now() - started < 800, 'setup must return before the separate cleanup grace');
  await tick();
  assert.equal(peer.cleanupCalls.length, 1);
  const { helper } = peer.cleanupCalls[0];
  await eventually(() => peer.signals.length === 1);
  assert.equal(helper.signals.length, 1, 'the stalled taskkill helper must also be terminated');
  assert.ok(Date.now() - started < 2500, 'cleanup must have a finite grace');
});

test('close yields to the event loop while cleanup stalls and never revisits an exited pid', async (t) => {
  const peer = processFixture(t);
  const client = await connectCodexDaemon({ timeoutMs: 2000 });
  assert.ok(client);
  t.after(() => client.close());
  const started = Date.now();
  client.close();
  client.close();
  await tick();
  assert.ok(Date.now() - started < 800, 'close and the next event-loop turn must not await cleanup');
  assert.equal(peer.cleanupCalls.length, 1);
  const { helper } = peer.cleanupCalls[0];
  peer.exit();
  assert.equal(helper.signals.length, 1, 'exit cancels a taskkill that could otherwise target a reused pid');
  await delay(1100);
  assert.deepEqual(peer.signals, []);
  assert.deepEqual(peer.groupSignals, []);
  assert.equal(peer.cleanupCalls.length, 1);
});
