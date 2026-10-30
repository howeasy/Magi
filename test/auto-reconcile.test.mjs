import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'magi-auto-'));
const state = await import('../src/state.mjs');
const H = 3600_000;
const base = { orchestrator: 'claude', peer: 'codex', mode: 'review', round: 1 };
const run = (now) => state.autoReconcile({ now, force: true });

test('stale rounds close; unchecked replies expire without a verdict and never touch outcome', () => {
  state.openRound({ ...base, taskId: 'silent' });
  state.openRound({ ...base, taskId: 'answered' });
  state.recordReply({ taskId: 'answered', from: 'codex', round: 1, payload: 'looks fine' });
  const t0 = Date.now();
  assert.deepEqual(run(t0 + H), { closed: 0, expired: 0 }, 'inside the windows nothing happens');
  assert.deepEqual(run(t0 + 9 * H), { closed: 1, expired: 0 });
  assert.equal(state.readTask('silent').rounds[0].closeCode, 'STALE');
  assert.deepEqual(run(t0 + 25 * H), { closed: 0, expired: 1 });
  const rec = state.readTask('answered');
  assert.equal(rec.outcome, undefined, 'an expiry is not an outcome');
  assert.ok(state.expiredCovers(rec) && !state.reconciliationOwed(rec) && !state.outcomeCovers(rec));
  assert.deepEqual(run(t0 + 26 * H), { closed: 0, expired: 0 }, 'idempotent');
});

test('an expiry keeps an earlier real verdict, and a later reply owes again', () => {
  state.openRound({ ...base, taskId: 'two', maxRounds: 4 });
  state.recordReply({ taskId: 'two', from: 'codex', round: 1, payload: 'r1' });
  state.recordOutcome({ taskId: 'two', from: 'claude', accepted: 1, rejected: 0, open: 0 });
  state.openRound({ ...base, taskId: 'two', round: 2 });
  state.recordReply({ taskId: 'two', from: 'codex', round: 2, payload: 'r2' });
  const t1 = Date.now();
  assert.equal(run(t1 + 25 * H).expired, 1);
  let rec = state.readTask('two');
  assert.deepEqual([rec.outcome.accepted, rec.outcome.rejected], [1, 0], 'the real verdict is untouched');
  assert.ok(!state.reconciliationOwed(rec));
  state.openRound({ ...base, taskId: 'two', round: 3 });
  state.recordReply({ taskId: 'two', from: 'codex', round: 3, payload: 'r3' });
  rec = state.readTask('two');
  assert.ok(state.reconciliationOwed(rec), 'a reply after the expiry owes again');
  assert.equal(run(Date.now() + H).expired, 0, 'a fresh reply is not expired by older ones');
});

test('the windows are exclusive at the boundary and the summary names a stale round', () => {
  state.openRound({ ...base, taskId: 'edge' });
  const opened = state.readTask('edge').rounds[0].openedAt;
  assert.equal(run(opened + 8 * H).closed, 0, 'exactly 8h is not yet stale');
  assert.equal(state.taskSummary(state.readTask('edge')).status, 'open');
  assert.equal(run(opened + 8 * H + 1).closed, 1);
  state.openRound({ ...base, taskId: 'old' });
  const rec = state.readTask('old');
  rec.rounds[0].openedAt -= 9 * H;
  assert.equal(state.taskSummary(rec).status, 'stale');
});

test('a manual close is not overwritten and the pass is throttled without force', () => {
  state.openRound({ ...base, taskId: 'manual' });
  state.closeRound({ taskId: 'manual', round: 1, reason: 'abandoned', code: 'MANUAL' });
  run(Date.now() + 9 * H);
  assert.equal(state.readTask('manual').rounds[0].closeCode, 'MANUAL');
  assert.deepEqual(state.autoReconcile({ now: Date.now() + 40 * H }), { closed: 0, expired: 0 }, 'throttled');
});
