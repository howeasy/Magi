// How a peer is chosen when the caller does not name one.
//
// Codex scopes its thread list to the working directory server-side, so any
// candidate is already in the right project. The Claude session registry is not
// scoped, so without an explicit filter the bridge would fall back to whichever
// live session was listed first and deliver a request about one project into a
// session working on another.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { makeWorkspace } from './helpers/harness.mjs';

function registryWith(ws, sessions) {
  const dir = join(ws, 'claude-cfg', 'sessions');
  mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    writeFileSync(
      join(dir, `${s.pid}.json`),
      JSON.stringify({
        pid: s.pid,
        sessionId: `sess-${s.pid}`,
        cwd: s.cwd,
        kind: 'interactive',
        name: s.name,
        messagingSocketPath: `\\.\pipe\LOCAL\cc-msg-${'b'.repeat(32)}`,
      }),
    );
  }
  process.env.CLAUDE_CONFIG_DIR = join(ws, 'claude-cfg');
}

test('a session in the working directory is chosen', async () => {
  const ws = makeWorkspace();
  registryWith(ws, [{ pid: process.pid, cwd: ws, name: 'here' }]);
  const { listClaudeSessions } = await import('../src/transport.mjs?' + Math.random());
  const live = listClaudeSessions();
  const here = live.filter((s) => s.cwd?.toLowerCase() === ws.toLowerCase());
  assert.equal(here.length, 1);
  assert.equal(here[0].name, 'here');
});

test('a session in a different directory is not chosen by default', async () => {
  const ws = makeWorkspace();
  registryWith(ws, [{ pid: process.pid, cwd: 'E:/somewhere/else', name: 'elsewhere' }]);
  const { listClaudeSessions } = await import('../src/transport.mjs?' + Math.random());
  const live = listClaudeSessions();
  assert.equal(live.length, 1, 'the session exists');
  const here = live.filter((s) => s.cwd?.toLowerCase() === ws.toLowerCase());
  assert.equal(here.length, 0, 'but none match the working directory, so none may be picked');
});

test('a live-only send refuses rather than misrouting, and names the alternatives', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'codex',
    peerName: 'claude',
    replyTool: 'codex_peer',
    replyAddress: () => null,
    listPeers: async () => [],
    pickDelivery: async () => {
      throw Object.assign(
        new Error('No live Claude session in E:/project-a. 1 live session(s) are working elsewhere: other in E:/project-b. Name one with peer:"<name>" if you meant it.'),
        { code: 'NO_LIVE_PEER' },
      );
    },
    deliverLive: async () => {
      throw new Error('must not be reached');
    },
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
  });
  const res = await engine.handleNote({ body: 'hello', workingDirectory: 'E:/project-a' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_LIVE_PEER/);
  assert.match(res.content[0].text, /working elsewhere/);
  assert.match(res.content[0].text, /Name one with peer/);
});

test('a request still falls back to a headless peer rather than failing', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'codex',
    peerName: 'claude',
    replyTool: 'codex_peer',
    replyAddress: () => null,
    listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => {
      throw new Error('must not be reached');
    },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfine', via: 'headless' }),
    deliverReply: async () => {},
  });
  const res = await engine.handleRequest({ wait: true, task: 'review', mode: 'REVIEW', workingDirectory: 'E:/project-a' }, {});
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /via=headless/);
});

// The default for a headless run: the tool call returns at once, the run
// finishes on its own, and the reply is filed and delivered the way a live
// peer's is. wait:true is the old inline behaviour.
test('a headless request does not block: the reply arrives later, filed and delivered like a live peer\'s; a failure closes the round and says so', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs?' + Math.random());
  const delivered = [];
  let resolveRun, rejectRun;
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => { throw new Error('must not be reached'); },
    deliverHeadless: () => new Promise((res, rej) => { resolveRun = res; rejectRun = rej; }),
    deliverReply: async ({ text, taskId }) => { delivered.push({ text, taskId }); },
  });

  const res = await engine.handleRequest({ task: 'review this', mode: 'REVIEW', workingDirectory: ws }, {});
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.waiting, false);
  assert.match(res.content[0].text, /running in the background/);
  const taskId = res.structuredContent.taskId;
  assert.equal(state.readTask(taskId).rounds[0].replied, false);

  resolveRun({ inlineReply: 'SUMMARY\nlooks fine', via: 'headless', usage: { costUsd: 0.01 } });
  await new Promise((r) => setTimeout(r, 200));
  const rec = state.readTask(taskId);
  assert.equal(rec.rounds[0].replied, true);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, new RegExp(`PEER REPLY magi/1 task_id=${taskId}`));
  assert.match(delivered[0].text, /looks fine/);
  assert.equal(state.listMail(taskId)[0].delivered > 0, true, 'the mailbox copy is marked delivered');

  // A failed run: the round closes with why, and the orchestrator hears.
  const res2 = await engine.handleRequest({ task: 'again', mode: 'REVIEW', workingDirectory: ws }, {});
  rejectRun(Object.assign(new Error('codex exited with code 1'), { code: 'PEER_FAILED' }));
  await new Promise((r) => setTimeout(r, 200));
  const rec2 = state.readTask(res2.structuredContent.taskId);
  assert.equal(rec2.rounds[0].closeReason, 'delivery_failed');
  assert.equal(rec2.rounds[0].closeCode, 'PEER_FAILED');
  assert.match(delivered[1].text, /PEER NOTE magi\/1 from=codex/);
  assert.match(delivered[1].text, /failed: PEER_FAILED/);

  // wait:true is the inline path.
  const p = engine.handleRequest({ task: 'inline', mode: 'REVIEW', workingDirectory: ws, wait: true }, {});
  await new Promise((r) => setTimeout(r, 50));
  resolveRun({ inlineReply: 'SUMMARY\ninline answer', via: 'headless' });
  const res3 = await p;
  assert.match(res3.content[0].text, /inline answer/);
});
