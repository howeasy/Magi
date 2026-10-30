import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace } from './helpers/harness.mjs';
import { ackRelayEvents, claimRelayEvents, queueRelayEvent } from '../src/relay.mjs';
import { mirrorRound, readTask, rollbackMirrorRound, RELAY_OUTBOX_DAYS, sweep } from '../src/state.mjs';
import { getRecord, listRecords, setRecord, statement } from '../src/store.mjs';

const TO = 'owner:isolated';
const A = { agent: 'codex', id: 'worker-a', sessionId: 'worker-a' };
const B = { agent: 'codex', id: 'worker-b', sessionId: 'worker-b' };

function isolated(t) {
  const home = join(makeWorkspace('relay outbox state'), 'home');
  const saved = { MAGI_HOME: process.env.MAGI_HOME, MAGI_TEST_HOME: process.env.MAGI_TEST_HOME };
  process.env.MAGI_HOME = home;
  process.env.MAGI_TEST_HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return home;
}

function mirror(taskId, { round = 1, peerTarget = A, ...extra } = {}) {
  const args = { taskId, orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round,
    orchestratorTarget: { agent: 'claude', remote: TO }, peerTarget, attemptId: 'creator', ...extra };
  mirrorRound(args);
  return args;
}

function legacy(home, { id = 'legacy-event', taskId = 'magi-legacy', ...extra } = {}) {
  const ev = { id, to: TO, taskId, round: 1, action: 'note', body: 'Preserve this worker observation.', files: [], at: Date.now(), claim: null, ...extra };
  setRecord(home, 'relay-outbox', id, ev);
  return ev;
}

function warnings(t) {
  const out = [];
  t.mock.method(console, 'warn', (...args) => out.push(args.join(' ')));
  return out;
}

test('admitting an outgoing note revokes creator rollback without losing the round or event', (t) => {
  const home = isolated(t);
  const base = mirror('magi-admission');
  const id = queueRelayEvent({ to: TO, taskId: base.taskId, round: 1, action: 'note', body: 'Already observed by the worker.' });
  assert.equal(rollbackMirrorRound(base), false, 'a queued note means the creator no longer owns an unused mirror');
  assert.equal(readTask(base.taskId).rounds[0].peerTarget.id, A.id);
  const [event] = claimRelayEvents(TO, { pid: process.pid });
  assert.equal(event.id, id);
  assert.equal(event.body, 'Already observed by the worker.');
  assert.equal(getRecord(home, 'relay-outbox', id).worker.id, A.id);
});

test('missing cards or exact rounds refuse admission without an event or revoking rollback', (t) => {
  const home = isolated(t);
  assert.throws(() => queueRelayEvent({ to: TO, taskId: 'magi-absent', round: 1, action: 'note' }), { code: 'UNKNOWN_TASK', dispatchUncertain: false });
  const base = mirror('magi-missing-round');
  assert.throws(() => queueRelayEvent({ to: TO, taskId: base.taskId, round: 2, action: 'note' }), { code: 'BAD_ROUND', dispatchUncertain: false });
  assert.deepEqual(listRecords(home, 'relay-outbox'), []);
  assert.equal(rollbackMirrorRound(base), true, 'refused admission did not use the real round');
});

test('an outbox insert failure rolls back mirror revocation in the same transaction', (t) => {
  const home = isolated(t);
  const base = mirror('magi-failed-admission');
  statement(home, `CREATE TRIGGER reject_outbox BEFORE INSERT ON records
    WHEN NEW.namespace='relay-outbox' BEGIN SELECT RAISE(ABORT,'outbox admission failed'); END`).run();
  assert.throws(() => queueRelayEvent({ to: TO, taskId: base.taskId, round: 1, action: 'note' }), (error) => {
    assert.match(error.message, /outbox admission failed/);
    assert.notEqual(error.dispatchUncertain, false, 'unknown storage failures are not classified as proven non-dispatch refusals');
    return true;
  });
  assert.deepEqual(listRecords(home, 'relay-outbox'), []);
  assert.equal(rollbackMirrorRound(base), true, 'failed admission restored the creator\'s rollback eligibility');
  assert.equal(readTask(base.taskId), null);
});

test('new events resolve an omitted round once and preserve explicit old-round identity', (t) => {
  isolated(t);
  const taskId = 'magi-concrete-round';
  mirror(taskId);
  mirror(taskId, { round: 2, peerTarget: B });
  const latest = queueRelayEvent({ to: TO, taskId, action: 'note', body: 'From B' });
  const old = queueRelayEvent({ to: TO, taskId, round: 1, action: 'note', body: 'From A' });
  const events = claimRelayEvents(TO, { pid: process.pid });
  assert.deepEqual(events.find((ev) => ev.id === latest).worker, B);
  assert.equal(events.find((ev) => ev.id === latest).round, 2);
  assert.deepEqual(events.find((ev) => ev.id === old).worker, A);
  assert.equal(events.find((ev) => ev.id === old).round, 1);
});

test('legacy recovery stamps the exact old round A while round B remains current', (t) => {
  const home = isolated(t);
  const taskId = 'magi-legacy';
  mirror(taskId);
  const ev = legacy(home);
  mirror(taskId, { round: 2, peerTarget: B });
  const [claimed] = claimRelayEvents(TO, { pid: process.pid });
  assert.equal(claimed.id, ev.id);
  assert.equal(claimed.round, 1);
  assert.deepEqual(claimed.worker, A);
  assert.equal(claimed.body, ev.body);
  assert.equal(readTask(taskId).peerTarget.id, B.id);
  assert.deepEqual(getRecord(home, 'relay-outbox', ev.id).worker, A, 'the stamp is persisted before delivery');
  ackRelayEvents([ev.id]);
  assert.equal(getRecord(home, 'relay-outbox', ev.id), null, 'a recoverable event remains normally acknowledgeable');
});

test('recovering a legacy event revokes rollback of the exact mirror round it needs', (t) => {
  const home = isolated(t);
  const base = mirror('magi-legacy');
  const ev = legacy(home);
  const [claimed] = claimRelayEvents(TO, { pid: process.pid });
  assert.equal(claimed.id, ev.id);
  assert.deepEqual(claimed.worker, A);
  assert.equal(rollbackMirrorRound(base), false);
  assert.equal(readTask(base.taskId).rounds[0].peerTarget.id, A.id);
});

test('a failed legacy stamp leaves its event intact and restores mirror rollback eligibility', (t) => {
  const home = isolated(t);
  const base = mirror('magi-legacy');
  const ev = legacy(home);
  statement(home, `CREATE TRIGGER reject_legacy_stamp BEFORE UPDATE ON records
    WHEN NEW.namespace='relay-outbox' AND json_extract(NEW.value,'$.worker') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'legacy stamp failed'); END`).run();
  assert.throws(() => claimRelayEvents(TO, { pid: process.pid }), /legacy stamp failed/);
  assert.deepEqual(getRecord(home, 'relay-outbox', ev.id), ev, 'neither the worker stamp nor a claim committed');
  assert.equal(rollbackMirrorRound(base), true);
});

test('admission cannot redirect a mirror event to a different orchestrator', (t) => {
  const home = isolated(t);
  const base = mirror('magi-wrong-owner');
  assert.throws(() => queueRelayEvent({ to: 'other:owner', taskId: base.taskId, round: 1, action: 'note' }), { code: 'ROLE_VIOLATION', dispatchUncertain: false });
  assert.deepEqual(listRecords(home, 'relay-outbox'), []);
  assert.equal(rollbackMirrorRound(base), true);
});

for (const scenario of ['missing card', 'missing round', 'missing event round', 'missing round target', 'ambiguous round', 'missing identity', 'ambiguous identity', 'invalid mirror binding', 'not a mirror']) {
  test(`unresolved legacy ${scenario} stays stored and unclaimed, with a non-repeating actionable warning`, (t) => {
    const home = isolated(t);
    const logs = warnings(t);
    const taskId = 'magi-legacy';
    if (scenario !== 'missing card') {
      mirror(taskId);
      mirror(taskId, { round: 2, peerTarget: B });
      const card = readTask(taskId);
      if (scenario === 'missing round') card.rounds.shift();
      if (scenario === 'missing round target') delete card.rounds[0].peerTarget;
      if (scenario === 'ambiguous round') card.rounds.push({ ...card.rounds[0], peerTarget: B });
      if (scenario === 'missing identity') card.rounds[0].peerTarget = { agent: 'codex', name: 'not-an-identity' };
      if (scenario === 'ambiguous identity') card.rounds[0].peerTarget = { agent: 'codex', id: A.id, sessionId: B.id };
      if (scenario === 'invalid mirror binding') card.orchestratorTarget.remote = 'another:owner';
      if (scenario === 'not a mirror') card.mirror = false;
      setRecord(home, 'tasks', taskId, card);
    }
    const now = Date.now();
    const ev = legacy(home, { ...(scenario === 'missing event round' ? { round: null } : {}), claim: { pid: process.pid, at: now } });
    assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }, { now }), []);
    const stored = getRecord(home, 'relay-outbox', ev.id);
    assert.equal(stored.body, ev.body);
    assert.equal(stored.worker, undefined);
    assert.equal(stored.claim, null, 'even an existing fresh claim must be released');
    ackRelayEvents([ev.id]);
    assert.ok(getRecord(home, 'relay-outbox', ev.id), 'an old in-flight acknowledgement cannot delete unresolved data');
    assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }, { now: now + 750 }), []);
    assert.equal(logs.length, 1, 'polling does not repeat the same warning');
    assert.match(logs[0], /RELAY_LEGACY_EVENT_HELD/);
    assert.ok(logs[0].includes(`event_id=${ev.id} task_id=${taskId} round=${ev.round ?? '(missing)'}`));
  });
}

test('repairing an unresolved exact-round identity makes its original event deliverable', (t) => {
  const home = isolated(t);
  warnings(t);
  const taskId = 'magi-repaired';
  mirror(taskId);
  const card = readTask(taskId);
  delete card.rounds[0].peerTarget;
  setRecord(home, 'tasks', taskId, card);
  const ev = legacy(home, { taskId });
  assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }), []);
  card.rounds[0].peerTarget = A;
  setRecord(home, 'tasks', taskId, card);
  const [claimed] = claimRelayEvents(TO, { pid: process.pid });
  assert.equal(claimed.id, ev.id);
  assert.deepEqual(claimed.worker, A);
  assert.equal(claimed.body, ev.body);
});

test('expired legacy rows are retained by claims and startup sweep, never upgraded into unsafe replay', async (t) => {
  const home = isolated(t);
  const logs = warnings(t);
  mirror('magi-legacy');
  const at = Date.now() - (RELAY_OUTBOX_DAYS + 1) * 86400000;
  const recoverable = legacy(home, { at, id: 'expired-recoverable' });
  const unresolved = legacy(home, { at, id: 'expired-unresolved', taskId: 'magi-missing' });
  assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }), []);
  await sweep();
  assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }), []);
  for (const ev of [recoverable, unresolved]) {
    const stored = getRecord(home, 'relay-outbox', ev.id);
    assert.equal(stored.body, ev.body);
    assert.equal(stored.worker, undefined, 'expiry must not become a stamp that later permits pruning');
    assert.equal(stored.claim, null);
  }
  assert.equal(logs.length, 2);
});

test('ordinary stamped events still expire through claim and startup retention', async (t) => {
  const home = isolated(t);
  mirror('magi-stamped-retention');
  const at = Date.now() - (RELAY_OUTBOX_DAYS + 1) * 86400000;
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const id = queueRelayEvent({ to: TO, taskId: 'magi-stamped-retention', round: 1, action: 'note' });
    setRecord(home, 'relay-outbox', id, { ...getRecord(home, 'relay-outbox', id), at });
    ids.push(id);
  }
  await sweep();
  assert.equal(getRecord(home, 'relay-outbox', ids[0]), null);
  assert.equal(getRecord(home, 'relay-outbox', ids[1]), null);
  const id = queueRelayEvent({ to: TO, taskId: 'magi-stamped-retention', round: 1, action: 'note' });
  assert.deepEqual(claimRelayEvents(TO, { pid: process.pid }, { now: Date.now() + (RELAY_OUTBOX_DAYS + 1) * 86400000 }), []);
  assert.equal(getRecord(home, 'relay-outbox', id), null);
});

test('a missing recorded worker refuses admission definitely without using the round', (t) => {
  const home = isolated(t);
  const base = mirror('magi-no-worker', { peerTarget: { agent: 'codex', name: 'not-an-identity' } });
  assert.throws(() => queueRelayEvent({ to: TO, taskId: base.taskId, round: 1, action: 'note' }), { code: 'ROLE_VIOLATION', dispatchUncertain: false });
  assert.deepEqual(listRecords(home, 'relay-outbox'), []);
  assert.equal(rollbackMirrorRound(base), true);
});
