import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import * as state from '../src/state.mjs';
import { statement } from '../src/store.mjs';
import { makeEngine } from '../src/peer.mjs';
import { makeServerEngine } from '../src/serve.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, startServer, textOf } from './helpers/harness.mjs';

function homeFor(ws) {
  return join(ws, 'magi-home');
}

async function stateFor(ws) {
  process.env.MAGI_HOME = homeFor(ws);
  // Fresh module instance per workspace so MAGI_HOME is read at call time.
  return import('../src/state.mjs?' + Math.random());
}

test('a peer can ask a bounded number of clarifying questions', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'q1', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, maxRounds: 2 });

  // As many as a real question needs; the cap is the loop guard.
  for (let i = 1; i <= s.MAX_CLARIFIES_PER_ROUND; i++) {
    assert.equal(typeof s.recordClarify({ taskId: 'q1', from: 'codex' }), 'string');
    assert.equal(s.readTask('q1').rounds[0].clarifies, i);
  }
  assert.equal(s.MAX_CLARIFIES_PER_ROUND, 6);
  assert.throws(() => s.recordClarify({ taskId: 'q1', from: 'codex' }), (e) => e.code === 'CLARIFY_LIMIT');
});

test('the orchestrator cannot pose clarifying questions to itself', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'q2', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, maxRounds: 2 });
  assert.throws(() => s.recordClarify({ taskId: 'q2', from: 'claude' }), (e) => e.code === 'ROLE_VIOLATION');
});

test('clarifying does not consume a round', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'q3', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 1, maxRounds: 2 });
  s.recordClarify({ taskId: 'q3', from: 'codex' });
  s.recordReply({ taskId: 'q3', from: 'codex' });
  const rec = s.openRound({ taskId: 'q3', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 2, maxRounds: 2 });
  assert.equal(rec.rounds.length, 2, 'the clarify should not have used up round 2');
});

test('a peer cannot clarify after it has already answered', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'q4', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, maxRounds: 2 });
  s.recordReply({ taskId: 'q4', from: 'codex' });
  assert.throws(() => s.recordClarify({ taskId: 'q4', from: 'codex' }), (e) => e.code === 'ALREADY_REPLIED');
});

test('a waiting orchestrator wakes on the question rather than the reply', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'q5', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, maxRounds: 2 });

  const waiting = s.waitForReply('q5', 8000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.isWaiting('q5'), true);
  s.recordClarify({ taskId: 'q5', body: 'Which branch is the baseline?', from: 'codex' });

  const got = await waiting;
  assert.equal(got.kind, 'clarify');
  assert.match(got.body, /baseline/);
});

// The server exits under PEER_DEPTH (bridge.test.mjs); the engine still
// refuses on its own, should anything else ever construct one in a peer.
test('a clarify still cannot turn the peer into an orchestrator', async () => {
  const { makeEngine } = await import('../src/peer.mjs');
  const before = process.env.PEER_DEPTH;
  process.env.PEER_DEPTH = '1';
  try {
    await assert.rejects(makeEngine({ orchestrator: 'claude', peerName: 'codex' }).handleClarifyAnswer({ taskId: 'whatever', body: 'answer' }), { code: 'RECURSION_BLOCKED' });
  } finally {
    if (before === undefined) delete process.env.PEER_DEPTH;
    else process.env.PEER_DEPTH = before;
  }
});

test('a clarify answer on an unknown task is refused', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws);
  const { env } = fakeEnv(ws);
  const s = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex, MAGI_HOME: homeFor(ws) } });
  try {
    const res = await s.call('codex_peer', { kind: 'clarify_answer', taskId: 'never-opened', body: 'answer' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /UNKNOWN_TASK/);
  } finally {
    await s.close();
  }
});

function clarifySetup({ supportsSteer = true, status = 'busy' } = {}) {
  const cwd = makeWorkspace();
  process.env.MAGI_HOME = homeFor(cwd);
  process.env.MAGI_AS = 'claude';
  state.openRound({ taskId: 'incident', orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', round: 1, cwd });
  state.setPeerTarget('incident', { id: 'worker', cwd });
  const delivered = [];
  const { engine: coordinator } = makeServerEngine({
    peer: 'codex', selfDefault: 'claude', replyTool: () => 'claude_peer',
    schema: { deliveries: supportsSteer ? ['auto', 'live', 'steer'] : ['auto', 'live'] },
    sessions: async () => [{ id: 'worker', cwd, status }],
    deliverLive: async (args) => {
      delivered.push(args);
      return { via: 'live:worker', deliveryStatus: args.delivery === 'steer' ? 'accepted' : 'queued_unread' };
    },
  });
  const frames = [];
  const worker = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    deliverReply: async (args) => { frames.push(args.text); return { via: 'live:coordinator', deliveryStatus: 'queued_unread' }; },
  });
  return { cwd, delivered, coordinator, worker, frames };
}

test('async clarify records a distinct question, returns after steered delivery, and refuses a repeated answer', async () => {
  const { coordinator, worker, delivered, frames } = clarifySetup();
  const asked = await worker.handleClarify({ taskId: 'incident', body: 'Which baseline?' });
  const id = asked.structuredContent.questionId;
  assert.equal(typeof id, 'string');
  const question = state.readQuestion('incident', id);
  assert.equal(question.body, 'Which baseline?');
  assert.equal(question.round, 1);
  assert.equal(question.answeredAt, null);
  assert.equal(typeof question.askedAt, 'number');
  assert.match(asked.structuredContent.next, /Continue with what does not depend on the answer/);
  assert.doesNotMatch(frames[0], /resumes.*wait/);
  assert.ok(frames[0].includes(id));
  const answer = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: id, body: 'master', timeoutMs: 1 });
  assert.equal(answer.isError, undefined);
  assert.equal(answer.structuredContent.timedOut, undefined);
  assert.equal(answer.structuredContent.delivery, 'steer');
  assert.equal(answer.structuredContent.deliveryStatus, 'accepted');
  assert.match(answer.structuredContent.next, /PEER REPLY/);
  assert.equal(state.isWaiting('incident'), false);
  assert.equal(state.readTask('incident').rounds[0].closedAt, undefined);
  assert.equal(delivered[0].delivery, 'steer');
  const answered = state.readQuestion('incident', id);
  assert.equal(answered.answer, 'master');
  const duplicate = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: id, body: 'main' });
  assert.equal(duplicate.isError, true);
  assert.match(textOf(duplicate), /ALREADY_ANSWERED/);
  assert.ok(textOf(duplicate).includes(new Date(answered.answeredAt).toISOString()));
  assert.match(textOf(duplicate), /note/);
  assert.equal(delivered.length, 1);
  assert.deepEqual(state.readExchange('incident').filter((e) => e.kind === 'clarification').map((e) => e.text), ['master']);
});

for (const [supportsSteer, status] of [[false, 'busy'], [true, 'idle']]) {
  test(`clarify answer queues when steer=${supportsSteer} and worker status=${status}`, async () => {
    const { coordinator, worker, delivered } = clarifySetup({ supportsSteer, status });
    const asked = await worker.handleClarify({ taskId: 'incident', body: 'Which baseline?' });
    const answer = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: asked.structuredContent.questionId, body: 'master', timeoutMs: 1 });
    assert.equal(answer.structuredContent.delivery, 'queued');
    assert.equal(answer.structuredContent.deliveryStatus, 'queued_unread');
    assert.equal(delivered[0].delivery, 'live');
    assert.equal(state.readTask('incident').rounds[0].closedAt, undefined);
  });
}

test('questions and final reply coexist without overwriting each other', async () => {
  const { worker } = clarifySetup();
  state.markWaiting('incident', 1);
  const one = await worker.handleClarify({ taskId: 'incident', body: 'Baseline?' });
  const two = await worker.handleClarify({ taskId: 'incident', body: 'Scope?' });
  state.recordReply({ taskId: 'incident', from: 'codex', round: 1, payload: { body: 'Completed independent work', round: 1 } });
  assert.deepEqual(state.listMail('incident').map((m) => m.body).sort(), ['Baseline?', 'Completed independent work', 'Scope?']);
  const first = await state.waitForReply('incident', 1000, undefined, 1);
  assert.equal(first.questionId, one.structuredContent.questionId);
  const second = await state.waitForReply('incident', 1000, undefined, 1);
  assert.equal(second.questionId, two.structuredContent.questionId);
  const reply = await state.waitForReply('incident', 1000, undefined, 1);
  assert.equal(reply.body, 'Completed independent work');
});

test('omitted questionId is refused without answering any question, including on round two', async () => {
  const { coordinator, worker } = clarifySetup();
  await worker.handleClarify({ taskId: 'incident', body: 'Old question' });
  state.recordReply({ taskId: 'incident', from: 'codex', round: 1 });
  state.openRound({ taskId: 'incident', orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', round: 2, maxRounds: 2 });
  const one = await worker.handleClarify({ taskId: 'incident', round: 2, body: 'First?' });
  const two = await worker.handleClarify({ taskId: 'incident', round: 2, body: 'Second?' });
  const refused = await coordinator.handleClarifyAnswer({ taskId: 'incident', body: 'Ambiguous answer', timeoutMs: 1 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /BAD_REQUEST/);
  assert.match(textOf(refused), /Every PEER QUESTION frame carries question_id/);
  for (const question of state.listQuestions('incident')) {
    assert.ok(textOf(refused).includes(question.id));
    assert.equal(question.answeredAt, null);
  }
  assert.equal(state.readExchange('incident').filter((e) => e.kind === 'clarification').length, 0);
  const answer = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: one.structuredContent.questionId, body: 'First answer', timeoutMs: 1 });
  assert.equal(answer.structuredContent.questionId, one.structuredContent.questionId);
  const next = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: two.structuredContent.questionId, body: 'Second answer', timeoutMs: 1 });
  assert.equal(next.structuredContent.questionId, two.structuredContent.questionId);
  assert.equal(state.listQuestions('incident', 1)[0].answeredAt, null);
});

test('question answer and history roll back together on database failure', async () => {
  const { coordinator, worker, delivered } = clarifySetup();
  const asked = await worker.handleClarify({ taskId: 'incident', body: 'Baseline?' });
  const db = statement(process.env.MAGI_HOME, `CREATE TRIGGER reject_answer BEFORE INSERT ON exchanges
    WHEN json_extract(NEW.value,'$.kind')='clarification' BEGIN SELECT RAISE(ABORT,'fixture history failure'); END`);
  db.run();
  const answer = await coordinator.handleClarifyAnswer({ taskId: 'incident', questionId: asked.structuredContent.questionId, body: 'master' });
  assert.equal(answer.isError, true);
  assert.equal(state.readQuestion('incident', asked.structuredContent.questionId).answeredAt, null);
  assert.equal(delivered.length, 0);
});

test('a blocking request interrupted by a question resumes waiting for its final reply', async () => {
  const cwd = makeWorkspace();
  process.env.MAGI_HOME = homeFor(cwd);
  const worker = makeEngine({ orchestrator: 'codex', peerName: 'claude' });
  const coordinator = makeEngine({
    orchestrator: 'claude', peerName: 'codex',
    pickDelivery: async () => ({ mode: 'live', target: 'worker' }),
    deliverLive: async ({ taskId, text }) => {
      if (text.startsWith('PEER CLARIFICATION')) {
        state.recordReply({ taskId, from: 'codex', round: 1, payload: { round: 1, body: 'SUMMARY\nCompared against master' } });
      } else {
        await worker.handleClarify({ taskId, body: 'Baseline?' });
      }
      return { via: 'live:worker', deliveryStatus: 'queued_unread' };
    },
  });
  const question = await coordinator.handleRequest({ task: 'compare', wait: true, workingDirectory: cwd, timeoutMs: 1000 });
  assert.equal(question.structuredContent.needsClarification, true);
  const result = await coordinator.handleClarifyAnswer({ taskId: question.structuredContent.taskId, questionId: question.structuredContent.questionId, body: 'master', timeoutMs: 1000 });
  assert.equal(result.structuredContent.deliveryStatus, 'received');
  assert.match(result.structuredContent.body, /Compared against master/);
});

test('a question filed while delivery is in flight goes out of band when the waiter is cancelled', async () => {
  const cwd = makeWorkspace();
  process.env.MAGI_HOME = homeFor(cwd);
  const controller = new AbortController();
  const sent = [];
  const worker = makeEngine({ orchestrator: 'codex', peerName: 'claude' });
  const coordinator = makeEngine({
    orchestrator: 'claude', peerName: 'codex',
    pickDelivery: async () => ({ mode: 'live', target: 'worker' }),
    deliverLive: async ({ taskId }) => {
      const asked = await worker.handleClarify({ taskId, body: 'Baseline?' });
      assert.equal(asked.structuredContent.deliveryStatus, 'queued_unread');
      controller.abort();
      return { via: 'live:worker', deliveryStatus: 'queued_unread' };
    },
    deliverReply: async ({ text }) => { sent.push(text); return { deliveryStatus: 'queued_unread' }; },
  });
  const result = await coordinator.handleRequest({ task: 'compare', wait: true, workingDirectory: cwd, timeoutMs: 1000 }, { signal: controller.signal });
  assert.match(textOf(result), /CANCELLED/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^PEER QUESTION/);
  assert.doesNotMatch(sent[0], /resumes.*wait/);
  const question = state.listQuestions(result.structuredContent?.taskId ?? state.listTasks()[0].taskId)[0];
  assert.equal(typeof question.deliveredAt, 'number');
});

test('a question filed after its waiter exits is handed off out of band', async () => {
  const { frames } = clarifySetup();
  state.markWaiting('incident', 1);
  const worker = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    resolveOrigin: async () => { state.clearWaiting('incident', 1); return null; },
    deliverReply: async ({ text }) => { frames.push(text); return { deliveryStatus: 'queued_unread' }; },
  });
  const result = await worker.handleClarify({ taskId: 'incident', body: 'Baseline?' });
  assert.equal(result.structuredContent.deliveryStatus, 'queued_unread');
  assert.equal(frames.length, 1);
  assert.equal(typeof state.readQuestion('incident', result.structuredContent.questionId).deliveredAt, 'number');
});

test('MCP preserves questionId and rejects the identified answered question instead of answering another', async () => {
  const { cwd } = clarifySetup();
  const pending = state.recordClarify({ taskId: 'incident', from: 'codex', body: 'Still open?' });
  const answered = state.recordClarify({ taskId: 'incident', from: 'codex', body: 'Already settled?' });
  state.recordClarifyAnswer({ taskId: 'incident', from: 'claude', questionId: answered, body: 'Settled' });
  const { env } = fakeEnv(cwd);
  const server = await startServer('codex', { cwd, as: 'claude', env: { ...env, CODEX_BIN: join(cwd, 'absent'), MAGI_HOME: process.env.MAGI_HOME } });
  try {
    const result = await server.call('codex_peer', { kind: 'clarify_answer', taskId: 'incident', questionId: answered, body: 'Repeated' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ALREADY_ANSWERED/);
    assert.equal(state.readQuestion('incident', pending).answeredAt, null);
    assert.equal(state.readQuestion('incident', answered).answer, 'Settled');
  } finally { await server.close(); }
});

test('explicit steer failure records one answer, reports the failure, and does not close async work', async () => {
  clarifySetup();
  const questionId = state.recordClarify({ taskId: 'incident', from: 'codex', body: 'Baseline?' });
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex',
    deliverLive: async () => { throw Object.assign(new Error('fixture uncertain send'), { code: 'STEER_TIMEOUT' }); },
  });
  const failed = await engine.handleClarifyAnswer({ taskId: 'incident', questionId, body: 'master', delivery: 'steer' });
  assert.match(textOf(failed), /STEER_TIMEOUT/);
  assert.equal(state.readQuestion('incident', questionId).answer, 'master');
  assert.equal(state.readTask('incident').rounds[0].closedAt, undefined);
  const duplicate = await engine.handleClarifyAnswer({ taskId: 'incident', questionId, body: 'main', delivery: 'steer' });
  assert.match(textOf(duplicate), /ALREADY_ANSWERED/);
});

test('wait:false on a normally blocking review also keeps its clarification answer nonblocking', async () => {
  const cwd = makeWorkspace();
  process.env.MAGI_HOME = homeFor(cwd);
  const coordinator = makeEngine({
    orchestrator: 'claude', peerName: 'codex',
    pickDelivery: async () => ({ mode: 'live', target: 'worker' }),
    deliverLive: async () => ({ via: 'live:worker', deliveryStatus: 'queued_unread' }),
  });
  const request = await coordinator.handleRequest({ task: 'compare', mode: 'REVIEW', wait: false, workingDirectory: cwd });
  assert.equal(request.structuredContent.waiting, false);
  const worker = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    deliverReply: async () => ({ deliveryStatus: 'queued_unread' }),
  });
  const question = await worker.handleClarify({ taskId: request.structuredContent.taskId, body: 'Baseline?' });
  const result = await coordinator.handleClarifyAnswer({ taskId: request.structuredContent.taskId, questionId: question.structuredContent.questionId, body: 'master', timeoutMs: 1 });
  assert.match(result.structuredContent.next, /PEER REPLY/);
  assert.equal(result.structuredContent.timedOut, undefined);
  assert.equal(state.readTask(request.structuredContent.taskId).rounds[0].closedAt, undefined);
});
