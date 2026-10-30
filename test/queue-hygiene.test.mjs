import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace } from './helpers/harness.mjs';
import { makeHygienicQueue, cleanupOwnedQueue } from '../src/queue-hygiene.mjs';
import { makeCodexLiveDelivery } from '../src/codex-delivery.mjs';
import { readQueueReceipts, QUEUE_TERMINAL_RECEIPTS } from '../src/state.mjs';

const target = '11111111-2222-3333-4444-555555555555';
const sender = { agent: 'claude', id: '22222222-2222-3333-4444-555555555555' };

function fixture() {
  process.env.MAGI_HOME = join(makeWorkspace('queue hygiene'), 'state');
  const rows = [];
  const deleted = [];
  let next = 0;
  const api = {
    resolve: async (id) => id,
    add: async ({ threadId, text, clientId }) => {
      const item = { id: `q-${++next}`, clientUserMessageId: clientId, input: [{ type: 'text', text, text_elements: [] }], threadId };
      rows.push(item);
      return { threadId, messageId: item.id };
    },
    list: async (threadId) => structuredClone(rows.filter((row) => row.threadId === threadId)),
    remove: async ({ threadId, messageId }) => {
      const index = rows.findIndex((row) => row.id === messageId && row.threadId === threadId);
      if (index < 0) return false;
      deleted.push(messageId); rows.splice(index, 1); return true;
    },
  };
  const send = (text, options = {}) => makeHygienicQueue(api)({ target, text, sender, kind: 'note', ...options });
  return { rows, deleted, api, send };
}

test('explicit topic replacement deletes only the prior owned pending note after adding the new one', async () => {
  const f = fixture();
  const first = await f.send('old status', { queueKey: 'audit-status' });
  const result = await f.send('new status', { queueKey: 'audit-status' });
  assert.deepEqual(f.deleted, [first.messageId]);
  assert.equal(f.rows[0].input[0].text, 'new status');
  assert.equal(result.queueHygiene.status, 'complete');
  assert.equal(readQueueReceipts(target).entries[0].state, 'superseded');
});

test('distinct notes survive by default; identical duplicates can coalesce', async () => {
  const f = fixture();
  await f.send('dependency A ready');
  await f.send('do not edit B');
  await f.send('dependency A ready');
  assert.deepEqual(f.rows.map((row) => row.input[0].text), ['do not edit B', 'dependency A ready']);
});

test('matching via=magi headers do not establish ownership', async () => {
  const f = fixture();
  f.rows.push({ id: 'unowned', threadId: target, clientUserMessageId: 'foreign', input: [{ type: 'text', text: 'PEER NOTE magi/1 via=magi\nold status' }] });
  await f.send('new status', { queueKey: 'status' });
  assert.equal(f.deleted.length, 0);
  assert.ok(f.rows.some((row) => row.id === 'unowned'));
});

test('coalescing never crosses sender, target, topic, or note/watch boundaries', async () => {
  const f = fixture();
  await f.send('first', { queueKey: 'status' });
  await f.send('other sender', { queueKey: 'status', sender: { ...sender, id: 'other' } });
  await f.send('other target', { queueKey: 'status', target: 'other-target' });
  await f.send('other topic', { queueKey: 'different' });
  await f.send('watch', { queueKey: 'status', kind: 'watch' });
  assert.equal(f.deleted.length, 0);
});

test('requests and replies never enter the automatic hygiene path', async () => {
  fixture();
  let queued = 0;
  const deliver = makeCodexLiveDelivery({
    queue: async () => { queued++; return { messageId: 'plain', threadId: target }; },
    hygienicQueue: () => assert.fail('must not coalesce requests or replies'),
  });
  for (const kind of ['request', 'reply', 'clarify', 'clarify_answer']) await deliver({ text: kind, target, kind, sender, queueKey: 'unsafe', delivery: 'live' });
  assert.equal(queued, 4);
});

test('an explicit replacement key cannot silently bypass missing sender identity', async () => {
  fixture();
  const deliver = makeCodexLiveDelivery({ queue: () => assert.fail('must not queue an unidentified replacement') });
  await assert.rejects(deliver({ text: 'status', target, kind: 'note', args: { queueKey: 'status' }, delivery: 'live' }), { code: 'QUEUE_IDENTITY_REQUIRED' });
});

test('an edited or attachment-bearing queue item is preserved', async () => {
  const f = fixture();
  await f.send('old', { queueKey: 'status' });
  f.rows[0].input[0].text = 'user-edited instruction';
  await f.send('new', { queueKey: 'status' });
  f.rows[1].input.push({ type: 'image', url: 'fixture' });
  await f.send('newer', { queueKey: 'status' });
  assert.equal(f.deleted.length, 0);
});

test('a failed replacement does not remove the old item', async () => {
  const f = fixture();
  await f.send('old', { queueKey: 'status' });
  f.api.add = async () => { throw Object.assign(new Error('unconfirmed'), { code: 'DELIVERY_UNCONFIRMED' }); };
  await assert.rejects(f.send('new', { queueKey: 'status' }), { code: 'DELIVERY_UNCONFIRMED' });
  assert.equal(readQueueReceipts(target).entries.at(-1).state, 'unconfirmed');
  assert.deepEqual(f.rows.map((row) => row.input[0].text), ['old']);
  assert.equal(f.deleted.length, 0);
});

test('completed receipt history is bounded while the current pending item remains owned', async () => {
  const f = fixture();
  for (let i = 0; i < QUEUE_TERMINAL_RECEIPTS + 5; i++) await f.send(`status ${i}`, { queueKey: 'status' });
  const record = readQueueReceipts(target);
  assert.ok(record.entries.length <= QUEUE_TERMINAL_RECEIPTS + 1);
  assert.equal(record.entries.filter((entry) => entry.state === 'queued').length, 1);
  assert.equal(f.rows.length, 1);
});

test('normal queue disappearance retires a receipt without calling it delivered', async () => {
  const f = fixture();
  await f.send('first');
  f.rows.length = 0;
  await f.send('second');
  assert.equal(readQueueReceipts(target).entries[0].state, 'not_pending');
});

test('cleanup bounds re-list calls and defers excess candidates', async () => {
  const f = fixture();
  const list = f.api.list;
  f.api.list = async () => { throw new Error('offline'); };
  for (let i = 0; i < 7; i++) await f.send(`status ${i}`, { queueKey: 'status' });
  let calls = 0;
  const result = await cleanupOwnedQueue(target, { ...f.api, list: async (id) => { calls++; return list(id); }, dryRun: false, batchLimit: 3 });
  assert.equal(calls, 4);
  assert.equal(result.removed.length, 3);
  assert.equal(result.deferred.length, 3);
  assert.equal(result.status, 'partial');
});

test('cleanup failure reports a queued message without causing a resend', async () => {
  const f = fixture();
  await f.send('old', { queueKey: 'status' });
  f.api.remove = async () => { throw Object.assign(new Error('delete failed'), { code: 'QUEUE_DELETE_FAILED' }); };
  const result = await f.send('new', { queueKey: 'status' });
  assert.equal(result.queueHygiene.status, 'incomplete');
  assert.ok(result.messageId);
  assert.equal(f.rows.length, 2);
});

test('late add acknowledgements cannot replace a newer generation', async () => {
  const f = fixture();
  const add = f.api.add;
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.api.add = async (args) => {
    const receipt = await add(args);
    if (args.text === 'old') { entered(); await new Promise((resolve) => { release = resolve; }); }
    return receipt;
  };
  const old = f.send('old', { queueKey: 'status' });
  await started;
  await f.send('new', { queueKey: 'status' });
  release();
  await old;
  assert.deepEqual(f.rows.map((row) => row.input[0].text), ['new']);
});

test('preview is non-destructive and final verification preserves concurrent edits', async () => {
  const f = fixture();
  // Simulate cleanup being unavailable during both adds.
  const list = f.api.list;
  f.api.list = async () => { throw new Error('offline'); };
  await f.send('old', { queueKey: 'status' });
  await f.send('new', { queueKey: 'status' });
  f.api.list = list;
  assert.equal((await cleanupOwnedQueue(target, { ...f.api })).candidates.length, 1);
  assert.equal(f.deleted.length, 0);
  let calls = 0;
  const changingList = async (id) => { if (++calls === 2) f.rows[0].input[0].text = 'edited during cleanup'; return list(id); };
  const result = await cleanupOwnedQueue(target, { ...f.api, list: changingList, dryRun: false });
  assert.equal(result.status, 'partial');
  assert.equal(f.deleted.length, 0);
});
