import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace, textOf } from './helpers/harness.mjs';
import { makeServerEngine, makePickDelivery } from '../src/serve.mjs';
import { selfName } from '../src/peer.mjs';
import { readTask, readExchange, roundDeliveries, sameSession, setPeerTarget } from '../src/state.mjs';

function fixture(t) {
  const cwd = makeWorkspace('omp same harness');
  const values = { MAGI_HOME: join(cwd, 'home'), MAGI_AS: '', PEER_DEPTH: '', MAGI_WORKER_WRAPPER: '' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const session = (id, pid) => ({ agent: 'omp', id, sessionId: id, name: id, pid, processStartedAt: `birth-${pid}`, cwd, live: true });
  const owner = session('owner', 10001);
  const worker = session('worker', 10002);
  const stranger = session('stranger', 10003);
  const sessions = [owner, worker, stranger];
  const sent = [];
  const receipt = (kind, target, text) => {
    sent.push({ kind, target, text });
    return { via: 'omp-inbox', target, messageId: `message-${sent.length}`, deliveryStatus: 'queued_unread' };
  };
  const adapter = {
    peer: 'omp', selfDefault: 'omp', replyTool: () => 'omp_peer',
    schema: { deliveries: ['auto', 'live', 'headless'] },
    sessions: async () => sessions,
    deliverLive: async ({ kind = 'request', target, text }) => receipt(kind, target, text),
    deliverReply: async ({ task, text }) => receipt('reply', task.orchestratorTarget, text),
  };
  const engine = (caller, verified = true) => makeServerEngine(adapter, {
    resolveOrigin: async () => ({ target: caller, identityVerified: verified, identitySource: verified ? 'test_runtime' : 'model_claim' }),
  }).engine;
  const request = (taskId, extra = {}) => engine(owner).handleRequest({ taskId, task: 'Inspect the session boundary', workingDirectory: cwd, delivery: 'live', wait: false, ...extra });
  return { cwd, owner, worker, stranger, sessions, sent, adapter, engine, request };
}

function ok(result) { assert.notEqual(result.isError, true, textOf(result)); return result; }
function refused(result, code = 'ROLE_VIOLATION') {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), new RegExp(code));
}

test('OMP may name OMP as its peer, but other same-harness defaults remain refused', (t) => {
  fixture(t);
  assert.equal(selfName('omp', 'omp'), 'omp');
  assert.throws(() => selfName('codex', 'codex'), { code: 'BAD_REQUEST' });
  process.env.MAGI_AS = 'omp';
  assert.equal(selfName('codex', 'omp'), 'omp');
});

test('OMP discovery and transcript inspection do not present the caller as its own peer', async (t) => {
  const f = fixture(t);
  const owner = f.engine(f.owner);
  const peers = ok(await owner.handlePeers({ workingDirectory: f.cwd }));
  assert.deepEqual(peers.structuredContent.peers.map((p) => p.id), ['worker', 'stranger']);
  assert.equal(peers.structuredContent.chosen, 'worker');
  refused(await owner.handleTranscript({ peer: 'owner', workingDirectory: f.cwd }), 'SELF_TARGET');
  refused(await owner.handleWatch({ peer: 'owner', workingDirectory: f.cwd }), 'SELF_TARGET');
});

test('two OMP sessions converse through the real server engine with independent delivery directions', async (t) => {
  const f = fixture(t);
  const owner = f.engine(f.owner);
  const worker = f.engine(f.worker);
  const opened = ok(await f.request('conversation'));
  assert.equal(opened.structuredContent.callerIdentity.agent, 'omp');
  assert.equal(opened.structuredContent.callerIdentity.id, 'owner');
  assert.equal(f.sent[0].target.id, 'worker', 'automatic selection must skip the first listed session: the caller');
  assert.match(f.sent[0].text, /omp_peer/);
  assert.doesNotMatch(f.sent[0].text, /codex_peer/);
  assert.equal(readTask('conversation').orchestrator, 'omp');
  assert.equal(readTask('conversation').peer, 'omp');

  ok(await owner.handleNote({ taskId: 'conversation', body: 'Please inspect session identity.' }));
  assert.equal(f.sent.at(-1).target.id, 'worker');
  ok(await worker.handleNote({ taskId: 'conversation', body: 'I am examining the recorded roles.' }));
  assert.equal(f.sent.at(-1).target.id, 'owner');
  assert.deepEqual(readExchange('conversation').filter((e) => e.kind === 'note').map((e) => e.fromRole), ['orchestrator', 'peer']);

  const asked = ok(await worker.handleClarify({ taskId: 'conversation', round: 1, body: 'Should aliases count as the same session?' }));
  assert.equal(f.sent.at(-1).target.id, 'owner');
  ok(await owner.handleClarifyAnswer({ taskId: 'conversation', questionId: asked.structuredContent.questionId, body: 'Yes, retain the verified alias identity.' }));
  assert.equal(f.sent.at(-1).target.id, 'worker');
  const requestReceipt = roundDeliveries(readTask('conversation').rounds[0]).peer.messageId;
  ok(await worker.handleReply({ taskId: 'conversation', round: 1, body: 'SUMMARY\nThe two session roles stay distinct.' }));
  assert.equal(f.sent.at(-1).target.id, 'owner');
  const receipts = roundDeliveries(readTask('conversation').rounds[0]);
  assert.deepEqual(Object.keys(receipts).sort(), ['orchestrator', 'peer']);
  assert.equal(receipts.peer.messageId, requestReceipt, 'reply must not replace the outbound receipt');
  assert.equal(receipts.peer.to, 'omp');
  assert.equal(receipts.orchestrator.to, 'omp');
  assert.equal(receipts.peer.toRole, 'peer');
  assert.equal(receipts.orchestrator.toRole, 'orchestrator');
  ok(await owner.handleOutcome({ taskId: 'conversation', accepted: 1, body: 'Verified the session routing.' }));
  ok(await f.request('conversation', { task: 'Inspect the next turn.' }));
  assert.equal(readTask('conversation').rounds.length, 2);
  ok(await owner.handleClose({ taskId: 'conversation', body: 'No further review needed.' }));
  assert.equal(readTask('conversation').rounds[1].closeReason, 'abandoned');
});

test('wrong and unverified OMP sessions cannot act on either recorded card role', async (t) => {
  const f = fixture(t);
  ok(await f.request('roles'));
  const worker = f.engine(f.worker);
  const question = ok(await worker.handleClarify({ taskId: 'roles', body: 'Which endpoint?' }));
  const questionId = question.structuredContent.questionId;
  const verbs = [
    ['handleRequest', { task: 'Take over the card', workingDirectory: f.cwd, wait: false }, f.worker],
    ['handleReply', { body: 'False reply', round: 1 }, f.owner],
    ['handleClarify', { body: 'False question', round: 1 }, f.owner],
    ['handleClarifyAnswer', { body: 'False answer', questionId }, f.worker],
    ['handleOutcome', { accepted: 1 }, f.worker],
    ['handleClose', {}, f.worker],
  ];
  const before = JSON.stringify(readTask('roles'));
  const deliveries = f.sent.length;
  for (const [method, args, wrongRole] of verbs) {
    for (const caller of [f.engine(wrongRole), f.engine(f.stranger), f.engine(f.owner, false), f.engine(f.worker, false), f.engine(null)]) {
      refused(await caller[method]({ taskId: 'roles', ...args }));
    }
  }
  for (const caller of [f.engine(f.stranger), f.engine(f.owner, false), f.engine(f.worker, false), f.engine(null)]) {
    refused(await caller.handleNote({ taskId: 'roles', body: 'Unowned card note' }));
  }
  assert.equal(f.sent.length, deliveries);
  assert.equal(JSON.stringify(readTask('roles')), before, 'refused calls must not mutate the card');
  ok(await f.engine(f.owner).handleClarifyAnswer({ taskId: 'roles', questionId, body: 'Use the recorded peer.' }));
  ok(await worker.handleReply({ taskId: 'roles', body: 'SUMMARY\nLegitimate reply still works.' }));
});

test('OMP self-targets are refused by name, id, alias, pid and resumed headless id before dispatch', async (t) => {
  const f = fixture(t);
  f.owner.sessionAliases = ['old-owner'];
  for (const peer of ['owner', 'omp:owner', 'old-owner', String(f.owner.pid)]) {
    refused(await f.request(`self-${peer.replace(/:/g, '-')}`, { peer }), 'SELF_TARGET');
  }
  refused(await f.request('self-resume', { delivery: 'headless', resumeThreadId: 'owner' }), 'SELF_TARGET');
  refused(await f.engine(f.owner).handleNote({ peer: 'owner', body: 'Self note', workingDirectory: f.cwd }), 'SELF_TARGET');
  assert.equal(f.sent.length, 0);
  assert.equal(readTask('self-resume'), null);
  const sibling = { ...f.worker, pid: f.owner.pid, processStartedAt: f.owner.processStartedAt };
  f.sessions.splice(1, 1, sibling);
  refused(await f.request('same-endpoint', { peer: 'worker' }), 'SELF_TARGET');
  assert.equal(readTask('same-endpoint'), null);
});

test('OMP selection fails closed without caller identity and excludes unverifiable candidates', async (t) => {
  const f = fixture(t);
  const args = { taskId: 'unknown-origin', task: 'Must not dispatch', workingDirectory: f.cwd, delivery: 'live', wait: false };
  for (const caller of [f.engine(null), f.engine(f.owner, false), f.engine({ agent: 'omp', pid: f.owner.pid })]) {
    refused(await caller.handleRequest(args), 'AMBIGUOUS_ORIGIN');
  }
  assert.equal(readTask('unknown-origin'), null);
  assert.equal(f.sent.length, 0);
  const picker = makePickDelivery(f.adapter);
  f.sessions.splice(1, 2, { agent: 'omp', pid: 10004, name: 'unidentified', cwd: f.cwd, live: true });
  const caller = { ...f.owner, identityVerified: true };
  assert.equal((await picker({ delivery: 'auto', cwd: f.cwd, caller })).mode, 'headless');
  await assert.rejects(picker({ delivery: 'live', target: 'unidentified', cwd: f.cwd, caller }), { code: 'AMBIGUOUS_ORIGIN' });
  assert.equal(sameSession({ agent: 'omp', pid: 10004 }, { agent: 'omp', pid: 10004 }), null);
});

test('same-harness card roles fail closed when recorded endpoints are missing or overlap', async (t) => {
  const f = fixture(t);
  ok(await f.request('ambiguous-card'));
  for (const endpoint of [null, f.owner]) {
    setPeerTarget('ambiguous-card', endpoint, 1);
    for (const method of ['handleClose', 'handleOutcome', 'handleReply', 'handleClarify', 'handleClarifyAnswer']) {
      refused(await f.engine(f.owner)[method]({ taskId: 'ambiguous-card', body: 'Must not act', questionId: 'missing' }));
    }
    refused(await f.engine(f.owner).handleNote({ taskId: 'ambiguous-card', body: 'Must not route' }), endpoint ? 'ROLE_VIOLATION' : 'NO_LIVE_PEER');
  }
});

test('OMP late replies stay bound to the worker of their own round', async (t) => {
  const f = fixture(t);
  ok(await f.request('round-workers'));
  ok(await f.engine(f.owner).handleClose({ taskId: 'round-workers' }));
  ok(await f.request('round-workers', { peer: 'stranger' }));
  refused(await f.engine(f.stranger).handleReply({ taskId: 'round-workers', round: 1, body: 'Wrong worker for this turn' }));
  refused(await f.engine(f.worker).handleReply({ taskId: 'round-workers', round: 2, body: 'Wrong worker for this turn' }));
  ok(await f.engine(f.worker).handleReply({ taskId: 'round-workers', round: 1, body: 'SUMMARY\nLate answer from the original worker.' }));
  assert.equal(readTask('round-workers').rounds[0].replied, true);
  assert.equal(readTask('round-workers').rounds[1].replied, false);
  ok(await f.engine(f.stranger).handleReply({ taskId: 'round-workers', round: 2, body: 'SUMMARY\nAnswer from the replacement worker.' }));
  assert.equal(readTask('round-workers').rounds[1].replied, true);
});
