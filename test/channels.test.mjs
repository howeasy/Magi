import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorkspace, ROOT } from './helpers/harness.mjs';
import { setRecord } from '../src/store.mjs';
import { recordExchange } from '../src/state.mjs';
import { channelsOf, sessionLabel, STALE_MS } from '../src/fleet.mjs';

function fixture() {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  Object.assign(process.env, { HOME: ws, USERPROFILE: ws, CLAUDE_APP_SESSIONS_DIR: join(ws, 'claude-app') });
  const now = Date.now();
  const put = (id, openedAt, { repliedAt, rounds, from = { id: 'coordinator-1', name: 'lead' }, to = { id: 'worker-1', name: 'impl' }, outcome } = {}) => {
    const t = { taskId: id, orchestrator: 'claude', peer: 'omp', orchestratorTarget: from, peerTarget: to, cwd: ws, mode: 'DELEGATE', maxRounds: 3, rounds: rounds ?? [{ round: 1, openedAt, replied: repliedAt != null, ...(repliedAt != null ? { repliedAt } : {}), brief: `Task ${id}` }], ...(outcome ? { outcome } : {}) };
    setRecord(process.env.MAGI_HOME, 'tasks', id, t);
    return t;
  };
  const event = (id, entry) => recordExchange(id, { round: 1, from: 'omp', at: now, ...entry });
  return { now, put, event, ws };
}

test('channel keys use session IDs, not display names; old targets fall back to names', () => {
  const { now, put } = fixture();
  const tasks = [
    put('magi-a', now - 5000),
    put('magi-b', now - 4000, { from: { id: 'coordinator-1', name: 'renamed' } }),
    put('magi-c', now - 3000, { to: { id: 'worker-2', name: 'impl' } }),
    put('magi-d', now - 2000, { from: 'old-lead', to: 'old-worker' }),
    put('magi-e', now - 1000, { from: { name: 'old-lead' }, to: { name: 'old-worker' } }),
  ];
  const channels = channelsOf(tasks, now);
  assert.equal(channels.length, 3);
  const byId = channels.find((c) => c.toId === 'worker-1');
  assert.deepEqual(byId.turns.map((t) => t.taskId), ['magi-b', 'magi-a']);
  assert.equal(byId.fromName, 'renamed');
  assert.equal(byId.turnCount, 2);
  assert.deepEqual(channels.find((c) => c.fromName === 'old-lead').turns.map((t) => t.taskId), ['magi-e', 'magi-d']);
});

test('identity-free workers never share a harness bucket; resumed headless sessions do share a channel', () => {
  const { now, put } = fixture();
  const tasks = [
    put('magi-no-target', now - 6000, { to: null }),
    put('magi-harness', now - 5000, { to: 'omp' }),
    put('magi-empty', now - 4000, { to: {} }),
    put('magi-persona-no-session', now - 3000, { to: { name: 'reviewer', headless: true } }),
    put('magi-session-a', now - 2000, { to: { harness: 'omp', id: 'headless-1', headless: true } }),
    put('magi-session-b', now - 1000, { to: { harness: 'omp', id: 'headless-1', headless: true } }),
    put('magi-session-c', now, { to: { harness: 'omp', id: 'headless-2', headless: true } }),
  ];
  const channels = channelsOf(tasks, now);
  assert.equal(channels.length, 6);
  assert.deepEqual(channels.find((c) => c.toId === 'headless-1').turns.map((t) => t.taskId), ['magi-session-b', 'magi-session-a']);
  for (const t of tasks.slice(0, 4)) assert.deepEqual(channels.find((c) => c.turns.some((turn) => turn.taskId === t.taskId)).turns.map((turn) => turn.taskId), [t.taskId]);
});

test('channel latency includes continuation rounds, skips replies without a next request, and counts debt', () => {
  const { now, put } = fixture();
  const start = now - 10000;
  const tasks = [
    put('magi-a', start, { repliedAt: start + 1000 }),
    put('magi-b', start + 3000, { rounds: [
      { round: 1, openedAt: start + 3000, replied: true, repliedAt: start + 4000 },
      { round: 2, openedAt: start + 8000, replied: true, repliedAt: start + 9000 },
    ] }),
  ];
  const [c] = channelsOf(tasks, now);
  assert.equal(c.turnCount, 3);
  assert.equal(c.medianLatencyMs, 3000); // 2s and 4s; final reply has no successor.
  assert.equal(c.unreconciledCount, 2);
  assert.equal(c.turn, 'coordinator');
  assert.equal(c.since, start + 9000);
  assert.equal(c.currentCard.taskId, 'magi-b');
});

test('covered answers clear channel debt without claiming that an unanswered newer round was checked', () => {
  const { now, put } = fixture();
  const covered = put('magi-covered', now - 3000, { repliedAt: now - 2000, outcome: { at: now - 1000, round: 1, accepted: 1, rejected: 0, open: 0 } });
  assert.equal(channelsOf([covered], now)[0].unreconciledCount, 0);
  const later = put('magi-later', now - 3000, { rounds: [
    { round: 1, openedAt: now - 3000, replied: true, repliedAt: now - 2000 },
    { round: 2, openedAt: now - 1000, replied: true, repliedAt: now },
  ], outcome: { at: now - 1500, round: 1, accepted: 1, rejected: 0, open: 0 } });
  assert.equal(channelsOf([later], now)[0].unreconciledCount, 1);
});

test('a last-round question reverses ownership until clarification; old-round questions cannot reverse it', () => {
  const { now, put, event } = fixture();
  const task = put('magi-q', now - 3000, { rounds: [
    { round: 1, openedAt: now - 6000, replied: true, repliedAt: now - 5000 },
    { round: 2, openedAt: now - 3000, replied: false },
  ] });
  event(task.taskId, { kind: 'question', text: 'Old question', at: now - 5500 });
  assert.equal(channelsOf([task], now)[0].turn, 'worker');
  event(task.taskId, { kind: 'question', round: 2, text: 'Which branch?', at: now - 2000 });
  const [waiting] = channelsOf([task], now);
  assert.equal(waiting.turn, 'coordinator');
  assert.equal(waiting.openQuestion.text, 'Which branch?');
  assert.equal(waiting.since, now - 2000);
  assert.match(waiting.statusText, /coordinator owes an answer/);
  event(task.taskId, { kind: 'clarification', round: 2, text: 'feat/channels', at: now - 1000 });
  const [working] = channelsOf([task], now);
  assert.equal(working.turn, 'worker');
  assert.equal(working.openQuestion, null);
  assert.equal(working.since, task.rounds[1].openedAt);
});

test('reply or close ends question waiting even without a recorded clarification', () => {
  const { now, put, event } = fixture();
  const answered = put('magi-answer', now - 3000, { repliedAt: now - 1000 });
  const closed = put('magi-close', now - 3000, { rounds: [{ round: 1, openedAt: now - 3000, replied: false, closedAt: now - 1000, closeReason: 'abandoned' }] });
  for (const t of [answered, closed]) event(t.taskId, { kind: 'question', text: 'Which branch?', at: now - 2000 });
  assert.equal(channelsOf([answered], now)[0].openQuestion, null);
  const [channel] = channelsOf([closed], now);
  assert.equal(channel.openQuestion, null);
  assert.equal(channel.turn, 'closed');
});

test('active cards beat newer completed cards; replies hand the turn back and stale cards are not working', () => {
  const { now, put } = fixture();
  const active = put('magi-active', now - 5000);
  const replied = put('magi-replied', now - 2000, { repliedAt: now - 1000 });
  assert.equal(channelsOf([active, replied], now)[0].currentCard.taskId, 'magi-active');
  const [idle] = channelsOf([replied], now);
  assert.equal(idle.turn, 'coordinator');
  assert.match(idle.statusText, /reply landed 1s ago/);
  const stale = put('magi-stale', now - STALE_MS - 1);
  assert.equal(channelsOf([stale], now)[0].turn, 'stale');
});

test('identical answers are flagged before clipping, and never across unrelated pairs', () => {
  const { now, put, event } = fixture();
  const same = 'A finding. '.repeat(100);
  const tasks = [put('magi-a', now - 5000, { repliedAt: now - 4000 }), put('magi-b', now - 3000, { repliedAt: now - 2000 }), put('magi-c', now - 1000, { repliedAt: now, to: { id: 'worker-2', name: 'impl' } })];
  event('magi-a', { kind: 'reply', text: same, at: now - 4000 });
  event('magi-b', { kind: 'reply', text: same, at: now - 2000 });
  event('magi-c', { kind: 'reply', text: same });
  const channels = channelsOf(tasks, now);
  const pair = channels.find((c) => c.toId === 'worker-1');
  assert.equal(pair.repeatedAnswers[0].repeatedFrom.taskId, 'magi-a');
  assert.equal(pair.turns[0].events[0].repeatedAnswer, true);
  assert.equal(pair.turns[0].events[0].clipped, true);
  assert.deepEqual(channels.find((c) => c.toId === 'worker-2').repeatedAnswers, []);
});

test('session labels prefer name, purpose title, short ID, then harness fallback', () => {
  assert.equal(sessionLabel({ name: 'worker', purpose: 'Review: the change', id: '1234567890' }), 'worker');
  assert.equal(sessionLabel({ name: '', purpose: 'Review: the change', id: '1234567890' }), 'Review');
  assert.equal(sessionLabel({ purpose: '\n', sessionId: '1234567890' }), '12345678');
  assert.equal(sessionLabel(null, 'omp'), 'omp');
});

test('channels CLI prints questions and task text, filters exact pair names; log/exchange share labels', () => {
  const { now, put, event } = fixture();
  put('magi-cli', now - 3000, { from: { id: 'coordinator-1', purpose: 'Lead: coordinator' }, to: { id: '1234567890' } });
  put('magi-other', now - 2000, { to: { id: 'different', name: 'other' } });
  event('magi-cli', { kind: 'request', from: 'claude', text: 'PEER REQUEST magi/1\n\nROLE\nboilerplate\n\nTASK\nCarry out the bounded task below.\n\nReview the parser\n\nMODE\nDELEGATE\n', at: now - 3000 });
  event('magi-cli', { kind: 'question', text: 'Which branch?', at: now - 1000 });
  const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), ...args], { env: { ...process.env }, encoding: 'utf8' });
  const channels = cli('channels', '--pair', 'Lead -> 12345678');
  assert.match(channels, /Lead <- 12345678/);
  assert.match(channels, /coordinator owes an answer/);
  assert.match(channels, /Which branch\?/);
  assert.match(channels, /Review the parser/);
  assert.doesNotMatch(channels, /ROLE|boilerplate|magi-other/);
  assert.match(cli('channels', '--pair', 'other'), /magi-other/);
  assert.match(cli('channels', '--pair', 'missing'), /No channels matching/);
  assert.match(cli('log', '--task', 'magi-cli'), /Lead->12345678/);
  const exchange = cli('exchange', 'magi-cli');
  assert.match(exchange, /Lead -> 12345678/);
  assert.match(exchange, /question round 1 from 12345678/);
  assert.match(exchange, /ROLE/); // Full exchange deliberately retains request-as-sent.
});

test('answering one question leaves an earlier unanswered question open in the channel view', async () => {
  const { openQuestion } = await import('../src/fleet.mjs');
  const card = { rounds: [{ round: 1 }] };
  const events = [
    { round: 1, kind: 'question', questionId: 'q1', text: 'first', at: 1 },
    { round: 1, kind: 'question', questionId: 'q2', text: 'second', at: 2 },
    { round: 1, kind: 'clarification', questionId: 'q2', text: 'answer', at: 3 },
  ];
  assert.equal(openQuestion(card, events).text, 'first');
  events.push({ round: 1, kind: 'clarification', questionId: 'q1', text: 'answer', at: 4 });
  assert.equal(openQuestion(card, events), null);
});
