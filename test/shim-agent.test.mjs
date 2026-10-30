// A harness that is neither Claude nor Codex orchestrates under its own name
// and is answered through database frames its own extension polls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf, initGitRepo, ROOT } from './helpers/harness.mjs';
import { getRecord, setRecord, statement } from '../src/store.mjs';
import * as state from '../src/state.mjs';

import { processStartedAt } from '../omp/process-identity.js';
const CLI = join(ROOT, 'bin', 'magi.mjs');

// The test process stands in for the omp session: the MCP server it spawns
// sees it as the parent pid, exactly as it would see omp.
function registerSelfAs(home, agent, extra = {}) {
  const rec = { agent, pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'omp-sess-1', name: 'omp-main', cwd: process.cwd(), startedAt: Date.now(), ...extra };
  setRecord(home, 'agents', String(process.pid), rec);
  return rec;
}

test('omp orchestrates a headless Claude review under its own name', async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws);
  registerSelfAs(env.MAGI_HOME, 'omp');

  const s = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude, MAGI_AS: 'omp' } });
  let res;
  try {
    res = await s.call('claude_peer', { wait: true, task: 'Review the change', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, diffRef: 'HEAD~1..HEAD' });
    assert.equal(res.isError, undefined, textOf(res));
  } finally {
    await s.close();
  }
  const { stdin } = readCalls(logFile)[0];
  assert.match(stdin, /orchestrator=omp name="omp-main" id=omp-sess-1/);
  assert.match(stdin, /omp is the ORCHESTRATOR/);
  const rec = getRecord(env.MAGI_HOME, 'tasks', res.structuredContent.taskId);
  assert.equal(rec.orchestrator, 'omp');
  assert.equal(rec.peer, 'claude');
  assert.equal(rec.orchestratorTarget.pid, process.pid);
  assert.equal(rec.replyTo, `omp:${process.pid}`);
});

test('a live Claude peer replying to omp lands in the omp inbox, and a dead omp keeps the mailbox', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws);
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;
  process.env.MAGI_HOME = home;
  registerSelfAs(home, 'omp');

  // Seed a task omp opened with wait:false, as the ledger would record it.
  const task = {
    taskId: 'cx-omp1', orchestrator: 'omp', peer: 'claude', mode: 'DELEGATE', maxRounds: 2,
    replyTo: `omp:${process.pid}`,
    orchestratorTarget: { agent: 'omp', pid: process.pid, sessionId: 'omp-sess-1', name: 'omp-main', cwd: ws, id: 'omp-sess-1' },
    cwd: ws, rounds: [{ round: 1, openedAt: Date.now(), replied: false, clarifies: 0 }],
  };
  setRecord(home, 'tasks', task.taskId, task);

  // Claude answers through its own server, whose reply route reads the ledger.
  const claude = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  try {
    const res = await claude.call('codex_peer', { kind: 'reply', taskId: 'cx-omp1', body: 'SUMMARY\ndone\n' });
    assert.equal(res.isError, undefined, textOf(res));
    assert.match(textOf(res), /Reply sent to omp/);
  } finally {
    await claude.close();
  }
  const frames = statement(home, 'SELECT body FROM frames WHERE to_pid=?').all(process.pid);
  assert.equal(frames.length, 1, 'exactly one frame for the omp session');
  const frame = JSON.parse(frames[0].body);
  assert.match(frame.text, /^PEER REPLY magi\/1 task_id=cx-omp1 round=1 from=claude/);
  assert.equal(frame.deliverAs, 'aside');
  assert.equal(frame.from.agent, 'claude');
  // The mailbox keeps a durable copy after out-of-band delivery, as it does
  // for Claude and Codex; `magi mail` shows it and sweep retains it.
  assert.equal(state.listMail('cx-omp1').some((reply) => reply.round === 1), true);

  // Same again with the omp session gone: the reply is retained, not lost.
  setRecord(home, 'tasks', 'cx-omp2', { ...task, taskId: 'cx-omp2', orchestratorTarget: { ...task.orchestratorTarget, pid: 999999, id: 'gone-session', sessionId: 'gone-session' }, replyTo: 'omp:999999' });
  const again = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  try {
    const res = await again.call('codex_peer', { kind: 'reply', taskId: 'cx-omp2', body: 'SUMMARY\nlate\n' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /NO_REPLY_ROUTE.*left in the mailbox/);
  } finally {
    await again.close();
  }
  assert.equal(state.listMail('cx-omp2').some((reply) => reply.round === 1), true);
});

test('the omp extension registers the session and turns inbox frames into user turns', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const { default: magi } = await import(pathToFileURL(join(ROOT, 'omp', 'magi-omp-extension.js')).href);

  const handlers = {};
  const sent = [];
  let tick = null;
  const pi = {
    on: (event, fn) => { handlers[event] = fn; },
    sendUserMessage: (text, opts) => sent.push([text, opts]),
    logger: { warn: () => {} },
  };
  let idle = true;
  const ctx = {
    cwd: 'E:/repo',
    isIdle: () => idle,
    sessionManager: { getSessionId: () => 'sess-42', getSessionName: () => 'main' },
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
  };
  magi(pi);
  await handlers.session_start({ type: 'session_start' }, ctx);

  const reg = getRecord(home, 'agents', String(process.pid));
  assert.deepEqual([reg.agent, reg.pid, reg.sessionId, reg.name, reg.cwd], ['omp', process.pid, 'sess-42', 'main', 'E:/repo']);

  const { deliverToAgentInbox, listAgentSessions } = await import('../src/transport.mjs');
  assert.equal(listAgentSessions('omp').length, 1);
  const target = listAgentSessions('omp')[0];

  deliverToAgentInbox({ target, text: 'PEER NOTE magi/1 from=claude\n\nhello', sender: { agent: 'claude', name: 'c1' } });
  await tick();
  assert.deepEqual(sent, [['PEER NOTE magi/1 from=claude\n\nhello', undefined]], 'idle: a plain prompt starts a turn');

  idle = false;
  deliverToAgentInbox({ target, text: 'busy note' });
  deliverToAgentInbox({ target, text: 'urgent', deliverAs: 'steer' });
  await tick();
  assert.deepEqual(sent.slice(1).map((x) => x[1]), [{ deliverAs: 'aside' }, { deliverAs: 'steer' }]);

  // Malformed input is quarantined once, never retried on every poll.
  statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)").run(process.pid, 'zz', '{"text": "trunc', Date.now());
  await tick();
  await tick();
  assert.equal(sent.length, 3);
  assert.equal(statement(home, 'SELECT state FROM frames WHERE id=?').get('zz').state, 'failed');

  await handlers.session_shutdown({ type: 'session_shutdown' }, ctx);
  assert.equal(getRecord(home, 'agents', String(process.pid)), null);
  assert.equal(listAgentSessions('omp').length, 0);
});

test('--as is validated and a dead registry entry is swept on read', async () => {
  const { selfName } = await import('../src/peer.mjs');
  process.env.MAGI_AS = 'omp';
  assert.equal(selfName('codex', 'claude'), 'omp');
  process.env.MAGI_AS = 'claude';
  assert.throws(() => selfName('codex', 'claude'), /cannot consult itself/);
  process.env.MAGI_AS = 'Not Valid';
  assert.throws(() => selfName('codex', 'claude'), /short lowercase identifier/);
  delete process.env.MAGI_AS;
  assert.equal(selfName('codex', 'claude'), 'codex');

  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  setRecord(home, 'agents', '999999', { agent: 'omp', pid: 999999 });
  const { listAgentSessions } = await import('../src/transport.mjs');
  assert.equal(listAgentSessions('omp').length, 0);
  assert.equal(getRecord(home, 'agents', '999999'), null);
});

test('install merges the omp servers into mcp.json without touching other entries, and uninstall removes only them', async () => {
  const { withOmpServers, withoutOmpServers } = await import('../src/install.mjs');
  const before = JSON.stringify({ mcpServers: { kalshi: { type: 'stdio', command: 'uv' } }, other: true });
  const merged = JSON.parse(withOmpServers(before, { cli: 'C:/x/magi.mjs', bins: { CLAUDE_BIN: 'C:/c.exe', CODEX_BIN: null, OMP_BIN: 'C:/omp.exe' } }));
  assert.deepEqual(merged.mcpServers.kalshi, { type: 'stdio', command: 'uv' });
  assert.equal(merged.other, true);
  for (const name of ['magi', 'magi-codex', 'magi-omp']) {
    assert.equal(merged.mcpServers[name].timeout, 0, 'blocking reviews must outlive the default MCP timeout');
    assert.equal(merged.mcpServers[name].env.OMP_BIN, 'C:/omp.exe');
    assert.equal('CODEX_BIN' in merged.mcpServers[name].env, false);
  }
  assert.equal(JSON.parse(withOmpServers('', { cli: 'x', bins: {} })).mcpServers.magi.env, undefined);
  // A key someone else set survives the rebuild; the pins install owns do not.
  const set = JSON.stringify({ mcpServers: { 'magi-omp': { command: 'node', env: { MAGI_WORKER_WRAPPER: '["n","w"]', OMP_BIN: 'C:/stale.exe' } } } });
  assert.deepEqual(JSON.parse(withOmpServers(set, { cli: 'x', bins: { OMP_BIN: 'C:/omp.exe' } })).mcpServers['magi-omp'].env, { OMP_BIN: 'C:/omp.exe', MAGI_WORKER_WRAPPER: '["n","w"]' });
  assert.throws(() => withOmpServers('{not json', { cli: 'x', bins: {} }), /not valid JSON/);
  const removed = JSON.parse(withoutOmpServers(JSON.stringify(merged)));
  assert.deepEqual(Object.keys(removed.mcpServers), ['kalshi']);

  // The CLI flag reaches the server: serving Claude "as" Claude is refused at startup.
  const r = spawnSync(process.execPath, [CLI, 'serve', 'claude', '--as', 'claude'], { encoding: 'utf-8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot consult itself/);
});

test('sweep removes the inbox of a process that is gone and keeps a live one', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const { sweep } = await import('../src/state.mjs');
  for (const pid of [999999, process.pid]) statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)").run(pid, String(pid), '{}', Date.now());
  await sweep();
  assert.equal(statement(home, 'SELECT id FROM frames WHERE to_pid=?').get(999999), undefined);
  assert.equal(statement(home, 'SELECT id FROM frames WHERE to_pid=?').get(process.pid).id, String(process.pid));
});

test('an omp sender carries its real permission class into the Claude envelope: yolo is bypass, the rest prompting, unknown unasserted', async () => {
  const { approvalToClass, ompPermissionClass, ompConfiguredApprovalMode } = await import('../src/omp-launch.mjs');
  assert.equal(approvalToClass('yolo'), 'bypass');
  assert.equal(approvalToClass('write'), 'prompting');
  assert.equal(approvalToClass('always-ask'), 'prompting');
  assert.equal(approvalToClass('always-ask-cached'), 'prompting', 'omp 18.14.0 added it; it prompts for every call until a grant is remembered');
  assert.equal(approvalToClass(null), null);  // A per-session override recorded by the extension wins over the configured default.
  assert.equal(await ompPermissionClass({ approvalMode: 'always-ask' }, async () => 'yolo'), 'prompting');
  // Otherwise omp's own answer, first line only, cached.
  let asked = 0;
  const q = async () => { asked++; return 'yolo\n'; };
  assert.equal(await ompPermissionClass({}, q), 'bypass');
  assert.equal(await ompConfiguredApprovalMode(q), 'yolo');
  assert.equal(asked, 1, 'the configured mode is cached');
});

// Seen live (omp 18.1.19, 2026-09-17): a review that used the task tool left
// the registry pointing at the subagent's session; the orchestrator's next
// request to the parent's id got NO_LIVE_PEER.
test('a subagent session inside the same omp process does not replace the parent in the registry', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const { default: magi } = await import(pathToFileURL(join(ROOT, 'omp', 'magi-omp-extension.js')).href + '?' + Math.random());
  const handlers = {};
  const pi = { on: (event, fn) => { handlers[event] = fn; }, sendUserMessage: () => {}, logger: { warn: () => {} } };
  const parent = 'C:\\u\\sessions\\2026-09-16T23-08-21-705Z_parent-id.jsonl';
  const ctxFor = (id, file) => ({ cwd: 'E:/repo', isIdle: () => true, sessionManager: { getSessionId: () => id, getSessionFile: () => file }, setInterval: () => ({ unref() {} }) });
  magi(pi);
  await handlers.session_start({ type: 'session_start' }, ctxFor('parent-id', parent));
  await handlers.session_start({ type: 'session_start' }, ctxFor('sub-id', 'C:\\u\\sessions\\2026-09-16T23-08-21-705Z_parent-id\\BagOracleV34.jsonl'));
  await handlers.session_switch({ type: 'session_switch' }, ctxFor('sub-id', 'C:\\u\\sessions\\2026-09-16T23-08-21-705Z_parent-id\\Scout2.jsonl'));
  const read = () => getRecord(home, 'agents', String(process.pid));
  assert.equal(read().sessionId, 'parent-id');
  assert.equal(read().sessionFile, parent);
  // A real switch to another session is still a new identity.
  await handlers.session_switch({ type: 'session_switch' }, ctxFor('other-id', 'C:\\u\\sessions\\2026-09-17T01-00-00-000Z_other-id.jsonl'));
  assert.equal(read().sessionId, 'other-id');
  await handlers.session_shutdown({ type: 'session_shutdown' }, ctxFor('other-id', null));
});

test('the omp extension records a command-line approval mode, or nothing', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const { default: magi } = await import(pathToFileURL(join(ROOT, 'omp', 'magi-omp-extension.js')).href + '?' + Math.random());
  const savedArgv = process.argv;
  const register = async (argv) => {
    process.argv = argv;
    const handlers = {};
    magi({ on: (e, fn) => { handlers[e] = fn; }, sendUserMessage() {}, logger: { warn() {} } });
    await handlers.session_start({}, { cwd: 'E:/r', isIdle: () => true, sessionManager: { getSessionId: () => 's' }, setInterval: () => ({}) });
    return getRecord(home, 'agents', String(process.pid)).approvalMode;
  };
  try {
    assert.equal(await register(['bun', 'omp', '--approval-mode', 'write']), 'write');
    assert.equal(await register(['bun', 'omp', '--approval-mode=always-ask']), 'always-ask');
    assert.equal(await register(['bun', 'omp', '--approval-mode', 'always-ask-cached']), 'always-ask-cached');
    assert.equal(await register(['bun', 'omp', '--auto-approve']), 'yolo');
    assert.equal(await register(['bun', 'omp', '--approval-mode', 'bogus']), null);
    assert.equal(await register(['bun', 'omp']), null);
  } finally {
    process.argv = savedArgv;
  }
});

test('an omp session waiting on a tool approval reads as blocked, and a steer to it goes as an aside', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const { default: magi } = await import(pathToFileURL(join(ROOT, 'omp', 'magi-omp-extension.js')).href);
  const handlers = {};
  const sent = [];
  let tick = null;
  magi({ on: (event, fn) => { handlers[event] = fn; }, sendUserMessage: (text, opts) => sent.push([text, opts]), logger: { warn: () => {} } });
  const ctx = {
    cwd: 'E:/repo',
    isIdle: () => false,
    sessionManager: { getSessionId: () => 'sess-77', getSessionName: () => 'main' },
    setInterval: (fn) => { tick = fn; return { unref() {} }; },
  };
  await handlers.session_start({ type: 'session_start' }, ctx);
  await handlers.agent_start({ type: 'agent_start' }, ctx);
  const { deliverToAgentInbox, listAgentSessions } = await import('../src/transport.mjs');
  const { peerState, describeState } = await import('../src/serve.mjs');

  handlers.tool_approval_requested({ sessionId: 'sess-77', toolCallId: 't1', toolName: 'bash', approvalMode: 'write' }, ctx);
  let row = listAgentSessions('omp')[0];
  assert.equal(row.waitingFor, 'approval of bash');
  assert.equal(row.approvalMode, 'write', 'the mode the session reports, over the command line');
  assert.equal(describeState(peerState(row)), 'blocked: approval of bash');

  deliverToAgentInbox({ target: row, text: 'urgent', deliverAs: 'steer' });
  await tick();
  assert.deepEqual(sent.map((x) => x[1]), [{ deliverAs: 'aside' }], 'a steer would deny the pending call');

  // Another call's approval is not this one's; once both are answered it is working again.
  handlers.tool_approval_requested({ sessionId: 'sess-77', toolCallId: 't2', toolName: 'edit' }, ctx);
  handlers.tool_approval_resolved({ sessionId: 'sess-77', toolCallId: 't1', toolName: 'bash', approved: true }, ctx);
  assert.equal(listAgentSessions('omp')[0].waitingFor, 'approval of edit');
  handlers.tool_approval_resolved({ sessionId: 'sess-77', toolCallId: 't2', toolName: 'edit', approved: false }, ctx);
  row = listAgentSessions('omp')[0];
  assert.equal(row.waitingFor, null);
  assert.equal(peerState(row).state, 'working');

  deliverToAgentInbox({ target: row, text: 'urgent again', deliverAs: 'steer' });
  await tick();
  assert.deepEqual(sent.at(-1)[1], { deliverAs: 'steer' }, 'not blocked: a steer is a steer');

  // An event naming another session is not this one's, even with this context.
  handlers.tool_approval_requested({ sessionId: 'sess-77', toolCallId: 'shared', toolName: 'bash' }, ctx);
  handlers.tool_approval_resolved({ sessionId: 'other-session', toolCallId: 'shared', toolName: 'bash', approved: true }, ctx);
  assert.equal(listAgentSessions('omp')[0].waitingFor, 'approval of bash', 'still pending: another session cannot resolve it');
  // A switch to another session drops what the last one waited on.
  let id = 'sess-77';
  const switched = { ...ctx, sessionManager: { getSessionId: () => id, getSessionName: () => 'main' } };
  id = 'sess-78';
  await handlers.session_switch({ type: 'session_switch' }, switched);
  row = listAgentSessions('omp')[0];
  assert.equal(row.sessionId, 'sess-78');
  assert.equal(row.waitingFor, null);
  assert.ok(Date.now() - row.statusAt < 5000, 'its clock starts at the switch, not the last session\'s change');
  await handlers.session_shutdown({ type: 'session_shutdown' }, switched);
});
