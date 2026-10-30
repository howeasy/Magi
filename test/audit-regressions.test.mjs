import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import * as state from '../src/state.mjs';
import { runCli } from '../src/exec.mjs';
import { deliverToCodex, deliverReplyToOrigin, resolveOrigin } from '../src/transport.mjs';
import { spawn } from 'node:child_process';
import { withoutMagiConfig } from '../src/install.mjs';

function setup() {
  const ws = makeWorkspace('audit workspace');
  process.env.MAGI_HOME = join(ws, 'state');
  return ws;
}

test('a fast live reply is retained before delivery returns', async () => {
  const ws = setup();
  let externalSends = 0;
  const peer = makeEngine({ orchestrator: 'claude', peerName: 'codex', deliverReply: async () => externalSends++ });
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    resolveOrigin: async () => ({ target: { agent: 'codex', id: 'origin' }, replyTo: 'codex:origin' }),
    pickDelivery: async () => ({ mode: 'live', target: 'claude-destination' }),
    deliverLive: async ({ taskId }) => {
      assert.equal(state.readTask(taskId).peerTarget, 'claude-destination');
      await peer.handleReply({ taskId, body: 'SUMMARY\nFast response.' });
      return { via: 'live', target: 'claude-destination' };
    },
  });
  const result = await engine.handleRequest({ wait: true, task: 'inspect', workingDirectory: ws, wait: true, timeoutMs: 1000 });
  assert.match(textOf(result), /Fast response/);
  assert.equal(result.structuredContent.timedOut, undefined);
  assert.equal(externalSends, 0);
  assert.equal(state.isWaiting(result.structuredContent.taskId), false);
  assert.equal(state.readTask(result.structuredContent.taskId).replyTo, 'codex:origin');
});

test('pending rounds cannot be overwritten and old replies cannot answer a new round', () => {
  setup();
  const request = { taskId: 'rounds', orchestrator: 'codex', peer: 'claude', mode: 'DEBATE', round: 1 };
  state.openRound(request);
  assert.throws(() => state.openRound({ ...request, round: 2 }), { code: 'ROUND_PENDING' });
  assert.throws(() => state.recordReply({ taskId: 'rounds', from: 'someone-else' }), { code: 'ROLE_VIOLATION' });
  state.recordReply({ taskId: 'rounds', from: 'claude', round: 1 });
  state.openRound({ ...request, round: 2 });
  assert.throws(() => state.recordReply({ taskId: 'rounds', from: 'claude', round: 1 }), { code: 'ALREADY_REPLIED' });
  assert.equal(state.readTask('rounds').rounds[1].replied, false);
});

test('headless completion is recorded', async () => {
  const ws = setup();
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nComplete.', via: 'headless' }),
  });
  const result = await engine.handleRequest({ wait: true, task: 'inspect', workingDirectory: ws });
  assert.equal(state.readTask(result.structuredContent.taskId).rounds[0].replied, true);
});

// `codex exec resume` dropped --sandbox; thread/resume carries it, and the
// turn's own sandboxPolicy holds whatever the resumed thread had.
test('a Codex resume keeps the sandbox, the directory and the approval policy', async () => {
  const ws = setup();
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws);
  const server = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  try {
    const result = await server.call('codex_peer', { wait: true, task: 'inspect', delivery: 'headless', workingDirectory: ws, resumeThreadId: 'prior-task' });
    assert.equal(result.isError, undefined, textOf(result));
    const [call] = readCalls(logFile);
    assert.equal(call.opened.method, 'thread/resume');
    assert.deepEqual(call.opened.params, { threadId: 'prior-task', cwd: ws, approvalPolicy: 'never', sandbox: 'read-only' });
    assert.equal(call.turn.threadId, 'prior-task');
    assert.deepEqual(call.turn.sandboxPolicy, { type: 'readOnly' });
  } finally { await server.close(); }
});

for (const scenario of ['failed-with-output', 'turn-failed', 'garbage', 'empty']) {
  test(`Codex rejects ${scenario} rather than returning a successful review`, async () => {
    const ws = setup();
    const { paths } = makeFakeBins(ws);
    const { env } = fakeEnv(ws, { scenario });
    const server = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
    try {
      const result = await server.call('codex_peer', { wait: true, task: 'inspect', delivery: 'headless', workingDirectory: ws });
      assert.equal(result.isError, true, textOf(result));
    } finally { await server.close(); }
  });
}

test('Codex queue works through a Windows shim and requires a successful receipt', async () => {
  const ws = setup();
  const { paths } = makeFakeBins(ws);
  const oldBin = process.env.CODEX_BIN;
  const oldScenario = process.env.FAKE_CLI_SCENARIO;
  try {
    process.env.CODEX_BIN = paths.codex;
    process.env.FAKE_CLI_SCENARIO = 'queue-ok';
    assert.deepEqual(await deliverToCodex({ thread: 'task-audit', text: 'hello' }), { messageId: 'msg-audit', threadId: 'task-audit' });
    process.env.FAKE_CLI_SCENARIO = 'queue-partial-failure';
    await assert.rejects(deliverToCodex({ thread: 'task-audit', text: 'hello' }), { code: 'CODEX_CLI_FAILED' });
    process.env.FAKE_CLI_SCENARIO = 'empty';
    await assert.rejects(deliverToCodex({ thread: 'task-audit', text: 'hello' }), { code: 'DELIVERY_UNCONFIRMED' });
  } finally {
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    if (oldScenario === undefined) delete process.env.FAKE_CLI_SCENARIO; else process.env.FAKE_CLI_SCENARIO = oldScenario;
  }
});

test('runCli has a usable default timeout when no environment override exists', async () => {
  const ws = setup();
  const { paths } = makeFakeBins(ws);
  const oldBin = process.env.CODEX_BIN;
  const oldTimeout = process.env.MAGI_TIMEOUT_MS;
  try {
    process.env.CODEX_BIN = paths.codex;
    delete process.env.MAGI_TIMEOUT_MS;
    const result = await runCli('codex', ['--help'], { cwd: ws });
    assert.equal(result.exitCode, 0);
  } finally {
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    if (oldTimeout === undefined) delete process.env.MAGI_TIMEOUT_MS; else process.env.MAGI_TIMEOUT_MS = oldTimeout;
  }
});

test('reply routing uses the originating Codex id and refuses directory-based substitutes', async () => {
  const ws = setup();
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws, { scenario: 'queue-ok' });
  const previous = { ...process.env };
  try {
    Object.assign(process.env, env, { CODEX_BIN: paths.codex });
    const task = { orchestrator: 'codex', replyTo: 'codex:exact-origin', peerTarget: { name: 'claude-recipient' }, cwd: ws };
    await deliverReplyToOrigin({ text: 'reply', task });
    assert.equal(readCalls(logFile)[0].args[2], 'exact-origin');
    await assert.rejects(deliverReplyToOrigin({ text: 'reply', task: { ...task, replyTo: null } }), { code: 'NO_REPLY_ROUTE' });
    assert.equal(readCalls(logFile).filter((c) => c.args[0] === 'queue').length, 1, 'missing origin must not trigger a send to a guessed task');
  } finally {
    for (const key of [...Object.keys(env), 'CODEX_BIN']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('concurrent MCP processes can file only one reply per round', async () => {
  setup();
  state.openRound({ taskId: 'race', orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1 });
  const moduleUrl = new URL('../src/state.mjs', import.meta.url).href;
  const source = `import {recordReply,retryState} from ${JSON.stringify(moduleUrl)}; try { await retryState(()=>recordReply({taskId:'race',from:'claude',round:1})); console.log('ok'); } catch(e) {console.log(e.code);}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => output += chunk);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`worker exited ${code}`)));
  })));
  assert.equal(results.filter((value) => value === 'ok').length, 1);
  assert.equal(results.filter((value) => value === 'ALREADY_REPLIED').length, 7, JSON.stringify(results));
});

test('ambiguous delivery never launches a duplicate headless request', async () => {
  const ws = setup();
  let headlessCalls = 0;
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    pickDelivery: async () => ({ mode: 'live', target: 'peer' }),
    deliverLive: async () => { throw Object.assign(new Error('receipt missing after write'), { code: 'DELIVERY_UNCONFIRMED' }); },
    deliverHeadless: async () => { headlessCalls++; return { inlineReply: 'duplicate' }; },
  });
  const result = await engine.handleRequest({ wait: true, task: 'implement', mode: 'DELEGATE', workingDirectory: ws, allowWrites: true });
  assert.equal(result.isError, true);
  assert.equal(headlessCalls, 0);
});

test('reinstall and uninstall remove only Magi tables, including env and CRLF headers', () => {
  for (const newline of ['\n', '\r\n']) {
    const before = ['model = "configured-model"', '[mcp_servers.magi]', 'command = "node"', '[mcp_servers.magi.env]', 'CODEX_BIN = "old"', '[mcp_servers.other]', 'command = "keep"', ''].join(newline);
    const kept = ['model = "configured-model"', '[mcp_servers.other]', 'command = "keep"', ''].join(newline);
    assert.equal(withoutMagiConfig(before), kept);
    const block = ['[mcp_servers.magi]', 'command = "node"', '[mcp_servers.magi.env]', 'CODEX_BIN = "new"', ''].join(newline);
    assert.equal(withoutMagiConfig(kept + block) + block, kept + block);
  }
});
