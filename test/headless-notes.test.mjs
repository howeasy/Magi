// A headless omp, Claude or Codex worker stays reachable while it works: a
// note on its card reaches it from the server that launched it and, through
// the frames inbox, from any other process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf, ROOT } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { runHeadless } from '../src/serve.mjs';
import { runState, deliverHeadlessNote } from '../src/worker-channel.mjs';
import { ompRpcSession, parseOmpJsonl } from '../src/omp-launch.mjs';
import { claudeStreamSession, parseClaudeJson } from '../src/exec.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { adapter as claudeAdapter } from '../src/claude-adapter.mjs';
import { adapter as codexAdapter } from '../src/codex-adapter.mjs';
import { codexAppServerSession } from '../src/codex-launch.mjs';
import * as state from '../src/state.mjs';
import { composeNote } from '../src/protocol.mjs';
import { getRecord, statement } from '../src/store.mjs';

const run = promisify(execFile);
const HARNESSES = [
  { peer: 'omp', adapter: ompAdapter, orchestrator: 'claude' },
  { peer: 'claude', adapter: claudeAdapter, orchestrator: 'codex' },
  { peer: 'codex', adapter: codexAdapter, orchestrator: 'claude' },
];

async function isolated(fn, { scenario = 'ok', env: extra = {} } = {}) {
  const ws = makeWorkspace('headless notes');
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['omp', 'claude', 'codex']);
  const { env, logFile } = fakeEnv(ws, { scenario });
  Object.assign(env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'), CODEX_HOME: join(ws, 'codex-home'),
    OMP_BIN: paths.omp, CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, PEER_DEPTH: '0', FAKE_CHILD_PID_FILE: join(ws, 'descendant.pid'), ...extra,
  });
  Object.assign(process.env, env);
  try { return await fn({ ws, env, logFile }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function eventually(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('condition did not become true before deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function running(pid) {
  if (process.platform === 'linux') {
    try { if (/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// The server side of a card: the real headless launcher and note route, with
// the reply captured where it would be delivered.
function launcher({ adapter, orchestrator }) {
  let replied;
  const reply = new Promise((resolve) => { replied = resolve; });
  const engine = makeEngine({
    orchestrator, peerName: adapter.peer, replyTool: `${orchestrator}_peer`,
    resolveOrigin: async () => ({ target: { agent: orchestrator, id: 'coordinator', name: 'lead' }, replyTo: `${orchestrator}:coordinator` }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: (options) => runHeadless(adapter, options),
    deliverHeadlessNote,
    deliverReply: async ({ text }) => { replied(text); return { deliveryStatus: 'received' }; },
  });
  return { engine, reply };
}

async function startCard(engine, ws, logFile) {
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: ws, wait: false });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  // The request has reached the worker and its turn is open.
  await eventually(() => readCalls(logFile).some((call) => call.args) && runState(taskId) === 'running');
  return taskId;
}

function notesOf(logFile) {
  return readCalls(logFile).filter((call) => call.note);
}

test('omp retries one SQLite truncate failure before RPC input, without duplicating the request', async () => {
  await isolated(async ({ ws, logFile }) => {
    const result = await runHeadless(ompAdapter, { text: 'inspect once', cwd: ws, timeoutMs: 10000 });
    assert.match(result.inlineReply, /Fake peer reply/);
    const calls = readCalls(logFile).filter((call) => call.name === 'omp' && call.args?.includes('rpc'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].startupFailure, true);
    assert.equal(calls[0].stdin, '');
    assert.equal(calls[1].stdin, 'inspect once');
  }, { env: { FAKE_OMP_STARTUP_SQLITE_COUNT: '1' } });
});

test('omp stops after the second SQLite startup failure', async () => {
  await isolated(async ({ ws, logFile }) => {
    await assert.rejects(runHeadless(ompAdapter, { text: 'inspect once', cwd: ws, timeoutMs: 10000 }), /SQLITE_IOERR_TRUNCATE/);
    const calls = readCalls(logFile).filter((call) => call.name === 'omp' && call.args?.includes('rpc'));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.startupFailure));
  }, { env: { FAKE_OMP_STARTUP_SQLITE_COUNT: '5' } });
});

test('omp never replays a SQLite failure after RPC input was sent', async () => {
  await isolated(async ({ ws, logFile }) => {
    await assert.rejects(runHeadless(ompAdapter, { text: 'inspect once', cwd: ws, timeoutMs: 10000 }), /SQLITE_IOERR_TRUNCATE/);
    const calls = readCalls(logFile).filter((call) => call.name === 'omp' && call.args?.includes('rpc'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stdin, 'inspect once');
  }, { env: { FAKE_OMP_SQLITE_AFTER_PROMPT: '1' } });
});

test('cancellation during SQLite startup recovery prevents a second launch', async () => {
  await isolated(async ({ ws, logFile }) => {
    const controller = new AbortController();
    await assert.rejects(runHeadless(ompAdapter, {
      text: 'inspect once', cwd: ws, timeoutMs: 10000, signal: controller.signal,
      progress: (message) => { if (message.includes('retrying once')) controller.abort(); },
    }), (error) => error.code === 'CANCELLED');
    assert.equal(readCalls(logFile).filter((call) => call.startupFailure).length, 1);
  }, { env: { FAKE_OMP_STARTUP_SQLITE_COUNT: '1' } });
});

function assertFolded(h, note) {
  assert.match(note.note, /^PEER NOTE magi\/1 task_id=\S+ from=/);
  assert.match(note.note, /Also check the empty case\./);
  assert.match(note.note, /your final message is still the reply/);
  assert.doesNotMatch(note.note, /kind="reply"/, 'a headless worker has no tool to answer with');
  if (h.peer === 'omp') assert.equal(note.streamingBehavior, 'steer');
  else if (h.peer === 'claude') assert.equal(note.priority, 'next');
  else {
    // turn/steer into the request's own turn, keyed by the note's id.
    assert.equal(note.expectedTurnId, 'turn-1');
    assert.match(note.clientUserMessageId, /^[0-9a-f-]{36}$/);
  }
}

for (const h of HARNESSES) {
  test(`a note from the launching server reaches a running headless ${h.peer} inside its turn`, { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
    const { engine, reply } = launcher(h);
    const taskId = await startCard(engine, ws, logFile);
    const prompt = readCalls(logFile).find((call) => call.args).stdin;
    assert.match(prompt, /PEER NOTE messages while you work/);

    const note = await engine.handleNote({ taskId, body: 'Also check the empty case.' });
    assert.equal(note.isError, undefined, textOf(note));
    assert.equal(note.structuredContent.deliveryStatus, 'received_mid_turn');
    assert.equal(note.structuredContent.via, `headless:${h.peer}`);
    // The receipt outlives the call: an ack record, and the card names the server holding the run.
    assert.equal(getRecord(process.env.MAGI_HOME, 'delivery-acks', note.structuredContent.messageId)?.status, 'received_mid_turn');
    assert.equal(Object.values(state.readTask(taskId).rounds.at(-1).deliveries ?? {}).find((d) => d.via === `headless:${h.peer}`)?.workerPid, process.pid);
    assert.match(await reply, /Fake peer reply/);
    const notes = notesOf(logFile);
    assert.equal(notes.length, 1);
    assertFolded(h, notes[0]);
    assert.ok(state.readExchange(taskId).some((row) => row.kind === 'note' && row.text === 'Also check the empty case.'));
  }, { env: { FAKE_CLI_HOLD_FOR_NOTES: '1' } }));

  test(`a note from another process reaches a running headless ${h.peer} through the frames inbox`, { timeout: 60000 }, () => isolated(async ({ ws, env, logFile }) => {
    const { engine, reply } = launcher(h);
    const taskId = await startCard(engine, ws, logFile);
    assert.equal(state.readWorker(taskId).pid, process.pid);
    assert.ok(state.readWorker(taskId).processStartedAt, 'the worker row carries the server birth marker');

    const script = `import { deliverHeadlessNote } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'worker-channel.mjs')).href)};
console.log(JSON.stringify(await deliverHeadlessNote({ taskId: process.argv[1], text: process.argv[2] })));`;
    const text = composeNote({ from: h.orchestrator, body: 'Also check the empty case.', taskId, headless: true });
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, taskId, text], {
      env: { ...process.env, MAGI_CONFIRM_MS: '15000' },
    });
    const used = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(used.deliveryStatus, 'received_mid_turn');
    assert.equal(used.via, `headless:${h.peer}`);
    assert.equal(getRecord(env.MAGI_HOME, 'delivery-acks', used.messageId).status, 'received_mid_turn');
    assert.equal(statement(env.MAGI_HOME, 'SELECT COUNT(*) AS n FROM frames WHERE id=?').get(used.messageId).n, 0, 'a delivered frame leaves the inbox');
    assert.match(await reply, /Fake peer reply/);
    assert.equal(notesOf(logFile).length, 1);
    assertFolded(h, notesOf(logFile)[0]);
  }, { env: { FAKE_CLI_HOLD_FOR_NOTES: '1' } }));
}

// omp closes stdin and waits for the exit; Codex unsubscribes and then stops
// the server (the fake answers thread/unsubscribe after the exit delay).
for (const h of [HARNESSES[0], HARNESSES[2]]) {
  test(`a note while a headless ${h.peer}'s reply is being taken is WORKER_FINISHING, and the refusal releases its budget`, { timeout: 60000 }, () => isolated(async ({ ws, logFile }) => {
    const { engine, reply } = launcher(h);
    const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: ws, wait: false });
    const { taskId } = started.structuredContent;
    await eventually(() => runState(taskId) === 'finishing');
    const refused = await engine.handleNote({ taskId, body: 'Too late for this turn.' });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /WORKER_FINISHING.*follow-up request/s);
    assert.match(await reply, /Fake peer reply/);
    await eventually(() => runState(taskId) === null && !state.readWorker(taskId));
    // Not NOTE_DUPLICATE: a definite refusal spends no dedupe reservation.
    assert.match(textOf(await engine.handleNote({ taskId, body: 'Too late for this turn.' })), /NO_LIVE_PEER.*follow-up request/s);
    assert.equal(notesOf(logFile).length, 0);
  }, { env: { FAKE_CLI_EXIT_DELAY_MS: '3000' } }));
}

for (const adapter of [ompAdapter, codexAdapter]) {
  for (const how of ['timeout', 'cancel']) {
    test(`a ${how} stops a headless ${adapter.peer} channel and its descendants`, { timeout: 60000 }, () => isolated(async ({ ws, env, logFile }) => {
      const controller = new AbortController();
      const taskId = `magi-${adapter.peer}-${how}`;
      const pending = runHeadless(adapter, { text: 'inspect', cwd: ws, taskId, timeoutMs: how === 'timeout' ? 4000 : 60000, signal: controller.signal });
      pending.catch(() => {});
      await eventually(() => readCalls(logFile).some((call) => call.args) && existsSync(env.FAKE_CHILD_PID_FILE));
      const pid = readCalls(logFile).find((call) => call.args).pid;
      const descendant = Number(readFileSync(env.FAKE_CHILD_PID_FILE, 'utf8'));
      assert.equal(running(descendant), true);
      if (how === 'cancel') controller.abort();
      await assert.rejects(pending, { code: how === 'timeout' ? 'TIMEOUT' : 'CANCELLED' });
      await eventually(() => !running(pid) && !running(descendant));
      assert.equal(runState(taskId), null);
      assert.equal(state.readWorker(taskId), null);
    }, { scenario: 'tree-hang' }));
  }
}

test('the omp rpc session reads the reply and usage --mode json reads, across protocol-2 chunks', () => {
  const user = { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } };
  const first = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'toolUse', usage: { input: 1000, output: 100, cacheRead: 50000, cost: { total: 0.0085 } } } };
  const final = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }], stopReason: 'stop', usage: { input: 300, output: 50, cacheRead: 51000, cost: { total: 0.0004 } } } };
  const sent = [];
  let finished = 0;
  const session = ompRpcSession({ send: async (command) => { sent.push(command); }, finish: () => { finished++; }, receipt: () => {} });
  session.start('the prompt');
  assert.deepEqual(sent, [], 'nothing is written before omp is ready');
  session.line({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
  assert.deepEqual(sent.map((c) => c.type), ['negotiate_protocol', 'set_event_filter', 'prompt', 'get_state']);
  assert.ok(!sent[1].events.includes('message_update'), 'per-token updates are filtered out');
  const [, , request, getState] = sent;
  assert.equal(request.message, 'the prompt');
  session.line({ type: 'response', id: request.id, command: 'prompt', success: true });
  session.line({ type: 'agent_start' });
  session.line(user);
  session.line(first);
  const whole = Buffer.from(JSON.stringify(final));
  const half = Math.ceil(whole.length / 2);
  for (const [index, part] of [whole.subarray(0, half), whole.subarray(half)].entries()) {
    session.line({ type: 'rpc_chunk', chunkId: 'rpc-1', index, count: 2, byteLength: whole.length, data: part.toString('base64') });
  }
  session.line({ type: 'response', id: getState.id, command: 'get_state', success: true, data: { sessionId: 'omp-sess' } });
  session.line({ type: 'agent_end', messages: [], isTerminal: false, yielded: true, awaitingAsyncWork: true });
  session.line({ type: 'prompt_result', id: request.id, agentInvoked: true, status: 'completed', sessionSettled: false });
  assert.equal(finished, 0, 'background work can still wake the agent');
  session.line({ type: 'session_settled' });
  assert.equal(finished, 1);
  const expected = parseOmpJsonl([user, first, final].map((e) => JSON.stringify(e)).join('\n'));
  assert.deepEqual(session.result(), { ...expected, sessionId: 'omp-sess' });
});

test('the Claude stream session finishes when every uuid is consumed and reads the result --output-format json reads', () => {
  const sent = [];
  const receipts = [];
  let finished = 0;
  const session = claudeStreamSession({ send: async (message) => { sent.push(message); }, finish: () => { finished++; }, receipt: (id, status) => receipts.push([id, status]) });
  session.start('the prompt');
  const note = session.note('a note');
  assert.ok(sent.every((m) => m.type === 'user' && typeof m.uuid === 'string'));
  assert.equal(sent[0].message.content, 'the prompt');
  assert.equal(sent[1].priority, 'next');
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess', total_cost_usd: 0.12, usage: { input_tokens: 40, cache_read_input_tokens: 40000, output_tokens: 250 }, duration_ms: 5100, num_turns: 3, modelUsage: { 'claude-opus-5': {} } };
  session.line({ type: 'user', uuid: note.id, isReplay: true, message: sent[1].message, session_id: 'sess' });
  session.line({ ...result, result: 'first turn', user_message_uuids: [sent[0].uuid] });
  assert.equal(finished, 0, 'the note is not consumed yet');
  const last = { ...result, result: 'final answer', user_message_uuids: [note.id] };
  session.line(last);
  assert.equal(finished, 1);
  assert.deepEqual(receipts, [[note.id, 'queued_unread'], [note.id, 'received']]);
  assert.deepEqual(session.result(), parseClaudeJson(JSON.stringify(last)));
});

// The Codex worker's JSON-RPC, driven by hand. Writes go out a microtask
// after the call, so each step waits one turn of the event loop.
const tick = () => new Promise((resolve) => setImmediate(resolve));

function codexSession(launch) {
  const sent = [];
  const receipts = [];
  const stops = [];
  const session = codexAppServerSession({
    send: async (message) => { sent.push(message); },
    finish: (stopAfter) => { stops.push(stopAfter); },
    receipt: (id, status) => receipts.push([id, status]),
  }, launch);
  const request = (method) => sent.find((m) => m.method === method && m.id !== undefined);
  const answer = (method, result) => session.line({ id: request(method).id, result });
  const event = (method, params) => session.line({ method, params });
  return { session, sent, receipts, stops, request, answer, event };
}

const counts = (inputTokens, cachedInputTokens, outputTokens) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens });

test('the Codex app-server session declines server requests, steers a note into the request turn, and reads what codex exec reported', async () => {
  const c = codexSession({ cwd: 'E:/r', model: 'gpt-6-astra' });
  c.session.start('the prompt');
  await tick();
  assert.deepEqual(c.sent.map((m) => m.method), ['initialize']);
  assert.deepEqual(c.request('initialize').params.capabilities, { experimentalApi: true });
  c.answer('initialize', { userAgent: 'codex' });
  await tick();
  assert.deepEqual(c.sent.map((m) => m.method), ['initialize', 'initialized', 'thread/start']);
  // threadSource "exec": listed as `codex exec` threads were, never as an interactive session.
  assert.deepEqual(c.request('thread/start').params, { cwd: 'E:/r', approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-astra', threadSource: 'exec' });
  const note = c.session.note('an early note');
  c.answer('thread/start', { thread: { id: 't1' } });
  await tick();
  const { input, clientUserMessageId, ...turnStart } = c.request('turn/start').params;
  assert.deepEqual(turnStart, { threadId: 't1', cwd: 'E:/r', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
  assert.deepEqual(input, [{ type: 'text', text: 'the prompt', text_elements: [] }]);
  assert.equal(c.request('turn/steer'), undefined, 'a note waits until the turn has an id');
  c.answer('turn/start', { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
  await tick();
  assert.deepEqual(c.request('turn/steer').params, { threadId: 't1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'an early note', text_elements: [] }], clientUserMessageId: note.id });

  c.session.line({ id: 'srv-1', method: 'item/tool/requestUserInput', params: { threadId: 't1', turnId: 'turn-1' } });
  await tick();
  const declined = c.sent.find((m) => m.id === 'srv-1' && !m.method);
  assert.ok(declined.error && !('result' in declined), 'a server request is answered with an error');

  c.session.line({ id: c.request('turn/steer').id, result: { turnId: 'turn-1' } });
  await note.sent;
  c.event('item/completed', { threadId: 't1', turnId: 'turn-1', item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'an early note' }], clientId: note.id } });
  // A subagent's thread reports on the same connection; it is not the reply.
  c.event('item/completed', { threadId: 'sub', turnId: 'sub-turn', item: { type: 'agentMessage', id: 's1', text: 'subagent says', phase: 'final_answer' } });
  c.event('turn/completed', { threadId: 'sub', turn: { id: 'sub-turn', status: 'completed' } });
  c.event('item/completed', { threadId: 't1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'looking', phase: 'commentary' } });
  c.event('thread/tokenUsage/updated', { threadId: 't1', turnId: 'turn-1', tokenUsage: { total: counts(10000, 6000, 2), last: counts(10000, 6000, 2) } });
  c.event('item/completed', { threadId: 't1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a2', text: 'final answer', phase: 'final_answer' } });
  c.event('thread/tokenUsage/updated', { threadId: 't1', turnId: 'turn-1', tokenUsage: { total: counts(22638, 13056, 5), last: counts(12638, 7056, 3) } });
  assert.equal(c.stops.length, 0);
  c.event('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed', items: [] } });
  assert.equal(c.session.finished, true);
  assert.equal(c.stops.length, 1);
  await tick();
  assert.deepEqual(c.request('thread/unsubscribe').params, { threadId: 't1' });
  let stopped = false;
  c.stops[0].then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, 'the server is stopped only once the thread is unsubscribed');
  c.answer('thread/unsubscribe', { status: 'unsubscribed' });
  await tick();
  assert.equal(stopped, true);
  assert.deepEqual(c.receipts, [[note.id, 'queued_unread'], [note.id, 'received_mid_turn']]);
  // `codex exec --json` on the same run (codex-cli 0.153.4, the fixture the
  // removed parseCodexJsonl was tested on): thread.started thread_id, the last
  // agent_message, turn.completed usage {input_tokens: 22638,
  // cached_input_tokens: 13056, output_tokens: 5}.
  assert.deepEqual(c.session.result(), { message: 'final answer', sessionId: 't1', errors: [], usage: { costUsd: null, inputTokens: 22638, cachedInputTokens: 13056, outputTokens: 5 } });
});

test('a Codex steer that loses the race with the end of the turn is WORKER_FINISHING, and a resumed thread counts only this run', async () => {
  const c = codexSession({ cwd: 'E:/r', allowWrites: true, resumeThreadId: 'old' });
  c.session.start('again');
  await tick();
  c.answer('initialize', {});
  await tick();
  assert.equal(c.request('thread/start'), undefined);
  assert.deepEqual(c.request('thread/resume').params, { threadId: 'old', cwd: 'E:/r', approvalPolicy: 'never', sandbox: 'workspace-write' });
  c.answer('thread/resume', { thread: { id: 'old' } });
  await tick();
  assert.deepEqual(c.request('turn/start').params.sandboxPolicy, { type: 'workspaceWrite' });
  c.answer('turn/start', { turn: { id: 'turn-2', status: 'inProgress', items: [] } });
  await tick();
  c.event('thread/tokenUsage/updated', { threadId: 'old', turnId: 'turn-2', tokenUsage: { total: counts(51000, 30500, 407), last: counts(1000, 500, 7) } });
  const late = c.session.note('too late');
  await tick();
  c.event('item/completed', { threadId: 'old', turnId: 'turn-2', item: { type: 'agentMessage', id: 'a1', text: 'resumed answer', phase: 'final_answer' } });
  c.event('thread/tokenUsage/updated', { threadId: 'old', turnId: 'turn-2', tokenUsage: { total: counts(53000, 32000, 420), last: counts(2000, 1500, 13) } });
  c.event('turn/completed', { threadId: 'old', turn: { id: 'turn-2', status: 'completed', items: [] } });
  assert.equal(c.stops.length, 0, 'an unanswered steer holds the run open');
  c.session.line({ id: c.request('turn/steer').id, error: { code: -32600, message: 'no active turn to steer' } });
  await assert.rejects(late.sent, { code: 'WORKER_FINISHING' });
  assert.equal(c.stops.length, 1);
  assert.deepEqual(c.receipts, []);
  assert.deepEqual(c.session.result(), { message: 'resumed answer', sessionId: 'old', errors: [], usage: { costUsd: null, inputTokens: 3000, cachedInputTokens: 2000, outputTokens: 20 } });
  c.session.close(); // the exit: the unanswered thread/unsubscribe is released
});

async function openTurn(c, turnId = 'turn-1') {
  c.session.start('the prompt');
  await tick();
  c.answer('initialize', {});
  await tick();
  c.answer('thread/start', { thread: { id: 't1' } });
  await tick();
  c.answer('turn/start', { turn: { id: turnId, status: 'inProgress', items: [] } });
  await tick();
}

test('a Codex note is received by its text when its echo carries an id that is not ours, and by its turn completing when nothing echoes it', async () => {
  const c = codexSession({ cwd: 'E:/r' });
  await openTurn(c);
  const echoed = c.session.note('first note');
  const silent = c.session.note('second note');
  await tick();
  for (const steer of c.sent.filter((m) => m.method === 'turn/steer')) c.session.line({ id: steer.id, result: { turnId: 'turn-1' } });
  await Promise.all([echoed.sent, silent.sent]);
  c.event('item/completed', { threadId: 't1', turnId: 'turn-1', item: { type: 'userMessage', id: 'u9', clientId: 'codex-own-id', content: [{ type: 'text', text: 'first note\r\n' }] } });
  assert.deepEqual(c.receipts, [[echoed.id, 'queued_unread'], [silent.id, 'queued_unread'], [echoed.id, 'received_mid_turn']]);
  c.event('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed', items: [] } });
  assert.deepEqual(c.receipts.slice(3), [[silent.id, 'received_mid_turn']]);
  c.session.close();
});

test('a Codex steer nobody answers is left unconfirmed and does not hold the run open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = codexSession({ cwd: 'E:/r' });
  await openTurn(c);
  const note = c.session.note('lost in the pipe');
  await tick();
  t.mock.timers.tick(60_000);
  await note.sent;
  c.event('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed', items: [] } });
  assert.equal(c.stops.length, 1);
  assert.deepEqual(c.receipts, [], 'neither failed nor received: it may be in the turn');
});

test('a Codex worker that stops answering, or prints something that is not JSON-RPC, is stopped at once with the reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = codexSession({ cwd: 'E:/r' });
  silent.session.start('the prompt');
  await tick();
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(silent.session.finished, true);
  assert.equal(silent.stops.length, 1);
  assert.equal(silent.request('thread/start'), undefined);
  assert.equal(silent.request('thread/unsubscribe'), undefined, 'a server that stopped answering is not asked anything more');
  assert.equal(silent.session.result().code, 'APPSERVER_TIMEOUT');
  assert.match(silent.session.result().errors[0], /did not answer initialize within 60 s/);

  const noisy = codexSession({ cwd: 'E:/r' });
  noisy.session.start('the prompt');
  await tick();
  noisy.session.junk('thread main panicked at core/src/lib.rs');
  assert.equal(noisy.session.finished, true);
  assert.equal(noisy.stops.length, 1);
  assert.equal(noisy.session.result().code, 'PROTOCOL_ERROR');
  // The exit that follows releases the unanswered initialize without a second error.
  noisy.session.close();
  await tick();
  assert.equal(noisy.session.result().errors.length, 1);
});

// A worker that dies while starting must not leave a note hanging: the tool
// call would never return, and a cross-process drain would stall behind it.
test('a note held for a worker that exits before its request went is refused, not left pending', async () => {
  const settle = (p) => Promise.race([p.then(() => 'resolved', (e) => e.code), new Promise((r) => setTimeout(() => r('PENDING'), 200))]);

  const omp = ompRpcSession({ send: async () => {}, finish: () => {}, receipt: () => {} });
  omp.start('the prompt');
  const ompNote = omp.note('held until ready');
  omp.close();
  assert.equal(await settle(ompNote.sent), 'WORKER_CLOSED');

  const c = codexSession({ cwd: 'E:/r' });
  c.session.start('the prompt');
  await tick();
  const codexNote = c.session.note('held until the turn has an id');
  c.session.close();
  assert.equal(await settle(codexNote.sent), 'DELIVERY_FAILED');
});
