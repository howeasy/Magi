import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmCodex } from '../src/delivery-confirm.mjs';
import { makeCodexLiveDelivery, makeCodexReplyDelivery } from '../src/codex-delivery.mjs';
import { codexThreadCursor } from '../src/codex-history.mjs';
import { makeHygienicQueue } from '../src/queue-hygiene.mjs';
import { channelsOf, refreshChannelDeliveries } from '../src/fleet.mjs';
import { readTask, recordCardDelivery } from '../src/state.mjs';
import { setRecord } from '../src/store.mjs';

async function fixture(t) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); }
  catch { t.skip('node:sqlite unavailable on this Node'); return null; }
  const home = mkdtempSync(join(tmpdir(), 'magi-codex-confirm-'));
  const saved = Object.fromEntries(['MAGI_HOME', 'CODEX_HOME', 'MAGI_CONFIRM_MS'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { MAGI_HOME: home, CODEX_HOME: home, MAGI_CONFIRM_MS: '0' });
  const db = new sqlite.DatabaseSync(join(home, 'thread_history_1.sqlite'));
  db.exec(`create table thread_turns (thread_id text, turn_id text, rollout_ordinal int, status text, started_at int, completed_at int);
    create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal int, created_at_ms int, item_json text, item_type text);`);
  const insert = db.prepare('insert into thread_items values (?, ?, ?, ?, ?, ?, ?)');
  const item = ({ threadId = 'thread', turnId = 'turn', id = 'item', ordinal = 0, at = 1000, type = 'userMessage', clientId = 'client', raw } = {}) =>
    insert.run(threadId, turnId, id, ordinal, at, raw ?? JSON.stringify({ type, clientId, content: [{ type: 'text', text: 'same payload' }] }), type);
  // A desktop steer as codex 0.160.1 stores it: a functionCallOutput whose
  // output wraps the XML-escaped text in <codex_delegation>.
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const steer = ({ threadId = 'thread', turnId = 'turn', id = 'fco', ordinal, at = 1000, marker, name = 'send_message_to_thread', namespace = 'codex_app', text = 'stop <now> & rebase' } = {}) =>
    insert.run(threadId, turnId, id, ordinal, at, JSON.stringify({ type: 'functionCallOutput', id, name, namespace,
      output: `<codex_delegation>\n  <source_thread_id>${threadId}</source_thread_id>\n  <input>${escape(`${text}\n\n${marker}`)}</input>\n</codex_delegation>` }), 'functionCallOutput');
  t.after(() => {
    db.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { db, item, steer, home };
}

const receipt = { threadId: 'thread', clientId: 'client', timeoutMs: 0 };

test('Codex confirms only an exact clientId userMessage in the destination thread', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item({ threadId: 'another-thread' });
  f.item({ clientId: 'another-client' });
  f.item({ type: 'agentMessage' });
  f.item({ raw: '{broken JSON' });
  assert.equal(await confirmCodex(receipt), 'queued_unread');
  f.item({ turnId: 'received-turn' });
  assert.equal(await confirmCodex(receipt), 'received');
});

test('Codex identifies earlier same-turn items, including after the running turn completes', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.db.prepare('insert into thread_turns values (?, ?, ?, ?, ?, ?)').run('thread', 'turn', 0, 'completed', 1, 3);
  f.item({ id: 'earlier', type: 'reasoning', clientId: null, at: 1000 });
  f.item({ id: 'delivered', ordinal: 1, at: 2000 });
  assert.equal(await confirmCodex(receipt), 'received_mid_turn');
});

test('Codex equal timestamp ordering uses rollout ordinal, not another thread or turn', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item({ threadId: 'another-thread', type: 'reasoning', at: 500 });
  f.item({ turnId: 'another-turn', type: 'reasoning', at: 500 });
  f.item({ id: 'delivered', ordinal: 2 });
  assert.equal(await confirmCodex(receipt), 'received');
  f.item({ id: 'earlier', type: 'reasoning', ordinal: 1 });
  assert.equal(await confirmCodex(receipt), 'received_mid_turn');
});

test('Codex missing identities are unconfirmed; known queue identities await history', async (t) => {
  const f = await fixture(t); if (!f) return;
  assert.equal(await confirmCodex({ threadId: 'thread', timeoutMs: 0 }), 'unconfirmed');
  assert.equal(await confirmCodex({ clientId: 'client', timeoutMs: 0 }), 'unconfirmed');
  assert.equal(await confirmCodex(receipt), 'queued_unread');
  process.env.CODEX_HOME = join(f.home, 'absent');
  assert.equal(await confirmCodex(receipt), 'queued_unread');
});

test('Codex uses MAGI_CONFIRM_MS to wait for a delayed persisted item', async (t) => {
  const f = await fixture(t); if (!f) return;
  process.env.MAGI_CONFIRM_MS = '1000';
  const timer = setTimeout(() => f.item(), 20);
  t.after(() => clearTimeout(timer));
  assert.equal(await confirmCodex({ threadId: 'thread', clientId: 'client' }), 'received');
});

test('live Codex delivery distinguishes queued evidence from receipt without resending', async (t) => {
  const f = await fixture(t); if (!f) return;
  let sends = 0;
  const deliver = makeCodexLiveDelivery({ queue: async () => {
    sends++;
    return { threadId: 'thread', clientId: 'client', messageId: 'queue-item' };
  } });
  const queued = await deliver({ text: 'peer request', target: 'thread', kind: 'request' });
  assert.equal(queued.deliveryStatus, 'queued_unread');
  assert.equal(sends, 1);
  f.item();
  assert.equal(await confirmCodex(queued), 'received');
  assert.equal(sends, 1, 'confirmation must not send another queue item');
});

test('Codex live delivery confirms a consumed queue receipt and preserves steer acceptance', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item();
  const target = '00000000-0000-0000-0000-000000000001';
  let steers = 0;
  const deliver = makeCodexLiveDelivery({
    queue: async () => ({ threadId: 'thread', clientId: 'client', messageId: 'queue-item' }),
    steer: async () => { steers++; },
  });
  assert.equal((await deliver({ text: 'peer request', target, kind: 'request' })).deliveryStatus, 'received');
  const steered = await deliver({ text: 'peer request', target, delivery: 'steer' });
  assert.equal(steered.deliveryStatus, 'accepted');
  assert.match(steered.statusText, /unconfirmed/);
  assert.equal(steers, 1);
});

test('hygienic receipts retain their reserved clientId for history confirmation', async (t) => {
  const f = await fixture(t); if (!f) return;
  const send = makeHygienicQueue({
    resolve: async (target) => target,
    add: async ({ threadId, clientId }) => {
      f.item({ threadId, clientId });
      return { threadId, messageId: 'queue-item' };
    },
    list: async () => [],
    remove: () => assert.fail('a consumed message must not be deleted or resent'),
  });
  const result = await send({ target: 'thread', text: 'peer note', kind: 'note', sender: { id: 'sender', agent: 'claude' } });
  assert.equal(await confirmCodex({ ...result, timeoutMs: 0 }), 'received');
});

function card(taskId, delivery, round = 1) {
  return { taskId, orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', maxRounds: 2,
    orchestratorTarget: { id: 'coordinator', name: 'lead' }, peerTarget: { id: 'thread', name: 'worker' },
    rounds: [{ round, openedAt: Date.now(), brief: 'inspect', deliveries: delivery ? { [delivery.to]: delivery } : undefined }] };
}

test('channel polling upgrades exact queued evidence without changing the stored card', async (t) => {
  const f = await fixture(t); if (!f) return;
  const pending = { to: 'codex', threadId: 'thread', clientId: 'client', deliveryStatus: 'queued_unread' };
  const tasks = [card('magi-pending', pending), card('magi-other', { ...pending, clientId: 'other' })];
  for (const task of tasks) setRecord(f.home, 'tasks', task.taskId, task);
  const channels = channelsOf(tasks);
  await refreshChannelDeliveries(channels);
  const cards = channels.flatMap((channel) => channel.turns);
  assert.equal(cards.find((c) => c.taskId === 'magi-pending').deliveryStatus, 'queued_unread');
  f.item();
  await refreshChannelDeliveries(channels);
  assert.equal(cards.find((c) => c.taskId === 'magi-pending').deliveryStatus, 'received');
  assert.equal(cards.find((c) => c.taskId === 'magi-other').deliveryStatus, 'queued_unread');
  assert.equal(readTask('magi-pending').rounds[0].deliveries.codex.deliveryStatus, 'queued_unread');
  assert.equal(channels[0].deliveryStatus, channels[0].currentCard.deliveryStatus);
});

test('remote Codex acceptance is never confirmed by an unrelated local thread with the same ids', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item();
  const pending = { to: 'codex', threadId: 'thread', clientId: 'client', messageId: 'client', deliveryStatus: 'accepted', via: 'relay:remote:steer:thread' };
  const task = card('magi-remote-accepted', pending);
  task.peerTarget.host = 'remote';
  const channels = channelsOf([task]);
  await refreshChannelDeliveries(channels);
  assert.equal(channels[0].currentCard.deliveryStatus, 'accepted');
  assert.equal(channels[0].currentCard.deliveries[0].deliveryStatus, 'accepted');
});

test('cards project the latest delivery in their current round, never a previous round receipt', async (t) => {
  const f = await fixture(t); if (!f) return;
  const task = card('magi-latest', null);
  setRecord(f.home, 'tasks', task.taskId, task);
  recordCardDelivery(task.taskId, 1, { to: 'codex', threadId: 'thread', clientId: 'old', deliveryStatus: 'received', at: 1000 });
  recordCardDelivery(task.taskId, 1, { to: 'codex', threadId: 'thread', clientId: 'new', deliveryStatus: 'queued_unread', at: 2000 });
  recordCardDelivery(task.taskId, 1, { to: 'codex', threadId: 'thread', clientId: 'late-old-request', deliveryStatus: 'received', at: 1500 });
  let current = readTask(task.taskId);
  let [channel] = channelsOf([current]);
  assert.equal(channel.currentCard.delivery.clientId, 'new');
  assert.equal(channel.deliveryStatus, 'queued_unread');
  current.rounds.push({ round: 2, openedAt: Date.now(), brief: 'continue' });
  [channel] = channelsOf([current]);
  assert.equal(channel.currentCard.deliveryStatus, 'unconfirmed');
  assert.equal(channel.currentCard.delivery, null);
});

const steerThread = '00000000-0000-0000-0000-000000000001';
const marker = 'magi-delivery:5f0c2a1e-0000-4000-8000-000000000001';

test('a steer receipt is its marker in a later desktop functionCallOutput, read once the model acts', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item({ threadId: steerThread, turnId: 'old', id: 'said', ordinal: 0, type: 'agentMessage', clientId: null });
  f.steer({ threadId: steerThread, turnId: 'old', id: 'reused', ordinal: 1, marker });
  const cursor = await codexThreadCursor(steerThread);
  assert.equal(cursor, 1);
  const receipt = { threadId: steerThread, marker, cursor, timeoutMs: 0 };
  assert.equal(await confirmCodex(receipt), 'accepted', 'evidence at or before the cursor is not this send');
  f.steer({ threadId: steerThread, turnId: 'noise', id: 'other-tool', ordinal: 2, marker, name: 'spawn_agent' });
  f.steer({ threadId: steerThread, turnId: 'noise', id: 'other-namespace', ordinal: 3, marker, namespace: 'other' });
  f.steer({ threadId: steerThread, turnId: 'noise', id: 'other-marker', ordinal: 4, marker: 'magi-delivery:other' });
  f.steer({ threadId: 'another-thread', turnId: 'noise', id: 'elsewhere', ordinal: 5, marker });
  f.item({ threadId: steerThread, turnId: 'noise', id: 'broken', ordinal: 5, type: 'functionCallOutput', raw: '{broken JSON' });
  assert.equal(await confirmCodex(receipt), 'accepted');
  f.steer({ threadId: steerThread, turnId: 'new', id: 'landed', ordinal: 6, marker });
  assert.equal(await confirmCodex(receipt), 'queued_unread', 'landing in history is not the model reading it');
  f.item({ threadId: steerThread, turnId: 'new', id: 'read', ordinal: 7, type: 'reasoning', clientId: null });
  assert.equal(await confirmCodex(receipt), 'received');
});

test('steer mid-turn absorption follows rollout order, and a command already running is not a read', async (t) => {
  const f = await fixture(t); if (!f) return;
  const receipt = { threadId: steerThread, marker, cursor: await codexThreadCursor(steerThread), timeoutMs: 0 };
  assert.equal(receipt.cursor, -1, 'an empty thread still has a cursor');
  // Written first, timestamped last: rollout order, not created_at_ms, decides.
  f.item({ threadId: steerThread, turnId: 'turn', id: 'before', ordinal: 0, type: 'reasoning', clientId: null, at: 5000 });
  f.steer({ threadId: steerThread, turnId: 'turn', id: 'landed', ordinal: 1, marker, at: 2000 });
  f.item({ threadId: steerThread, turnId: 'turn', id: 'running', ordinal: 2, type: 'commandExecution', clientId: null, at: 1500 });
  assert.equal(await confirmCodex(receipt), 'queued_unread', 'a command started before the steer and finished after it proves nothing');
  f.item({ threadId: steerThread, turnId: 'turn', id: 'acted', ordinal: 3, type: 'commandExecution', clientId: null, at: 2500 });
  assert.equal(await confirmCodex(receipt), 'received_mid_turn');
});

test('steer replies return immediately and upgrade only from their own marker', { timeout: 10000 }, async (t) => {
  const f = await fixture(t); if (!f) return;
  const task = { orchestrator: 'codex', orchestratorTarget: { agent: 'codex', id: steerThread } };
  process.env.MAGI_CONFIRM_MS = '60000';
  const deliver = makeCodexReplyDelivery({ steer: async ({ thread }) => ({ threadId: thread, marker, cursor: await codexThreadCursor(thread) }) });
  const receipt = await deliver({ text: 'reply', task, delivery: 'steer' });
  assert.equal(receipt.deliveryStatus, 'accepted');
  const channels = channelsOf([card('magi-steer-reply', { ...receipt, to: 'codex' }),
    card('magi-steer-without-marker', { to: 'codex', threadId: steerThread, deliveryStatus: 'accepted' })]);
  const cards = channels.flatMap((channel) => channel.turns);
  const status = (taskId) => cards.find((entry) => entry.taskId === taskId).deliveryStatus;
  await refreshChannelDeliveries(channels);
  assert.equal(status('magi-steer-reply'), 'accepted');
  f.steer({ threadId: steerThread, turnId: 'turn', ordinal: 0, marker });
  await refreshChannelDeliveries(channels);
  assert.equal(status('magi-steer-reply'), 'queued_unread');
  f.item({ threadId: steerThread, turnId: 'turn', id: 'read', ordinal: 1, type: 'agentMessage', clientId: null });
  await refreshChannelDeliveries(channels);
  assert.equal(status('magi-steer-reply'), 'received');
  assert.equal(status('magi-steer-without-marker'), 'accepted');
});

test('live steer confirms from history through the marker its transport appended', async (t) => {
  const f = await fixture(t); if (!f) return;
  f.item({ threadId: steerThread, turnId: 'turn', id: 'working', ordinal: 0, type: 'reasoning', clientId: null });
  const deliver = makeCodexLiveDelivery({ steer: async ({ thread }) => {
    const cursor = await codexThreadCursor(thread);
    f.steer({ threadId: thread, turnId: 'turn', ordinal: cursor + 1, marker });
    f.item({ threadId: thread, turnId: 'turn', id: 'read', ordinal: cursor + 2, type: 'reasoning', clientId: null });
    return { threadId: thread, marker, cursor };
  } });
  const result = await deliver({ text: 'steer', target: steerThread, delivery: 'steer' });
  assert.equal(result.deliveryStatus, 'received_mid_turn');
  assert.equal(result.marker, marker);
});

test('a reply home keeps the other direction\'s receipt for later confirmation', async (t) => {
  const f = await fixture(t); if (!f) return;
  // A round recorded before per-direction slots holds a single `delivery`.
  const task = card('magi-two-way', null);
  task.rounds[0].delivery = { to: 'codex', threadId: steerThread, marker, cursor: -1, deliveryStatus: 'accepted', at: 1000 };
  setRecord(f.home, 'tasks', task.taskId, task);
  recordCardDelivery(task.taskId, 1, { to: 'claude', deliveryStatus: 'received', at: 2000 });
  recordCardDelivery(task.taskId, 1, { to: 'codex', threadId: steerThread, marker: 'magi-delivery:older', cursor: -1, deliveryStatus: 'accepted', at: 500 });
  const stored = readTask(task.taskId).rounds[0];
  assert.equal(stored.deliveries.codex.marker, marker, 'neither the reply home nor an older send replaces it');
  assert.equal(stored.deliveries.claude.deliveryStatus, 'received');
  assert.equal(stored.delivery, undefined);
  const [channel] = channelsOf([readTask(task.taskId)]);
  assert.equal(channel.currentCard.delivery.to, 'claude', 'the card shows the latest receipt');
  f.steer({ threadId: steerThread, turnId: 'turn', ordinal: 0, marker });
  f.item({ threadId: steerThread, turnId: 'turn', id: 'read', ordinal: 1, type: 'reasoning', clientId: null });
  await refreshChannelDeliveries([channel]);
  assert.equal(channel.currentCard.deliveries.find((d) => d.to === 'codex').deliveryStatus, 'received');
  assert.equal(readTask(task.taskId).rounds[0].deliveries.codex.deliveryStatus, 'accepted', 'polling changes the view, not the ledger');
});
