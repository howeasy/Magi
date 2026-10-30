import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf, isWin } from './helpers/harness.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import { runCli } from '../src/exec.mjs';
import { runHeadless } from '../src/serve.mjs';
import { makeEngine } from '../src/peer.mjs';
import { headlessOmpArgs, ompRpcSession, ompPermissionClass } from '../src/omp-launch.mjs';
import { composeRequest } from '../src/protocol.mjs';
import * as state from '../src/state.mjs';
import { deliverToClaude, parseClaudeEnvelope } from '../src/transport.mjs';
import { listRecords } from '../src/store.mjs';

async function isolated(fn, scenario = 'ok') {
  const ws = makeWorkspace('fin hardening');
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['codex', 'omp']);
  const { env, logFile } = fakeEnv(ws, { scenario });
  Object.assign(env, { MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'), OMP_BIN: paths.omp, CODEX_BIN: paths.codex, FAKE_CHILD_PID_FILE: join(ws, 'descendant.pid') });
  Object.assign(process.env, env);
  setEmbedder(null);
  try { return await fn({ ws, env, logFile, paths }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function eventually(check, timeout = 10000) {
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
function stop(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }

// This text is a security instruction, not incidental formatting.
test('full and compact read-only reviews disclose web access and forbid repository disclosure', () => {
  for (const compact of [false, true]) {
    const frame = composeRequest({ taskId: 'review', task: 'inspect', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', replyTool: 'claude_peer', compact }).text;
    assert.match(frame, /file tools plus web search\/fetch/);
    assert.match(frame, /never send repository content to the web/);
  }
});

test('exchange and notice persistence redact every nested metadata string and credential field', () => isolated(() => {
  state.recordExchange('card', { kind: 'note', from: 'token=from-secret', to: 'password=to-secret', sender: { name: 'api_key=name-secret', token: 'raw-secret', nested: [{ value: 'password=nested-secret' }] }, text: 'safe text' });
  const notice = state.putNotice({ from: 'token=notice-from', sender: { name: 'password=notice-name', api_key: 'notice-key' }, cwd: 'token=cwd-secret', body: 'safe body' });
  const exchange = state.readExchange('card')[0];
  assert.equal(exchange.sender.token, '[REDACTED]');
  assert.equal(exchange.sender.nested[0].value, '[REDACTED]');
  assert.equal(exchange.text, 'safe text');
  assert.equal(notice.sender.api_key, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify([exchange, state.listNotices()]), /from-secret|to-secret|name-secret|raw-secret|nested-secret|notice-from|notice-name|notice-key|cwd-secret/);
}));

test('the first round closure survives later close attempts without duplicate exchange rows', () => isolated(() => {
  state.openRound({ taskId: 'card', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', round: 1 });
  state.closeRound({ taskId: 'card', round: 1, reason: 'abandoned', code: 'FIRST', detail: 'operator stopped it' });
  const before = state.readTask('card').rounds[0];
  state.closeRound({ taskId: 'card', round: 1, reason: 'timed_out', code: 'SECOND', detail: 'late timeout' });
  assert.deepEqual(state.readTask('card').rounds[0], before);
  assert.equal(state.readExchange('card').filter((row) => row.kind === 'closed').length, 1);
}));

test('stdout, stderr and stderr callbacks preserve UTF-8 split across three writes', () => isolated(async ({ ws }) => {
  const chunks = [];
  const result = await runCli('codex', [], { cwd: ws, timeoutMs: 10000, onStderr: (text) => chunks.push(text) });
  assert.equal(result.stdout, '€');
  assert.equal(result.stderr, '€');
  assert.equal(chunks.join(''), '€');
}, 'utf8-chunks'));

test('headless omp provenance uses launch approval rather than a yolo global default', () => isolated(async ({ ws }) => {
  const adapter = { peer: 'omp', headless: { bin: 'omp', args: headlessOmpArgs, channel: ompRpcSession } };
  for (const allowWrites of [false, true]) {
    const used = await runHeadless(adapter, { text: 'inspect', cwd: ws, allowWrites, timeoutMs: 10000 });
    assert.equal(used.approvalMode, allowWrites ? 'write' : 'always-ask');
    let queried = false;
    assert.equal(await ompPermissionClass({ headless: true, approvalMode: used.approvalMode }, async () => { queried = true; return 'yolo'; }), 'prompting');
    assert.equal(queried, false);
    assert.equal(await ompPermissionClass({ headless: true }, async () => { queried = true; return 'yolo'; }), null);
    assert.equal(queried, false);
  }
  let sender;
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer', pickDelivery: async () => ({ mode: 'headless' }), deliverHeadless: (options) => runHeadless(adapter, options), deliverReply: async (options) => { sender = options.sender; return { via: 'test' }; } });
  const result = await engine.handleRequest({ task: 'inspect', workingDirectory: ws, mode: 'REVIEW', wait: false });
  assert.equal(result.isError, undefined, textOf(result));
  await eventually(() => sender !== undefined);
  assert.equal(sender.headless, true);
  assert.equal(sender.approvalMode, 'always-ask');
  assert.equal(await ompPermissionClass(sender, async () => 'yolo'), 'prompting');
  await eventually(() => state.listMail(result.structuredContent.taskId).some((mail) => Boolean(mail.delivered)));
}));

test('combined adapters share a background cap and release a slot after failure', () => isolated(async ({ ws, env, logFile }) => {
  const server = await startServer('codex omp', { cwd: ws, as: 'claude', env: { ...env, MAGI_MAX_BACKGROUND: '4' } });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      server.call(i % 2 ? 'omp_peer' : 'codex_peer', { task: 'inspect ' + i, mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, wait: false, timeoutMs: 60000 })));
    for (const result of results) assert.equal(result.isError, undefined, textOf(result));
    await eventually(() => readCalls(logFile).length === 4);
    const refused = await server.call('codex_peer', { task: 'excess', delivery: 'headless', workingDirectory: ws, wait: false });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /BACKGROUND_LIMIT.*wait:true/);
    assert.equal(readCalls(logFile).length, 4);
    stop(readCalls(logFile)[0].pid);
    await eventually(() => listRecords(env.MAGI_HOME, 'workers').length === 3);
    const admitted = await server.call('codex_peer', { task: 'after failure', delivery: 'headless', workingDirectory: ws, wait: false });
    assert.equal(admitted.isError, undefined, textOf(admitted));
    await eventually(() => readCalls(logFile).length === 5);
  } finally {
    await server.close();
    for (const call of readCalls(logFile)) stop(call.pid);
  }
}, 'hang'));

for (const shutdown of ['stdin', 'SIGTERM']) {
  test(`server ${shutdown} shutdown terminates its headless child and descendant`, { skip: shutdown === 'SIGTERM' && isWin }, () => isolated(async ({ ws, env, logFile }) => {
    const server = await startServer('codex', { cwd: ws, env });
    let pid, descendant;
    try {
      const result = await server.call('codex_peer', { task: 'inspect', delivery: 'headless', workingDirectory: ws, wait: false, timeoutMs: 60000 });
      assert.equal(result.isError, undefined, textOf(result));
      await eventually(() => readCalls(logFile).length === 1 && existsSync(env.FAKE_CHILD_PID_FILE));
      pid = readCalls(logFile)[0].pid;
      descendant = Number(readFileSync(env.FAKE_CHILD_PID_FILE, 'utf8'));
      assert.equal(running(pid), true);
      assert.equal(running(descendant), true);
      if (shutdown === 'SIGTERM') process.kill(listRecords(env.MAGI_HOME, 'workers')[0].pid, 'SIGTERM');
      else await server.close();
      await eventually(() => !running(pid) && !running(descendant));
    } finally {
      await server.close();
      if (pid) stop(pid);
      if (descendant) stop(descendant);
    }
  }, 'tree-hang'));
}

test('Claude envelopes assert actual headless omp approval and never an inferred bypass', () => isolated(async ({ ws }) => {
  const config = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(config, 'sessions'), { recursive: true });
  writeFileSync(join(config, 'sessions', `${process.pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'fixture-token' }));
  const socket = isWin ? `\\\\.\\pipe\\magi-fin-${process.pid}-${Date.now()}` : join(ws, 'inbox');
  const frames = [];
  const inbox = net.createServer((connection) => {
    let body = '';
    connection.on('data', (chunk) => { body += chunk; });
    connection.on('end', () => { frames.push(...body.split('\n').filter(Boolean).map(JSON.parse)); });
  });
  await new Promise((resolve) => inbox.listen(socket, resolve));
  try {
    for (const approvalMode of ['always-ask', 'write', null]) {
      const prior = frames.length;
      await deliverToClaude({ target: { pid: process.pid, socket, sessionId: 'receiver' }, text: 'answer', sender: { agent: 'omp', name: 'headless omp', headless: true, approvalMode, mode: 'bypass' } });
      await eventually(() => frames.length === prior + 2);
      const envelope = parseClaudeEnvelope(frames.at(-1).message.content);
      assert.equal(envelope.fromMode, approvalMode ? 'prompting' : undefined);
      assert.match(envelope.body, /^answer/);
    }
  } finally { await new Promise((resolve) => inbox.close(resolve)); }
}));
