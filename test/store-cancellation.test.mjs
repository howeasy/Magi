import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeWorkspace } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { runHeadless } from '../src/serve.mjs';
import { runCli } from '../src/exec.mjs';
import * as state from '../src/state.mjs';

// Generous: these wait on child MCP processes, which start slowly under a
// full parallel suite.
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, 'expected cancellation state transition before deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function workspace() {
  const cwd = makeWorkspace('store cancellation');
  process.env.MAGI_HOME = join(cwd, 'state');
  return cwd;
}

test('actual MCP cancellation removes the live waiter before its timeout', async () => {
  const cwd = workspace();
  const live = join(cwd, 'live-delivery');
  const source = `import {serve} from ${JSON.stringify(new URL('../src/serve.mjs', import.meta.url).href)}; import {adapter} from ${JSON.stringify(new URL('../src/claude-adapter.mjs', import.meta.url).href)}; import {writeFileSync} from 'node:fs'; await serve({...adapter,sessions:async()=>[{pid:process.pid,name:'fixture-peer',cwd:${JSON.stringify(cwd)},status:'idle'}],deliverLive:async()=>{writeFileSync(${JSON.stringify(live)},'delivered');return {via:'live'};}});`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', source], cwd, env: process.env, stderr: 'pipe' });
  const client = new Client({ name: 'cancellation-test', version: '1' });
  const controller = new AbortController();
  await client.connect(transport);
  try {
    const pending = client.callTool({ name: 'claude_peer', arguments: { taskId: 'mcp-cancel', task: 'inspect', delivery: 'live', peer: 'fixture-peer', wait: true, timeoutMs: 10000, workingDirectory: cwd }, _meta: { threadId: '11111111-2222-3333-4444-555555555555' } }, undefined, { signal: controller.signal, timeout: 15000 });
    const cancelled = pending.then(() => false, () => true);
    await until(() => existsSync(live) && state.isWaiting('mcp-cancel', 1));
    controller.abort();
    assert.equal(await cancelled, true);
    await until(() => !state.isWaiting('mcp-cancel', 1));
    assert.equal(state.readTask('mcp-cancel').rounds[0].closeCode, undefined, 'cancelling a live wait must not invalidate a peer still answering');
  } finally { controller.abort(); await client.close(); }
});

test('cancelling after a reply was routed to the waiter hands retained mail out of band', async () => {
  const cwd = workspace();
  const controller = new AbortController();
  const delivered = [];
  const peer = makeEngine({ orchestrator: 'claude', peerName: 'codex', deliverReply: async () => assert.fail('reply is initially assigned to waiter') });
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'live', target: 'fixture-peer' }),
    deliverLive: async () => {
      const reply = await peer.handleReply({ taskId: 'handoff', round: 1, body: 'reply survives cancellation' });
      assert.equal(reply.isError, undefined);
      controller.abort();
      return { via: 'live' };
    },
    deliverReply: async ({ text }) => { delivered.push(text); },
  });
  const result = await engine.handleRequest({ taskId: 'handoff', task: 'inspect', wait: true, delivery: 'live', workingDirectory: cwd, timeoutMs: 2000 }, { signal: controller.signal });
  assert.equal(result.isError, true, 'cancelled request must not return the retained answer inline');
  assert.match(result.content[0].text, /CANCELLED/);
  assert.equal(state.isWaiting('handoff', 1), false);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /reply survives cancellation/);
  assert.equal(state.listMail('handoff')[0].delivered > 0, true);
});

test('a cancellation handoff the receiver rejects leaves the reply undelivered in the mailbox', async () => {
  const cwd = workspace();
  const controller = new AbortController();
  const peer = makeEngine({ orchestrator: 'claude', peerName: 'codex', deliverReply: async () => assert.fail('reply is initially assigned to waiter') });
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'live', target: 'fixture-peer' }),
    deliverLive: async () => {
      await peer.handleReply({ taskId: 'handoff-refused', round: 1, body: 'reply the receiver refuses' });
      controller.abort();
      return { via: 'live' };
    },
    deliverReply: async () => ({ via: 'live', deliveryStatus: 'failed' }),
  });
  const result = await engine.handleRequest({ taskId: 'handoff-refused', task: 'inspect', wait: true, delivery: 'live', workingDirectory: cwd, timeoutMs: 2000 }, { signal: controller.signal });
  assert.match(result.content[0].text, /CANCELLED/);
  assert.ok(!(state.listMail('handoff-refused')[0].delivered > 0), 'a refused reply stays eligible for retry');
});

test('runCli cancellation stops the running process before it can perform later work', async () => {
  const cwd = workspace();
  const ready = join(cwd, 'running');
  const later = join(cwd, 'later-work');
  const controller = new AbortController();
  // The later work waits 10 s: the test's own poll can notice `ready` a second
  // or more late on a loaded machine, and a shorter wait then ran the later
  // work before the abort was even sent, failing for the wrong reason.
  const source = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(later)},'must not happen'),10000);`;
  const pending = runCli('node', ['-e', source], { cwd, signal: controller.signal, timeoutMs: 20000 });
  const observed = pending.then((value) => ({ value }), (error) => ({ error }));
  await until(() => existsSync(ready));
  const pid = Number(readFileSync(ready, 'utf8'));
  controller.abort();
  const result = await observed;
  assert.equal(result.error?.code, 'CANCELLED');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(later), false);
});

test('headless cancellation propagates to execution and removes its worker row', async () => {
  const cwd = workspace();
  const ready = join(cwd, 'headless-running');
  const controller = new AbortController();
  const adapter = { peer: 'omp', headless: { bin: 'node', args: () => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'running');setTimeout(()=>console.log('too late'),1000);`], parse: (stdout) => ({ message: stdout.trim(), errors: [] }) } };
  const observed = runHeadless(adapter, { cwd, taskId: 'headless-cancel', round: 1, text: '', signal: controller.signal, timeoutMs: 2500 }).then((value) => ({ value }), (error) => ({ error }));
  await until(() => existsSync(ready));
  controller.abort();
  const result = await observed;
  assert.equal(result.error?.code, 'CANCELLED');
  assert.deepEqual(state.listWorkers(), []);
});

test('cancellation handoff and the replying peer cannot deliver the same retained reply twice', async () => {
  const cwd = workspace();
  const controller = new AbortController();
  let beginHandoff, finishHandoff, peerPending;
  const started = new Promise((resolve) => { beginHandoff = resolve; });
  const finish = new Promise((resolve) => { finishHandoff = resolve; });
  const delivered = [];
  const peer = makeEngine({
    orchestrator: 'claude', peerName: 'codex',
    resolveOrigin: async () => null,
    deliverReply: async () => { delivered.push('replying peer'); },
  });
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'live' }),
    deliverLive: async () => {
      peerPending = peer.handleReply({ taskId: 'handoff-race', round: 1, body: 'one answer' });
      await until(() => state.readTask('handoff-race').rounds[0].replied);
      controller.abort();
      return { via: 'live' };
    },
    deliverReply: async () => { delivered.push('cancellation handoff'); beginHandoff(); await finish; },
  });
  const pending = engine.handleRequest({ taskId: 'handoff-race', task: 'inspect', wait: true, workingDirectory: cwd, timeoutMs: 2000 }, { signal: controller.signal });
  await started;
  try {
    await peerPending;
  } finally { finishHandoff(); }
  assert.equal((await pending).isError, true);
  assert.deepEqual(delivered, ['cancellation handoff']);
});

test('an acknowledged background headless run outlives cancellation of its original tool call', async () => {
  const cwd = workspace();
  const controller = new AbortController();
  const delivered = [];
  const adapter = { peer: 'claude', headless: { bin: 'node', args: () => ['-e', "setTimeout(()=>console.log('independently owned answer'),120)"], parse: (stdout) => ({ message: stdout.trim(), errors: [] }) } };
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: (options) => runHeadless(adapter, options),
    deliverReply: async ({ text }) => { delivered.push(text); },
  });
  const result = await engine.handleRequest({ taskId: 'background-owned', task: 'inspect', wait: false, workingDirectory: cwd, timeoutMs: 2000 }, { signal: controller.signal });
  assert.equal(result.structuredContent.waiting, false);
  controller.abort();
  await until(() => delivered.length === 1);
  assert.match(delivered[0], /independently owned answer/);
  assert.equal(state.readTask('background-owned').rounds[0].replied, true);
});
