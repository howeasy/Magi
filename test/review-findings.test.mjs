// Three findings from the review of master 12c0f50: the sign-in remedy belongs to
// the harness that failed, two projects must not share a memory bank, and a
// verdict on round 1 does not reconcile a round 2 answered after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { authError, classifyFailure } from '../src/exec.mjs';
import { makeWorkspace } from './helpers/harness.mjs';
import { setRecord, migrateLegacy } from '../src/store.mjs';

test('the sign-in remedy is the failing harness\'s own', () => {
  assert.match(authError('codex', '').message, /codex login/);
  assert.match(authError('claude', '').message, /"claude" once and sign in, or set ANTHROPIC_API_KEY/);
  const omp = authError('omp', '').message;
  assert.match(omp, /omp login/);
  assert.doesNotMatch(omp, /claude|ANTHROPIC/i, 'omp is not told to sign into Claude');
  assert.match(authError('C:\\Users\\x\\AppData\\Local\\omp\\omp.exe', '').message, /omp login/, 'a full path or .exe still names omp');
  assert.match(authError('gemini', '').message, /gemini with its own login command/);
  assert.match(classifyFailure('omp', { stderr: 'Error: not logged in', exitCode: 1 }).message, /omp login/);
});

async function fresh() {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  mkdirSync(process.env.MAGI_HOME, { recursive: true });
  return { ws, mem: await import('../src/memory.mjs?' + Math.random()) };
}

test('paths that collapse to one slug get different banks; case and slashes still agree', async () => {
  const { mem } = await fresh();
  assert.notEqual(mem.bankFor('E:/work/foo-bar'), mem.bankFor('E:/work/foo/bar'));
  assert.equal(mem.legacyBankFor('E:/work/foo-bar'), mem.legacyBankFor('E:/work/foo/bar'), 'the old key is what collided');
  assert.equal(mem.bankFor('E:\\Work\\Foo\\'), mem.bankFor('e:/work/foo'));
  assert.match(mem.bankFor('E:/work/foo'), /^e-work-foo\.[0-9a-f]{8}$/);
  assert.equal(mem.bankFor('anything', 'global'), '_global');
  assert.equal(mem.bankFor(''), '_root');
});

test('projects keep distinct new banks; legacy slug notes require explicit import', async () => {
  const { ws, mem } = await fresh();
  const a = join(ws, 'work', 'foo-bar');
  const b = join(ws, 'work', 'foo', 'bar');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const old = join(process.env.MAGI_HOME, 'memory', mem.legacyBankFor(a));
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'm-01d00001.md'), '---\nid: m-01d00001\nat: 2026-10-01T00:00:00.000Z\nfrom: claude\ntags: \n---\nLegacy flux capacitor note.\n');
  assert.equal((await mem.recall({ query: 'flux capacitor', cwd: a })).length, 0);
  assert.ok(existsSync(join(old, 'm-01d00001.md')), 'ordinary read leaves legacy input untouched');
  migrateLegacy(process.env.MAGI_HOME);
  await mem.remember({ body: 'Project A uses sprockets.', cwd: a });
  assert.equal((await mem.recall({ query: 'sprockets', cwd: a })).length, 1);
  assert.equal((await mem.recall({ query: 'sprockets', cwd: b })).length, 0);
  assert.equal((await mem.recall({ query: 'flux capacitor', cwd: a })).length, 1);
  await mem.forget({ memoryId: 'm-01d00001', cwd: a });
  assert.equal((await mem.recall({ query: 'flux capacitor', cwd: a })).length, 0);
  assert.equal((await mem.recall({ query: 'sprockets', cwd: a })).length, 1);
});

async function ledger() {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const state = await import('../src/state.mjs');
  const put = (taskId, rounds, outcome) => {
    setRecord(process.env.MAGI_HOME, 'tasks', taskId, { taskId, orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', maxRounds: 6, cwd: ws, rounds, ...(outcome ? { outcome } : {}) });
    state.recordExchange(taskId, { kind: 'reply', round: 1, from: 'codex', text: 'answer' });
  };
  return { state, put };
}

test('a verdict on round 1 leaves an answered round 2 owed, and a verdict on round 2 clears it', async () => {
  const { state, put } = await ledger();
  const r = (round, replied = true) => ({ round, openedAt: Date.now(), replied });
  const verdict = (round) => ({ accepted: 2, rejected: 0, open: 0, notes: null, round, at: 1 });
  put('cx-twoRound1', [r(1), r(2)], verdict(1));
  put('cx-twoRound2', [r(1), r(2)], verdict(2));
  put('cx-oneRound1', [r(1)], verdict(1));
  put('cx-noVerdict', [r(1)], null);
  const owed = state.unreconciledFor('claude', { limit: 10 }).sort();
  assert.deepEqual(owed, ['cx-noVerdict', 'cx-twoRound1']);
  assert.equal(state.outcomeCovers(state.readTask('cx-twoRound1')), false);
  assert.equal(state.outcomeCovers(state.readTask('cx-twoRound2')), true);
  assert.match(state.taskSummary(state.readTask('cx-twoRound1')).outcome, /^2\/0\/0 \(does not cover every reply; an answered round is unchecked\)$/);
  assert.equal(state.taskSummary(state.readTask('cx-twoRound2')).outcome, '2/0/0');
});

test('an outcome recorded while round 2 is still open is about round 1, so the round 2 reply is owed', async () => {
  const { state, put } = await ledger();
  put('cx-openRound2', [{ round: 1, openedAt: Date.now(), replied: true }, { round: 2, openedAt: Date.now(), replied: false }], null);
  const rec = state.recordOutcome({ taskId: 'cx-openRound2', from: 'claude', accepted: 1, rejected: 0, open: 1, notes: 'round one only' });
  assert.equal(rec.outcome.round, 1);
  // Round 2's reply arrives afterwards.
  const task = state.readTask('cx-openRound2');
  task.rounds[1].replied = true;
  setRecord(process.env.MAGI_HOME, 'tasks', 'cx-openRound2', task);
  assert.deepEqual(state.unreconciledFor('claude', { limit: 10 }), ['cx-openRound2']);
});

// --- from the Codex review of 50175ca ---------------------------------------

test('a verdict recorded before a reply arrived does not cover it, whatever round the outcome says', async () => {
  const { state } = await ledger();
  // Older code stamped a verdict with the latest round even while it was open.
  const legacy = { orchestrator: 'claude', rounds: [{ round: 1, replied: true, repliedAt: 10 }, { round: 2, replied: true, repliedAt: 30 }], outcome: { accepted: 1, rejected: 0, open: 0, round: 2, at: 20 } };
  assert.equal(state.outcomeCovers(legacy), false);
  assert.equal(state.outcomeCovers({ ...legacy, outcome: { ...legacy.outcome, at: 31 } }), true, 'recorded after the reply: covered');
});

test('an outcome recorded while the only round was still open covers nothing that arrives later', async () => {
  const { state, put } = await ledger();
  put('cx-earlyverdict', [{ round: 1, openedAt: Date.now(), replied: false }], null);
  const rec = state.recordOutcome({ taskId: 'cx-earlyverdict', from: 'claude', accepted: 1, rejected: 0, open: 0 });
  rec.rounds[0].replied = true;
  rec.rounds[0].repliedAt = rec.outcome.at + 5;
  assert.equal(state.outcomeCovers(rec), false);
});

test('sweeping keeps whether a verdict covered the latest reply', async () => {
  const { state, put } = await ledger();
  put('cx-archcover', [{ round: 1, openedAt: 1, replied: true, repliedAt: 10 }, { round: 2, openedAt: 15, replied: true, repliedAt: 30 }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 1, at: 20 });
  assert.equal(state.outcomeCovers(state.readTask('cx-archcover')), false);
  state.sweep(1);
  assert.equal(state.readTask('cx-archcover').rounds.length, 2, 'all rounds remain available');
  const back = state.listTasksWithArchive().find((t) => t.taskId === 'cx-archcover');
  assert.equal(state.outcomeCovers(back), false, 'still not covered after the sweep');
  assert.match(state.taskSummary(back).outcome, /an answered round is unchecked/);

  // Older code stamped round 2 on a verdict given while it was open; only the reply time says it came late.
  put('cx-archlate1', [{ round: 1, openedAt: 1, replied: true, repliedAt: 10 }, { round: 2, openedAt: 15, replied: true, repliedAt: 30 }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 20 });
  state.sweep(1);
  const late = state.listTasksWithArchive().find((t) => t.taskId === 'cx-archlate1');
  assert.equal(state.outcomeCovers(late), false, 'the reply time survives the sweep');

  // And the other direction: a verdict given after the round 2 reply still covers it after a sweep.
  put('cx-archgood1', [{ round: 1, openedAt: 1, replied: true, repliedAt: 10 }, { round: 2, openedAt: 15, replied: true, repliedAt: 30 }], { accepted: 2, rejected: 0, open: 0, notes: null, round: 2, at: 40 });
  state.sweep(1);
  const good = state.listTasksWithArchive().find((t) => t.taskId === 'cx-archgood1');
  assert.ok(good, 'retained');
  assert.equal(state.outcomeCovers(good), true, 'a covered verdict is not reported unchecked after the sweep');
});

test('a new bank key can never equal an old slug, so one project cannot reach another\'s new notes', async () => {
  const { ws, mem } = await fresh();
  const a = join(ws, 'foo');
  mkdirSync(a, { recursive: true });
  // The other project's path is chosen so that its OLD slug equals A's NEW key under a dash scheme.
  const hash = mem.bankFor(a).split('.').pop();
  const b = join(ws, `foo-${hash}`);
  mkdirSync(b, { recursive: true });
  assert.equal(mem.legacyBankFor(b), mem.bankFor(a).replace('.', '-'), 'the construction collides under a dash');
  assert.notEqual(mem.legacyBankFor(b), mem.bankFor(a));
  const { id } = await mem.remember({ body: 'Project A private note about gizmos.', cwd: a });
  assert.equal((await mem.recall({ query: 'gizmos', cwd: b })).length, 0);
  await assert.rejects(mem.forget({ memoryId: id, cwd: b }), (e) => e.code === 'UNKNOWN_MEMORY');
  assert.equal((await mem.recall({ query: 'gizmos', cwd: a })).length, 1);
});


// --- from the second Codex review (b0e626c): order by arrival, not by clock ---

test('a verdict recorded first is not covering a reply recorded in the same millisecond, or one the clock puts earlier', async () => {
  const { state, put } = await ledger();
  put('cx-clocktie1', [{ round: 1, openedAt: 1, replied: false }], null);
  const real = Date.now;
  try {
    Date.now = () => 20;
    state.recordOutcome({ taskId: 'cx-clocktie1', from: 'claude', accepted: 1, rejected: 0, open: 0 });
    Date.now = () => 19; // the clock went backwards too
    state.recordReply({ taskId: 'cx-clocktie1', from: 'codex', round: 1, payload: { body: 'late' } });
  } finally {
    Date.now = real;
  }
  assert.equal(state.outcomeCovers(state.readTask('cx-clocktie1')), false);
});

test('a late reply to an older timed-out round is the newest reply, and the earlier verdict does not cover it', async () => {
  const { state, put } = await ledger();
  // Round 1 timed out; round 2 was answered and judged; then round 1's reply finally arrived.
  put('cx-latereply', [{ round: 1, openedAt: 1, replied: false, closedAt: 5, closeReason: 'timed_out' }, { round: 2, openedAt: 6, replied: true, repliedAt: 20, replySeq: 1 }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 30, seq: 1 });
  const task = state.readTask('cx-latereply');
  task.replySeq = 1;
  setRecord(process.env.MAGI_HOME, 'tasks', 'cx-latereply', task);
  assert.equal(state.outcomeCovers(state.readTask('cx-latereply')), true, 'before the late reply');
  state.recordReply({ taskId: 'cx-latereply', from: 'codex', round: 1, payload: { body: 'finally' } });
  assert.equal(state.outcomeCovers(state.readTask('cx-latereply')), false, 'the late reply is unchecked');
  assert.deepEqual(state.unreconciledFor('claude', { limit: 10 }), ['cx-latereply']);
});

test('a retained task whose last round went unanswered keeps the coverage of the answer it did get', async () => {
  const { state, put } = await ledger();
  put('cx-unansfinal', [{ round: 1, openedAt: 1, replied: true, repliedAt: 30, replySeq: 1 }, { round: 2, openedAt: 31, replied: false, closedAt: 40, closeReason: 'timed_out' }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 1, at: 20, seq: 0 });
  assert.equal(state.outcomeCovers(state.readTask('cx-unansfinal')), false, 'live: the round 1 reply is unchecked');
  state.sweep(1);
  const back = state.listTasksWithArchive().find((t) => t.taskId === 'cx-unansfinal');
  assert.ok(back, 'retained');
  assert.equal(state.outcomeCovers(back), false, 'still unchecked after the sweep');
  assert.equal(back.rounds[0].replied, true, 'the earlier answer remains available');
});

test('paths with no ASCII letters get their own banks rather than sharing one', async () => {
  const { mem } = await fresh();
  assert.notEqual(mem.bankFor('/中文'), mem.bankFor('/日本語'));
  assert.match(mem.bankFor('/中文'), /^_\.[0-9a-f]{8}$/);
  assert.equal(mem.bankFor(''), '_root');
});

test('through the real calls: a verdict after a reply covers it, and the next reply is owed again', async () => {
  const { state, put } = await ledger();
  put('cx-realflow1', [{ round: 1, openedAt: 1, replied: false }, { round: 2, openedAt: 2, replied: false }], null);
  state.recordReply({ taskId: 'cx-realflow1', from: 'codex', round: 1, payload: { body: 'one' } });
  state.recordOutcome({ taskId: 'cx-realflow1', from: 'claude', accepted: 1, rejected: 0, open: 0 });
  assert.equal(state.outcomeCovers(state.readTask('cx-realflow1')), true, 'judged after it arrived');
  state.recordReply({ taskId: 'cx-realflow1', from: 'codex', round: 2, payload: { body: 'two' } });
  assert.equal(state.outcomeCovers(state.readTask('cx-realflow1')), false, 'round 2 arrived after the verdict');
  state.recordOutcome({ taskId: 'cx-realflow1', from: 'claude', accepted: 1, rejected: 0, open: 0 });
  assert.equal(state.outcomeCovers(state.readTask('cx-realflow1')), true, 'and judged again');
});

test('sweep keeps the reply sequence, which outranks a clock that disagrees', async () => {
  const { state, put } = await ledger();
  // Skewed clock: the verdict looks later by time (20 > 10) but had seen only 1 of 2 replies.
  put('cx-seqbeatsclock', [{ round: 1, openedAt: 1, replied: true, repliedAt: 5, replySeq: 1 }, { round: 2, openedAt: 6, replied: true, repliedAt: 10, replySeq: 2 }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 1, at: 20, seq: 1 });
  assert.equal(state.outcomeCovers(state.readTask('cx-seqbeatsclock')), false, 'live');
  state.sweep(1);
  const back = state.listTasksWithArchive().find((t) => t.taskId === 'cx-seqbeatsclock');
  assert.equal(state.outcomeCovers(back), false, 'retained');
});

// --- from the third Codex review (64f5571) ---

test('an answer to an older round that nobody checked is owed even when the last round never answered', async () => {
  const { state, put } = await ledger();
  // Round 1 timed out, round 2 opened, the verdict was given, then round 1's reply arrived late; round 2 then timed out.
  put('cx-lateolder', [
    { round: 1, openedAt: 1, replied: true, repliedAt: 40, replySeq: 1 },
    { round: 2, openedAt: 5, replied: false, closedAt: 50, closeReason: 'timed_out' },
  ], { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 30, seq: 0 });
  assert.equal(state.outcomeCovers(state.readTask('cx-lateolder')), false);
  assert.equal(state.reconciliationOwed(state.readTask('cx-lateolder')), true);
  assert.deepEqual(state.unreconciledFor('claude', { limit: 10 }), ['cx-lateolder']);
});

test('while the next round is still open the argument is in progress and no verdict is owed yet', async () => {
  const { state, put } = await ledger();
  put('cx-inprogress', [{ round: 1, openedAt: 1, replied: true, repliedAt: 10, replySeq: 1 }, { round: 2, openedAt: 11, replied: false }], null);
  assert.equal(state.reconciliationOwed(state.readTask('cx-inprogress')), false);
  assert.deepEqual(state.unreconciledFor('claude', { limit: 10 }), []);
});

test('historic archive summaries from the earlier formats are restored honestly', async () => {
  const { state } = await ledger();
  const putArchive = (summary) => setRecord(process.env.MAGI_HOME, 'archive', summary.taskId, { orchestrator: 'claude', peer: 'omp', mode: 'DEBATE', maxRounds: 6, openedAt: 1, ...summary });
  // The previous format: replied was the last round's flag; answeredRound/repliedAt describe the answered one.
  putArchive({ taskId: 'cx-prevfmt1', replied: false, answeredRound: 1, repliedAt: 30, outcome: { accepted: 1, rejected: 0, open: 0, at: 20, round: 1 } });
  // The first format: no coverage evidence at all.
  putArchive({ taskId: 'cx-firstfmt', replied: true, outcome: { accepted: 2, rejected: 0, open: 0, at: 20 } });
  const all = state.listTasksWithArchive();
  const prev = all.find((t) => t.taskId === 'cx-prevfmt1');
  assert.equal(state.outcomeCovers(prev), false, 'the retained times prove the verdict came before the reply');
  const first = all.find((t) => t.taskId === 'cx-firstfmt');
  assert.equal(first.coverageUnknown, true);
  assert.match(state.taskSummary(first).outcome, /whether it covered the newest reply is unknown/);
  assert.doesNotMatch(state.taskSummary(prev).outcome, /unknown/);
});

test('an unnumbered reply from a server that has not restarted is the newest if it came last', async () => {
  const { state } = await ledger();
  const rounds = [{ round: 1, replied: true, repliedAt: 10, replySeq: 1 }, { round: 2, replied: true, repliedAt: 50 }];
  assert.equal(state.newestAnswered(rounds).round, 2);
  assert.equal(state.outcomeCovers({ rounds, outcome: { at: 30, seq: 1 } }), false, 'verdict at 30 predates the unnumbered reply at 50');
  assert.equal(state.outcomeCovers({ rounds, outcome: { at: 60, seq: 1 } }), true);
  // an older unnumbered reply does not outrank a numbered one
  assert.equal(state.newestAnswered([{ round: 1, replied: true, repliedAt: 5 }, { round: 2, replied: true, repliedAt: 10, replySeq: 1 }]).round, 2);
});

// --- from the fourth review (647d8f1): every answered reply must be covered ---

test('a verdict must cover every answered reply, so mixed numbered and unnumbered history is not judged by the clock alone', async () => {
  const { state } = await ledger();
  const mixed = [{ round: 1, replied: true, repliedAt: 100, replySeq: 1 }, { round: 2, replied: true, repliedAt: 150 }];
  assert.equal(state.outcomeCovers({ rounds: mixed, outcome: { at: 200, seq: 0 } }), false, 'seq 0 had not seen the numbered reply');
  assert.equal(state.outcomeCovers({ rounds: mixed, outcome: { at: 200, seq: 1 } }), true, 'saw the numbered one, and is later than the unnumbered one');
  const tie = [{ round: 1, replied: true, repliedAt: 10, replySeq: 1 }, { round: 2, replied: true, repliedAt: 10 }];
  assert.equal(state.outcomeCovers({ rounds: tie, outcome: { at: 10, seq: 1 } }), false, 'a tie with an unnumbered reply is not proof');
  assert.equal(state.outcomeCovers({ rounds: tie, outcome: { at: 11, seq: 1 } }), true);
});

test('a historic archive summary with no coverage evidence is never covered, whatever its replied flag says', async () => {
  const { state } = await ledger();
  for (const [taskId, replied] of [['cx-unk-true', true], ['cx-unk-false', false]]) {
    setRecord(process.env.MAGI_HOME, 'archive', taskId, { taskId, orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, openedAt: 1, replied, outcome: { accepted: 1, rejected: 0, open: 0, at: 20 } });
  }
  for (const id of ['cx-unk-true', 'cx-unk-false']) {
    const t = state.listTasksWithArchive().find((x) => x.taskId === id);
    assert.equal(t.coverageUnknown, true);
    assert.equal(state.outcomeCovers(t), false, id);
    assert.match(state.taskSummary(t).outcome, /unknown/);
  }
});

test('sweep keeps the verdict on coverage for a mixed history, neither losing nor inventing it', async () => {
  const { state, put } = await ledger();
  const mixed = [{ round: 1, openedAt: 1, replied: true, repliedAt: 100, replySeq: 1 }, { round: 2, openedAt: 2, replied: true, repliedAt: 150 }];
  put('cx-mixed-no', mixed, { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 200, seq: 0 });
  put('cx-mixed-yes', mixed, { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 200, seq: 1 });
  put('cx-tie-no', [{ round: 1, openedAt: 1, replied: true, repliedAt: 10, replySeq: 1 }, { round: 2, openedAt: 2, replied: true, repliedAt: 10 }], { accepted: 1, rejected: 0, open: 0, notes: null, round: 2, at: 10, seq: 1 });
  assert.equal(state.outcomeCovers(state.readTask('cx-mixed-no')), false, 'live');
  state.sweep(1);
  const get = (id) => state.listTasksWithArchive().find((t) => t.taskId === id);
  assert.equal(state.outcomeCovers(get('cx-mixed-no')), false, 'retained: still uncovered');
  assert.equal(state.outcomeCovers(get('cx-mixed-yes')), true, 'retained: still covered');
  assert.equal(state.outcomeCovers(get('cx-tie-no')), false, 'retained: a tie is not proof');
  assert.equal(get('cx-mixed-no').coverageUnknown, undefined, 'known, not unknown');
});

// --- from the fifth review (1d3d5b6): a verdict names the rounds it had seen ---

test('a fresh outcome always covers the replies recorded before it, even over legacy unnumbered replies and a clock that stepped back', async () => {
  const { state, put } = await ledger();
  put('cx-rollback', [{ round: 1, openedAt: 1, replied: true, repliedAt: 1000 }, { round: 2, openedAt: 2, replied: true, repliedAt: 1001, replySeq: 1 }], null);
  const task = state.readTask('cx-rollback');
  task.replySeq = 1;
  setRecord(process.env.MAGI_HOME, 'tasks', 'cx-rollback', task);
  const real = Date.now;
  try {
    Date.now = () => 200; // the wall clock is far behind the legacy reply times
    const rec = state.recordOutcome({ taskId: 'cx-rollback', from: 'claude', accepted: 1, rejected: 0, open: 0 });
    assert.deepEqual(rec.outcome.seen, [1, 2]);
  } finally {
    Date.now = real;
  }
  assert.equal(state.outcomeCovers(state.readTask('cx-rollback')), true);
  assert.equal(state.reconciliationOwed(state.readTask('cx-rollback')), false);
});

test('seen decides without a clock or a counter: a reply that arrives after the verdict is not in it', async () => {
  const { state } = await ledger();
  const rounds = [{ round: 1, replied: true, repliedAt: 500 }, { round: 2, replied: true, repliedAt: 400, replySeq: 9 }];
  assert.equal(state.outcomeCovers({ rounds, outcome: { at: 1, seq: 0, seen: [1, 2] } }), true, 'saw both, whatever the stamps say');
  assert.equal(state.outcomeCovers({ rounds, outcome: { at: 9999, seq: 99, seen: [1] } }), false, 'did not see round 2');
});

test('an older archive summary proves a failure but never a success, because it kept one reply only', async () => {
  const { state } = await ledger();
  const putArchive = (taskId, summary) => setRecord(process.env.MAGI_HOME, 'archive', taskId, { taskId, orchestrator: 'claude', peer: 'omp', mode: 'DEBATE', maxRounds: 6, openedAt: 1, replied: true, answeredRound: 2, ...summary });
  // The retained reply looks covered, but round 1's evidence was discarded.
  putArchive('cx-prev-looks-ok', { repliedAt: 150, outcome: { accepted: 1, rejected: 0, open: 0, at: 200, seq: 0 } });
  // The retained reply is provably newer than the verdict.
  putArchive('cx-prev-fails', { repliedAt: 250, outcome: { accepted: 1, rejected: 0, open: 0, at: 200, seq: 0 } });
  const get = (id) => state.listTasksWithArchive().find((t) => t.taskId === id);
  assert.equal(state.outcomeCovers(get('cx-prev-looks-ok')), false);
  assert.equal(get('cx-prev-looks-ok').coverageUnknown, true, 'unknown, not covered');
  assert.match(state.taskSummary(get('cx-prev-looks-ok')).outcome, /unknown/);
  assert.equal(state.outcomeCovers(get('cx-prev-fails')), false);
  assert.equal(get('cx-prev-fails').coverageUnknown, undefined, 'a provable failure is a failure, not unknown');
  assert.match(state.taskSummary(get('cx-prev-fails')).outcome, /an answered round is unchecked/);
});
