import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, startServer, ROOT } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import * as state from '../src/state.mjs';
import { resolveOrigin } from '../src/transport.mjs';
import { getRecord } from '../src/store.mjs';

function workspace() {
  const ws = makeWorkspace('peer reconciliation');
  process.env.MAGI_HOME = join(ws, 'state');
  return ws;
}

test('timed-out round closes and its late reply cannot complete a newer round', async () => {
  const ws = workspace();
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    pickDelivery: async () => ({ mode: 'live', target: 'claude' }),
    deliverLive: async () => ({ via: 'live', target: 'claude' }),
  });
  const response = await engine.handleRequest({ taskId: 'timeout', task: 'audit', mode: 'DEBATE', workingDirectory: ws, timeoutMs: 20 });
  assert.equal(response.structuredContent.timedOut, true);
  const closed = state.readTask('timeout').rounds[0];
  assert.equal(closed.closeReason, 'timed_out');
  // How long it waited is the diagnosis: a caller's short limit and the default
  // close identically without it.
  assert.equal(closed.closeCode, 'NO_REPLY');
  assert.match(closed.closeDetail, /^waited \d+s via live; no reply arrived$/);
  state.openRound({ taskId: 'timeout', orchestrator: 'codex', peer: 'claude', mode: 'DEBATE', round: 2 });
  state.recordReply({ taskId: 'timeout', from: 'claude', round: 1, payload: { body: 'late round one' } });
  assert.equal(state.takeReply('timeout', 2), null);
  assert.equal(state.readTask('timeout').rounds[1].replied, false);
  state.recordReply({ taskId: 'timeout', from: 'claude', round: 2, payload: { body: 'round two' } });
  assert.equal(state.takeReply('timeout', 2).body, 'round two');
  assert.equal(state.takeReply('timeout', 1).body, 'late round one');
});

for (const stage of ['discovery', 'delivery']) {
  test(`${stage} failure before dispatch does not spend a round`, async () => {
    const ws = workspace();
    const fail = () => { throw Object.assign(new Error('failed: token=sk-livekey0123456789abcdef'), { code: 'DELIVERY_FAILED', dispatchUncertain: false }); };
    const engine = makeEngine({
      orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
      pickDelivery: stage === 'discovery' ? fail : async () => ({ mode: 'live', target: 'peer' }),
      deliverLive: fail,
      deliverHeadless: () => assert.fail('must not retry ambiguous execution'),
    });
    const result = await engine.handleRequest({ taskId: 'failed', task: 'audit', workingDirectory: ws });
    assert.equal(result.isError, true);
    assert.equal(state.readTask('failed'), null);
    assert.ok(!result.content[0].text.includes('sk-livekey'), 'failure output is redacted');
    assert.equal(state.openRound({ taskId: 'failed', orchestrator: 'codex', peer: 'claude', round: 1 }).rounds.length, 1);
  });
}

test('mailbox lookup leaves a mismatched legacy reply intact', async () => {
  workspace();
  state.putReply('mismatch', { body: 'legacy round one' });
  assert.equal(await state.waitForReply('mismatch', 20, undefined, 2), null);
  assert.equal(state.listMail('mismatch')[0].body, 'legacy round one');
  assert.equal(state.takeReply('mismatch', 1).body, 'legacy round one');
});

test('explicit sender is recorded; a shared process environment is not an origin', async () => {
  const ws = workspace();
  const id = '11111111-2222-3333-4444-555555555555';
  const oldId = process.env.CODEX_THREAD_ID;
  try {
    process.env.CODEX_THREAD_ID = 'different-task';
    assert.equal(await resolveOrigin('codex', { cwd: ws }), null);
    const { paths } = makeFakeBins(ws);
    const { env } = fakeEnv(ws);
    const server = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } });
    try {
      const result = await server.call('claude_peer', { wait: true, task: 'audit', from: id, delivery: 'headless', workingDirectory: ws });
      assert.equal(result.isError, undefined);
      const record = getRecord(env.MAGI_HOME, 'tasks', result.structuredContent.taskId);
      assert.equal(record.orchestratorTarget.id, id);
      assert.equal(record.orchestratorTarget.agent, 'codex');
      assert.equal(record.replyTo, `codex:${id}`);
    } finally { await server.close(); }
  } finally {
    if (oldId === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = oldId;
  }
});

test('killed lock owner is recovered, while live contention does not block the event loop', async () => {
  workspace();
  state.listTasks(); // Initialize the store before another process holds its transaction.
  const url = new URL('../src/state.mjs', import.meta.url).href;
  const source = `import {withStateLock} from ${JSON.stringify(url)}; withStateLock('task-crash',()=>{process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, windowsHide: true });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('owner exited too early'))); });
    let heartbeatRan = false;
    const heartbeat = setTimeout(() => { heartbeatRan = true; }, 5);
    await assert.rejects(state.retryState(() => state.openRound({ taskId: 'crash', orchestrator: 'codex', peer: 'claude', round: 1 }), 70), { code: 'LEDGER_BUSY' });
    clearTimeout(heartbeat);
    assert.equal(heartbeatRan, true);
    child.kill('SIGKILL');
    await exit;
    assert.equal(state.openRound({ taskId: 'crash', orchestrator: 'codex', peer: 'claude', round: 1 }).taskId, 'crash');
  } finally { child.kill('SIGKILL'); await exit; }
});

test('mail CLI inspection is non-destructive and draining is explicit and round-scoped', async () => {
  workspace();
  state.putReply('retained', { round: 1, body: 'first' });
  state.putReply('retained', { round: 2, body: 'second' });
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'mail', ...args], { env: process.env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => output += chunk);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`mail exited ${code}`)));
  });
  assert.equal((await run(['--task', 'retained'])).length, 2);
  assert.equal(state.listMail('retained').length, 2);
  assert.equal((await run(['--task', 'retained', '--round', '2', '--drain']))[0].body, 'second');
  assert.deepEqual(state.listMail('retained').map((row) => row.body), ['first']);
});

test('contending processes preserve every update across repeated lock acquisitions', async () => {
  workspace();
  const url = new URL('../src/state.mjs', import.meta.url).href;
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  state.listTasks();
  const source = `import {withStateLock,retryState,magiHome} from ${JSON.stringify(url)}; import {getRecord,setRecord} from ${JSON.stringify(storeUrl)}; const home=magiHome(); for(let i=0;i<25;i++) await retryState(()=>withStateLock('counter',()=>{const record=getRecord(home,'tasks','counter')??{taskId:'counter',rounds:[],count:0};setRecord(home,'tasks','counter',{...record,count:record.count+1});}),5000);`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk) => errors += chunk);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  })));
  assert.equal(getRecord(state.magiHome(), 'tasks', 'counter').count, 200);
});
