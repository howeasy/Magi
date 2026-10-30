import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { makeWorkspace, textOf } from './helpers/harness.mjs';
import magi from '../omp/magi-omp-extension.js';
import { processStartedAt } from '../omp/process-identity.js';
import { listAgentSessions, deliverTo, deliverToAgentInbox, postToClaude, appToolSend } from '../src/transport.mjs';
import { makeEngine } from '../src/peer.mjs';
import * as state from '../src/state.mjs';
import { getRecord, setRecord, statement } from '../src/store.mjs';

function isolated(t) {
  const cwd = makeWorkspace('identity round fixes');
  const values = { MAGI_HOME: join(cwd, 'home'), CLAUDE_CONFIG_DIR: join(cwd, 'claude'), CODEX_HOME: join(cwd, 'codex'), CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return cwd;
}
function row(pid, fields = {}) {
  setRecord(process.env.MAGI_HOME, 'agents', String(pid), { agent: 'omp', pid, processStartedAt: processStartedAt(pid), sessionId: 'current', cwd: process.env.MAGI_HOME, ...fields });
  return String(pid);
}
function target(agent, id, pid) { return { agent, id, sessionId: id, ...(pid ? { pid } : {}) }; }
function engine(caller, worker, extra = {}) {
  return makeEngine({ orchestrator: caller.agent, peerName: worker.agent, replyTool: 'peer_tool',
    resolveOrigin: async () => ({ target: caller, identityVerified: true, identitySource: 'test_runtime' }),
    pickDelivery: async () => ({ mode: 'live', target: worker }),
    deliverLive: async () => ({ via: 'live', target: worker, deliveryStatus: 'queued_unread' }),
    deliverReply: async () => {}, ...extra });
}
function open(taskId, owner, worker, cwd) {
  state.openRound({ taskId, orchestrator: owner.agent, peer: worker.agent, orchestratorTarget: owner, round: 1, maxRounds: 3, cwd });
  state.setPeerTarget(taskId, worker, 1);
}

test('resumed omp delivery follows its stable id or alias rather than its stale pid', async (t) => {
  isolated(t);
  row(process.pid, { sessionId: 'resumed', sessionAliases: ['original', 'resumed'] });
  for (const id of ['resumed', 'original']) {
    const receipt = await deliverTo(target('omp', id, 999999), `reply to ${id}`);
    const frame = JSON.parse(statement(process.env.MAGI_HOME, 'SELECT body FROM frames WHERE id=?').get(receipt.messageId).body);
    assert.equal(receipt.pid, process.pid);
  }
  await assert.rejects(deliverTo(target('omp', 'unrelated', process.pid), 'must not land'), { code: 'NO_REPLY_ROUTE' });
  const pidOnly = await deliverTo({ agent: 'omp', pid: process.pid, id: String(process.pid) }, 'pid-only route');
  assert.match(JSON.parse(statement(process.env.MAGI_HOME, 'SELECT body FROM frames WHERE id=?').get(pidOnly.messageId).body).text, /^pid-only route/);
  await assert.rejects(deliverTo({ agent: 'omp', pid: process.pid, processStartedAt: 'recycled' }, 'must not land'), { code: 'NO_REPLY_ROUTE' });
});

test('omp ownership survives a changed pid but never equates unrelated sessions by pid alone', async (t) => {
  const cwd = isolated(t);
  const owner = target('omp', 'original', 999999);
  const worker = target('claude', 'worker');
  open('resume-owner', owner, worker, cwd);
  const resumed = { ...target('omp', 'resumed', process.pid), sessionAliases: ['original', 'resumed'] };
  assert.equal(state.sameSession(owner, resumed), true);
  assert.equal(state.sameSession(resumed, { ...resumed, id: 'intruder', sessionId: 'intruder', sessionAliases: [] }), false);
  assert.equal(state.sameSession({ agent: 'omp', pid: process.pid, processStartedAt: 'old' }, { agent: 'omp', pid: process.pid, processStartedAt: 'new' }), false);
  assert.equal((await engine(resumed, worker).handleClose({ taskId: 'resume-owner' })).isError, undefined);
  assert.equal(state.readTask('resume-owner').rounds[0].closeReason, 'abandoned');
});

test('late replies and clarifications use the worker recorded for their own round', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const a = target('omp', 'worker-a', 101);
  const b = target('omp', 'worker-b', 102);
  open('late-workers', owner, a, cwd);
  state.closeRound({ taskId: 'late-workers', round: 1, reason: 'timed_out' });
  const sent = await engine(owner, b).handleRequest({ taskId: 'late-workers', peer: 'worker-b', task: 'second inspection', workingDirectory: cwd, wait: false, delivery: 'live' });
  assert.equal(sent.isError, undefined, textOf(sent));
  const rec = state.readTask('late-workers');
  assert.equal(rec.rounds[0].peerTarget.id, 'worker-a');
  assert.equal(rec.rounds[1].peerTarget.id, 'worker-b');
  for (const action of ['handleReply', 'handleClarify']) {
    assert.match(textOf(await engine(b, owner)[action]({ taskId: 'late-workers', round: 1, body: 'wrong worker' })), /ROLE_VIOLATION/);
    assert.match(textOf(await engine(a, owner)[action]({ taskId: 'late-workers', round: 2, body: 'wrong round' })), /ROLE_VIOLATION/);
  }
  const reply = await engine(a, owner).handleReply({ taskId: 'late-workers', round: 1, body: 'SUMMARY\nlate first answer' });
  assert.equal(reply.isError, undefined, textOf(reply));
  assert.equal(state.readTask('late-workers').rounds[0].replied, true);
  assert.equal(state.readTask('late-workers').rounds[1].replied, false);
  const question = await engine(b, owner).handleClarify({ taskId: 'late-workers', round: 2, body: 'which boundary?' });
  assert.equal(question.isError, undefined, textOf(question));
  assert.equal(state.readTask('late-workers').rounds[1].clarifies, 1);
});

for (const code of ['DELIVERY_FAILED', 'DELIVERY_TIMEOUT', 'STEER_FAILED', 'STEER_TIMEOUT']) {
  test(`${code} retains a possibly dispatched round and accepts its eventual reply`, async (t) => {
    const cwd = isolated(t);
    const owner = target('codex', 'owner');
    const worker = target('omp', 'worker');
    const e = engine(owner, worker, { deliverLive: async () => { throw Object.assign(new Error('receipt lost'), { code, dispatchUncertain: true, fallback: true }); }, deliverHeadless: () => assert.fail('uncertain dispatch must not start a second worker') });
    const res = await e.handleRequest({ taskId: code, task: 'inspect', workingDirectory: cwd, wait: false });
    assert.equal(res.isError, true);
    assert.equal(state.readTask(code).rounds[0].closeCode, code);
    assert.equal((await engine(worker, owner).handleReply({ taskId: code, body: 'SUMMARY\nanswer after lost receipt' })).isError, undefined);
    assert.equal(state.readTask(code).rounds[0].replied, true);
  });
}

test('only definite predispatch errors release a live round for retry', async (t) => {
  const cwd = isolated(t);
  const owner = target('codex', 'owner');
  const worker = target('omp', 'worker');
  for (const certainty of [false, undefined]) {
    const taskId = certainty === false ? 'definite' : 'unknown';
    const e = engine(owner, worker, { deliverLive: async () => { throw Object.assign(new Error('failed'), { code: 'DELIVERY_FAILED', dispatchUncertain: certainty, fallback: certainty === undefined }); }, deliverHeadless: () => assert.fail('unknown dispatch must not start a second worker') });
    await e.handleRequest({ taskId, task: 'inspect', workingDirectory: cwd, wait: false });
    if (certainty === false) assert.equal(state.readTask(taskId), null);
    else assert.equal(state.readTask(taskId).rounds[0].closeCode, 'DELIVERY_FAILED');
  }
});

test('registry rejects a recycled live pid and a legacy row without a birth marker', async (t) => {
  isolated(t);
  const birth = processStartedAt(process.pid);
  assert.equal(typeof birth, 'string', 'the OS must expose this live process birth marker');
  const path = row(process.pid, { processStartedAt: `${birth}:different-process` });
  assert.deepEqual(listAgentSessions('omp'), []);
  assert.equal(getRecord(process.env.MAGI_HOME, 'agents', path), null);
  row(process.pid, { processStartedAt: null });
  assert.deepEqual(listAgentSessions('omp'), []);
  row(process.pid);
  const live = listAgentSessions('omp')[0];
  assert.equal(live.processStartedAt, birth);
  assert.throws(() => deliverToAgentInbox({ target: { ...live, processStartedAt: `${birth}:different-process` }, text: 'must not land' }), { code: 'NO_LIVE_PEER' });
  assert.deepEqual(statement(process.env.MAGI_HOME, 'SELECT id FROM frames').all(), []);
});

test('ancestry queries are cached while advertised transcript titles and registry contents stay fresh', async (t) => {
  const cwd = isolated(t);
  const file = join(cwd, 'session.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'title_change', title: 'Transcript title' }) + '\n');
  row(process.pid, { name: null, sessionFile: file });
  const transport = new URL('../src/transport.mjs', import.meta.url).href;
  const adapter = new URL('../src/omp-adapter.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import {writeFileSync} from 'node:fs';
    import {resolveOrigin} from ${JSON.stringify(transport)};
    import {setRecord} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    import {adapter} from ${JSON.stringify(adapter)};
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const run = childProcess.execFileSync;
    let ancestryQueries = 0;
    childProcess.execFileSync = function(binary, args, options) {
      if (args.includes('ppid=') || args.some((arg) => arg.includes('Get-CimInstance Win32_Process'))) ancestryQueries++;
      return run(binary, args, options);
    };
    syncBuiltinESMExports();
    const listed = (await adapter.sessions())[0];
    assert.equal(listed.name, 'Transcript title');
    assert.equal((await resolveOrigin('omp', {from: listed.name})).identityVerified, true);
    const initialQueries = ancestryQueries;
    assert.ok(initialQueries > 0, 'the wrapper chain must exercise ancestry discovery');
    await assert.rejects(resolveOrigin('omp', {from: 'contradiction'}), {code: 'ORIGIN_MISMATCH'});
    writeFileSync(${JSON.stringify(file)}, JSON.stringify({type: 'title_change', title: 'Updated transcript title'}) + '\\n');
    const updated = (await adapter.sessions())[0];
    assert.equal(updated.name, 'Updated transcript title');
    assert.equal((await resolveOrigin('omp', {from: updated.name})).target.name, 'Updated transcript title');
    setRecord(process.env.MAGI_HOME, 'agents', ${JSON.stringify(String(process.pid))}, {...listed, sessionId: 'rotated', sessionAliases: ['current', 'rotated'], name: 'Registry title'});
    const fresh = await resolveOrigin('omp', {from: 'Registry title'});
    assert.equal(fresh.target.sessionId, 'rotated');
    assert.equal(fresh.target.name, 'Registry title');
    assert.equal(ancestryQueries, initialQueries, 'later calls must not query process ancestry again');
    console.log('title accepted; contradictory from refused; registry refreshed');
  `;
  // Two wrappers force the cached ancestry path rather than the direct parent.
  const wrapper = `const {execFileSync}=require('node:child_process'); process.stdout.write(execFileSync(process.execPath,['--input-type=module','-e',${JSON.stringify(source)}],{encoding:'utf8'}));`;
  assert.match(execFileSync(process.execPath, ['-e', wrapper], { encoding: 'utf8', timeout: 30000 }), /title accepted; contradictory from refused; registry refreshed/);
});

for (const disposer of [true, false]) {
  test(`shutdown cancels ${disposer ? 'disposer' : 'timer'} polling and stale events cannot recreate the row`, (t) => {
    isolated(t);
    const handlers = {};
    let tick;
    let cancelled = false;
    const handle = {};
    const ctx = { cwd: process.env.MAGI_HOME, isIdle: () => true, sessionManager: { getSessionId: () => 'root' }, setInterval: (fn) => { tick = fn; return disposer ? () => { cancelled = true; } : handle; }, clearInterval: (timer) => { assert.equal(timer, handle); cancelled = true; } };
    magi({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage: () => assert.fail('shutdown cannot deliver'), logger: { warn() {} } });
    handlers.session_start({}, ctx);
    const key = String(process.pid);
    assert.equal(getRecord(process.env.MAGI_HOME, 'agents', key).processStartedAt, processStartedAt(process.pid));
    handlers.session_shutdown({}, ctx);
    assert.equal(cancelled, true);
    tick();
    handlers.agent_end({}, ctx);
    handlers.session_switch({}, ctx);
    assert.equal(getRecord(process.env.MAGI_HOME, 'agents', key), null);
  });
}

test('Claude connection refusal is definite but a timeout after the frame is read is uncertain', async (t) => {
  isolated(t);
  await assert.rejects(postToClaude({ socket: join(process.env.MAGI_HOME, 'missing-inbox'), text: 'not sent' }), { code: 'DELIVERY_FAILED', dispatchUncertain: false });
  const server = net.createServer({ allowHalfOpen: true });
  const sockets = new Set();
  let observed;
  const frameRead = new Promise((resolve) => { observed = resolve; });
  server.on('connection', (socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      if (buffer.includes('\n')) observed(JSON.parse(buffer.split('\n')[0]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = postToClaude({ socket: { host: '127.0.0.1', port: server.address().port }, text: 'possibly landed' });
  const rejected = assert.rejects(pending, { code: 'DELIVERY_TIMEOUT', dispatchUncertain: true });
  assert.equal((await frameRead).message.content, 'possibly landed');
  t.mock.timers.tick(15000);
  await rejected;
});

test('steer failures are definite during initialization and uncertain after tools/call', async (t) => {
  const cwd = isolated(t);
  for (const phase of ['initialize', 'tools/call']) {
    const dir = join(cwd, phase === 'initialize' ? 'init' : 'call');
    mkdirSync(dir);
    writeFileSync(join(dir, 'server.mjs'), `
      let buffer = '';
      process.stdin.on('data', (data) => {
        buffer += data;
        const lines = buffer.split('\\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.method === ${JSON.stringify(phase)}) process.exit(1);
          if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');
        }
      });
    `);
    await assert.rejects(appToolSend({ node: process.execPath, cwd: dir, pipe: 'unused' }, { threadId: 't', prompt: 'inspect' }, {}, { timeoutMs: 2000 }), { code: 'STEER_FAILED', dispatchUncertain: phase === 'tools/call' });
  }
});
