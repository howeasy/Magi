import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmClaude, confirmOmp, deliveryCursor } from '../src/delivery-confirm.mjs';
import { getRecord, setRecord, transaction, statement } from '../src/store.mjs';
import magi from '../omp/magi-omp-extension.js';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { processStartedAt } from '../omp/process-identity.js';

const marker = 'unique-frame';
const jsonl = (...records) => records.map((record) => JSON.stringify(record) + '\n').join('');
const peerUser = (content = marker) => ({ type: 'user', origin: { kind: 'peer' }, message: { content: [{ type: 'text', text: content }] } });
const ompUser = (content = marker) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: content }] } });
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'magi-confirm-'));
  const saved = { MAGI_HOME: process.env.MAGI_HOME, MAGI_CONFIRM_MS: process.env.MAGI_CONFIRM_MS, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.MAGI_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const transcriptPath = join(home, 'session.jsonl');
  return { home, transcriptPath };
}

test('Claude sessionId resolves the live registry transcript in the isolated config', async (t) => {
  const { home } = fixture(t);
  const config = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(config, 'sessions'), { recursive: true });
  writeFileSync(join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'receiver', cwd: home }));
  const project = join(config, 'projects', home.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'receiver.jsonl'), jsonl(peerUser()));
  assert.equal(await confirmClaude({ sessionId: 'receiver', marker, timeoutMs: 0 }), 'received');
});

test('Claude requires the marker in a peer-origin user record', async (t) => {
  const { transcriptPath } = fixture(t);
  writeFileSync(transcriptPath, jsonl(
    { ...peerUser(), origin: { kind: 'user' } },
    { type: 'assistant', message: { content: marker } },
    peerUser('different-frame'),
  ));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'unconfirmed');
  appendFileSync(transcriptPath, jsonl(peerUser()));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'received');
});

test('Claude enqueue is queued_unread; only its linked absorption confirms mid-turn receipt', async (t) => {
  const { transcriptPath } = fixture(t);
  writeFileSync(transcriptPath, jsonl(
    { type: 'queue-operation', operation: 'enqueue', content: marker, uuid: 'our-command' },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', commandUuid: 'other-command' },
    { type: 'queue-operation', operation: 'remove', reason: 'deleted', commandUuid: 'our-command' },
  ));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'queued_unread');
  appendFileSync(transcriptPath, jsonl({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', commandUuid: 'our-command' }));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'received_mid_turn');
});

test('Claude attachment alone is not receipt; its delivery_id joins a contentless removal', async (t) => {
  const { transcriptPath } = fixture(t);
  writeFileSync(transcriptPath, jsonl({ type: 'attachment', attachment: {
    type: 'queued_command', origin: { kind: 'peer' }, content: marker, delivery_id: 'our-delivery',
  } }));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'unconfirmed');
  appendFileSync(transcriptPath, jsonl({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', deliveryId: 'our-delivery' }));
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'received_mid_turn');
});

test('Claude polls appended JSONL, retaining a partial UTF-8 record', async (t) => {
  const { transcriptPath } = fixture(t);
  const unicodeMarker = `${marker}-é`;
  const bytes = Buffer.from(jsonl(peerUser(unicodeMarker)));
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  writeFileSync(transcriptPath, bytes.subarray(0, split));
  const timer = setTimeout(() => appendFileSync(transcriptPath, bytes.subarray(split)), 20);
  t.after(() => clearTimeout(timer));
  assert.equal(await confirmClaude({ transcriptPath, marker: unicodeMarker, timeoutMs: 1000 }), 'received');
});

test('Claude missing transcript and empty marker remain unconfirmed', async (t) => {
  const { transcriptPath } = fixture(t);
  assert.equal(await confirmClaude({ transcriptPath, marker, timeoutMs: 0 }), 'unconfirmed');
  assert.equal(await confirmClaude({ transcriptPath, marker: '', timeoutMs: 0 }), 'unconfirmed');
});

test('omp submission is queued_unread, and only a matching user session record is received', async (t) => {
  const { home, transcriptPath } = fixture(t);
  const pid = 123;
  statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)").run(pid, marker, '{}', Date.now());
  const args = { pid, sessionId: 'session', sessionFile: transcriptPath, cursor: 0, marker, timeoutMs: 0 };
  assert.equal(await confirmOmp(args), 'queued_unread');
  statement(home, 'DELETE FROM frames WHERE id=?').run(marker);
  assert.equal(await confirmOmp(args), 'unconfirmed');
  setRecord(home, 'delivery-acks', marker, { pid: 456, sessionId: 'session', status: 'submitted' });
  assert.equal(await confirmOmp(args), 'unconfirmed');
  setRecord(home, 'delivery-acks', marker, { pid, sessionId: 'different', status: 'submitted' });
  assert.equal(await confirmOmp(args), 'unconfirmed');
  transaction(home, () => setRecord(home, 'delivery-acks', marker, { pid, sessionId: 'session', status: 'submitted', at: Date.now() }));
  assert.equal(await confirmOmp(args), 'queued_unread');
  writeFileSync(transcriptPath, jsonl(
    { type: 'message', message: { role: 'assistant', content: marker } },
    ompUser('different-frame'),
  ));
  assert.equal(await confirmOmp(args), 'queued_unread');
  appendFileSync(transcriptPath, jsonl(ompUser()));
  assert.equal(await confirmOmp(args), 'received');
});

test('omp polls delayed session evidence, and MAGI_CONFIRM_MS supplies the deadline', async (t) => {
  const { transcriptPath } = fixture(t);
  process.env.MAGI_CONFIRM_MS = '1000';
  const timer = setTimeout(() => writeFileSync(transcriptPath, jsonl(ompUser())), 20);
  t.after(() => clearTimeout(timer));
  assert.equal(await confirmOmp({ pid: 123, sessionId: 'session', sessionFile: transcriptPath, cursor: 0, marker }), 'received');
  process.env.MAGI_CONFIRM_MS = '0';
  assert.equal(await confirmOmp({ pid: 123, marker: 'missing' }), 'unconfirmed');
});

function extension(t, sendUserMessage) {
  const { home, transcriptPath } = fixture(t);
  writeFileSync(transcriptPath, '');
  const handlers = new Map();
  let tick;
  magi({ on: (name, handler) => handlers.set(name, handler), sendUserMessage, logger: { warn() {} } });
  const ctx = {
    cwd: home, isIdle: () => true,
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => transcriptPath },
    setInterval: (fn) => { tick = fn; return () => {}; },
  };
  handlers.get('session_start')({}, ctx);
  const shutdown = () => handlers.get('session_shutdown')({}, ctx);
  t.after(shutdown);
  const put = (id) => statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)")
    .run(process.pid, id, JSON.stringify({ id, text: `peer request\n<!-- magi-delivery:${id} -->` }), Date.now());
  const switchSession = (sessionId, sessionFile) => handlers.get('session_switch')({}, {
    ...ctx, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
  });
  return { home, transcriptPath, put, shutdown, switchSession, tick: () => tick() };
}

test('void sendUserMessage acknowledges submission, not session receipt', async (t) => {
  let delivered;
  const { home, transcriptPath, put, tick } = extension(t, (text) => { delivered = text; });
  put('void-frame');
  await tick();
  const args = { pid: process.pid, sessionId: 'session', marker: 'magi-delivery:void-frame', frameId: 'void-frame', timeoutMs: 0 };
  assert.equal(await confirmOmp(args), 'queued_unread');
  const receipt = getRecord(home, 'delivery-acks', 'void-frame');
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.sessionFile, transcriptPath);
  assert.equal(receipt.cursor, 0);
  appendFileSync(transcriptPath, jsonl(ompUser(delivered)));
  assert.equal(await confirmOmp(args), 'received');
});

test('omp receipt session path and pre-invocation cursor exclude reused-marker history', async (t) => {
  const { transcriptPath, put, tick } = extension(t, () => {});
  const deliveryMarker = 'magi-delivery:reused-frame';
  writeFileSync(transcriptPath, jsonl(ompUser(deliveryMarker)));
  put('reused-frame');
  await tick();
  const args = { pid: process.pid, sessionId: 'session', marker: deliveryMarker, frameId: 'reused-frame', timeoutMs: 0 };
  assert.equal(await confirmOmp(args), 'queued_unread');
  appendFileSync(transcriptPath, jsonl(ompUser(deliveryMarker)));
  assert.equal(await confirmOmp(args), 'received');
});

test('omp records no submission while an asynchronous send is pending', async (t) => {
  let succeed;
  const sent = new Promise((resolve) => { succeed = resolve; });
  const { home, put, tick } = extension(t, () => sent);
  put('successful-frame');
  const drain = tick();
  assert.equal(getRecord(home, 'delivery-acks', 'successful-frame'), null);
  succeed();
  await drain;
  assert.equal(await confirmOmp({ pid: process.pid, sessionId: 'session', marker: 'successful-frame', timeoutMs: 0 }), 'queued_unread');
  assert.equal(getRecord(home, 'delivery-acks', 'successful-frame').status, 'submitted');
});

test('omp retains synchronous throws and asynchronous rejections as failed without retry', async (t) => {
  let calls = 0;
  const { home, put, tick } = extension(t, () => {
    calls++;
    if (calls === 1) throw new Error('send failed');
    return Promise.reject(new Error('send rejected'));
  });
  put('throw-frame');
  await tick();
  put('reject-frame');
  await tick();
  await tick();
  assert.equal(calls, 2, 'failed frames are not polled again');
  for (const id of ['throw-frame', 'reject-frame']) {
    assert.equal(await confirmOmp({ pid: process.pid, sessionId: 'session', marker: id, timeoutMs: 0 }), 'failed');
    const failed = JSON.parse(statement(home, 'SELECT body FROM frames WHERE id=?').get(id).body);
    assert.match(failed.text, /peer request/);
    assert.match(failed.failure.error, /send (failed|rejected)/);
  }
  assert.equal(getRecord(home, 'delivery-acks', 'throw-frame'), null);
});

for (const transport of ['claude', 'omp']) {
  const record = transport === 'claude' ? peerUser : ompUser;
  const confirm = (path, args) => transport === 'claude'
    ? confirmClaude({ transcriptPath: path, ...args })
    : confirmOmp({ sessionFile: path, pid: 123, ...args });

  test(`${transport} ignores reused-marker history and sees evidence already appended before confirmation`, async (t) => {
    const { transcriptPath } = fixture(t);
    writeFileSync(transcriptPath, jsonl(record()));
    const cursor = deliveryCursor(transcriptPath);
    assert.equal(await confirm(transcriptPath, { cursor, marker, timeoutMs: 0 }), 'unconfirmed');
    appendFileSync(transcriptPath, jsonl(record()));
    assert.equal(await confirm(transcriptPath, { cursor, marker, timeoutMs: 0 }), 'received');
  });

  test(`${transport} does not rewind into history after truncation`, async (t) => {
    const { transcriptPath } = fixture(t);
    writeFileSync(transcriptPath, jsonl(record()) + '\n'.repeat(1000));
    const cursor = deliveryCursor(transcriptPath);
    writeFileSync(transcriptPath, jsonl(record()));
    assert.equal(await confirm(transcriptPath, { cursor, marker, timeoutMs: 0 }), 'unconfirmed');
  });

  test(`${transport} caps one inspection before observing a marker beyond its byte budget`, async (t) => {
    const { transcriptPath } = fixture(t);
    writeFileSync(transcriptPath, jsonl({ type: 'irrelevant', content: 'x'.repeat(280 * 1024) }, record()));
    t.mock.method(Date, 'now', () => 0);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const pending = confirm(transcriptPath, { cursor: 0, marker, timeoutMs: 100 }).then((status) => {
      settled = true;
      return status;
    });
    // Allow more yields than a single inspection needs, without advancing
    // its poll timer: the next inspection must not have started yet.
    for (let i = 0; i < 32; i++) await new Promise(setImmediate);
    assert.equal(settled, false, 'late evidence is deferred to another bounded inspection');
    t.mock.timers.tick(50);
    assert.equal(await pending, 'received');
  });

  test(`${transport} zero deadline bounds a large suffix instead of reading to its late marker`, async (t) => {
    const { transcriptPath } = fixture(t);
    writeFileSync(transcriptPath, jsonl({ type: 'irrelevant', content: 'x'.repeat(2 * 1024 * 1024) }, record()));
    assert.equal(await confirm(transcriptPath, { cursor: 0, marker, timeoutMs: 0 }), 'unconfirmed');
  });

  test(`${transport} yields and checks its deadline inside the suffix read loop`, async (t) => {
    const { transcriptPath } = fixture(t);
    writeFileSync(transcriptPath, jsonl({ type: 'irrelevant', content: 'x'.repeat(2 * 1024 * 1024) }, record()));
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    let yielded = false;
    const immediate = setImmediate(() => { yielded = true; now = 1000; });
    t.after(() => clearImmediate(immediate));
    assert.equal(await confirm(transcriptPath, { cursor: 0, marker, timeoutMs: 100 }), 'unconfirmed');
    assert.equal(yielded, true);
  });
}

for (const transition of ['shutdown', 'switch']) {
  test(`omp ${transition} mid-drain fences the suspended send and leaves the next frame untouched`, async (t) => {
    let resolve;
    let calls = 0;
    const pending = new Promise((done) => { resolve = done; });
    const f = extension(t, () => { calls++; return pending; });
    f.put('a-frame');
    f.put('b-frame');
    const drain = f.tick();
    if (transition === 'shutdown') f.shutdown();
    else {
      const nextFile = join(f.home, 'next.jsonl');
      writeFileSync(nextFile, '');
      f.switchSession('next-session', nextFile);
    }
    resolve();
    await drain;
    assert.equal(calls, 1);
    assert.equal(statement(f.home, 'SELECT state FROM frames WHERE id=?').get('b-frame').state, 'queued');
    assert.equal(statement(f.home, 'SELECT state FROM frames WHERE id=?').get('a-frame').state, 'processing');
    assert.equal(getRecord(f.home, 'delivery-acks', 'a-frame'), null, 'obsolete drain must not publish a submission');
  });
}

test('omp delivery embeds independent full UUID markers for each write', async (t) => {
  const { home, transcriptPath } = fixture(t);
  process.env.MAGI_CONFIRM_MS = '0';
  const target = { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'session', sessionFile: transcriptPath };
  const markers = [];
  for (let i = 0; i < 2; i++) {
    const result = await ompAdapter.deliverLive({ target, text: 'same request' });
    const frame = JSON.parse(statement(home, 'SELECT body FROM frames WHERE id=?').get(result.messageId).body);
    const match = frame.text.match(/<!-- magi-delivery:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->$/);
    assert.ok(match, 'delivered text carries a full UUID');
    assert.notEqual(match[1], result.messageId);
    markers.push(match[1]);
  }
  assert.notEqual(markers[0], markers[1]);
});
