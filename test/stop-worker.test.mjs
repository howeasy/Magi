// kind "close" with stop kills the card's headless worker. The orchestrator
// owns that process, so unlike a teammate it need not be asked to agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf, ROOT } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { runHeadless } from '../src/serve.mjs';
import { runState, deliverHeadlessNote, stopHeadlessWorker } from '../src/worker-channel.mjs';
import { adapter as claudeAdapter } from '../src/claude-adapter.mjs';
import * as state from '../src/state.mjs';

const run = promisify(execFile);

async function isolated(fn, { scenario = 'ok', env: extra = {} } = {}) {
  const ws = makeWorkspace('stop worker');
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['omp', 'claude', 'codex']);
  const { env, logFile } = fakeEnv(ws, { scenario });
  Object.assign(env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'), CODEX_HOME: join(ws, 'codex-home'),
    OMP_BIN: paths.omp, CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, PEER_DEPTH: '0', FAKE_CHILD_PID_FILE: join(ws, 'descendant.pid'), ...extra,
  });
  Object.assign(process.env, env);
  try { return await fn({ ws, env, logFile }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function eventually(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('condition did not become true before deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function running(pid) {
  if (process.platform === 'linux') {
    try { if (/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// The real headless launcher; everything a worker sends home is counted.
function launcher({ stopHeadless = stopHeadlessWorker } = {}) {
  const sent = [];
  let replied;
  const reply = new Promise((resolve) => { replied = resolve; });
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    resolveOrigin: async () => ({ target: { agent: 'codex', id: 'coordinator', name: 'lead' }, replyTo: 'codex:coordinator' }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: (options) => runHeadless(claudeAdapter, options),
    deliverHeadlessNote,
    stopHeadless,
    deliverReply: async ({ text }) => { sent.push(text); replied(text); return { deliveryStatus: 'received' }; },
  });
  return { engine, reply, sent };
}

async function startCard(engine, ws, logFile) {
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: ws, wait: false });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  await eventually(() => readCalls(logFile).some((call) => call.args) && runState(taskId) === 'running' && state.readWorker(taskId)?.childPid);
  return taskId;
}

const lastRound = (taskId) => state.readTask(taskId).rounds.at(-1);

test('stop kills the worker, closes the round as STOPPED, and reports nothing back as a failure', { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
  const { engine, sent } = launcher();
  const taskId = await startCard(engine, ws, logFile);
  const pid = state.readWorker(taskId).childPid;
  assert.ok(running(pid), 'the fake worker is running before the stop');

  const res = await engine.handleClose({ taskId, stop: true });
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(res.structuredContent.stopped, true);
  assert.equal(res.structuredContent.stop, 'stopped');
  assert.match(textOf(res), /headless worker was stopped; no reply will come/);

  await eventually(() => !running(pid));
  await eventually(() => runState(taskId) === null && state.readWorker(taskId) === null);
  const round = lastRound(taskId);
  assert.equal(round.closeReason, 'abandoned');
  assert.equal(round.closeCode, 'STOPPED', 'the stop, not a delivery failure, is what the ledger records');
  assert.equal(sent.length, 0, 'the orchestrator is not told that its own stop was a failure');
}, { scenario: 'hang' }));

test('a round closed earlier still has its running worker, and a later stop reaches it', { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
  const { engine } = launcher();
  const taskId = await startCard(engine, ws, logFile);
  const pid = state.readWorker(taskId).childPid;

  const closed = await engine.handleClose({ taskId });
  assert.equal(closed.isError, undefined, textOf(closed));
  assert.equal(closed.structuredContent.stopped, undefined, 'a plain close does not stop anything');
  assert.ok(running(pid), 'a plain close leaves the worker running');
  assert.equal(lastRound(taskId).closeCode, undefined);

  const again = await engine.handleClose({ taskId });
  assert.equal(again.isError, true);
  assert.match(textOf(again), /ROUND_CLOSED/);

  const stopped = await engine.handleClose({ taskId, stop: true });
  assert.equal(stopped.isError, undefined, textOf(stopped));
  assert.equal(stopped.structuredContent.stopped, true);
  await eventually(() => !running(pid));
  assert.equal(lastRound(taskId).closeCode, undefined, 'the earlier close keeps its own record');
}, { scenario: 'hang' }));

test('magi close --stop from another process stops a worker held by this server', { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
  const { engine, sent } = launcher();
  const taskId = await startCard(engine, ws, logFile);
  const pid = state.readWorker(taskId).childPid;
  assert.equal(state.readWorker(taskId).pid, process.pid);

  const { stdout } = await run(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'close', '--task', taskId, '--stop'], { env: { ...process.env } });
  assert.match(stdout, /closed as abandoned; its headless worker was stopped/);
  await eventually(() => !running(pid));
  await eventually(() => runState(taskId) === null);
  assert.equal(lastRound(taskId).closeCode, 'STOPPED');
  assert.equal(sent.length, 0);
}, { scenario: 'hang' }));

test('a stop that arrives after the worker answered leaves the answer standing', { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
  const { engine, reply } = launcher();
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: ws, wait: false });
  const { taskId } = started.structuredContent;
  // The reply is complete and the worker is on its way out (the fake delays its exit).
  await eventually(() => runState(taskId) === 'finishing');

  const res = await engine.handleClose({ taskId, stop: true });
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(res.structuredContent.stopped, false);
  assert.equal(res.structuredContent.stop, 'finishing');
  assert.match(textOf(res), /already answered, so that reply will still be recorded/);
  assert.match(await reply, /Fake peer reply/, 'the answer that was already complete is still delivered');
  // Let the late reply's delivery bookkeeping finish before the test's home is torn down.
  await eventually(() => state.readWorker(taskId) === null);
  await new Promise((resolve) => setTimeout(resolve, 300));
}, { env: { FAKE_CLI_EXIT_DELAY_MS: '3000' } }));

test('a peer with nothing to stop closes the round and says so', { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
  // null, not undefined: undefined would take the default and stop it.
  const { engine } = launcher({ stopHeadless: null });
  const taskId = await startCard(engine, ws, logFile);
  try {
    const res = await engine.handleClose({ taskId, stop: true });
    assert.equal(res.isError, undefined, textOf(res));
    assert.equal(res.structuredContent.stopped, false);
    assert.equal(res.structuredContent.stop, 'none');
    assert.match(textOf(res), /no headless worker is running on this card/);
    assert.equal(lastRound(taskId).closeCode, 'STOPPED');
  } finally {
    // The fake worker never exits on its own.
    await stopHeadlessWorker({ taskId });
  }
}, { scenario: 'hang' }));

test('stopping a card with no worker row is NO_LIVE_PEER, not a crash', async () => {
  await isolated(async () => {
    await assert.rejects(() => stopHeadlessWorker({ taskId: 'no-such-card' }), { code: 'NO_LIVE_PEER' });
  });
});
