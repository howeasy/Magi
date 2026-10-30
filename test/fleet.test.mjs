// The fleet listing and the exchange the CLI reads, read-only. Seeded home,
// fake harness listings, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { makeWorkspace } from './helpers/harness.mjs';
import { setRecord } from '../src/store.mjs';

async function seeded() {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  const cfg = join(ws, 'claude-cfg');
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  process.env.MAGI_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.CODEX_HOME = join(ws, 'codex-home'); // no thread history: codex reads unknown
  process.env.CODEX_BIN = join(ws, 'absent-codex'); // thread/list fails fast -> codexError
  const state = await import('../src/state.mjs?' + Math.random());
  // Two tasks: one open, one replied with a priced headless round and an outcome.
  const now = Date.now();
  setRecord(home, 'tasks', 'cx-open', { taskId: 'cx-open', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', maxRounds: 2, cwd: 'E:/repo', rounds: [{ round: 1, openedAt: now - 60000, replied: false, snapshot: { diffSha256: 'a'.repeat(64) } }] });
  setRecord(home, 'tasks', 'cx-done', { taskId: 'cx-done', orchestrator: 'codex', peer: 'claude', mode: 'DELEGATE', maxRounds: 2, cwd: 'E:/repo', rounds: [{ round: 1, openedAt: now - 120000, replied: true, repliedAt: now - 100000, via: 'headless', usage: { costUsd: 0.5 }, snapshot: {} }], outcome: { accepted: 2, rejected: 1, open: 0, notes: 'held', round: 1, at: now } });
  state.putReply('cx-done', { body: 'x'.repeat(2500), at: now, from: 'claude', round: 1 });
  // One live Claude session, blocked, with a transcript.
  const cwd = join(ws, 'proj');
  mkdirSync(cwd);
  writeFileSync(join(cfg, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's-1', cwd, kind: 'interactive', name: 'main', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-test', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: now }));
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(join(cfg, 'projects', slug), { recursive: true });
  writeFileSync(join(cfg, 'projects', slug, 's-1.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: new Date(now - 5000).toISOString(), message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 4000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000 } } }),
    JSON.stringify({ type: 'user', timestamp: new Date(now - 3000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'file' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 2000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done reading' }], usage: { input_tokens: 12, cache_read_input_tokens: 2000 } } }),
    '',
  ].join('\n'));
  const fleet = await import('../src/fleet.mjs?' + Math.random());
  return { ws, home, cwd, fleet, state };
}

test('listFleet lists peers with state and turns a codex failure into an error field', async () => {
  const { cwd, fleet } = await seeded();
  const s = await fleet.listFleet({ cwd });
  const main = s.peers.find((p) => p.name === 'main');
  assert.equal(main.harness, 'claude');
  assert.equal(main.state, 'blocked');
  assert.match(main.stateText, /blocked: permission prompt, ctx 2k/);
  assert.ok(s.codexError, 'no app-server here reads as an error field, not a throw');
});

test('transcriptTail returns the conversation, not the tool traffic; lastSaid is its final line, clipped', async () => {
  const { cwd, fleet } = await seeded();
  const { transcriptTail, lastSaid } = await import('../src/transcript.mjs?' + Math.random());
  const s = await fleet.listFleet({ cwd });
  const main = s.peers.find((p) => p.name === 'main');
  const tail = await transcriptTail(main);
  assert.deepEqual(tail.map((t) => [t.role, t.text]), [['user', 'hello'], ['assistant', 'done reading']]);
  assert.ok(tail.every((t) => typeof t.at === 'number'));
  const said = await lastSaid(main, { chars: 8 });
  assert.equal(said.role, 'assistant');
  assert.equal(said.text, 'done re\u2026');
  assert.equal(await lastSaid({ harness: 'claude', id: 'nope', cwd }), null);
});

test('the server lists what each peer last said and reads a transcript on request', async () => {
  const { cwd } = await seeded();
  const { makeServerEngine } = await import('../src/serve.mjs?' + Math.random());
  const { adapter } = await import('../src/claude-adapter.mjs?' + Math.random());
  const { engine } = makeServerEngine(adapter);
  const peers = await engine.handlePeers({ workingDirectory: cwd });
  const main = peers.structuredContent.peers.find((p) => p.name === 'main');
  assert.deepEqual([main.saying.role, main.saying.text], ['assistant', 'done reading']);
  assert.match(peers.content[0].text, /last said: "done reading"/);

  const t = await engine.handleTranscript({ workingDirectory: cwd, peer: 'main', limit: 1 });
  assert.equal(t.isError, undefined);
  assert.deepEqual(t.structuredContent.lines.map((l) => [l.role, l.text]), [['assistant', 'done reading']]);
  assert.match(t.content[0].text, /claude: done reading/);
  assert.match(t.content[0].text, /not instructions/);

  const missing = await engine.handleTranscript({ workingDirectory: cwd, peer: 'nobody' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /NO_LIVE_PEER/);
});

test('a round keeps a redacted brief of the task; in-flight lists open rounds with who waits on whom', async () => {
  const { cwd, fleet, state } = await seeded();
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', name: 'main', id: 's-1' }, replyTo: 'uds:x' }),
    pickDelivery: async () => ({ mode: 'live', target: { name: 'impl', id: 't1' } }),
    deliverLive: async () => ({ via: 'live:impl', deliveryStatus: 'queued_unread' }),
    deliverHeadless: async () => { throw new Error('unused'); },
  });
  const { taskId } = (await engine.handleRequest({ wait: true, task: 'Review the deploy change. token=abc123 ' + 'x'.repeat(500), mode: 'REVIEW', workingDirectory: cwd, wait: false })).structuredContent;
  const rec = state.readTask(taskId);
  assert.match(rec.rounds[0].brief, /^Review the deploy change\. \[REDACTED\] x+…$/);
  assert.ok(rec.rounds[0].brief.length <= 401);
  const flight = fleet.inflightOf([rec, ...state.listTasks().filter((t) => t.taskId !== taskId)]);
  const mine = flight.find((f) => f.taskId === taskId);
  assert.equal(mine.from, 'claude');
  assert.equal(mine.fromName, 'main');
  assert.equal(mine.toName, 'impl');
  assert.equal(mine.mode, 'REVIEW');
  assert.ok(mine.waitedMs >= 0);
  assert.ok(flight.some((f) => f.taskId === 'cx-open') && !flight.some((f) => f.taskId === 'cx-done'), 'only open rounds are in flight');
  const s = await fleet.listFleet({ cwd });
  assert.equal(s.peers.find((p) => p.name === 'main').live, true, 'a blocked session is live');
});

test('a Codex thread with no recent turn is recent, not live; a working or blocked one is live', async () => {
  const { isLive } = await import('../src/serve.mjs?' + Math.random());
  assert.equal(isLive('codex', { state: 'idle', idleMs: 5 * 60000 }), true);
  assert.equal(isLive('codex', { state: 'idle', idleMs: 5 * 3600000 }), false);
  assert.equal(isLive('codex', { state: 'unknown' }), false, 'a saved thread with no turn on record is recent');
  assert.equal(isLive('claude', { state: 'unknown' }), true, 'a registered session is live even before it reports');
  assert.equal(isLive('codex', { state: 'working' }), true);
  assert.equal(isLive('omp', { state: 'blocked', idleMs: null }), true);
});

test('a reply is filed undelivered and marked delivered once it reaches the orchestrator', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  mkdirSync(process.env.MAGI_HOME, { recursive: true });
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs?' + Math.random());
  const ask = (orchestrator) => makeEngine({
    orchestrator, peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: orchestrator, name: orchestrator }, replyTo: `${orchestrator}:x` }),
    pickDelivery: async () => ({ mode: 'live', target: { name: 't' } }),
    deliverLive: async () => ({ via: 'live:t', deliveryStatus: 'queued_unread' }),
    deliverHeadless: async () => { throw new Error('unused'); },
  });
  const answer = (via) => makeEngine({
    orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    pickDelivery: async () => ({ mode: 'live', target: {} }),
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => { throw new Error('unused'); },
    deliverReply: async () => ({ via, deliveryStatus: 'received' }),
  });
  const agentTask = (await ask('claude').handleRequest({ wait: true, task: 'x', workingDirectory: ws, wait: false })).structuredContent.taskId;
  await answer('live:claude').handleReply({ taskId: agentTask, body: 'answer' });
  assert.equal(typeof state.listMail(agentTask)[0].delivered, 'number', 'delivered into the orchestrator: marked with the time');
});

test('the exchange keeps the words: request, reply, outcome and close in order; channel cards clip them', async () => {
  const { cwd, fleet, state } = await seeded();
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const long = 'A finding. '.repeat(120);
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', name: 'main', id: 's-1' }, replyTo: 'uds:x' }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => { throw new Error('unused'); },
    deliverHeadless: async () => ({ inlineReply: `SUMMARY\n${long} token=abc123`, via: 'headless', usage: { costUsd: 0.25 } }),
  });
  const { taskId } = (await engine.handleRequest({ wait: true, task: 'Review the deploy change', mode: 'REVIEW', workingDirectory: cwd })).structuredContent;
  await engine.handleOutcome({ taskId, accepted: 1, rejected: 0, open: 0, body: 'the finding held' });
  const ev = state.readExchange(taskId);
  assert.deepEqual(ev.map((e) => [e.kind, e.from, e.to ?? null, e.round]), [['request', 'claude', 'codex', 1], ['reply', 'codex', 'claude', 1], ['outcome', 'claude', null, 1]]);
  assert.match(ev[0].text, /^PEER REQUEST magi\/1[\s\S]*Review the deploy change/);
  assert.equal(ev[0].fromName, 'main');
  assert.match(ev[1].text, /\[REDACTED\]$/);
  assert.equal(ev[1].via, 'headless');
  assert.deepEqual([ev[2].accepted, ev[2].rejected, ev[2].text], [1, 0, 'the finding held']);

  const card = (id) => fleet.channelsOf(state.listTasks()).flatMap((c) => c.turns).find((t) => t.taskId === id);
  const mine = card(taskId);
  assert.equal(mine.status, 'settled');
  assert.equal(mine.costUsd, 0.25);
  assert.ok(mine.events[1].clipped && mine.events[1].text.length <= 601, 'the card carries a clipped copy');
  assert.ok(state.readExchange(taskId)[1].text.length > 1000, 'the whole stays in the exchange');

  state.closeRound({ taskId: 'cx-open', round: 1, reason: 'abandoned', detail: 'dead' });
  assert.deepEqual(state.readExchange('cx-open').map((e) => [e.kind, e.reason, e.text]), [['closed', 'abandoned', 'dead']]);
  assert.equal(card('cx-open').status, 'closed');
});


test('the next request names the replies this orchestrator never reconciled', async () => {
  const { cwd, state } = await seeded();
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', name: 'main', id: 's-1' }, replyTo: 'uds:x' }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => { throw new Error('unused'); },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfine', via: 'headless' }),
  });
  const first = await engine.handleRequest({ wait: true, task: 'Review one', mode: 'REVIEW', workingDirectory: cwd });
  assert.ok(!/not reconciled/.test(first.content[0].text), 'nothing owed yet');
  const second = await engine.handleRequest({ wait: true, task: 'Review two', mode: 'REVIEW', workingDirectory: cwd });
  const id1 = first.structuredContent.taskId;
  assert.deepEqual(state.unreconciledFor('claude', { cwd }), [second.structuredContent.taskId, id1]);
  await engine.handleOutcome({ taskId: id1, accepted: 1, rejected: 0, open: 0, body: 'held' });
  await engine.handleOutcome({ taskId: second.structuredContent.taskId, accepted: 0, rejected: 1, open: 0, body: 'overturned' });
  const third = await engine.handleRequest({ wait: true, task: 'Review three', mode: 'REVIEW', workingDirectory: cwd });
  assert.ok(!/not reconciled/.test(third.content[0].text));
  assert.deepEqual(state.unreconciledFor('codex', { cwd: 'E:/repo' }), [], 'cx-done has its outcome');
});

test('unreconciled-card hold follows the coordinator session; a continuation is not a new card', async () => {
  const { cwd, state } = await seeded();
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', name: 'main', id: 's-1' }, replyTo: 'uds:x' }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => { throw new Error('unused'); },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfine', via: 'headless' }),
  });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await engine.handleRequest({ wait: true, task: `Review ${i}`, mode: 'REVIEW', workingDirectory: cwd })).structuredContent.taskId);
  const refused = await engine.handleRequest({ wait: true, task: 'Review five', mode: 'REVIEW', workingDirectory: cwd });
  assert.equal(refused.isError, true);
  const elsewhere = await engine.handleRequest({ wait: true, task: 'Review elsewhere', mode: 'REVIEW', workingDirectory: join(cwd, 'other') });
  assert.equal(elsewhere.isError, true, 'changing directory does not escape session debt');
  const debate = await engine.handleRequest({ wait: true, task: 'Round two', taskId: ids[0], workingDirectory: cwd });
  assert.equal(debate.isError, undefined, 'a second round of an answered task is not a new request');
  for (const id of ids) await engine.handleOutcome({ taskId: id, accepted: 0, rejected: 0, open: 1, body: 'not checked' });
  const ok = await engine.handleRequest({ wait: true, task: 'Review five', mode: 'REVIEW', workingDirectory: cwd });
  assert.equal(ok.isError, undefined);
  assert.equal(state.unreconciledFor('claude', { cwd, limit: 10 }).length, 1, 'only the new card remains owed');
});

test('a headless worker is registered for the length of its run; a dead server\'s record is dropped', async () => {
  const { state } = await seeded();
  state.registerWorker({ taskId: 'cx-open', harness: 'codex', bin: 'codex', cwd: 'E:/repo', round: 1 });
  assert.deepEqual(state.listWorkers().map((x) => [x.taskId, x.harness]), [['cx-open', 'codex']]);
  setRecord(process.env.MAGI_HOME, 'workers', 'cx-dead', { taskId: 'cx-dead', harness: 'claude', bin: 'claude', pid: 999999, startedAt: Date.now() });
  assert.deepEqual(state.listWorkers().map((x) => x.taskId), ['cx-open'], 'a worker whose server is gone is not running');
  state.unregisterWorker('cx-open');
  assert.deepEqual(state.listWorkers(), []);
});

test('a peer row links to the app that owns it: a Claude desktop session by the app id its own records give it, a terminal session nowhere, nothing guessed', async () => {
  const { fleet, cwd } = await seeded();
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const row = (id, name) => JSON.stringify({ pid: process.pid, sessionId: id, cwd, kind: 'interactive', name, entrypoint: 'claude-desktop', messagingSocketPath: 'pipe-app', status: 'idle', statusUpdatedAt: Date.now() });
  writeFileSync(join(cfg, 'sessions', '424242.json'), row('app-1', 'From the app'));
  writeFileSync(join(cfg, 'sessions', '424243.json'), row('cleared-2', 'Cleared once'));
  writeFileSync(join(cfg, 'sessions', '424244.json'), row('unknown-3', 'Not in the store'));
  // The app's own records map CLI session ids (current and prior) to app
  // ids; after a /clear the app id is not derivable from the CLI id.
  const store = join(cfg, 'app-store', 'acct', 'org');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'local_A.json'), JSON.stringify({ sessionId: 'local_A', cliSessionId: 'app-1' }));
  writeFileSync(join(store, 'local_B.json'), JSON.stringify({ sessionId: 'local_B', cliSessionId: 'later-2', priorCliSessionIds: ['cleared-2'] }));
  process.env.CLAUDE_APP_SESSIONS_DIR = join(cfg, 'app-store');
  try {
    const s = await fleet.listFleet({ cwd });
    assert.equal(s.peers.find((p) => p.name === 'main').appLink, null, 'a terminal session has no app to open in');
    assert.equal(s.peers.find((p) => p.name === 'From the app').appLink, 'claude://claude.ai/epitaxy/local_A');
    assert.equal(s.peers.find((p) => p.name === 'Cleared once').appLink, 'claude://claude.ai/epitaxy/local_B', 'a prior CLI id still maps to its app session');
    assert.equal(s.peers.find((p) => p.name === 'Not in the store').appLink, null, 'nothing is guessed');
  } finally {
    delete process.env.CLAUDE_APP_SESSIONS_DIR;
  }
});

// Seen live 2026-09-20: a desktop-app session running in the cloud had no
// process and no registry row here, but its transcript and eleven subagent
// transcripts kept landing under ~/.claude/projects. Nothing here listed it;
// the app showed three subagents at work.
test('a Claude session with a fresh transcript and no registry row is listed as remote, and is never a delivery target', async () => {
  const { cwd, fleet } = await seeded();
  const { pickSession } = await import('../src/serve.mjs?' + Math.random());
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug);
  const now = Date.now();
  const rec = (type, content, extra = {}) => JSON.stringify({ type, cwd, sessionId: '11111111-2222-4333-8444-555555555555', entrypoint: 'claude-desktop', timestamp: new Date(now - 1000).toISOString(), message: { role: type, model: 'claude-fable-5', content, ...extra } });
  writeFileSync(join(dir, '11111111-2222-4333-8444-555555555555.jsonl'), [rec('user', 'audit everything'), rec('assistant', [{ type: 'tool_use', name: 'Agent' }], { stop_reason: 'tool_use' }), ''].join('\n'));
  mkdirSync(join(dir, '11111111-2222-4333-8444-555555555555', 'subagents'), { recursive: true });
  writeFileSync(join(dir, '11111111-2222-4333-8444-555555555555', 'subagents', 'agent-x1.jsonl'), [rec('user', 'scan'), rec('assistant', [{ type: 'tool_use', name: 'Grep' }], { stop_reason: 'tool_use' }), ''].join('\n'));
  writeFileSync(join(dir, '11111111-2222-4333-8444-555555555555', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Finder A' }));

  const s = await fleet.listFleet({ cwd });
  const remote = s.peers.find((p) => p.id === '11111111-2222-4333-8444-555555555555');
  assert.ok(remote, 'listed');
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.live, true);
  assert.equal(remote.pid, null);

  // The registered session in the same directory is still what a request picks; the remote one is refused by name.
  const sessions = [{ sessionId: '11111111-2222-4333-8444-555555555555', cwd, remote: true, status: 'busy' }, { sessionId: 's-1', name: 'main', cwd, status: 'busy', socket: 'x' }];
  assert.equal(pickSession(sessions, null, cwd, 'claude').sessionId, 's-1');
  assert.throws(() => pickSession(sessions, '11111111-2222-4333-8444-555555555555', cwd, 'claude'), (e) => e.code === 'NO_LIVE_PEER' && /remotely/.test(e.message));
});

test('Codex session listings evict cold directories while reused directories stay hot', async () => {
  const { ws, fleet } = await seeded();
  const { setProvider } = await import('../src/providers.mjs');
  setProvider('claude', false);
  setProvider('omp', false);
  const adapter = fleet.HARNESSES.codex;
  const original = adapter.sessions;
  const calls = new Map();
  adapter.sessions = async ({ cwd }) => {
    calls.set(cwd, (calls.get(cwd) ?? 0) + 1);
    return [];
  };
  try {
    const hot = join(ws, 'hot'), cold = join(ws, 'cold');
    await fleet.listFleet({ cwd: hot });
    await fleet.listFleet({ cwd: cold });
    for (let i = 0; i < fleet.CODEX_CACHE_MAX_ENTRIES * 2; i++) {
      await fleet.listFleet({ cwd: hot });
      await fleet.listFleet({ cwd: join(ws, 'dir-' + i) });
    }
    await fleet.listFleet({ cwd: hot });
    await fleet.listFleet({ cwd: cold });
    assert.equal(calls.get(hot), 1);
    assert.equal(calls.get(cold), 2);
  } finally { adapter.sessions = original; }
});
