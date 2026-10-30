import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, fakeEnv, textOf } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { makeServerEngine } from '../src/serve.mjs';
import { compactionAt, transcriptPosition } from '../src/transcript.mjs';
import { statement } from '../src/store.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import * as state from '../src/state.mjs';

function fixture(t, peer = 'omp') {
  const cwd = makeWorkspace('conversation fixes');
  setEmbedder(null);
  const values = { ...fakeEnv(cwd).env, HOME: cwd, USERPROFILE: cwd, OMP_AGENT_DIR: join(cwd, 'omp'), MAGI_AS: 'claude', PEER_DEPTH: '0', CLAUDE_CODE_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const owner = { agent: 'claude', id: 'owner', sessionId: 'owner', cwd };
  const worker = { agent: peer, id: 'worker', sessionId: 'worker', cwd };
  const replacement = { ...worker, id: 'replacement', sessionId: 'replacement' };
  const sent = [];
  const engine = (overrides = {}) => makeEngine({
    orchestrator: 'claude', peerName: peer, replyTool: 'peer_tool',
    resolveOrigin: async () => ({ target: owner, identityVerified: true }),
    pickDelivery: async ({ target }) => ({ mode: 'live', target: target === 'replacement' ? replacement : worker }),
    deliverLive: async (args) => { sent.push(args); return { via: 'live', deliveryStatus: 'queued_unread' }; },
    deliverReply: async () => ({ via: 'live', deliveryStatus: 'queued_unread' }),
    ...overrides,
  });
  const ok = (result) => { assert.notEqual(result.isError, true, textOf(result)); return result.structuredContent; };
  const request = (e, args = {}) => e.handleRequest({ task: 'Inspect rotation', mode: 'DELEGATE', workingDirectory: cwd, wait: false, ...args });
  const answer = async (taskId, round = state.readTask(taskId).rounds.at(-1).round, target = state.readTask(taskId).peerTarget) => {
    const e = makeEngine({ orchestrator: peer, peerName: 'claude', resolveOrigin: async () => ({ target, identityVerified: true }), deliverReply: async () => ({ via: 'live' }) });
    return ok(await e.handleReply({ taskId, round, body: 'Checked source and behavior.' }));
  };
  return { cwd, owner, worker, replacement, sent, engine, ok, request, answer };
}

for (const harness of ['claude', 'omp']) {
  test(`${harness} compaction beyond the tail resets the full frame using its transcript position`, async (t) => {
    const f = fixture(t, harness);
    const file = join(f.cwd, 'transcript.jsonl');
    const row = harness === 'claude' ? { harness, transcript: file } : { harness, sessionFile: file };
    const marker = harness === 'claude' ? { type: 'system', subtype: 'compact_boundary' } : { type: 'compaction' };
    writeFileSync(file, JSON.stringify({ ...marker, timestamp: Date.now() - 10000 }) + '\n');
    const e = f.engine({ transcriptPosition: () => transcriptPosition(row), compactionAt: (_target, cursor) => compactionAt(row, cursor) });
    const first = f.ok(await f.request(e));
    await f.answer(first.taskId);
    f.ok(await f.request(e, { taskId: first.taskId }));
    assert.match(f.sent.at(-1).text, /^PEER TURN/, 'marker before the full receipt is excluded');
    await f.answer(first.taskId);
    // No clock is required: this lifecycle record lies after the receipt.
    appendFileSync(file, JSON.stringify(marker) + '\n' + JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(300 * 1024) } }) + '\n');
    f.ok(await f.request(e, { taskId: first.taskId }));
    assert.match(f.sent.at(-1).text, /^PEER REQUEST/, 'the marker remains visible beyond the last 256 KiB');
    await f.answer(first.taskId);
    f.ok(await f.request(e, { taskId: first.taskId }));
    assert.match(f.sent.at(-1).text, /^PEER TURN/, 'the new full receipt resets the scan position');
  });
}

test('transcript cursors include an unfinished record and invalidate a truncated file', (t) => {
  const f = fixture(t);
  const file = join(f.cwd, 'partial.jsonl');
  const row = { harness: 'omp', sessionFile: file };
  writeFileSync(file, '{"type":"message"}\n{"type":"comp');
  const cursor = transcriptPosition(row);
  appendFileSync(file, 'action"}\n');
  assert.equal(compactionAt(row, cursor), Infinity);
  const after = transcriptPosition(row);
  writeFileSync(file, '{}\n');
  assert.equal(compactionAt(row, after), Infinity);
  assert.equal(transcriptPosition({ harness: 'codex', sessionFile: file }), null);
});

for (const headless of [false, true]) {
  test(`${headless ? 'resumed headless' : 'Codex live'} pairs refresh every ten turns without a compaction signal`, async (t) => {
    const f = fixture(t, 'codex');
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const runs = [];
    const e = f.engine(headless ? {
      pickDelivery: async () => ({ mode: 'headless' }),
      deliverHeadless: async (args) => { runs.push(args); return { via: 'headless', threadId: 'worker', inlineReply: 'Source checked.' }; },
    } : { compactionAt: () => null, transcriptPosition: () => null });
    const first = f.ok(await f.request(e, { wait: headless, maxRounds: 12 }));
    for (let turn = 2; turn <= 12; turn++) {
      if (!headless) await f.answer(first.taskId);
      clock += 1000;
      f.ok(await f.request(e, { taskId: first.taskId, wait: headless }));
      const text = headless ? runs.at(-1).text : f.sent.at(-1).text;
      assert.match(text, turn === 11 ? /^PEER REQUEST/ : /^PEER TURN/, `turn ${turn}`);
    }
  });
}

for (const headless of [false, true]) {
  test(`${headless ? 'resumed headless' : 'Codex live'} pairs refresh at the two-hour boundary before ten turns`, async (t) => {
    const f = fixture(t, 'codex');
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const runs = [];
    const e = f.engine(headless ? {
      pickDelivery: async () => ({ mode: 'headless' }),
      deliverHeadless: async (args) => { runs.push(args); return { via: 'headless', threadId: 'worker', inlineReply: 'Source checked.' }; },
    } : {});
    const first = f.ok(await f.request(e, { wait: headless, maxRounds: 12 }));
    if (!headless) await f.answer(first.taskId);
    clock += 2 * 60 * 60 * 1000 - 1;
    f.ok(await f.request(e, { taskId: first.taskId, wait: headless }));
    assert.match((headless ? runs : f.sent).at(-1).text, /^PEER TURN/);
    if (!headless) await f.answer(first.taskId);
    clock++;
    f.ok(await f.request(e, { taskId: first.taskId, wait: headless }));
    assert.match((headless ? runs : f.sent).at(-1).text, /^PEER REQUEST/);
  });
}
test('the no-signal refresh counter follows a pair across separate cards', async (t) => {
  const f = fixture(t, 'codex');
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const e = f.engine();
  for (let turn = 1; turn <= 11; turn++) {
    clock++;
    const card = f.ok(await f.request(e));
    assert.match(f.sent.at(-1).text, turn === 1 || turn === 11 ? /^PEER REQUEST/ : /^PEER TURN/, `pair turn ${turn}`);
    await f.answer(card.taskId);
    f.ok(await e.handleOutcome({ taskId: card.taskId, accepted: 1, rejected: 0, open: 0, body: 'Checked this card.' }));
  }
});


test('continuation persist and differing resumeThreadId cannot replace live or headless workers implicitly', async (t) => {
  const f = fixture(t);
  const live = f.engine();
  const first = f.ok(await f.request(live));
  await f.answer(first.taskId);
  for (const options of [{ persist: 'other' }, { resumeThreadId: 'worker' }, { resumeThreadId: 'other' }]) {
    assert.match(textOf(await f.request(live, { taskId: first.taskId, ...options })), /CARD_FIXED.*peer/);
  }
  assert.equal(state.readTask(first.taskId).rounds.length, 1);
  const runs = [];
  const e = f.engine({
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async (args) => { runs.push(args); return { via: 'headless', threadId: args.resumeThreadId ?? 'headless-worker', inlineReply: 'Source checked.' }; },
  });
  const card = f.ok(await f.request(e, { wait: true, maxRounds: 12 }));
  assert.match(textOf(await f.request(e, { taskId: card.taskId, wait: true, resumeThreadId: 'other' })), /CARD_FIXED.*peer/);
  assert.match(textOf(await f.request(e, { taskId: card.taskId, wait: true, persist: 'other' })), /CARD_FIXED.*peer/);
  assert.equal(state.readTask(card.taskId).rounds.length, 1);
  f.ok(await f.request(e, { taskId: card.taskId, wait: true, resumeThreadId: 'headless-worker' }));
  assert.equal(runs.at(-1).resumeThreadId, 'headless-worker');
  f.ok(await f.request(e, { taskId: card.taskId, wait: true, peer: 'other', resumeThreadId: 'other' }));
  assert.equal(state.readTask(card.taskId).peerTarget.id, 'other');
  assert.equal(state.readTask(card.taskId).rounds[1].peerTarget.id, 'headless-worker');
});

for (const wait of [false, true]) {
  test(`late ${wait ? 'blocking' : 'background'} headless completion keeps both turns' workers and authorizes live B`, async (t) => {
    const f = fixture(t);
    let release, entered, handedOff;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const completion = new Promise((resolve) => { handedOff = resolve; });
    const e = f.engine({
      pickDelivery: async ({ target }) => target === 'replacement' ? { mode: 'live', target: f.replacement } : { mode: 'headless' },
      deliverHeadless: async ({ taskId }) => { entered(taskId); await gate; return { via: 'headless', threadId: 'late-worker', inlineReply: 'Late turn one evidence.' }; },
      deliverReply: async () => { handedOff(); return { via: 'live' }; },
    });
    const first = f.request(e, { wait, maxRounds: 12 });
    const taskId = await started;
    if (!wait) f.ok(await first);
    f.ok(await e.handleClose({ taskId }));
    f.ok(await f.request(e, { taskId, peer: 'replacement', wait: false }));
    release();
    if (wait) f.ok(await first);
    else { await completion; await new Promise(setImmediate); }
    const card = state.readTask(taskId);
    assert.equal(card.rounds[0].peerTarget.id, 'late-worker');
    assert.equal(card.rounds[0].replied, true);
    assert.equal(card.rounds[1].peerTarget.id, 'replacement');
    assert.equal(card.peerTarget.id, 'replacement');
    await f.answer(taskId, 2, f.replacement);
    assert.equal(state.readTask(taskId).rounds[1].replied, true);
  });
}

for (const route of ['alias', 'unrelated-pid', 'wrong-birth', 'pid-only-wrong-birth']) {
  test(`card note resolves the recorded endpoint, not an override or bare pid: ${route}`, async (t) => {
    const f = fixture(t);
    const current = { ...f.worker, id: 'resumed', sessionId: 'resumed', sessionAliases: ['original'], pid: 101, processStartedAt: 'birth', status: 'idle' };
    const endpoint = route === 'pid-only-wrong-birth' ? { agent: 'omp', pid: 101, processStartedAt: 'old-birth' } : {
      agent: 'omp', id: route === 'unrelated-pid' ? 'unrelated' : 'original', sessionId: route === 'unrelated-pid' ? 'unrelated' : 'original',
      pid: 101, processStartedAt: route === 'wrong-birth' ? 'old-birth' : 'birth',
    };
    state.openRound({ taskId: 'note-route', orchestrator: 'claude', orchestratorTarget: f.owner, peer: 'omp', round: 1, cwd: f.cwd });
    state.setPeerTarget('note-route', endpoint, 1);
    const e = makeServerEngine({
      peer: 'omp', selfDefault: 'claude', replyTool: () => 'peer_tool', schema: { deliveries: ['auto', 'live'], peerHint: 'session id' },
      sessions: async () => [current],
      deliverLive: async (args) => { f.sent.push(args); return { via: 'live' }; },
    }).engine;
    const result = await e.handleNote({ taskId: 'note-route', peer: 'resumed', body: 'Use the updated baseline.' });
    if (route === 'alias') {
      f.ok(result);
      assert.equal(f.sent[0].target.sessionId, 'resumed');
      assert.equal(f.sent[0].target.processStartedAt, 'birth');
      assert.equal(state.readExchange('note-route')[0].text, 'Use the updated baseline.');
    } else {
      assert.equal(result.isError, true);
      assert.match(textOf(result), /NO_LIVE_PEER/);
      assert.deepEqual(f.sent, []);
    }
  });
}

for (const dispatchUncertain of [true, undefined, false]) {
  test(`note dispatch uncertainty ${dispatchUncertain} ${dispatchUncertain === false ? 'releases' : 'retains'} its charge`, async (t) => {
    const f = fixture(t);
    const e = f.engine({ deliverLive: async () => { throw Object.assign(new Error('Dispatch failed'), { code: 'DELIVERY_FAILED', dispatchUncertain }); } });
    assert.equal((await e.handleNote({ body: 'One dispatch.' })).isError, true);
    const retry = await f.engine().handleNote({ body: 'One dispatch.' });
    if (dispatchUncertain === false) f.ok(retry);
    else {
      assert.match(textOf(retry), /NOTE_DUPLICATE/);
      for (let n = 0; n < 4; n++) f.ok(await f.engine().handleNote({ body: `Remaining budget ${n}.`, peer: 'replacement' }));
      assert.match(textOf(await f.engine().handleNote({ body: 'Over budget.' })), /NOTE_RATE_LIMIT/);
    }
  });
}

test('a delivered note with failed exchange recording returns a warning and cannot be resent', async (t) => {
  const f = fixture(t);
  const e = f.engine();
  const first = f.ok(await f.request(e));
  statement(process.env.MAGI_HOME, `CREATE TRIGGER reject_note_exchange BEFORE INSERT ON exchanges
    WHEN json_extract(NEW.value,'$.kind')='note' BEGIN SELECT RAISE(ABORT,'fixture note history failure'); END`).run();
  const result = f.ok(await e.handleNote({ taskId: first.taskId, body: 'Do not dispatch twice.' }));
  assert.equal(result.note, true);
  assert.equal(result.deliveryStatus, 'queued_unread');
  assert.match(result.warning, /NOTE_EXCHANGE_RECORD_FAILED.*do not send it again/);
  assert.match(textOf(await e.handleNote({ taskId: first.taskId, body: 'Do not dispatch twice.' })), /NOTE_DUPLICATE/);
  assert.equal(f.sent.filter((args) => args.kind === 'note').length, 1);
  assert.deepEqual(state.readExchange(first.taskId).filter((row) => row.kind === 'note'), []);
});
test('delivered note accounting failure warns while retaining its pending reservation', async (t) => {
  const f = fixture(t);
  const e = f.engine();
  statement(process.env.MAGI_HOME, `CREATE TRIGGER reject_note_settlement BEFORE UPDATE ON records
    WHEN NEW.namespace='notes' BEGIN SELECT RAISE(ABORT,'fixture note accounting failure'); END`).run();
  const result = f.ok(await e.handleNote({ body: 'Already dispatched.' }));
  assert.match(result.warning, /NOTE_ACCOUNTING_FAILED.*do not send it again/);
  assert.match(textOf(await e.handleNote({ body: 'Already dispatched.' })), /NOTE_DUPLICATE/);
  assert.equal(f.sent.filter((args) => args.kind === 'note').length, 1);
});


test('successful note charges cannot be released by a stale failure settlement', (t) => {
  fixture(t);
  const reservation = state.reserveNote('sender', 'One committed note.');
  state.settleNote(reservation, true);
  state.settleNote(reservation, false);
  assert.throws(() => state.reserveNote('sender', 'One committed note.'), { code: 'NOTE_DUPLICATE' });
});
