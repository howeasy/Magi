import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { openCodexDaemon } from '../src/codex-daemon.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const T = '01900000-0000-7000-8000-000000000001';
const U = '01900000-0000-7000-8000-000000000002';

// The earlier test encoder is private; importing that test file would run its suite again.
function serverFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extended);
  header[0] = 128 | opcode;
  header[1] = extended === 8 ? 127 : extended === 2 ? 126 : payload.length;
  if (extended === 2) header.writeUInt16BE(payload.length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function fixture(t, handler = () => {}, options = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const messages = [];
  const frames = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const peer = {
    readable, writable, messages, frames,
    send(message) { readable.write(serverFrame(1, JSON.stringify(message))); },
    result(id, result) { peer.send({ id, result }); },
    error(id, message, code = -32600, data) { peer.send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } }); },
  };
  writable.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const request = buffer.subarray(0, end + 4).toString('ascii');
      const key = /^Sec-WebSocket-Key: (.+)\r$/mi.exec(request)[1];
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      readable.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    }
    while (buffer.length >= 2) {
      const marker = buffer[1] & 127;
      const extended = marker === 126 ? 2 : marker === 127 ? 8 : 0;
      const masked = Boolean(buffer[1] & 128);
      const header = 2 + extended + (masked ? 4 : 0);
      if (buffer.length < header) return;
      const size = extended === 8 ? Number(buffer.readBigUInt64BE(2)) : extended === 2 ? buffer.readUInt16BE(2) : marker;
      if (buffer.length < header + size) return;
      const opcode = buffer[0] & 15;
      const payload = Buffer.from(buffer.subarray(header, header + size));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[2 + extended + i % 4];
      buffer = buffer.subarray(header + size);
      frames.push({ opcode, payload });
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString());
      messages.push(message);
      if (message.method === 'initialize' && !options.manualInitialize) {
        peer.result(message.id, { userAgent: 'fake-codex/0.160.1', codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'linux' });
      } else handler(message, peer);
    }
  });
  peer.ready = openCodexDaemon({ readable, writable, clientVersion: '9.8.7', timeoutMs: 2000, ...options });
  peer.ready.catch(() => {});
  t.after(() => { readable.destroy(); writable.destroy(); });
  return peer;
}

test('initializes before becoming usable, declares no approval ownership, and sends initialized', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  assert.deepEqual(peer.messages, [
    {
      id: 1, method: 'initialize', params: {
        clientInfo: { name: 'magi', title: 'Magi', version: '9.8.7' },
        capabilities: {
          experimentalApi: true, requestAttestation: false,
          optOutNotificationMethods: [
            'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
            'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
          ],
        },
      },
    },
    { method: 'initialized' },
  ]);
  assert.equal(Object.hasOwn(peer.messages[0].params.capabilities, 'explicitGatewayOauth'), false);
  assert.deepEqual(client.unansweredRequests(), { count: 0, methods: {} });
  client.close();
});

test('finds an exact id through metadata-only read', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/read') peer.result(message.id, { thread: { id: T, name: 'worker', status: { type: 'idle' } } });
  });
  const client = await peer.ready;
  assert.equal((await client.findThread({ id: T })).name, 'worker');
  assert.deepEqual(peer.messages[2].params, { threadId: T, includeTurns: false });
  assert.equal(peer.messages[2].method, 'thread/read');
  client.close();
});

test('finds an exact name across pages without mistaking substring matches or duplicate ids', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method !== 'thread/list') return;
    peer.result(message.id, message.params.cursor
      ? { data: [{ id: T, name: 'worker' }], nextCursor: null, backwardsCursor: null }
      : { data: [{ id: 'other', name: 'worker suffix' }, { id: T, name: 'worker' }], nextCursor: 'page-2', backwardsCursor: null });
  });
  const client = await peer.ready;
  assert.equal((await client.findThread({ name: 'worker' })).id, T);
  const requests = peer.messages.filter((m) => m.method === 'thread/list');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].params, { limit: 100, archived: false, modelProviders: [], useStateDbOnly: true, searchTerm: 'worker' });
  assert.equal(requests[1].params.cursor, 'page-2');
  client.close();
});

test('refuses missing and ambiguous exact names and names their candidates', async (t) => {
  for (const [name, data, code] of [
    ['zero', [{ id: 'partial', name: 'worker suffix' }], 'THREAD_NOT_FOUND'],
    ['several', [{ id: 'first', name: 'worker' }, { id: 'second', name: 'worker' }], 'AMBIGUOUS_THREAD'],
  ]) {
    await t.test(name, async (t) => {
      const peer = fixture(t, (message, peer) => {
        if (message.method === 'thread/list') peer.result(message.id, { data, nextCursor: null });
      });
      const client = await peer.ready;
      await assert.rejects(client.findThread({ name: 'worker' }), (cause) => {
        assert.equal(cause.code, code);
        assert.deepEqual(cause.candidates, data);
        for (const candidate of data) assert.ok(cause.message.includes(candidate.id));
        return true;
      });
      client.close();
    });
  }
});

test('does not select a first-page match before checking later pages for ambiguity', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/list') peer.result(message.id, {
      data: [{ id: message.params.cursor ? 'second' : 'first', name: 'worker' }],
      nextCursor: message.params.cursor ? null : 'more',
    });
  });
  const client = await peer.ready;
  await assert.rejects(client.findThread({ name: 'worker' }), { code: 'AMBIGUOUS_THREAD' });
  client.close();
});

test('refuses cyclic pagination instead of returning a partial name selection', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/list') peer.result(message.id, { data: [{ id: T, name: 'worker' }], nextCursor: 'same' });
  });
  const client = await peer.ready;
  await assert.rejects(client.findThread({ name: 'worker' }), { code: 'PAGINATION_FAILED' });
  client.close();
});

test('enumerates all loaded ids across pages', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/loaded/list') peer.result(message.id, message.params.cursor
      ? { data: ['second', T], nextCursor: null }
      : { data: [T], nextCursor: 'loaded-page-2' });
  });
  const client = await peer.ready;
  assert.deepEqual(await client.loadedIds(), [T, 'second']);
  assert.ok(peer.messages.slice(2).every((m) => m.method === 'thread/loaded/list'));
  client.close();
});

test('reads the in-progress turn id or null without resuming the thread', async (t) => {
  let active = true;
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/read') peer.result(message.id, { thread: {
      id: T, turns: [{ id: 'completed', status: 'completed' }, ...(active ? [{ id: U, status: 'inProgress' }] : [])],
    } });
  });
  const client = await peer.ready;
  assert.equal(await client.activeTurnId(T), U);
  active = false;
  assert.equal(await client.activeTurnId(T), null);
  assert.ok(peer.messages.slice(2).every((m) => m.method === 'thread/read' && m.params.includeTurns === true));
  client.close();
});

test('returns queue acceptance with its queue id and caller correlation id', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/queue/add') peer.result(message.id, { queuedSubmission: {
      id: 'queue-id', clientUserMessageId: message.params.clientUserMessageId, input: message.params.input,
    } });
  });
  const client = await peer.ready;
  const queued = await client.queueAdd(T, 'inspect 世界', 'client-queue');
  assert.deepEqual(queued, { id: 'queue-id', clientUserMessageId: 'client-queue', input: [{ type: 'text', text: 'inspect 世界', text_elements: [] }] });
  assert.equal(peer.messages[2].params.threadId, T);
  client.close();
});

test('steers only the explicit expected turn and returns its acceptance', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'turn/steer') peer.result(message.id, { turnId: message.params.expectedTurnId });
  });
  const client = await peer.ready;
  assert.deepEqual(await client.steer(T, U, 'change direction', 'client-steer'), { turnId: U });
  assert.deepEqual(peer.messages[2].params, {
    threadId: T, expectedTurnId: U, clientUserMessageId: 'client-steer',
    input: [{ type: 'text', text: 'change direction', text_elements: [] }],
  });
  client.close();
});

test('maps all four steer refusals without refreshing or queue fallback', async (t) => {
  for (const [message, code, expected] of [
    ['no active turn to steer', 'NO_ACTIVE_TURN', U],
    [`expected active turn id \`${U}\` but found \`other\``, 'TURN_MISMATCH', U],
    [`thread not found: ${T}`, 'THREAD_NOT_LOADED', U],
    ['expectedTurnId must not be empty', 'BAD_REQUEST', ''],
  ]) {
    await t.test(code, async (t) => {
      const peer = fixture(t, (request, peer) => {
        if (request.method === 'turn/steer') peer.error(request.id, message);
      });
      const client = await peer.ready;
      await assert.rejects(client.steer(T, expected, 'direction', 'client-id'), (cause) => {
        assert.equal(cause.code, code);
        assert.equal(cause.rpcCode, -32600);
        assert.equal(cause.dispatchUncertain, false);
        assert.ok(cause.message.includes(message));
        return true;
      });
      assert.deepEqual(peer.messages.slice(2).map((m) => m.method), ['turn/steer']);
      client.close();
    });
  }
});

for (const kind of ['review', 'compact']) {
  test(`a ${kind} turn's definite steer refusal permits an explicit queued alternative`, async (t) => {
    const peer = fixture(t, (request, peer) => {
      if (request.method === 'turn/steer') peer.error(request.id, `cannot steer a ${kind} turn`);
      if (request.method === 'thread/queue/add') peer.result(request.id, { queuedSubmission: { id: 'queue-after-refusal', clientUserMessageId: request.params.clientUserMessageId, input: request.params.input } });
    });
    const client = await peer.ready;
    await assert.rejects(client.steer(T, U, 'inspect this', 'client-refused'), (e) => e.code === 'TURN_NOT_STEERABLE' && e.dispatchUncertain === false);
    assert.equal((await client.queueAdd(T, 'inspect this', 'client-queued')).id, 'queue-after-refusal');
    assert.deepEqual(peer.messages.slice(2).map((m) => m.method), ['turn/steer', 'thread/queue/add']);
    client.close();
  });
}

test('never replies to reverse approvals or auth requests, even with a colliding RPC id', async (t) => {
  let held;
  const peer = fixture(t, (message) => { if (message.method === 'thread/queue/add') held = message; });
  const client = await peer.ready;
  const queued = client.queueAdd(T, 'pending', 'client-id');
  await tick();
  const baseline = peer.frames.length;
  const method = 'item/commandExecution/requestApproval';
  peer.send({ id: held.id, method, params: { threadId: T, command: 'must not be answered' } });
  peer.send({ id: 900, method, params: { threadId: T } });
  peer.send({ id: 901, method: 'account/chatgptAuthTokens/refresh', params: {} });
  await tick();
  assert.equal(peer.frames.length, baseline);
  assert.deepEqual(client.unansweredRequests(), { count: 3, methods: { [method]: 2, 'account/chatgptAuthTokens/refresh': 1 } });
  const snapshot = client.unansweredRequests();
  snapshot.methods[method] = 999;
  assert.equal(client.unansweredRequests().methods[method], 2);
  peer.result(held.id, { queuedSubmission: { id: 'queue-id', clientUserMessageId: 'client-id', input: held.params.input } });
  assert.equal((await queued).id, 'queue-id');
  assert.equal(peer.frames.length, baseline);
  client.close();
});

test('delivers a notification before its RPC result without confusing correlation', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method !== 'thread/queue/add') return;
    peer.send({ method: 'item/completed', params: { threadId: T, turnId: U, item: { type: 'userMessage', id: 'canonical-item', clientId: message.params.clientUserMessageId } } });
    peer.result(message.id, { queuedSubmission: { id: 'queue-id', clientUserMessageId: message.params.clientUserMessageId, input: message.params.input } });
  });
  const client = await peer.ready;
  const order = [];
  client.onNotification((message) => {
    assert.equal(message.params.item.clientId, 'client-id');
    order.push(message.method);
  });
  await client.queueAdd(T, 'hello', 'client-id').then(() => order.push('result'));
  assert.deepEqual(order, ['item/completed', 'result']);
  client.close();
});

test('preserves notifications emitted during initialization for the first listener', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'initialize') {
      peer.send({ method: 'thread/status/changed', params: { threadId: T, status: { type: 'idle' } } });
      peer.result(message.id, { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' });
    }
  }, { manualInitialize: true });
  const client = await peer.ready;
  const seen = [];
  const off = client.onNotification((message) => seen.push(message.params.status.type));
  assert.deepEqual(seen, ['idle']);
  off();
  client.close();
});

test('correlates concurrent calls whose replies arrive out of order', async (t) => {
  const requests = [];
  const peer = fixture(t, (message) => { if (message.id) requests.push(message); });
  const client = await peer.ready;
  const read = client.findThread({ id: T });
  const loaded = client.loadedIds();
  await tick();
  assert.equal(requests.length, 2);
  const loadedRequest = requests.find((m) => m.method === 'thread/loaded/list');
  const readRequest = requests.find((m) => m.method === 'thread/read');
  peer.result(loadedRequest.id, { data: ['loaded-id'], nextCursor: null });
  peer.result(readRequest.id, { thread: { id: T, name: 'exact-thread' } });
  assert.deepEqual(await loaded, ['loaded-id']);
  assert.equal((await read).name, 'exact-thread');
  client.close();
});

test('EOF rejects every pending call and marks written mutations uncertain', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const settled = Promise.allSettled([
    client.loadedIds(), client.queueAdd(T, 'queued', 'q'), client.steer(T, U, 'steered', 's'),
  ]);
  await tick();
  assert.deepEqual(peer.messages.slice(2).map((m) => m.method), ['thread/loaded/list', 'thread/queue/add', 'turn/steer']);
  peer.readable.end();
  const results = await settled;
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'DAEMON_CLOSED'));
  assert.deepEqual(results.map((r) => r.reason.dispatchUncertain), [false, true, true]);
  const before = peer.messages.length;
  await assert.rejects(client.queueAdd(T, 'later', 'new'), (cause) => cause.code === 'DAEMON_CLOSED' && cause.dispatchUncertain === false);
  assert.equal(peer.messages.length, before);
});

test('distinguishes a write attempt under backpressure from an unsent queued mutation', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  peer.writable.pause();
  const settled = Promise.allSettled([
    client.queueAdd(T, 'backpressure'.repeat(32768), 'written'),
    client.steer(T, U, 'still queued in client', 'not-written'),
  ]);
  await tick();
  assert.equal(peer.messages.length, 2);
  client.close();
  const results = await settled;
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.deepEqual(results.map((r) => r.reason.dispatchUncertain), [true, false]);
});

test('onClose fires once and a late subscriber receives the stored reason', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  let count = 0;
  const closed = new Promise((resolve) => client.onClose((reason) => { count++; resolve(reason); }));
  client.close();
  client.close();
  assert.equal((await closed).code, 'DAEMON_CLOSED');
  const late = await new Promise((resolve) => client.onClose(resolve));
  assert.equal(late.code, 'DAEMON_CLOSED');
  await tick();
  assert.equal(count, 1);
});

test('times out initialization and pending calls without automatically retrying', async (t) => {
  await t.test('initialize', async (t) => {
    const peer = fixture(t, () => {}, { manualInitialize: true, timeoutMs: 20 });
    await assert.rejects(peer.ready, (cause) => cause.code === 'DAEMON_TIMEOUT' && cause.dispatchUncertain === false);
    assert.deepEqual(peer.messages.map((m) => m.method), ['initialize']);
  });
  for (const mutating of [false, true]) {
    await t.test(mutating ? 'mutation' : 'read', async (t) => {
      const peer = fixture(t, () => {}, { timeoutMs: 20 });
      const client = await peer.ready;
      const request = mutating ? client.queueAdd(T, 'uncertain', 'q') : client.loadedIds();
      await assert.rejects(request, (cause) => {
        assert.equal(cause.code, 'DAEMON_TIMEOUT');
        assert.equal(cause.dispatchUncertain, mutating);
        return true;
      });
      assert.equal(peer.messages.length, 3);
      await assert.rejects(client.loadedIds(), { code: 'DAEMON_CLOSED' });
    });
  }
});

test('preserves generic RPC error details and marks a malformed acceptance uncertain', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/loaded/list') peer.error(message.id, 'not available', -32001, { retryLater: true });
    if (message.method === 'thread/queue/add') peer.result(message.id, { queuedSubmission: { id: 'q', clientUserMessageId: 'wrong', input: [] } });
  });
  const client = await peer.ready;
  await assert.rejects(client.loadedIds(), (cause) => cause.code === 'DAEMON_RPC' && cause.rpcCode === -32001 && cause.data.retryLater === true && cause.dispatchUncertain === false);
  await assert.rejects(client.queueAdd(T, 'text', 'expected'), (cause) => cause.code === 'DAEMON_PROTOCOL' && cause.dispatchUncertain === true);
  client.close();
});

test('does not treat an unknown mutation RPC error as proof that nothing was persisted', async (t) => {
  const peer = fixture(t, (message, peer) => {
    if (message.method === 'thread/queue/add') peer.error(message.id, 'failed after persistence', -32603);
  });
  const client = await peer.ready;
  await assert.rejects(client.queueAdd(T, 'possibly persisted', 'uncertain'), (cause) => {
    assert.equal(cause.code, 'DAEMON_RPC');
    assert.equal(cause.rpcCode, -32603);
    assert.equal(cause.dispatchUncertain, true);
    return true;
  });
  assert.deepEqual(peer.messages.slice(2).map((m) => m.method), ['thread/queue/add']);
  client.close();
});
