// Listing who is reachable, the analogue of listing the sessions you can message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace, ROOT } from './helpers/harness.mjs';

async function engineWith(ws, peers, pick) {
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  return makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    listPeers: async () => peers,
    pickDelivery: pick ?? (async () => ({ mode: 'live', target: peers[0]?.name })),
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
  });
}

test('peers are listed with the one a note would reach', async () => {
  const ws = makeWorkspace();
  const engine = await engineWith(ws, [
    { name: 'reviewer', cwd: 'E:/repo', detail: 'status=idle' },
    { name: 'other', cwd: 'E:/elsewhere', detail: null },
  ]);
  const res = await engine.handlePeers({ workingDirectory: 'E:/repo' });
  const text = res.content[0].text;
  assert.match(text, /Reachable codex sessions \(2\)/);
  assert.match(text, /reviewer/);
  assert.match(text, /E:\/repo/);
  assert.match(text, /would go to "reviewer"/);
  assert.equal(res.structuredContent.chosen, 'reviewer');
  assert.equal(res.structuredContent.peers.length, 2);
});

test('an empty listing says what happens instead', async () => {
  const ws = makeWorkspace();
  const engine = await engineWith(ws, [], async () => {
    throw Object.assign(new Error('none'), { code: 'NO_LIVE_PEER' });
  });
  const res = await engine.handlePeers({});
  const text = res.content[0].text;
  assert.match(text, /No live codex session is reachable/);
  assert.match(text, /falls back to a fresh headless peer/);
  assert.equal(res.structuredContent.chosen, null);
});

test('listing failures surface rather than pretending nobody is there', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    listPeers: async () => {
      throw Object.assign(new Error('app-server unreachable'), { code: 'APPSERVER_TIMEOUT' });
    },
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
  });
  const res = await engine.handlePeers({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /APPSERVER_TIMEOUT/);
});

// A thread the app-server reports as notLoaded is a saved conversation, not a
// running session. Listing those as reachable made the bridge claim six live
// Codex peers when none existed and every delivery would have failed.
test('saved threads are not counted as reachable', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const rows = [];
  rows.note = '6 saved thread(s) here, none of them loaded.';
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    listPeers: async () => rows,
    pickDelivery: async () => {
      throw Object.assign(new Error('none'), { code: 'NO_LIVE_PEER' });
    },
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
  });
  const res = await engine.handlePeers({});
  const text = res.content[0].text;
  assert.match(text, /Reachable codex sessions \(0\)/);
  assert.doesNotMatch(text, /Live codex sessions \(6\)/);
  assert.match(text, /6 saved thread\(s\) here, none of them loaded/);
});

test('magi peers --json prints machine-readable rows for hooks and scripts', async () => {
  const { spawnSync } = await import('node:child_process');
  const ws = makeWorkspace();
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'peers', '--json', '--cwd', ws], {
    encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: join(ws, 'home'), CODEX_BIN: join(ws, 'no-such-codex') },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.cwd, ws);
  assert.ok(Array.isArray(out.peers));
  for (const p of out.peers) assert.deepEqual(Object.keys(p).sort(), ['cwd', 'harness', 'id', 'idleMs', 'name', 'remote', 'state']);
});

test('a watch on a peer with one of your requests still open is refused; with none open it goes out', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs');
  const target = { id: 'thread-1', name: 'Polished' };
  const sent = [];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target }),
    deliverLive: async (o) => { sent.push(o.kind); return { via: 'live', label: 'Polished', target, deliveryStatus: 'queued_unread' }; },
  });
  state.openRound({ orchestrator: 'claude', peer: 'codex', mode: 'FACT_CHECK', round: 1, taskId: 'cx-open0001', cwd: ws });
  state.setPeerTarget('cx-open0001', target);
  const refused = await engine.handleWatch({ workingDirectory: ws }, {});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /WATCH_REDUNDANT/);
  assert.match(refused.content[0].text, /cx-open0001/);
  assert.deepEqual(sent, [], 'nothing was delivered');
  state.recordReply({ taskId: 'cx-open0001', from: 'codex', round: 1, via: 'live' });
  const ok = await engine.handleWatch({ workingDirectory: ws }, {});
  assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
  assert.deepEqual(sent, ['watch']);
});

test('a watch is refused only for the caller session\'s own open task, and not after a headless fallback', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs');
  const target = { id: 'thread-9', name: 'Polished' };
  const mk = (selfId) => makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { id: selfId } }),
    pickDelivery: async () => ({ mode: 'live', target }),
    deliverLive: async () => ({ via: 'live', label: 'Polished', target, deliveryStatus: 'queued_unread' }),
  });
  state.openRound({ orchestrator: 'claude', peer: 'codex', mode: 'FACT_CHECK', round: 1, taskId: 'cx-mine0001', cwd: ws, orchestratorTarget: { id: 'sess-A' } });
  state.setPeerTarget('cx-mine0001', target);
  assert.equal((await mk('sess-A').handleWatch({ workingDirectory: ws }, {})).isError, true, 'my own open task');
  assert.notEqual((await mk('sess-B').handleWatch({ workingDirectory: ws }, {})).isError, true, "another session's task is not mine");
});

test('a request that fell back to headless records no live target, so a watch on that session is allowed', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs');
  const target = { id: 'thread-7', name: 'Busy' };
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target }),
    deliverLive: async () => { throw Object.assign(new Error('unreachable'), { fallback: true, dispatchUncertain: false }); },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nok', via: 'headless' }),
  });
  await engine.handleRequest({ task: 'x', wait: false, workingDirectory: ws }, {});
  await new Promise((r) => setTimeout(r, 100));
  const rec = state.listTasks()[0];
  assert.notEqual(rec.peerTarget?.id ?? null, 'thread-7', 'the live target was not kept'); if (rec.peerTarget) assert.equal(rec.peerTarget.headless, true);
  const watcher = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target }),
    deliverLive: async () => ({ via: 'live', label: 'Busy', target, deliveryStatus: 'queued_unread' }),
  });
  assert.notEqual((await watcher.handleWatch({ workingDirectory: ws }, {})).isError, true);
});
