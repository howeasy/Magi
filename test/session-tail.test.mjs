// What a session is doing, read from the tail of its own transcript, and how
// the picker routes around a session its human has to answer first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { tailLines, claudeContextFrom } from '../src/session-tail.mjs';
import { peerState, describeState, makePickDelivery } from '../src/serve.mjs';
import { makeWorkspace } from './helpers/harness.mjs';

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('tailLines reads only the end of a file and drops the cut line', () => {
  const ws = makeWorkspace();
  const f = join(ws, 'big.jsonl');
  const rows = Array.from({ length: 3000 }, (_, i) => ({ i }));
  writeFileSync(f, jsonl(rows));
  const { lines, mtimeMs } = tailLines(f, 4096);
  assert.ok(lines.length > 10 && lines.length < 3000);
  assert.equal(lines.at(-1).i, 2999);
  assert.ok(lines.every((l) => Number.isInteger(l.i)), 'no fragment parsed as a row');
  assert.ok(mtimeMs > 0);
  assert.deepEqual(tailLines(join(ws, 'absent.jsonl')), { lines: [], mtimeMs: null });
});

test('a Claude transcript yields the last turn\'s context size', () => {
  const lines = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 40 } } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', message: { usage: { input_tokens: 12, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0, output_tokens: 9 } } },
  ];
  assert.deepEqual(claudeContextFrom(lines), { tokens: 80012 });
  assert.equal(claudeContextFrom([{ type: 'user' }]), null);
});

test('peerState maps every harness\'s words onto working / idle / blocked / unknown', () => {
  assert.equal(peerState({ status: 'busy' }).state, 'working');
  assert.equal(peerState({ status: 'shell' }).state, 'working');
  assert.equal(peerState({ status: 'idle', statusAt: Date.now() - 5 * 60000 }).state, 'idle');
  assert.equal(peerState({ status: 'waiting', waitingFor: 'permission prompt' }).state, 'blocked');
  assert.equal(peerState({}).state, 'unknown');
  assert.match(describeState(peerState({ status: 'idle', statusAt: Date.now() - 5 * 60000 })), /^idle 5m$/);
  assert.equal(describeState(peerState({ status: 'waiting', waitingFor: 'permission prompt' })), 'blocked: permission prompt');
  assert.equal(describeState(peerState({ status: 'busy', context: { tokens: 137000, window: 828400 } })), 'working, ctx 137k/828k (17%)');
  assert.equal(describeState(peerState({ status: 'idle', context: { tokens: 86500 } })), 'idle, ctx 87k');
});

// An adapter whose one live session is blocked on its human.
const blocked = { name: 'main', sessionId: 's1', pid: 7, cwd: 'E:/repo', status: 'waiting', waitingFor: 'permission prompt', statusAt: Date.now() };
const adapter = { peer: 'claude', sessions: async () => [blocked] };

test('the picker routes a request on auto around a blocked peer, delivers on live with a warning, and lets notes land', async () => {
  const pick = makePickDelivery(adapter);
  const auto = await pick({ delivery: 'auto', cwd: 'E:/repo', kind: 'request' });
  assert.equal(auto.mode, 'headless');
  assert.equal(auto.reason, 'PEER_BLOCKED');
  assert.match(auto.detail, /"main" is blocked on permission prompt; using a fresh headless claude/);
  const live = await pick({ delivery: 'live', cwd: 'E:/repo', kind: 'request' });
  assert.equal(live.mode, 'live');
  assert.equal(live.target, blocked);
  assert.match(live.warning, /reads this after its user answers/);
  const note = await pick({ delivery: 'live', cwd: 'E:/repo', kind: 'note' });
  assert.equal(note.mode, 'live');
  assert.match(note.warning, /blocked on permission prompt/);
});

test('the engine says where a routed-around request went and shows state in the peer list', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  mkdirSync(join(ws, 'home'), { recursive: true });
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const progress = [];
  const engine = makeEngine({
    orchestrator: 'codex',
    peerName: 'claude',
    replyTool: 'codex_peer',
    listPeers: async () => [{ name: 'main', cwd: 'E:/repo', state: 'blocked', waitingFor: 'permission prompt', stateText: 'blocked: permission prompt, ctx 87k' }],
    pickDelivery: makePickDelivery(adapter),
    deliverLive: async () => ({ via: 'live:main', deliveryStatus: 'queued_unread', statusText: 'queued' }),
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfresh view', via: 'headless' }),
  });
  const res = await engine.handleRequest({ wait: true, task: 'review this', workingDirectory: 'E:/repo' }, { progress: (m) => progress.push(m) });
  assert.match(res.content[0].text, /via=headless/);
  assert.match(res.content[0].text, /\[magi\] claude session "main" is blocked on permission prompt; using a fresh headless claude instead/);
  assert.ok(progress.some((m) => /blocked on permission prompt/.test(m)));
  const peers = await engine.handlePeers({ workingDirectory: 'E:/repo' });
  assert.match(peers.content[0].text, /- main\n    blocked: permission prompt, ctx 87k/);
  const note = await engine.handleNote({ body: 'fyi', workingDirectory: 'E:/repo' });
  assert.match(note.content.map((c) => c.text).join(' '), /blocked on permission prompt; it reads this after its user answers/);
});

test('a Codex thread is busy while its last turn is inProgress, idle after, and unknown when the turn went stale', async (t) => {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite unavailable on this Node');
    return;
  }
  const ws = makeWorkspace();
  process.env.CODEX_HOME = ws;
  const db = new sqlite.DatabaseSync(join(ws, 'thread_history_1.sqlite'));
  db.exec(`create table thread_turns (thread_id text, turn_id text, rollout_ordinal int, status text, started_at int, completed_at int);
    create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal int, created_at_ms int, item_json text, item_type text);`);
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare('insert into thread_turns values (?, ?, 0, ?, ?, ?)');
  ins.run('busy', 't1', 'inProgress', now - 30, null);
  ins.run('idle', 't1', 'completed', now - 900, now - 600);
  ins.run('stale', 't1', 'inProgress', now - 3600, null);
  const item = db.prepare('insert into thread_items values (?, ?, ?, 0, ?, ?, ?)');
  item.run('idle', 't1', 'u1', 1000, JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'PEER REQUEST …' }] }), 'userMessage');
  item.run('idle', 't1', 'a1', 2000, JSON.stringify({ type: 'agentMessage', text: 'done' }), 'agentMessage');
  item.run('idle', 't1', 'r1', 1500, JSON.stringify({ type: 'reasoning' }), 'reasoning');
  db.close();
  const { codexTurnState, codexRecentMessages } = await import('../src/codex-history.mjs?' + Math.random());
  assert.equal((await codexTurnState('busy')).status, 'busy');
  const idle = await codexTurnState('idle');
  assert.equal(idle.status, 'idle');
  assert.equal(idle.statusAt, (now - 600) * 1000);
  assert.equal((await codexTurnState('stale')).status, null);
  assert.equal((await codexTurnState('absent')).status, null);
  assert.deepEqual(await codexRecentMessages('idle'), [
    { role: 'user', text: 'PEER REQUEST …', at: 1000 },
    { role: 'assistant', text: 'done', at: 2000 },
  ]);
  delete process.env.CODEX_HOME;
});

// A Codex thread with no turn for a day is a saved conversation, not a peer.
test('the picker never chooses a saved Codex thread on its own: auto goes headless and says why, live refuses, a named one is delivered with a warning', async () => {
  const stale = { name: 'Gen1', id: 't1', cwd: 'E:/repo', status: 'idle', statusAt: Date.now() - 22 * 3600000 };
  const fresh = { name: 'now', id: 't2', cwd: 'E:/repo', status: 'idle', statusAt: Date.now() - 5 * 60000 };
  const pick = makePickDelivery({ peer: 'codex', sessions: async () => [stale] });
  const auto = await pick({ delivery: 'auto', cwd: 'E:/repo', kind: 'request' });
  assert.equal(auto.mode, 'headless');
  assert.equal(auto.reason, 'NO_LIVE_PEER');
  assert.match(auto.detail, /1 saved codex session\(s\) here have had no turn in the last hour; using a fresh headless codex/);
  await assert.rejects(pick({ delivery: 'live', cwd: 'E:/repo', kind: 'request' }), (e) => e.code === 'NO_LIVE_PEER' && /would not read this/.test(e.message));
  const named = await pick({ delivery: 'live', target: 'Gen1', cwd: 'E:/repo', kind: 'request' });
  assert.equal(named.target, stale);
  assert.match(named.warning, /"Gen1" is idle 22h, a saved conversation/);
  const both = makePickDelivery({ peer: 'codex', sessions: async () => [stale, fresh] });
  assert.equal((await both({ delivery: 'auto', cwd: 'E:/repo', kind: 'request' })).target, fresh, 'the live one is picked over the newer-listed saved one');
});

// A registered Claude or omp session is a running process: named, it is
// delivered to without the saved-conversation warning, however long it idled.
test('a named Claude or omp session idle for hours is delivered to without a saved-conversation warning', async () => {
  for (const peer of ['claude', 'omp']) {
    const idle = { name: 'loop slot', pid: 4242, sessionId: 's1', cwd: 'E:/repo', status: 'idle', statusAt: Date.now() - 17 * 3600000 };
    const named = await makePickDelivery({ peer, sessions: async () => [idle] })({ delivery: 'live', target: 'loop slot', cwd: 'E:/elsewhere', kind: 'note' });
    assert.equal(named.target, idle, peer);
    assert.equal(named.warning, undefined, peer);
  }
});
