// A headless round survives two things that used to end it with nothing: the
// model provider having no capacity for the turn (retried inside the round),
// and the time limit (the worker is told to wrap up shortly before it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { makeWorkspace, textOf } from './helpers/harness.mjs';
import { runHeadless } from '../src/serve.mjs';
import { makeEngine, runNotes } from '../src/peer.mjs';
import { looksLikeCapacity, claudeStreamSession } from '../src/exec.mjs';
import { ompRpcSession } from '../src/omp-launch.mjs';
import { wrapUpLeadMs, deliverHeadlessNote, stopHeadlessWorker, runState } from '../src/worker-channel.mjs';
import { composeWrapUp, composeCapacityRetry } from '../src/protocol.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import * as state from '../src/state.mjs';

const CAPACITY = 'Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)';

// One prompt per process, JSON lines both ways. FAIL_TIMES attempts answer
// with `FAIL_WITH` and exit 1; MODE=slow answers only when a note arrives.
const WORKER = `
const fs = require('node:fs');
const log = (row) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(row) + '\\n');
const say = (row) => process.stdout.write(JSON.stringify(row) + '\\n');
const attempts = fs.existsSync(process.env.FAKE_COUNT) ? Number(fs.readFileSync(process.env.FAKE_COUNT, 'utf8')) : 0;
fs.writeFileSync(process.env.FAKE_COUNT, String(attempts + 1));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (;;) {
    const at = buf.indexOf('\\n');
    if (at < 0) break;
    const row = JSON.parse(buf.slice(0, at));
    buf = buf.slice(at + 1);
    log({ attempt: attempts + 1, argv: process.argv.slice(2), ...row });
    if (row.type === 'prompt') {
      say({ type: 'session', id: 'sess-' + (attempts + 1) });
      if (attempts < Number(process.env.FAIL_TIMES || 0)) { say({ type: 'error', message: process.env.FAIL_WITH }); setTimeout(() => process.exit(1), 20); }
      else if (process.env.MODE === 'fail-after-note' && attempts < 1) { /* waits for the note */ }
      else if (process.env.MODE !== 'slow') say({ type: 'done', message: 'STATUS: RESOLVED - done\\nSUMMARY\\nanswered on attempt ' + (attempts + 1) });
    }
    if (row.type === 'note' && process.env.MODE === 'fail-after-note' && attempts < 1) { say({ type: 'ack', id: row.id }); say({ type: 'error', message: process.env.FAIL_WITH }); setTimeout(() => process.exit(1), 20); }
    else if (row.type === 'note' && process.env.MODE === 'fail-after-note') say({ type: 'ack', id: row.id });
    else if (row.type === 'note') { say({ type: 'ack', id: row.id }); say({ type: 'done', message: 'STATUS: BLOCKED - wrapped up\\nSUMMARY\\nhalf done' }); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function fixture(t, vars = {}) {
  const ws = makeWorkspace('capacity wrap');
  const script = join(ws, 'fake-worker.cjs');
  writeFileSync(script, WORKER);
  const logFile = join(ws, 'log.jsonl');
  const env = { FAKEPEER_BIN: script, FAKE_LOG: logFile, FAKE_COUNT: join(ws, 'count'), MAGI_CAPACITY_RETRY_MS: '40', MAGI_AS: 'claude', PEER_DEPTH: '0', FAIL_TIMES: '0', FAIL_WITH: CAPACITY, MODE: '', MAGI_WRAP_UP_MS: '', MAGI_CAPACITY_RETRIES: '', ...vars };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const adapter = {
    peer: 'fakepeer',
    headless: {
      bin: 'fakepeer',
      args: ({ resumeThreadId }) => (resumeThreadId ? ['--resume', resumeThreadId] : []),
      channel: ({ send, finish, receipt }) => {
        const r = { message: '', sessionId: null, errors: [] };
        let finished = false;
        let notes = 0;
        return {
          get finished() { return finished; },
          start: (text) => { send({ type: 'prompt', text }); },
          note: (text) => { const id = `n${++notes}`; return { id, sent: send({ type: 'note', id, text }) }; },
          line: (ev) => {
            if (ev.type === 'session') r.sessionId = ev.id;
            if (ev.type === 'error') r.errors.push(ev.message);
            if (ev.type === 'ack') receipt(ev.id, 'received_mid_turn');
            if (ev.type === 'done') { r.message = ev.message; finished = true; finish(); }
          },
          result: () => r,
        };
      },
    },
  };
  const rows = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ws, adapter, rows };
}

test('capacity errors are told apart from a spent usage limit', () => {
  for (const text of [CAPACITY, 'Error: 529 overloaded_error', 'HTTP 429 Too Many Requests', 'The server is busy, retry shortly']) assert.equal(looksLikeCapacity(text), true, text);
  for (const text of ['You’ve hit your usage limit. Visit the settings page to purchase more credits', 'Codex error event: The usage limit has been reached (code=usage_limit_reached)', 'rate limit exceeded: monthly quota used', 'omp exited before it had answered', '', undefined]) assert.equal(looksLikeCapacity(text), false, String(text));
});

test('a run the provider had no capacity for is started again inside the round and answers', async (t) => {
  const f = fixture(t, { FAIL_TIMES: '2' });
  const said = [];
  const reply = await runHeadless(f.adapter, { text: 'PEER REQUEST magi/1 the task', cwd: f.ws, timeoutMs: 120000, progress: (m) => said.push(m) });
  assert.match(reply.inlineReply, /answered on attempt 3/);
  assert.equal(reply.capacityRetries, 2);
  const prompts = f.rows().filter((r) => r.type === 'prompt');
  assert.equal(prompts.length, 3);
  assert.equal(prompts[0].text, 'PEER REQUEST magi/1 the task');
  assert.deepEqual(prompts[0].argv, []);
  // Each retry resumes the session the failed attempt reported, and says what it is.
  assert.deepEqual(prompts[1].argv, ['--resume', 'sess-1']);
  assert.deepEqual(prompts[2].argv, ['--resume', 'sess-2']);
  assert.equal(prompts[1].text, composeCapacityRetry('PEER REQUEST magi/1 the task', 1));
  assert.match(prompts[2].text, /^\[magi\] The model provider was at capacity .*\(retry 2\)\. This is the same request again/);
  assert.ok(said.some((m) => /at capacity; retry 1 of 2/.test(m)), said.join(' | '));
  assert.match(runNotes(reply), /started again 2 times before it answered/);
});

test('retries stop at the limit, and the failure says they were made', async (t) => {
  const f = fixture(t, { FAIL_TIMES: '9' });
  await assert.rejects(runHeadless(f.adapter, { text: 'x', cwd: f.ws, timeoutMs: 120000 }), (e) => {
    assert.equal(e.code, 'PEER_FAILED');
    assert.match(e.message, /Codex is at capacity/);
    assert.match(e.message, /started again 2 times before giving up/);
    return true;
  });
  assert.equal(f.rows().filter((r) => r.type === 'prompt').length, 3);
});

test('a spent usage limit, MAGI_CAPACITY_RETRIES=0 and a round with too little time left are not retried', async (t) => {
  const limit = fixture(t, { FAIL_TIMES: '9', FAIL_WITH: 'Codex error event: The usage limit has been reached (code=usage_limit_reached)' });
  await assert.rejects(runHeadless(limit.adapter, { text: 'x', cwd: limit.ws, timeoutMs: 120000 }), (e) => !/started again/.test(e.message));
  assert.equal(limit.rows().filter((r) => r.type === 'prompt').length, 1);

  const off = fixture(t, { FAIL_TIMES: '9', MAGI_CAPACITY_RETRIES: '0' });
  await assert.rejects(runHeadless(off.adapter, { text: 'x', cwd: off.ws, timeoutMs: 120000 }), { code: 'PEER_FAILED' });
  assert.equal(off.rows().filter((r) => r.type === 'prompt').length, 1);

  // Under a minute left: a retry could not finish, so the failure is reported now.
  const short = fixture(t, { FAIL_TIMES: '9' });
  await assert.rejects(runHeadless(short.adapter, { text: 'x', cwd: short.ws, timeoutMs: 30000 }), { code: 'PEER_FAILED' });
  assert.equal(short.rows().filter((r) => r.type === 'prompt').length, 1);
});

test('a round the orchestrator closed during the wait is not started again', async (t) => {
  const f = fixture(t, { FAIL_TIMES: '9', MAGI_CAPACITY_RETRY_MS: '400' });
  state.openRound({ taskId: 'magi-capclose', orchestrator: 'claude', peer: 'fakepeer', mode: 'DELEGATE', round: 1, cwd: f.ws });
  const run = runHeadless(f.adapter, { text: 'x', cwd: f.ws, timeoutMs: 120000, taskId: 'magi-capclose', round: 1 });
  for (let i = 0; i < 100 && f.rows().filter((r) => r.type === 'prompt').length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100)); // the first attempt has failed; the wait is running
  state.closeRound({ taskId: 'magi-capclose', round: 1, reason: 'abandoned', code: 'STOPPED', detail: 'stopped by the orchestrator' });
  await assert.rejects(run, { code: 'STOPPED_BY_ORCHESTRATOR' });
  assert.equal(f.rows().filter((r) => r.type === 'prompt').length, 1);
});

test('a plain close during the wait leaves the retry to run; a stop ends it', async (t) => {
  const closed = fixture(t, { FAIL_TIMES: '1', MAGI_CAPACITY_RETRY_MS: '400' });
  state.openRound({ taskId: 'magi-capplain', orchestrator: 'claude', peer: 'fakepeer', mode: 'DELEGATE', round: 1, cwd: closed.ws });
  const run = runHeadless(closed.adapter, { text: 'x', cwd: closed.ws, timeoutMs: 120000, taskId: 'magi-capplain', round: 1 });
  for (let i = 0; i < 100 && closed.rows().filter((r) => r.type === 'prompt').length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  // The orchestrator stopped waiting; its worker is still allowed to finish.
  state.closeRound({ taskId: 'magi-capplain', round: 1, reason: 'abandoned', detail: 'closed by the orchestrator without a reply' });
  assert.match((await run).inlineReply, /answered on attempt 2/);

  const stopped = fixture(t, { FAIL_TIMES: '9', MAGI_CAPACITY_RETRY_MS: '400' });
  const second = runHeadless(stopped.adapter, { text: 'x', cwd: stopped.ws, timeoutMs: 120000, taskId: 'magi-capstop', round: 1 });
  for (let i = 0; i < 100 && stopped.rows().filter((r) => r.type === 'prompt').length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  // Nothing is running to kill; the stop is what the retry reads when its wait ends.
  assert.deepEqual(await stopHeadlessWorker({ taskId: 'magi-capstop' }), { stopped: true, outcome: 'stopped', workerPid: process.pid });
  await assert.rejects(second, { code: 'STOPPED_BY_ORCHESTRATOR' });
  assert.equal(stopped.rows().filter((r) => r.type === 'prompt').length, 1);
});

test('a note during the wait is refused with the reason; one the failed attempt took goes with the retry', async (t) => {
  const f = fixture(t, { MODE: 'fail-after-note', MAGI_CAPACITY_RETRY_MS: '500' });
  const run = runHeadless(f.adapter, { text: 'the request', cwd: f.ws, timeoutMs: 120000, taskId: 'magi-capnote', round: 1 });
  for (let i = 0; i < 100 && f.rows().filter((r) => r.type === 'prompt').length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  const taken = await deliverHeadlessNote({ taskId: 'magi-capnote', text: 'PEER NOTE magi/1 from=claude\n\nalso check X' });
  assert.equal(taken.deliveryStatus, 'received_mid_turn');
  // Attempt 1 now fails on capacity; once its run is gone the wait is running.
  for (let i = 0; i < 200 && runState('magi-capnote') !== null; i++) await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(deliverHeadlessNote({ taskId: 'magi-capnote', text: 'a second note' }), (e) => {
    assert.equal(e.code, 'WORKER_RETRYING');
    assert.equal(e.dispatchUncertain, false);
    assert.match(e.message, /between attempts.*Send it again in a minute/);
    return true;
  });
  assert.match((await run).inlineReply, /answered on attempt 2/);
  const again = f.rows().filter((r) => r.type === 'prompt')[1];
  assert.match(again.text, /^\[magi\] The model provider was at capacity/);
  assert.match(again.text, /the request\n\n\[magi\] The orchestrator sent this note during the previous attempt; it still applies:\n\nPEER NOTE magi\/1 from=claude\n\nalso check X$/);
});

test('the wait keeps the call alive with progress, so a client that drops quiet calls does not drop it', { timeout: 60000 }, async (t) => {
  const f = fixture(t, { FAIL_TIMES: '1', MAGI_CAPACITY_RETRY_MS: '11500' });
  const said = [];
  const reply = await runHeadless(f.adapter, { text: 'x', cwd: f.ws, timeoutMs: 180000, progress: (m) => said.push(m) });
  assert.match(reply.inlineReply, /answered on attempt 2/);
  assert.ok(said.some((m) => /waiting for provider capacity \(\d+s left\)/.test(m)), said.join(' | '));
});

test('a stack frame is not a status code, and a wrap-up that could not be written is not reported as sent', async (t) => {
  assert.equal(looksLikeCapacity('TypeError: x is not a function\n    at run (worker.js:429:12)\n    at main (worker.js:529:3)'), false);
  assert.equal(looksLikeCapacity('    at read (status.mjs:429:7)\n    at fail (error.js:529:1)'), false);
  assert.equal(looksLikeCapacity('request failed with status code 529'), true);
  assert.equal(looksLikeCapacity('HTTP 429'), true);

  const f = fixture(t, { MODE: 'slow', MAGI_WRAP_UP_MS: '1000' });
  const deaf = { ...f.adapter, headless: { ...f.adapter.headless, channel: (io) => ({ ...f.adapter.headless.channel(io), finished: false, note: () => ({ id: 'n1', sent: Promise.reject(new Error('input closed')) }) }) } };
  await assert.rejects(runHeadless(deaf, { text: 'x', cwd: f.ws, timeoutMs: 1800 }), (e) => e.code === 'TIMEOUT' && !/told to wrap up/.test(e.message));
  // Rounded down: 90 seconds left is "1 minute", never "2".
  assert.match(composeWrapUp({ taskId: 'magi-1', minutes: Math.max(1, Math.floor(90000 / 60000)) }), /stopped in about 1 minute,/);
});

test('a worker near its limit is told to wrap up, and its partial reply is the answer', async (t) => {
  const f = fixture(t, { MODE: 'slow', MAGI_WRAP_UP_MS: '2500' });
  const said = [];
  const t0 = Date.now();
  const reply = await runHeadless(f.adapter, { text: 'a long task', cwd: f.ws, timeoutMs: 4000, taskId: undefined, progress: (m) => said.push(m) });
  assert.ok(Date.now() - t0 < 3900, 'answered before the limit, not killed at it');
  assert.match(reply.inlineReply, /STATUS: BLOCKED - wrapped up/);
  assert.equal(reply.wrapUp, true);
  const note = f.rows().find((r) => r.type === 'note');
  assert.equal(note.text, composeWrapUp({ taskId: undefined, minutes: 1 }));
  assert.match(note.text, /^PEER NOTE magi\/1 from=magi via=magi\n\nTime is nearly up/);
  assert.match(note.text, /STATUS: BLOCKED, then what is done, what is left/);
  assert.ok(said.some((m) => /told to wrap up/.test(m)));
  assert.match(runNotes(reply), /told to wrap up, so the reply may be partial\. Continue the card with its taskId/);
});

test('a worker that answers in time is sent no wrap-up; one that ignores it times out saying so', async (t) => {
  const quick = fixture(t, { MAGI_WRAP_UP_MS: '2500' });
  const reply = await runHeadless(quick.adapter, { text: 'x', cwd: quick.ws, timeoutMs: 4000 });
  assert.equal(reply.wrapUp, undefined);
  assert.equal(quick.rows().some((r) => r.type === 'note'), false);
  assert.equal(runNotes(reply), '');

  // The fake's note handler is what answers; with the wrap-up off it never does.
  const deaf = fixture(t, { MODE: 'slow', MAGI_WRAP_UP_MS: '0' });
  await assert.rejects(runHeadless(deaf.adapter, { text: 'x', cwd: deaf.ws, timeoutMs: 1500 }), (e) => e.code === 'TIMEOUT' && !/wrap up/.test(e.message));
});

// The worker was writing its final answer when the wrap-up went out: the note
// then opens a turn of its own, and that short turn must not be the reply.
test('an answer that was already complete when the wrap-up landed is the reply, on Claude and on omp', () => {
  const sent = [];
  const claude = claudeStreamSession({ send: async (m) => { sent.push(m); }, finish: () => {}, receipt: () => {} });
  claude.start('the request');
  const wrap = claude.note('wrap up', { own: true });
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess' };
  claude.line({ ...result, result: 'the complete answer', user_message_uuids: [sent[0].uuid] });
  claude.line({ ...result, result: 'STATUS: BLOCKED - nothing left, see above', user_message_uuids: [wrap.id] });
  assert.equal(claude.finished, true);
  assert.equal(claude.result().message, 'the complete answer');
  assert.equal(claude.result().completeBeforeWrapUp, true);

  // Taken inside the request's turn, the wrap-up reply is the answer as before.
  const sent2 = [];
  const mid = claudeStreamSession({ send: async (m) => { sent2.push(m); }, finish: () => {}, receipt: () => {} });
  mid.start('the request');
  const wrap2 = mid.note('wrap up', { own: true });
  mid.line({ ...result, result: 'STATUS: BLOCKED - half done', user_message_uuids: [sent2[0].uuid, wrap2.id] });
  assert.equal(mid.result().message, 'STATUS: BLOCKED - half done');
  assert.equal(mid.result().completeBeforeWrapUp, undefined);

  const out = [];
  const omp = ompRpcSession({ send: async (c) => { out.push(c); }, finish: () => {}, receipt: () => {} });
  const said = (role, text, stop) => ({ type: 'message_end', message: { role, content: [{ type: 'text', text }], ...(stop ? { stopReason: stop } : {}) } });
  omp.start('the request');
  omp.line({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
  const request = out.find((c) => c.type === 'prompt');
  omp.line({ type: 'response', id: request.id, command: 'prompt', success: true });
  omp.line({ type: 'agent_start' });
  omp.line(said('user', 'the request'));
  omp.line(said('assistant', 'the complete answer', 'stop'));
  omp.line({ type: 'agent_end', messages: [], yielded: true });
  const note = omp.note('wrap up', { own: true });
  const written = out.find((c) => c.id === note.id);
  omp.line({ type: 'response', id: note.id, command: 'prompt', success: true });
  omp.line({ type: 'agent_start' });
  omp.line(said('user', written.message));
  omp.line(said('assistant', 'STATUS: BLOCKED - nothing left, see above', 'stop'));
  assert.equal(omp.result().message, 'the complete answer');
  assert.equal(omp.result().completeBeforeWrapUp, true);
});

test('the wrap-up lead: five minutes on a long run, 15% on a shorter one, none under ten minutes', () => {
  const saved = process.env.MAGI_WRAP_UP_MS;
  delete process.env.MAGI_WRAP_UP_MS;
  try {
    assert.equal(wrapUpLeadMs(40 * 60000), 5 * 60000);
    assert.equal(wrapUpLeadMs(60 * 60000), 5 * 60000);
    assert.equal(wrapUpLeadMs(10 * 60000), 90000);
    assert.equal(wrapUpLeadMs(9 * 60000), 0);
    process.env.MAGI_WRAP_UP_MS = '120000';
    assert.equal(wrapUpLeadMs(40 * 60000), 120000);
    assert.equal(wrapUpLeadMs(60000), 0, 'a lead longer than the run is no lead');
    process.env.MAGI_WRAP_UP_MS = '0';
    assert.equal(wrapUpLeadMs(40 * 60000), 0);
  } finally {
    if (saved === undefined) delete process.env.MAGI_WRAP_UP_MS; else process.env.MAGI_WRAP_UP_MS = saved;
  }
});

test('the orchestrator reads both notes under the reply, inline and in the background', async (t) => {
  setEmbedder(null);
  const f = fixture(t);
  const home = [];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', id: 'owner', sessionId: 'owner', cwd: f.ws }, identityVerified: true }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ inlineReply: 'STATUS: BLOCKED - wrapped up\nSUMMARY\nhalf done', via: 'headless', threadId: 'th-1', capacityRetries: 1, wrapUp: true }),
    deliverReply: async (o) => { home.push(o.text); return { via: 'live', deliveryStatus: 'queued_unread' }; },
  });
  const inline = await engine.handleRequest({ task: 'x', mode: 'DELEGATE', wait: true, workingDirectory: f.ws });
  assert.notEqual(inline.isError, true, textOf(inline));
  assert.match(textOf(inline), /started again 1 time before it answered/);
  assert.match(textOf(inline), /told to wrap up, so the reply may be partial/);
  assert.equal(inline.structuredContent.status.state, 'blocked');

  const background = await engine.handleRequest({ task: 'y', mode: 'DELEGATE', workingDirectory: f.ws });
  assert.notEqual(background.isError, true, textOf(background));
  for (let i = 0; i < 100 && !home.length; i++) await new Promise((r) => setTimeout(r, 30));
  assert.match(home[0], /^PEER REPLY magi\/1/);
  assert.match(home[0], /started again 1 time before it answered/);
  assert.match(home[0], /told to wrap up, so the reply may be partial/);
});
