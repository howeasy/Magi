import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { openWebSocket } from '../src/ws-stream.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function serverFrame(opcode, payload = Buffer.alloc(0), { fin = true, lengthBytes = 0, masked = false } = {}) {
  payload = Buffer.from(payload);
  const extended = lengthBytes || (payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8);
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (extended === 8 ? 127 : extended === 2 ? 126 : payload.length);
  if (extended === 2) header.writeUInt16BE(payload.length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
  if (masked) {
    const mask = Buffer.from([1, 2, 3, 4]);
    mask.copy(header, 2 + extended);
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }
  return Buffer.concat([header, payload]);
}

function fixture(t, options = {}, respond = null) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const frames = [];
  let request = '';
  let input = Buffer.alloc(0);
  let upgraded = false;
  const capture = (chunk) => {
    input = Buffer.concat([input, chunk]);
    if (!upgraded) {
      const end = input.indexOf('\r\n\r\n');
      if (end < 0) return;
      request = input.subarray(0, end + 4).toString('ascii');
      input = input.subarray(end + 4);
      upgraded = true;
      const key = /^Sec-WebSocket-Key: (.+)\r$/mi.exec(request)?.[1];
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      const response = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      if (respond) respond({ readable, response, request });
      else readable.write(response);
    }
    while (input.length >= 2) {
      const marker = input[1] & 127;
      const extended = marker === 126 ? 2 : marker === 127 ? 8 : 0;
      const masked = Boolean(input[1] & 128);
      const header = 2 + extended + (masked ? 4 : 0);
      if (input.length < header) return;
      const length = marker === 126 ? input.readUInt16BE(2) : marker === 127 ? Number(input.readBigUInt64BE(2)) : marker;
      if (input.length < header + length) return;
      const payload = Buffer.from(input.subarray(header, header + length));
      const mask = masked ? Buffer.from(input.subarray(2 + extended, header)) : null;
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      frames.push({ opcode: input[0] & 15, fin: Boolean(input[0] & 128), masked, mask, payload });
      input = input.subarray(header + length);
    }
  };
  writable.on('data', capture);
  const ready = openWebSocket({ readable, writable, timeoutMs: 2000, ...options });
  // A refusal can arrive synchronously from the fake server before the test awaits it.
  ready.catch(() => {});
  t.after(() => { readable.destroy(); writable.destroy(); });
  return { readable, writable, ready, frames, get request() { return request; } };
}

const nextClose = (client) => new Promise((resolve) => client.onClose(resolve));

function messages(client) {
  const values = [];
  client.onMessage((text) => values.push(text));
  return values;
}

test('upgrades with a fresh key and sends a masked UTF-8 text message', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  assert.match(peer.request, /^GET \/rpc HTTP\/1\.1\r\nHost: localhost\r\n/);
  const key = /^Sec-WebSocket-Key: (.+)\r$/mi.exec(peer.request)[1];
  assert.equal(Buffer.from(key, 'base64').length, 16);
  assert.match(peer.request, /Sec-WebSocket-Version: 13\r\n/);
  await client.send('hello 世界');
  assert.equal(peer.frames[0].opcode, 1);
  assert.equal(peer.frames[0].fin, true);
  assert.equal(peer.frames[0].masked, true);
  assert.equal(peer.frames[0].payload.toString(), 'hello 世界');
  const other = fixture(t);
  await other.ready;
  assert.notEqual(/^Sec-WebSocket-Key: (.+)\r$/mi.exec(other.request)[1], key);
  client.close();
  (await other.ready).close();
});

test('refuses a bad accept without returning a connection', async (t) => {
  const peer = fixture(t, {}, ({ readable, response }) => {
    readable.write(response.toString().replace(/Sec-WebSocket-Accept: .+\r/, 'Sec-WebSocket-Accept: invalid\r'));
  });
  await assert.rejects(peer.ready, { code: 'WS_BAD_HANDSHAKE' });
});

test('verifies status, Upgrade, Connection, and unrequested extensions', async (t) => {
  for (const [name, mutate] of [
    ['status', (text) => text.replace('101 Switching Protocols', '200 OK')],
    ['upgrade', (text) => text.replace('Upgrade: websocket', 'Upgrade: other')],
    ['connection', (text) => text.replace('Connection: keep-alive, Upgrade', 'Connection: keep-alive')],
    ['extension', (text) => text.replace('\r\n\r\n', '\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n')],
  ]) {
    await t.test(name, async (t) => {
      const peer = fixture(t, {}, ({ readable, response }) => readable.write(mutate(response.toString())));
      await assert.rejects(peer.ready, { code: 'WS_BAD_HANDSHAKE' });
    });
  }
});

test('accepts a split upgrade and preserves a text frame joined to its response', async (t) => {
  const peer = fixture(t, { path: '/', host: 'example.test' }, ({ readable, response }) => {
    readable.write(response.subarray(0, 17));
    readable.write(Buffer.concat([response.subarray(17), serverFrame(1, 'already here')]));
  });
  const client = await peer.ready;
  const received = messages(client);
  assert.match(peer.request, /^GET \/ HTTP\/1\.1\r\nHost: example.test\r\n/);
  assert.deepEqual(received, ['already here']);
  client.close();
});

test('parses a UTF-8 frame split at every byte and several joined messages', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = messages(client);
  for (const byte of serverFrame(1, 'split 世界')) peer.readable.write(Buffer.from([byte]));
  peer.readable.write(Buffer.concat([serverFrame(1, ''), serverFrame(1, 'joined one'), serverFrame(1, 'joined two')]));
  assert.deepEqual(received, ['split 世界', '', 'joined one', 'joined two']);
  client.close();
});

test('receives 16-bit and 64-bit lengths across split extended headers', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = messages(client);
  const short = 's'.repeat(126);
  const long = 'L'.repeat(65536);
  for (const encoded of [serverFrame(1, short), serverFrame(1, long)]) {
    for (let index = 0; index < 10; index++) peer.readable.write(encoded.subarray(index, index + 1));
    peer.readable.write(encoded.subarray(10));
  }
  assert.deepEqual(received, [short, long]);
  await client.send(short);
  await client.send(long);
  assert.deepEqual(peer.frames.map((f) => f.payload.toString()), [short, long]);
  assert.ok(peer.frames.every((f) => f.masked));
  assert.ok(peer.frames.every((f) => f.mask.length === 4));
  client.close();
});

test('reassembles fragmented UTF-8 with an interleaved Ping', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = messages(client);
  peer.readable.write(serverFrame(1, Buffer.from([0xf0]), { fin: false }));
  peer.readable.write(serverFrame(0, Buffer.from([0x9f]), { fin: false }));
  peer.readable.write(serverFrame(9, 'ping bytes'));
  assert.deepEqual(received, []);
  peer.readable.write(serverFrame(0, Buffer.from([0x98, 0x80])));
  await tick();
  assert.deepEqual(received, ['😀']);
  assert.equal(peer.frames[0].opcode, 10);
  assert.equal(peer.frames[0].masked, true);
  assert.equal(peer.frames[0].payload.toString(), 'ping bytes');
  client.close();
});

test('drops binary messages, ignores Pong, and continues with text', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = messages(client);
  peer.readable.write(Buffer.concat([
    serverFrame(2, Buffer.from([255])),
    serverFrame(2, Buffer.from([254]), { fin: false }),
    serverFrame(0, Buffer.from([253])),
    serverFrame(10, 'unsolicited pong'),
    serverFrame(1, 'text survived'),
  ]));
  await tick();
  assert.deepEqual(received, ['text survived']);
  assert.deepEqual(peer.frames, []);
  client.close();
});

test('masks Ping replies including an empty Ping', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  peer.readable.write(Buffer.concat([serverFrame(9), serverFrame(9, Buffer.from([0, 255, 7]))]));
  await tick();
  assert.deepEqual(peer.frames.map((f) => f.opcode), [10, 10]);
  assert.deepEqual(peer.frames.map((f) => [...f.payload]), [[], [0, 255, 7]]);
  assert.ok(peer.frames.every((f) => f.masked));
  assert.ok(peer.frames.every((f) => f.mask.length === 4));
  client.close();
});

test('refuses masked server frames and closes exactly once', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  let count = 0;
  client.onClose(() => count++);
  const closed = nextClose(client);
  peer.readable.write(serverFrame(1, 'not allowed', { masked: true }));
  assert.equal((await closed).code, 'WS_PROTOCOL_ERROR');
  client.close();
  await tick();
  assert.equal(count, 1);
  await assert.rejects(client.send('too late'), { code: 'WS_PROTOCOL_ERROR' });
});

test('rejects oversize frames and cumulative fragmented messages', async (t) => {
  for (const [name, pieces] of [
    ['single', [serverFrame(1, '123456')]],
    ['fragmented', [serverFrame(1, '123', { fin: false }), serverFrame(0, '456')]],
    ['binary', [serverFrame(2, '123456')]],
  ]) {
    await t.test(name, async (t) => {
      const peer = fixture(t, { maxMessageBytes: 5 });
      const client = await peer.ready;
      const closed = nextClose(client);
      for (const piece of pieces) peer.readable.write(piece);
      assert.equal((await closed).code, 'WS_MESSAGE_TOO_LARGE');
    });
  }
});

test('enforces the default 64 MiB limit from a header without allocating its payload', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const closed = nextClose(client);
  const header = Buffer.from('817f0000000004000001', 'hex');
  peer.readable.write(header);
  assert.equal((await closed).code, 'WS_MESSAGE_TOO_LARGE');
});

test('refuses malformed lengths, control frames, continuation, and UTF-8', async (t) => {
  for (const [name, bytes] of [
    ['nonminimal length', Buffer.from('817e0001', 'hex')],
    ['64-bit sign bit', Buffer.from('817f8000000000000000', 'hex')],
    ['fragmented Ping', serverFrame(9, 'bad', { fin: false })],
    ['oversize Ping', serverFrame(9, Buffer.alloc(126))],
    ['orphan continuation', serverFrame(0, 'bad')],
    ['reserved opcode', serverFrame(3, 'bad')],
    ['invalid UTF-8', serverFrame(1, Buffer.from([0xff]))],
    ['interrupted fragmentation', Buffer.concat([serverFrame(1, 'a', { fin: false }), serverFrame(1, 'b')])],
  ]) {
    await t.test(name, async (t) => {
      const peer = fixture(t);
      const client = await peer.ready;
      const closed = nextClose(client);
      peer.readable.write(bytes);
      assert.equal((await closed).code, 'WS_PROTOCOL_ERROR');
    });
  }
});

test('echoes peer Close masked, reports its status, and ignores trailing frames', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = messages(client);
  const closed = nextClose(client);
  const payload = Buffer.from('03e8646f6e65', 'hex');
  peer.readable.write(Buffer.concat([serverFrame(8, payload), serverFrame(1, 'after close')]));
  const reason = await closed;
  await tick();
  assert.equal(reason.code, 'WS_CLOSED');
  assert.equal(reason.closeCode, 1000);
  assert.equal(reason.closeReason, 'done');
  assert.deepEqual(received, []);
  assert.equal(peer.frames[0].opcode, 8);
  assert.equal(peer.frames[0].masked, true);
  assert.deepEqual(peer.frames[0].payload, payload);
});

test('local Close sends its code and UTF-8 reason, fires once, and refuses new sends', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  let count = 0;
  client.onClose(() => count++);
  const closed = nextClose(client);
  client.close(1000, '再见');
  client.close();
  assert.equal((await closed).closeReason, '再见');
  await tick();
  assert.equal(count, 1);
  assert.equal(peer.frames[0].opcode, 8);
  assert.equal(peer.frames[0].masked, true);
  assert.equal(peer.frames[0].payload.readUInt16BE(), 1000);
  assert.equal(peer.frames[0].payload.subarray(2).toString(), '再见');
  await assert.rejects(client.send('too late'), { code: 'WS_CLOSED' });
});

test('EOF ends a connection even with a partially received frame', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const closed = nextClose(client);
  peer.readable.write(serverFrame(1, 'unfinished').subarray(0, 4));
  peer.readable.end();
  assert.equal((await closed).code, 'WS_EOF');
  await assert.rejects(client.send('too late'), { code: 'WS_EOF' });
});

test('times out an unanswered upgrade and rejects EOF during the handshake', async (t) => {
  await t.test('timeout', async (t) => {
    const peer = fixture(t, { timeoutMs: 15 }, () => {});
    await assert.rejects(peer.ready, { code: 'WS_HANDSHAKE_TIMEOUT' });
  });
  await t.test('EOF', async (t) => {
    const peer = fixture(t, {}, ({ readable }) => readable.end());
    await assert.rejects(peer.ready, { code: 'WS_EOF' });
  });
});

test('preserves frame order across reentrant server writes', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const received = [];
  client.onMessage((text) => {
    received.push(text);
    if (text === 'first') peer.readable.write(serverFrame(1, 'reentrant'));
  });
  peer.readable.write(Buffer.concat([serverFrame(1, 'first'), serverFrame(1, 'second')]));
  assert.deepEqual(received, ['first', 'second', 'reentrant']);
  client.close();
});

test('send waits for writable backpressure and resumes without losing bytes', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  peer.writable.pause();
  let completed = false;
  const text = 'pressure'.repeat(32768);
  const sent = client.send(text).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  peer.writable.resume();
  await sent;
  assert.equal(peer.frames[0].payload.toString(), text);
  client.close();
});

test('stream errors close the connection and reject subsequent sends', async (t) => {
  const peer = fixture(t);
  const client = await peer.ready;
  const closed = nextClose(client);
  peer.writable.destroy(new Error('fake pipe failure'));
  assert.equal((await closed).code, 'WS_IO');
  await assert.rejects(client.send('lost'), { code: 'WS_IO' });
});

test('keeps an early message even when Close shares the upgrade response chunk', async (t) => {
  const peer = fixture(t, {}, ({ readable, response }) => {
    readable.write(Buffer.concat([response, serverFrame(1, 'before close'), serverFrame(8)]));
  });
  const client = await peer.ready;
  const received = messages(client);
  const closed = await nextClose(client);
  assert.deepEqual(received, ['before close']);
  assert.equal(closed.code, 'WS_CLOSED');
});

test('combines repeated Connection fields but refuses duplicate accept keys', async (t) => {
  const peer = fixture(t, {}, ({ readable, response }) => {
    readable.write(response.toString().replace('Connection: keep-alive, Upgrade', 'Connection: keep-alive\r\nConnection: Upgrade'));
  });
  const client = await peer.ready;
  await client.send('valid repeated list header');
  assert.equal(peer.frames[0].payload.toString(), 'valid repeated list header');
  client.close();
  const bad = fixture(t, {}, ({ readable, response }) => {
    readable.write(response.toString().replace('\r\n\r\n', '\r\nSec-WebSocket-Accept: duplicate\r\n\r\n'));
  });
  await assert.rejects(bad.ready, { code: 'WS_BAD_HANDSHAKE' });
});
