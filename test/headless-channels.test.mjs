import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { readTask, readPersona, listTasks } from '../src/state.mjs';
import { channelsOf } from '../src/fleet.mjs';

let savedEnv;
test.beforeEach(() => { savedEnv = { ...process.env }; });
test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function fixture(overrides = {}) {
  const cwd = makeWorkspace('headless channels');
  process.env.MAGI_HOME = join(cwd, 'home');
  process.env.PEER_DEPTH = '0';
  Object.assign(process.env, { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'claude-cfg'), CLAUDE_APP_SESSIONS_DIR: join(cwd, 'claude-app'), CODEX_HOME: join(cwd, 'codex-home'), OMP_AGENT_DIR: join(cwd, 'omp-agent') });
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', id: 'coordinator', name: 'lead' }, replyTo: 'claude:coordinator' }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ via: 'headless', threadId: 'worker-session', inlineReply: 'Verified answer' }),
    deliverReply: async () => ({ deliveryStatus: 'received' }),
    ...overrides,
  });
  return { cwd, engine };
}

test('blocking headless sessions persist on tasks, and a resumed persona groups by its actual session', async () => {
  const resumes = [];
  const { cwd, engine } = fixture({ deliverHeadless: async ({ resumeThreadId }) => {
    resumes.push(resumeThreadId);
    return { via: 'headless', threadId: 'worker-session', inlineReply: 'Verified answer' };
  } });
  const first = await engine.handleRequest({ task: 'First card', persist: 'reviewer', workingDirectory: cwd, wait: true });
  const second = await engine.handleRequest({ task: 'Next card', persist: 'reviewer', workingDirectory: cwd, wait: true });
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.deepEqual(resumes, [undefined, 'worker-session']);
  for (const result of [first, second]) assert.deepEqual(readTask(result.structuredContent.taskId).peerTarget, { harness: 'omp', id: 'worker-session', headless: true, name: 'reviewer' });
  assert.equal(readPersona('claude', cwd, 'reviewer', 'omp').sessionId, 'worker-session');
  const channels = channelsOf(listTasks());
  assert.equal(channels.length, 1);
  assert.equal(channels[0].toId, 'worker-session');
  assert.deepEqual(new Set(channels[0].turns.map((t) => t.taskId)), new Set([first.structuredContent.taskId, second.structuredContent.taskId]));
});

test('background headless settlement records session identity before delivering the reply, including immediate completion', { timeout: 5000 }, async () => {
  let delivered;
  const completion = new Promise((resolve) => { delivered = resolve; });
  const { cwd, engine } = fixture({ deliverReply: async ({ task }) => {
    delivered(task);
    return { deliveryStatus: 'received' };
  } });
  const result = await engine.handleRequest({ task: 'Background card', workingDirectory: cwd, wait: false });
  assert.equal(result.isError, undefined);
  const deliveredTask = await completion;
  await new Promise(setImmediate);
  assert.deepEqual(deliveredTask.peerTarget, { harness: 'omp', id: 'worker-session', headless: true });
  const task = readTask(result.structuredContent.taskId);
  assert.equal(task.rounds[0].replied, true);
  assert.deepEqual(task.peerTarget, deliveredTask.peerTarget, 'request bookkeeping must not overwrite an already settled worker');
});

test('live fallback records the headless session rather than the unreachable live worker', async () => {
  const { cwd, engine } = fixture({
    pickDelivery: async () => ({ mode: 'live', target: { id: 'unreachable', name: 'old worker' } }),
    deliverLive: async () => { throw Object.assign(new Error('Unavailable'), { code: 'NO_LIVE_PEER', fallback: true, dispatchUncertain: false }); },
  });
  const result = await engine.handleRequest({ task: 'Fallback card', workingDirectory: cwd, wait: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(readTask(result.structuredContent.taskId).peerTarget, { harness: 'omp', id: 'worker-session', headless: true });
  assert.equal(channelsOf(listTasks())[0].toId, 'worker-session');
});

test('fallback without a returned session discards the live identity and isolates each fresh worker', async () => {
  const { cwd, engine } = fixture({
    pickDelivery: async () => ({ mode: 'live', target: { id: 'unreachable', name: 'old worker' } }),
    deliverLive: async () => { throw Object.assign(new Error('Unavailable'), { code: 'NO_LIVE_PEER', fallback: true, dispatchUncertain: false }); },
    deliverHeadless: async () => ({ via: 'headless', inlineReply: 'Verified answer' }),
  });
  const first = await engine.handleRequest({ task: 'First fallback', workingDirectory: cwd, wait: true });
  const second = await engine.handleRequest({ task: 'Second fallback', workingDirectory: cwd, wait: true });
  for (const result of [first, second]) assert.deepEqual(readTask(result.structuredContent.taskId).peerTarget, { harness: 'omp', id: null, headless: true });
  const channels = channelsOf(listTasks());
  assert.equal(channels.length, 2);
  assert.ok(channels.every((c) => c.toId === null && c.turns.length === 1));
});
