// steerReply: a headless peer has no tools, so the orchestrator asks at request
// time for the reply to reach it mid-turn; the background settle honours it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace } from './helpers/harness.mjs';
import { processStartedAt } from '../omp/process-identity.js';

async function engineFor(deliverReply, orchestrator = 'codex') {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator,
    peerName: 'claude',
    replyTool: 'codex_peer',
    replyAddress: () => null,
    listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => assert.fail('must not be reached'),
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nlooks fine', via: 'headless' }),
    deliverReply,
  });
  return { engine, ws };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

test('a steerReply headless reply is sent home by steer', async () => {
  const calls = [];
  const { engine, ws } = await engineFor(async ({ delivery }) => { calls.push(delivery); });
  const res = await engine.handleRequest({ task: 'review', mode: 'REVIEW', workingDirectory: ws, steerReply: true }, {});
  assert.equal(res.isError, undefined);
  await settle();
  assert.deepEqual(calls, ['steer']);
});

test('a failed steer falls back to the normal route and says so; a timed-out one does not resend', async () => {
  const calls = [];
  const { engine, ws } = await engineFor(async ({ delivery, text }) => {
    calls.push({ delivery, text });
    if (delivery === 'steer') throw Object.assign(new Error('no pipe'), { code: 'NO_STEER_CHANNEL' });
  });
  await engine.handleRequest({ task: 'review', mode: 'REVIEW', workingDirectory: ws, steerReply: true }, {});
  await settle();
  assert.deepEqual(calls.map((c) => c.delivery), ['steer', 'auto']);
  assert.match(calls[1].text, /steer failed \(NO_STEER_CHANNEL/);

  const again = [];
  const t = await engineFor(async ({ delivery }) => {
    again.push(delivery);
    throw Object.assign(new Error('slow'), { code: 'STEER_TIMEOUT' });
  });
  await t.engine.handleRequest({ task: 'review', mode: 'REVIEW', workingDirectory: t.ws, steerReply: true }, {});
  await settle();
  assert.deepEqual(again, ['steer'], 'the steer may have landed; the mailbox holds it rather than a second copy');
});

test('without steerReply the reply is queued as before; a Claude orchestrator is refused', async () => {
  const calls = [];
  const { engine, ws } = await engineFor(async ({ delivery }) => { calls.push(delivery); });
  await engine.handleRequest({ task: 'review', mode: 'REVIEW', workingDirectory: ws }, {});
  await settle();
  assert.deepEqual(calls, ['auto']);

  // The refusal is the adapter layer's: the server built for a Claude host says
  // no, the engine itself only asks.
  const ws2 = makeWorkspace();
  process.env.MAGI_HOME = join(ws2, 'home');
  process.env.MAGI_AS = 'claude';
  try {
    const { makeServerEngine } = await import('../src/serve.mjs?' + Math.random());
    const { adapter } = await import('../src/codex-adapter.mjs?' + Math.random());
    const { engine: claudeHosted } = makeServerEngine(adapter);
    const res = await claudeHosted.handleRequest({ task: 'review', mode: 'REVIEW', workingDirectory: ws2, steerReply: true }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /STEER_UNSUPPORTED/);
  } finally {
    delete process.env.MAGI_AS;
  }
});

test('a live peer is told to reply by steer when asked', async () => {
  const { composeRequest } = await import('../src/protocol.mjs');
  const base = { taskId: 't1', orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1, maxRounds: 2, task: 'x', replyTool: 'codex_peer', replyVia: 'tool' };
  assert.match(composeRequest({ ...base, steerReply: true }).text, /delivery="steer"/);
  assert.doesNotMatch(composeRequest(base).text, /delivery="steer"/);
});

test('deliverTo refuses to steer a Claude session and steers a shim agent by frame', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const t = await import('../src/transport.mjs?' + Math.random());
  await assert.rejects(t.deliverTo({ agent: 'claude', socket: 'x' }, 'hi', { steer: true }), { code: 'STEER_UNSUPPORTED' });
  const { setRecord, statement } = await import('../src/store.mjs');
  setRecord(process.env.MAGI_HOME, 'agents', String(process.pid), { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), name: 'o1', cwd: ws, startedAt: Date.now() });
  await t.deliverTo({ agent: 'omp', pid: process.pid }, 'hi', { steer: true });
  const frame = JSON.parse(statement(process.env.MAGI_HOME, 'SELECT body FROM frames WHERE to_pid=?').get(process.pid).body);
  assert.equal(frame.deliverAs, 'steer');
});
