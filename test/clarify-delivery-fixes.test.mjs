import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, fakeEnv, textOf } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { makeServerEngine } from '../src/serve.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { processStartedAt } from '../omp/process-identity.js';
import { statement, setRecord } from '../src/store.mjs';
import * as state from '../src/state.mjs';

function isolated(t) {
  const cwd = makeWorkspace('clarify delivery fixes');
  const values = { ...fakeEnv(cwd).env, MAGI_AS: 'claude', PEER_DEPTH: '0', CLAUDE_CODE_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return cwd;
}

for (const consumed of ['question', 'reply']) {
  test(`a failed other-question handoff preserves the consumed ${consumed} and sends later questions`, async (t) => {
    const cwd = isolated(t);
    const ids = [];
    const handedOff = [];
    const coordinator = makeEngine({
      orchestrator: 'claude', peerName: 'codex',
      pickDelivery: async () => ({ mode: 'live', target: { agent: 'codex', id: 'worker' } }),
      deliverLive: async ({ taskId }) => {
        for (const body of ['First question', 'Second question', 'Third question']) {
          ids.push(state.recordClarify({ taskId, from: 'codex', body }));
        }
        if (consumed === 'reply') {
          state.recordReply({ taskId, from: 'codex', round: 1, payload: { round: 1, body: 'SUMMARY\nAlready consumed final answer' } });
          // Model a reply already assigned to this reservation by another waiter,
          // before polling notices the remaining question mail.
          const reply = state.takeReply(taskId, 1);
          statement(process.env.MAGI_HOME, 'UPDATE waiters SET result=? WHERE task_id=? AND result IS NULL').run(JSON.stringify(reply), taskId);
        }
        return { via: 'live:worker', deliveryStatus: 'queued_unread' };
      },
      deliverReply: async ({ text }) => {
        const id = text.match(/question_id=([^\s]+)/)[1];
        handedOff.push(id);
        if (id === ids[consumed === 'question' ? 1 : 0]) {
          throw Object.assign(new Error('fixture predispatch failure'), { code: 'DELIVERY_FAILED', dispatchUncertain: false });
        }
        return { deliveryStatus: 'queued_unread' };
      },
    });
    const result = await coordinator.handleRequest({ task: 'inspect', workingDirectory: cwd, wait: true, timeoutMs: 1000 });
    assert.notEqual(result.isError, true, textOf(result));
    const taskId = result.structuredContent.taskId;
    const failedId = ids[consumed === 'question' ? 1 : 0];
    if (consumed === 'question') {
      assert.equal(result.structuredContent.questionId, ids[0]);
      assert.equal(result.structuredContent.question, 'First question');
      assert.equal(typeof state.readQuestion(taskId, ids[0]).receivedAt, 'number');
      assert.deepEqual(handedOff, ids.slice(1));
    } else {
      assert.match(result.structuredContent.body, /Already consumed final answer/);
      assert.equal(result.structuredContent.deliveryStatus, 'received');
      assert.deepEqual(handedOff, ids);
      assert.equal(state.takeReply(taskId, 1), null);
    }
    assert.deepEqual(result.structuredContent.questionHandoffFailures.map(({ questionId, code }) => ({ questionId, code })), [{ questionId: failedId, code: 'DELIVERY_FAILED' }]);
    assert.equal(typeof state.readQuestion(taskId, ids[2]).deliveredAt, 'number');
    assert.ok(state.listMail(taskId).some((mail) => mail.questionId === failedId));
  });
}

for (const [code, dispatchUncertain, retained] of [
  ['DELIVERY_FAILED', false, false],
  ['DELIVERY_FAILED', true, true],
  ['DELIVERY_FAILED', undefined, true],
  ['STEER_TIMEOUT', false, true],
]) {
  test(`question claim after ${code} with dispatchUncertain=${dispatchUncertain} is ${retained ? 'retained' : 'released'}`, async (t) => {
    const cwd = isolated(t);
    state.openRound({ taskId: 'claim', orchestrator: 'claude', peer: 'codex', round: 1, cwd });
    const worker = makeEngine({
      orchestrator: 'codex', peerName: 'claude',
      deliverReply: async () => { throw Object.assign(new Error('fixture dispatch failure'), { code, dispatchUncertain }); },
    });
    const result = await worker.handleClarify({ taskId: 'claim', body: 'Which baseline?' });
    assert.equal(result.isError, true);
    const question = state.listQuestions('claim')[0];
    if (retained) {
      assert.ok(question.deliveryClaim);
      assert.equal(state.claimQuestionDelivery('claim', question.id), null, 'uncertain dispatch must not be eligible for a duplicate send');
    } else {
      assert.equal(question.deliveryClaim, undefined);
      const retry = state.claimQuestionDelivery('claim', question.id);
      assert.equal(retry.id, question.id, 'known predispatch failure must remain retryable');
      state.releaseQuestionDelivery('claim', question.id, retry.deliveryClaim.id);
    }
  });
}

test('a question sent before its delivery-mark transaction fails retains the claim', async (t) => {
  const cwd = isolated(t);
  state.openRound({ taskId: 'sent', orchestrator: 'claude', peer: 'codex', round: 1, cwd });
  statement(process.env.MAGI_HOME, `CREATE TRIGGER reject_question_mark BEFORE UPDATE ON questions
    WHEN NEW.pending=0 AND json_extract(NEW.value,'$.deliveredAt') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'fixture delivery mark failure'); END`).run();
  const frames = [];
  const worker = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    deliverReply: async ({ text }) => { frames.push(text); return { deliveryStatus: 'queued_unread' }; },
  });
  const result = await worker.handleClarify({ taskId: 'sent', body: 'Which baseline?' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /fixture delivery mark failure/);
  assert.equal(frames.length, 1);
  const question = state.listQuestions('sent')[0];
  assert.ok(question.deliveryClaim);
  assert.equal(question.deliveredAt, undefined);
  assert.equal(state.claimQuestionDelivery('sent', question.id), null, 'a completed send must not be repeated after ledger failure');
});

function publishWorker(fields = {}) {
  setRecord(process.env.MAGI_HOME, 'agents', String(process.pid), {
    agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid),
    sessionId: 'resumed', sessionAliases: ['original'], status: 'idle', cwd: process.env.MAGI_HOME, ...fields,
  });
}

for (const route of ['resumed', 'resumed-helper', 'other-worker', 'recycled-birth']) {
  test(`clarify answer resolves the recorded omp worker: ${route}`, async (t) => {
    const cwd = isolated(t);
    const birth = processStartedAt(process.pid);
    assert.equal(typeof birth, 'string');
    publishWorker(route === 'recycled-birth' ? { processStartedAt: `${birth}:recycled` }
      : route === 'resumed-helper' ? { parentSession: 'coordinator' } : {});
    state.openRound({ taskId: 'route', orchestrator: 'claude', peer: 'omp', round: 1, cwd });
    state.setPeerTarget('route', {
      agent: 'omp', id: route === 'other-worker' ? 'unrelated' : 'original',
      sessionId: route === 'other-worker' ? 'unrelated' : 'original',
      pid: route === 'other-worker' ? process.pid : 999999, processStartedAt: 'previous-process',
    });
    const questionId = state.recordClarify({ taskId: 'route', from: 'omp', body: 'Which baseline?' });
    const { engine } = makeServerEngine({ ...ompAdapter, selfDefault: 'claude' });
    const result = await engine.handleClarifyAnswer({ taskId: 'route', questionId, body: 'Use master.', peer: 'resumed' });
    if (route === 'resumed' || route === 'resumed-helper') {
      assert.notEqual(result.isError, true, textOf(result));
      const rows = statement(process.env.MAGI_HOME, 'SELECT body FROM frames WHERE to_pid=?').all(process.pid);
      assert.equal(rows.length, 1);
      const frame = JSON.parse(rows[0].body);
      assert.match(frame.text, /^PEER CLARIFICATION/);
      assert.ok(frame.text.includes(`question_id=${questionId}`));
      assert.match(frame.text, /Use master\./);
      assert.equal(frame.deliverAs, 'aside');
    } else {
      assert.equal(result.isError, true);
      assert.match(textOf(result), /NO_LIVE_PEER/);
      assert.deepEqual(statement(process.env.MAGI_HOME, 'SELECT id FROM frames WHERE to_pid=?').all(process.pid), [], 'neither a caller override nor a reused pid may substitute another worker');
    }
    assert.equal(state.readQuestion('route', questionId).answer, 'Use master.');
  });
}
