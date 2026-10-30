import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf } from './helpers/harness.mjs';
import magi from '../omp/magi-omp-extension.js';
import { listAgentSessions, resolveOrigin, deliverTo } from '../src/transport.mjs';
import { pickSession } from '../src/serve.mjs';
import { codexCaller } from '../src/mcp-caller.mjs';
import { makeEngine } from '../src/peer.mjs';
import * as state from '../src/state.mjs';
import { processStartedAt } from '../omp/process-identity.js';
import { getRecord, setRecord, removeRecord, statement } from '../src/store.mjs';

function isolated(t) {
  const cwd = makeWorkspace('identity lifecycle');
  const values = { MAGI_HOME: join(cwd, 'home'), CLAUDE_CONFIG_DIR: join(cwd, 'claude'), CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return cwd;
}

function extension() {
  const handlers = {};
  let tick;
  magi({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage() {}, logger: { warn() {} } });
  const ctx = (id, file) => ({ cwd: process.env.MAGI_HOME, isIdle: () => true, sessionManager: { getSessionId: () => id, getSessionFile: () => file }, setInterval: (fn) => { tick = fn; return {}; } });
  const key = String(process.pid);
  return { handlers, ctx, key, read: () => getRecord(process.env.MAGI_HOME, 'agents', key), tick: () => tick() };
}

function row(pid, fields = {}) {
  setRecord(process.env.MAGI_HOME, 'agents', String(pid), { agent: 'omp', pid, processStartedAt: processStartedAt(pid), sessionId: 'old', cwd: process.cwd(), ...fields });
  return String(pid);
}

function target(agent, id, pid) { return { agent, id, sessionId: id, ...(pid ? { pid } : {}) }; }
function engine(caller, counterparty, extra = {}) {
  return makeEngine({ orchestrator: caller.agent, peerName: counterparty.agent, replyTool: 'peer_tool',
    resolveOrigin: async () => ({ target: caller, identityVerified: true, identitySource: 'test_runtime' }),
    pickDelivery: async () => ({ mode: 'live', target: counterparty }),
    deliverLive: async () => ({ via: 'live', target: counterparty, deliveryStatus: 'queued_unread' }),
    ...extra });
}
function open(taskId, owner, worker, cwd) {
  state.openRound({ taskId, orchestrator: owner.agent, peer: worker.agent, orchestratorTarget: owner, round: 1, maxRounds: 3, cwd });
  state.setPeerTarget(taskId, worker);
}

test('omp heartbeat restores a deleted registry immediately and session rotation retains every alias', async (t) => {
  isolated(t);
  const e = extension();
  e.handlers.session_start({}, e.ctx('first'));
  const startedAt = e.read().startedAt;
  await e.tick();
  removeRecord(process.env.MAGI_HOME, 'agents', e.key);
  await e.tick();
  assert.equal(e.read().sessionId, 'first');
  e.handlers.session_switch({}, e.ctx('second'));
  e.handlers.session_switch({}, e.ctx('third'));
  assert.equal(e.read().pid, process.pid);
  assert.equal(e.read().startedAt, startedAt);
  assert.deepEqual(e.read().sessionAliases, ['first', 'second', 'third']);
  const sessions = listAgentSessions('omp');
  assert.equal(pickSession(sessions, 'first', process.env.MAGI_HOME, 'omp').pid, process.pid);
  assert.equal(pickSession(sessions, String(process.pid), process.env.MAGI_HOME, 'omp').sessionId, 'third');
});

test('a live pid survives stale heartbeat and old-id delivery still reaches its inbox', async (t) => {
  isolated(t);
  const path = row(process.pid, { sessionId: 'new', sessionAliases: ['old', 'new'], heartbeat: true });
  statement(process.env.MAGI_HOME, "UPDATE records SET updated_at=0 WHERE namespace='agents' AND key=?").run(path);
  assert.equal(listAgentSessions('omp')[0].live, true);
  assert.equal(listAgentSessions('omp')[0].heartbeatStale, true);
  assert.notEqual(getRecord(process.env.MAGI_HOME, 'agents', path), null);
  const delivered = await deliverTo({ agent: 'omp', sessionId: 'old' }, 'alias route');
  const frame = JSON.parse(statement(process.env.MAGI_HOME, 'SELECT body FROM frames WHERE id=?').get(delivered.messageId).body);
  assert.match(frame.text, /^alias route/);
});

test('a helper first registered in its own process is marked with its parent and not a free worker', (t) => {
  const cwd = isolated(t);
  const parent = join(cwd, 'parent.jsonl');
  mkdirSync(join(cwd, 'parent'));
  const helper = join(cwd, 'parent', 'helper.jsonl');
  writeFileSync(helper, JSON.stringify({ type: 'session', id: 'helper', parentSession: parent }) + '\n');
  const e = extension();
  e.handlers.session_start({}, e.ctx('helper', helper));
  assert.equal(e.read().parentSession, parent);
  assert.deepEqual(listAgentSessions('omp'), []);
  assert.equal(listAgentSessions('omp', { includeHelpers: true })[0].sessionId, 'helper');
  assert.equal(pickSession(listAgentSessions('omp'), 'helper', cwd, 'omp'), null);
});

test('in-process helper status and shutdown cannot overwrite or unregister its parent', (t) => {
  const cwd = isolated(t);
  const parent = join(cwd, 'parent.jsonl');
  const child = join(cwd, 'parent', 'helper.jsonl');
  const e = extension();
  const parentCtx = e.ctx('parent', parent);
  const helperCtx = e.ctx('helper', child);
  e.handlers.session_start({}, parentCtx);
  e.handlers.agent_start({}, parentCtx);
  e.handlers.session_start({}, helperCtx);
  e.handlers.agent_end({}, helperCtx);
  e.handlers.session_shutdown({}, helperCtx);
  assert.equal(e.read().sessionId, 'parent');
  assert.equal(e.read().status, 'busy');
  e.handlers.session_switch({}, e.ctx('next', join(cwd, 'next.jsonl')));
  assert.equal(e.read().sessionId, 'next');
  e.handlers.session_start({}, helperCtx);
  e.handlers.agent_end({}, helperCtx);
  e.handlers.session_shutdown({}, helperCtx);
  assert.equal(e.read().sessionId, 'next', 'late helper events from the old root are still helpers');
});

test('omp resolves the nearest registry ancestor through a wrapper and accepts its previous session id', (t) => {
  isolated(t);
  row(process.pid, { sessionId: 'current', sessionAliases: ['old', 'current'] });
  const url = new URL('../src/transport.mjs', import.meta.url).href;
  const leaf = `import {resolveOrigin} from ${JSON.stringify(url)}; console.log(JSON.stringify(await resolveOrigin('omp',{from:'old'})));`;
  const wrapper = `const {execFileSync}=require('node:child_process');process.stdout.write(execFileSync(process.execPath,['--input-type=module','-e',${JSON.stringify(leaf)}],{encoding:'utf8'}));`;
  const origin = JSON.parse(execFileSync(process.execPath, ['-e', wrapper], { encoding: 'utf8', timeout: 15000 }));
  assert.equal(origin.target.pid, process.pid);
  assert.equal(origin.target.sessionId, 'current');
  assert.equal(origin.identityVerified, true);
});

test('Claude ignores a socket owned by a non-ancestor and uses its parent row before spawn env', async (t) => {
  isolated(t);
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'foreign', messagingSocketPath: 'foreign-socket' }));
  writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'parent', messagingSocketPath: 'parent-socket' }));
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = 'foreign-socket';
  process.env.CLAUDE_CODE_SESSION_ID = 'spawn';
  const origin = await resolveOrigin('claude');
  assert.equal(origin.target.sessionId, 'parent');
  assert.equal(origin.identitySource, 'pid_registry');
  await assert.rejects(resolveOrigin('claude', { from: 'foreign' }), { code: 'ORIGIN_MISMATCH' });
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = 'parent-socket';
  assert.equal((await resolveOrigin('claude')).identitySource, 'messaging_socket_registry');
  unlinkSync(join(dir, `${process.ppid}.json`));
  const spawn = await resolveOrigin('claude');
  assert.equal(spawn.target.spawnSessionId, 'spawn');
  assert.equal(spawn.identitySource, 'spawn_session_env');
});

test('Codex root session is a fallback, not a conflicting thread identity', async (t) => {
  isolated(t);
  const meta = { threadId: 'child', sessionId: 'root', 'x-codex-turn-metadata': { thread_id: 'child' } };
  assert.equal(codexCaller(meta).threadId, 'child');
  assert.equal(codexCaller(meta).sessionId, 'root');
  const origin = await resolveOrigin('codex', { meta });
  assert.equal(origin.target.id, 'child');
  assert.equal(origin.target.rootSessionId, 'root');
  assert.equal(origin.identityVerified, true);
  assert.throws(() => codexCaller({ ...meta, thread_id: 'other-child' }), { code: 'ORIGIN_MISMATCH' });
});

test('model-only origin is visibly unverified in the successful result', async (t) => {
  isolated(t);
  const origin = await resolveOrigin('omp', { from: 'claimed-session' });
  assert.equal(origin.identityVerified, false);
  const e = makeEngine({ orchestrator: 'omp', peerName: 'claude', resolveOrigin: async () => origin, listPeers: async () => [], pickDelivery: async () => { throw new Error('none'); } });
  const res = await e.handlePeers({});
  assert.equal(res.structuredContent.callerIdentity.id, 'claimed-session');
  assert.equal(res.structuredContent.callerIdentity.verified, false);
  assert.equal(res.structuredContent.callerIdentity.source, 'model_claim');
});

for (const action of ['handleClarifyAnswer', 'handleClose', 'handleOutcome', 'handleRequest']) {
  test(`${action} refuses a different session of the orchestrator harness without changing the task`, async (t) => {
    const cwd = isolated(t);
    const owner = target('codex', 'owner');
    const worker = target('omp', 'worker', process.pid);
    open('roles', owner, worker, cwd);
    state.recordClarify({ taskId: 'roles', from: 'omp', round: 1 });
    const before = state.readTask('roles');
    const e = engine(target('codex', 'intruder'), worker);
    const res = await e[action]({ taskId: 'roles', round: action === 'handleRequest' ? 2 : 1, task: 'inspect', body: 'answer', workingDirectory: cwd, wait: false });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /ROLE_VIOLATION/);
    assert.deepEqual(state.readTask('roles'), before);
  });
}

test('reply and clarify are also restricted to the recorded worker session', async (t) => {
  const cwd = isolated(t);
  const owner = target('claude', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('worker-role', owner, worker, cwd);
  const e = engine(target('omp', 'intruder', process.ppid), owner);
  for (const action of ['handleReply', 'handleClarify']) {
    assert.match(textOf(await e[action]({ taskId: 'worker-role', round: 1, body: 'answer' })), /ROLE_VIOLATION/);
  }
  assert.equal(state.readTask('worker-role').rounds[0].replied, false);
  assert.equal(state.readTask('worker-role').rounds[0].clarifies, 0);
});

test('omp aliases preserve session ownership after session id rotation', async (t) => {
  const cwd = isolated(t);
  const owner = target('omp', 'old', process.pid);
  const worker = target('claude', 'worker');
  open('rotated-role', owner, worker, cwd);
  const resumed = { ...target('omp', 'new', process.pid), sessionAliases: ['old', 'new'] };
  const res = await engine(resumed, worker).handleClose({ taskId: 'rotated-role' });
  assert.equal(res.isError, undefined);
  assert.equal(state.readTask('rotated-role').rounds[0].closeReason, 'abandoned');
});

test('reconciliation debt belongs to the orchestrator session, with harness fallback for unknown identity', (t) => {
  const cwd = isolated(t);
  const worker = target('omp', 'worker', process.pid);
  for (const id of ['a', 'b']) {
    open(id, target('codex', id), worker, cwd);
    state.recordReply({ taskId: id, from: 'omp', round: 1 });
    state.recordExchange(id, { kind: 'reply', from: 'omp', text: id });
  }
  assert.deepEqual(state.unreconciledFor('codex', { cwd, session: target('codex', 'a') }), ['a']);
  assert.deepEqual(state.unreconciledFor('codex', { cwd, session: target('codex', 'b') }), ['b']);
  assert.deepEqual(new Set(state.unreconciledFor('codex', { cwd })), new Set(['a', 'b']));
});

test('reverse request is blocked while a reply is owed; questions and the owed reply still work', async (t) => {
  const cwd = isolated(t);
  const owner = target('claude', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('owed', owner, worker, cwd);
  state.markWaiting('owed', 1);
  const e = engine(worker, owner);
  const res = await e.handleRequest({ taskId: 'reverse', task: 'delegate back', workingDirectory: cwd, wait: false });
  assert.match(textOf(res), /REPLY_FIRST.*owed/);
  assert.equal(state.readTask('reverse'), null);
  const question = await e.handleClarify({ taskId: 'owed', round: 1, body: 'which branch?' });
  assert.equal(question.isError, undefined);
  assert.equal(state.readTask('owed').rounds[0].clarifies, 1);
  const reply = await e.handleReply({ taskId: 'owed', round: 1, body: 'SUMMARY\ndone' });
  assert.equal(reply.isError, undefined);
  assert.equal(state.readTask('owed').rounds[0].replied, true);
  const next = await e.handleRequest({ taskId: 'after-reply', task: 'independent review', workingDirectory: cwd, wait: false });
  assert.equal(next.isError, undefined);
});

test('reply debt does not block a different worker or a different counterparty session', async (t) => {
  const cwd = isolated(t);
  const owner = target('claude', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('owed', owner, worker, cwd);
  const otherWorker = engine(target('omp', 'other', process.ppid), owner);
  assert.equal((await otherWorker.handleRequest({ task: 'separate worker', workingDirectory: cwd, wait: false })).isError, undefined);
  const otherOwner = engine(worker, target('claude', 'other-owner'));
  assert.equal((await otherOwner.handleRequest({ task: 'separate owner', workingDirectory: cwd, wait: false })).isError, undefined);
});

test('failed live delivery restores the prior round and the same round number can be retried', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('retry', owner, worker, cwd);
  state.recordReply({ taskId: 'retry', from: 'omp', round: 1 });
  const before = state.readTask('retry');
  let fail = true;
  const e = engine(owner, worker, { deliverLive: async () => {
    if (fail) throw Object.assign(new Error('gone'), { code: 'NO_LIVE_PEER', dispatchUncertain: false });
    return { via: 'live', target: worker, deliveryStatus: 'queued_unread' };
  } });
  const args = { taskId: 'retry', round: 2, task: 'follow up', workingDirectory: cwd, wait: false, delivery: 'live' };
  assert.match(textOf(await e.handleRequest(args)), /NO_LIVE_PEER/);
  assert.deepEqual(state.readTask('retry'), before);
  assert.equal(state.isWaiting('retry', 2), false);
  fail = false;
  assert.equal((await e.handleRequest(args)).isError, undefined);
  assert.equal(state.readTask('retry').rounds.at(-1).round, 2);
});

test('failed first delivery leaves no task, but a reply racing a dispatch error survives', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker', process.pid);
  const fail = Object.assign(new Error('gone'), { code: 'NO_LIVE_PEER', dispatchUncertain: false });
  const e = engine(owner, worker, { deliverLive: async () => { throw fail; } });
  await e.handleRequest({ taskId: 'never-delivered', task: 'inspect', workingDirectory: cwd, delivery: 'live', wait: true });
  assert.equal(state.readTask('never-delivered'), null);
  assert.equal(state.isWaiting('never-delivered', 1), false);
  const race = engine(owner, worker, { deliverLive: async ({ taskId }) => { state.recordReply({ taskId, from: 'omp', round: 1 }); throw fail; } });
  await race.handleRequest({ taskId: 'race', task: 'inspect', workingDirectory: cwd, delivery: 'live', wait: false });
  assert.equal(state.readTask('race').rounds[0].replied, true);
});

test('a root fork is not mistaken for a helper merely because it records parentSession', (t) => {
  const cwd = isolated(t);
  const file = join(cwd, 'fork.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'session', id: 'fork', parentSession: join(cwd, 'parent.jsonl') }) + '\n');
  const e = extension();
  e.handlers.session_start({}, e.ctx('fork', file));
  assert.equal(e.read().parentSession, null);
  assert.equal(listAgentSessions('omp')[0].sessionId, 'fork');
});

test('Codex reply falls back to the recorded root only when the child has no live route', async (t) => {
  const cwd = isolated(t);
  const { paths } = makeFakeBins(cwd);
  const { env, logFile } = fakeEnv(cwd, { scenario: 'queue-root-fallback' });
  const values = { CODEX_BIN: paths.codex, FAKE_CLI_SCENARIO: env.FAKE_CLI_SCENARIO, FAKE_CLI_LOG: logFile };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const receipt = await deliverTo({ agent: 'codex', id: 'child', rootSessionId: 'root' }, 'SUMMARY\nanswer');
  assert.equal(receipt.threadId, 'root');
  const addresses = () => readCalls(logFile).filter((call) => call.args[0] === 'queue').map((call) => call.args[call.args.indexOf('--thread') + 1]);
  assert.deepEqual(addresses(), ['child', 'root']);
  process.env.FAKE_CLI_SCENARIO = 'queue-partial-failure';
  await assert.rejects(deliverTo({ agent: 'codex', id: 'child', rootSessionId: 'root' }, 'uncertain'));
  assert.deepEqual(addresses(), ['child', 'root', 'child'], 'an unrelated queue failure must not resend to root');
});

test('unconfirmed live dispatch keeps a closed task so its eventual reply can still be filed', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker', process.pid);
  const e = engine(owner, worker, { deliverLive: async () => { throw Object.assign(new Error('receipt missing; do not resend'), { code: 'DELIVERY_UNCONFIRMED' }); } });
  const res = await e.handleRequest({ taskId: 'uncertain', task: 'inspect', delivery: 'live', workingDirectory: cwd, wait: false });
  assert.equal(res.isError, true);
  assert.equal(state.readTask('uncertain').rounds[0].closeCode, 'DELIVERY_UNCONFIRMED');
  state.recordReply({ taskId: 'uncertain', from: 'omp', round: 1, payload: { body: 'eventual answer' } });
  assert.equal(state.takeReply('uncertain', 1).body, 'eventual answer');
});

test('rollback preserves a late reply to an older round while removing only the failed new round', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('late', owner, worker, cwd);
  state.closeRound({ taskId: 'late', round: 1, reason: 'timed_out' });
  const e = engine(owner, worker, { deliverLive: async () => {
    state.recordReply({ taskId: 'late', from: 'omp', round: 1, payload: { body: 'late first answer' } });
    throw Object.assign(new Error('gone'), { code: 'NO_LIVE_PEER', dispatchUncertain: false });
  } });
  await e.handleRequest({ taskId: 'late', round: 2, task: 'inspect again', delivery: 'live', workingDirectory: cwd, wait: false });
  const rec = state.readTask('late');
  assert.deepEqual(rec.rounds.map((r) => [r.round, r.replied]), [[1, true]]);
  assert.equal(state.takeReply('late', 1).body, 'late first answer');
});

test('reply debt permits notes without transferring ownership or spending a round', async (t) => {
  const cwd = isolated(t);
  const owner = target('claude', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('owed-note', owner, worker, cwd);
  const res = await engine(worker, owner).handleNote({ body: 'The branch is unclear; continuing independent work.', workingDirectory: cwd });
  assert.equal(res.isError, undefined);
  assert.deepEqual(state.readTask('owed-note').rounds.map((r) => [r.round, r.replied]), [[1, false]]);
  assert.deepEqual(state.repliesOwedBy('omp').map((r) => r.taskId), ['owed-note']);
});

test('reconciliation admission does not charge another known session of the same harness', async (t) => {
  const cwd = isolated(t);
  const worker = target('omp', 'worker', process.pid);
  for (let i = 0; i < 4; i++) {
    const taskId = `debt-${i}`;
    open(taskId, target('codex', 'owner'), worker, cwd);
    state.recordReply({ taskId, from: 'omp', round: 1 });
    state.recordExchange(taskId, { kind: 'reply', from: 'omp', text: 'answer' });
  }
  const args = { task: 'inspect', workingDirectory: cwd, wait: false };
  assert.match(textOf(await engine(target('codex', 'owner'), worker).handleRequest(args)), /RECONCILE_FIRST/);
  assert.equal((await engine(target('codex', 'other'), worker).handleRequest(args)).isError, undefined);
});

test('the recorded orchestrator session can answer a clarification without opening another round', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker', process.pid);
  open('answer-question', owner, worker, cwd);
  const questionId = state.recordClarify({ taskId: 'answer-question', from: 'omp', round: 1 });
  const e = engine(owner, worker, { deliverLive: async () => {
    state.recordReply({ taskId: 'answer-question', from: 'omp', round: 1, payload: { body: 'SUMMARY\nClarified boundary verified.' } });
    return { via: 'live' };
  } });
  const res = await e.handleClarifyAnswer({ taskId: 'answer-question', questionId, round: 1, body: 'Use main.', timeoutMs: 1000, workingDirectory: cwd });
  assert.equal(res.isError, undefined);
  assert.ok(state.listQuestions('answer-question').every((q) => q.answeredAt), 'the owner session answered the question');
  assert.deepEqual(state.readTask('answer-question').rounds.map((r) => [r.round, r.replied, r.clarifies]), [[1, true, 1]]);
});

test('model-only from is never verified for any harness', async (t) => {
  isolated(t);
  for (const agent of ['claude', 'codex', 'omp']) {
    const origin = await resolveOrigin(agent, { from: '11111111-2222-3333-4444-555555555555' });
    assert.equal(origin.identityVerified, false);
    assert.equal(origin.target.identityVerified, false);
    assert.equal(origin.identitySource, 'model_claim');
  }
});

test('a Claude parent registry without a socket identifies the caller but is not a deliverable peer', async (t) => {
  isolated(t);
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'no-socket' }));
  const origin = await resolveOrigin('claude');
  assert.equal(origin.target.sessionId, 'no-socket');
  assert.equal(origin.identitySource, 'pid_registry');
  await assert.rejects(deliverTo(origin.target, 'reply'), { code: 'NO_REPLY_ROUTE' });
});

// omp rebinds the extension's factory into a task subagent's own runtime in
// the same process: a second copy with its own closure. It must stay passive:
// never register over the parent, never drain the parent's frames, never
// unregister it (2026-10-08: a copy did all three, and the parent's replies
// were refused ROLE_VIOLATION).
test("a task subagent's own copy of the extension leaves the parent's registry row and frames alone", async (t) => {
  const cwd = isolated(t);
  const root = join(cwd, 'root.jsonl');
  writeFileSync(root, JSON.stringify({ type: 'session', id: 'root' }) + '\n');
  mkdirSync(join(cwd, 'root'));
  const child = join(cwd, 'root', 'Helper.jsonl');
  writeFileSync(child, JSON.stringify({ type: 'session', id: 'helper-sub', parentSession: root }) + '\n');
  const parentCopy = extension();
  parentCopy.handlers.session_start({}, parentCopy.ctx('root', root));
  assert.equal(parentCopy.read().sessionId, 'root');
  const childCopy = extension();
  childCopy.handlers.session_start({}, childCopy.ctx('helper-sub', child));
  assert.equal(childCopy.read().sessionId, 'root', 'the subagent copy does not register over its parent');
  childCopy.handlers.agent_start?.({}, childCopy.ctx('helper-sub', child));
  assert.equal(childCopy.read().sessionId, 'root');
  childCopy.handlers.session_shutdown({}, childCopy.ctx('helper-sub', child));
  assert.notEqual(parentCopy.read(), null, 'the subagent copy does not unregister its parent');
  assert.equal(parentCopy.read().sessionId, 'root');
});
