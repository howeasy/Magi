// `magi status --json`: what the Claude Code mod draws its MAGI pane from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { makeWorkspace, ROOT } from './helpers/harness.mjs';

const CLI = join(ROOT, 'bin', 'magi.mjs');

test('OMP-to-OMP status keeps the worker note and both delivery directions distinct', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const state = await import('../src/state.mjs');
  const { setProvider } = await import('../src/providers.mjs');
  setProvider('codex', false);
  const now = Date.now();
  const taskId = 'magi-omp-pair';
  setRecord(home, 'tasks', taskId, {
    taskId, orchestrator: 'omp', peer: 'omp', mode: 'REVIEW', maxRounds: 2, cwd: ws,
    orchestratorTarget: { agent: 'omp', sessionId: 'omp-coordinator', name: 'Coordinator' },
    peerTarget: { agent: 'omp', sessionId: 'omp-worker', name: 'Worker' },
    rounds: [{ round: 1, openedAt: now }],
  });
  state.recordExchange(taskId, { kind: 'note', round: 1, from: 'omp', to: 'omp', fromRole: 'peer', text: 'Worker found the fault.' });
  state.recordExchange(taskId, { kind: 'note', round: 1, from: 'omp', to: 'omp', fromRole: 'orchestrator', text: 'Coordinator asks for evidence.' });
  state.recordCardDelivery(taskId, 1, { to: 'omp', toRole: 'peer', deliveryStatus: 'received', at: now });
  state.recordCardDelivery(taskId, 1, { to: 'omp', toRole: 'orchestrator', deliveryStatus: 'queued_unread', at: now + 1 });
  const result = spawnSync(process.execPath, [CLI, 'status', '--json', '--cwd', ws, '--as', 'omp'], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const card = JSON.parse(result.stdout).cards.find((c) => c.taskId === taskId);
  assert.equal(card.from, 'omp');
  assert.equal(card.to, 'omp');
  assert.equal(card.coordinator.name, 'Coordinator');
  assert.equal(card.worker.name, 'Worker');
  assert.equal(card.worker.lastSaid, 'Worker found the fault.');
  assert.deepEqual(card.delivery.map((d) => [d.toRole, d.status]), [['orchestrator', 'queued_unread'], ['peer', 'received']]);
});

test('magi status --json reports units, providers, open cards with worker and coordinator, debt, outcomes, a week\'s ledger and the last messages, every text redacted and cut', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const state = await import('../src/state.mjs');
  const { setProvider } = await import('../src/providers.mjs');
  const now = Date.now();
  const task = (taskId, peer, rounds, extra = {}) =>
    setRecord(home, 'tasks', taskId, { taskId, orchestrator: 'claude', peer, mode: 'REVIEW', maxRounds: 2, cwd: ws, rounds, ...extra });

  // Gen 2 Boogaloo's card on a headless omp persona, still running, that sent a note home.
  task('magi-open0001', 'omp', [{ round: 1, openedAt: now - 3000 }], { mode: 'DELEGATE', orchestratorTarget: { agent: 'claude', sessionId: 'sess-0001', name: 'Gen 2 Boogaloo' } });
  state.recordExchange('magi-open0001', { kind: 'request', round: 1, from: 'claude', to: 'omp', mode: 'DELEGATE', via: 'headless', task: 'Check the band line api_key=hunter2hunter2\nSECRET second line of the task', text: 'framed SECRET request' });
  state.setPeerTarget('magi-open0001', { harness: 'omp', id: null, headless: true, name: 'Polished-2' }, 1);
  state.registerWorker({ taskId: 'magi-open0001', harness: 'omp', bin: 'omp', cwd: ws, round: 1 });
  state.recordExchange('magi-open0001', { kind: 'note', round: 1, from: 'omp', to: 'claude', text: `Reading src/status.mjs now.\n${'x'.repeat(300)} SECRET TAIL` });
  state.recordCardDelivery('magi-open0001', 1, { to: 'omp', deliveryStatus: 'running', via: 'headless', at: now - 2900 });
  state.recordCardDelivery('magi-open0001', 1, { to: 'claude', deliveryStatus: 'queued_unread', via: 'live', at: now - 2500 });
  task('magi-asks0001', 'omp', [{ round: 1, openedAt: now - 2000 }]);
  state.recordExchange('magi-asks0001', { kind: 'question', round: 1, questionId: 'q-1', from: 'omp', text: 'Which branch should I read?' });
  // An unnamed live omp session that is not listed now, and an unnamed headless run.
  task('magi-anon0001', 'omp', [{ round: 1, openedAt: now - 1500 }], { peerTarget: { agent: 'omp', id: '01a118ef-0000-4000-8000-000000000001' } });
  task('magi-head0001', 'omp', [{ round: 1, openedAt: now - 1200 }], { peerTarget: { harness: 'omp', id: null, headless: true } });
  task('magi-stale001', 'omp', [{ round: 1, openedAt: now - 9 * 60 * 60 * 1000 }]);
  task('magi-fail0001', 'omp', [{ round: 1, openedAt: now - 4000, closedAt: now - 3500, closeReason: 'delivery_failed', closeCode: 'NO_LIVE_PEER' }]);
  task('magi-owed0001', 'codex', [{ round: 1, openedAt: now - 5000, replied: true, repliedAt: now - 4000, replySeq: 1 }], { replySeq: 1 });
  state.recordExchange('magi-owed0001', { kind: 'reply', round: 1, from: 'codex', text: `password=hunter2hunter2 ${'y'.repeat(120)} SECRET TAIL` });
  for (let i = 0; i < 6; i++) {
    task(`magi-done000${i}`, 'codex', [{ round: 1, openedAt: now - 60000, replied: true, repliedAt: now - 50000, replySeq: 1, usage: { costUsd: 0.25 } }], {
      replySeq: 1,
      outcome: { accepted: i, rejected: 1, open: 0, notes: 'SECRET NOTES', round: 1, at: now - 10000 + i, seq: 1, seen: [1] },
    });
  }
  // Codex disabled: its unit reads as such, and no app-server is spawned.
  setProvider('codex', false);

  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--cwd', ws], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout) < 40000);
  // Secrets are redacted, and nothing past a message's first line or its cut leaves.
  assert.doesNotMatch(r.stdout, /SECRET|hunter2/);
  const s = JSON.parse(r.stdout);

  assert.equal(s.v, 1);
  assert.equal(s.cwd, ws);
  assert.deepEqual(s.units.map((u) => [u.unit, u.harness]), [['MELCHIOR-1', 'claude'], ['BALTHASAR-2', 'codex'], ['CASPER-3', 'omp']]);
  const unit = Object.fromEntries(s.units.map((u) => [u.harness, u]));
  assert.equal(unit.codex.state, 'disabled');
  assert.equal(unit.omp.state, 'active', 'four open cards wait on omp');
  assert.equal(unit.omp.openCards, 4);
  assert.deepEqual(s.providers.map((p) => p.name), ['claude', 'codex', 'omp']);
  assert.equal(s.providers[1].status, 'disabled');

  assert.deepEqual(s.cards.map((c) => c.taskId), ['magi-open0001', 'magi-asks0001', 'magi-anon0001', 'magi-head0001'], 'oldest first; the stale and the failed card are not in flight');
  assert.deepEqual(Object.keys(s.cards[0]).sort(), ['brief', 'coordinator', 'delivery', 'from', 'lastExchangeAt', 'maxRounds', 'mode', 'openedAt', 'questionAt', 'recent', 'round', 'taskId', 'to', 'turn', 'worker']);
  const [working, asking, anon, headless] = s.cards;
  const note = state.readExchange('magi-open0001').find((e) => e.kind === 'note');
  const question = state.readExchange('magi-asks0001').find((e) => e.kind === 'question');
  assert.equal(working.brief, 'Check the band line [REDACTED]', 'the first line only, redacted');
  assert.deepEqual(working.coordinator, { harness: 'claude', name: 'Gen 2 Boogaloo', ids: ['sess-0001'] });
  const registered = state.readWorker('magi-open0001');
  assert.deepEqual({ ...working.worker, lastSaid: undefined }, {
    harness: 'omp', name: 'Polished-2', id: null, live: false, state: 'working', lastActivityAt: note.at, lastSaid: undefined, via: 'headless',
    timeoutAt: registered.startedAt + registered.timeoutMs,
    waitingFor: null,
    // On this machine: a remote worker names its host (test/remote-worker.test.mjs).
    host: null,
  });
  assert.equal(working.worker.lastSaid.length, 140);
  assert.match(working.worker.lastSaid, /^Reading src\/status\.mjs now\. x+…$/, 'one line, cut to 140 characters');
  assert.deepEqual(working.delivery, [{ to: 'claude', status: 'queued_unread', at: now - 2500 }, { to: 'omp', status: 'running', at: now - 2900 }]);
  assert.equal(working.lastExchangeAt, note.at);
  assert.deepEqual(working.recent.map((m) => [m.from, m.kind, m.text.length]), [['claude', 'request', 'Check the band line [REDACTED]'.length], ['omp', 'note', 100]]);
  assert.equal(working.questionAt, null);
  // No recorded session: not live, state unknown, its question its latest words and when it was asked.
  assert.deepEqual(asking.worker, { harness: 'omp', name: 'omp', id: null, live: false, state: 'unknown', waitingFor: null, lastActivityAt: question.at, lastSaid: 'Which branch should I read?', via: 'live', timeoutAt: null, host: null });
  assert.equal(asking.questionAt, question.at);
  assert.deepEqual(asking.coordinator, { harness: 'claude', name: 'claude', ids: [] });
  assert.equal(asking.brief, null);
  assert.deepEqual(asking.delivery, []);
  // Never a bare id: an unnamed session reads `omp session 01a118ef`, an unnamed headless run `headless omp`.
  assert.deepEqual([anon.worker.name, anon.worker.id, anon.worker.state], ['omp session 01a118ef', '01a118ef', 'unknown']);
  assert.deepEqual([headless.worker.name, headless.worker.via], ['headless omp', 'headless']);
  assert.deepEqual(s.cards.map((c) => c.turn), ['peer', 'orchestrator', 'peer', 'peer'], 'an unanswered question hands the turn back');
  assert.equal(s.cardsTotal, 4);

  assert.equal(s.unreconciled, 1, 'the answered card with no outcome');
  assert.deepEqual(s.outcomes.map((o) => o.taskId), ['magi-done0005', 'magi-done0004', 'magi-done0003', 'magi-done0002', 'magi-done0001']);
  assert.deepEqual(s.outcomes[0], { taskId: 'magi-done0005', mode: 'REVIEW', from: 'claude', to: 'codex', accepted: 5, rejected: 1, open: 0, at: now - 10000 + 5 });

  // The last messages on any card, newest first; `to` filled in from the card.
  assert.deepEqual(s.exchanges.map((x) => [x.taskId, x.from, x.to, x.kind]), [
    ['magi-owed0001', 'codex', 'claude', 'reply'],
    ['magi-asks0001', 'omp', 'claude', 'question'],
    ['magi-open0001', 'omp', 'claude', 'note'],
    ['magi-open0001', 'claude', 'omp', 'request'],
  ]);
  assert.match(s.exchanges[0].text, /^\[REDACTED\] y+…$/);
  assert.equal([...s.exchanges[0].text].length, 100);

  // The week: every card opened in it, checked or not, by mode and direction, and the priced headless runs.
  assert.deepEqual(s.ledger.total, { cards: 13, checked: 6, accepted: 15, rejected: 6, open: 0, heldPct: 71 });
  assert.deepEqual(s.ledger.byMode.map((b) => [b.mode, b.cards]), [['REVIEW', 12], ['DELEGATE', 1]]);
  assert.deepEqual(s.ledger.byDirection.map((b) => [b.from, b.to, b.cards, b.checked]), [['claude', 'codex', 7, 6], ['claude', 'omp', 6, 0]]);
  assert.deepEqual([s.ledger.costUsd, s.ledger.pricedRuns], [1.5, 6]);
  assert.deepEqual(s.failures, [{ taskId: 'magi-fail0001', from: 'claude', to: 'omp', code: 'NO_LIVE_PEER', at: now - 3500, coordinatorIds: [] }]);
});

test('magi status lists at most 20 cards and keeps under 40 KB by dropping the newest cards\' message lines first', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const state = await import('../src/state.mjs');
  const { setProvider } = await import('../src/providers.mjs');
  setProvider('codex', false);
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const taskId = `magi-size${String(i).padStart(4, '0')}`;
    setRecord(home, 'tasks', taskId, { taskId, orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', maxRounds: 2, cwd: ws, rounds: [{ round: 1, openedAt: now - 100000 + i }] });
    // Two and four bytes a character: twenty such cards with their message lines are ~54 KB, without them ~30 KB.
    state.recordExchange(taskId, { kind: 'request', round: 1, from: 'claude', to: 'omp', via: 'live', task: 'é'.repeat(200) });
    state.recordExchange(taskId, { kind: 'note', round: 1, from: 'omp', to: 'claude', text: `${'𝄞'.repeat(300)} first` });
    state.recordExchange(taskId, { kind: 'note', round: 1, from: 'omp', to: 'claude', text: '𝄞'.repeat(300) });
  }

  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--cwd', ws], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout.trim()) <= 40000, `${Buffer.byteLength(r.stdout)} bytes`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.cardsTotal, 30);
  assert.equal(s.cards.length, 20, 'dropping message lines was enough; no listed card was cut');
  assert.equal(s.cards[0].taskId, 'magi-size0000', 'oldest first');
  assert.equal(s.cards[0].recent.length, 3, 'the oldest keep their message lines');
  assert.deepEqual(s.cards.at(-1).recent, [], 'the newest lose theirs first');
  assert.ok(s.cards.every((c) => c.worker.lastSaid === `${'𝄞'.repeat(139)}…` && c.brief === `${'é'.repeat(139)}…`), 'every listed card keeps its words and brief');
  assert.equal(s.exchanges.length, 8);
});

test('magi status shows only the session\'s project: its checkout and the linked worktrees of it, not another project', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const state = await import('../src/state.mjs');
  const now = Date.now();
  // A checkout, a linked worktree of it beside it (its .git a file naming the checkout), and another project.
  const main = join(ws, 'main');
  const linked = join(ws, 'main-feature');
  const other = join(ws, 'other');
  mkdirSync(join(main, '.git', 'worktrees', 'main-feature'), { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'main-feature')}\n`);
  mkdirSync(join(other, '.git'), { recursive: true });
  const card = (taskId, cwd) => {
    setRecord(home, 'tasks', taskId, { taskId, orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', maxRounds: 2, cwd, rounds: [{ round: 1, openedAt: now - 5000 }] });
    state.recordExchange(taskId, { kind: 'request', round: 1, from: 'claude', to: 'omp', via: 'live', task: `work in ${taskId}` });
  };
  card('magi-here0001', main);
  card('magi-here0002', join(linked, 'src'));
  card('magi-away0001', other);

  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--cwd', main], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.cards.map((c) => c.taskId).sort(), ['magi-here0001', 'magi-here0002']);
  assert.equal(s.cardsTotal, 2);
  assert.deepEqual([...new Set(s.exchanges.map((e) => e.taskId))].sort(), ['magi-here0001', 'magi-here0002'], 'another project\'s messages stay out');
  assert.equal(s.ledger.total.cards, 2, 'the ledger is the project\'s');
});

test('magi exchange --json gives a card\'s whole conversation for the deck: the request\'s task, every reply in full, redacted, long ones cut with a pointer', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const state = await import('../src/state.mjs');
  const now = Date.now();
  setRecord(home, 'tasks', 'magi-full0001', { taskId: 'magi-full0001', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, cwd: ws, rounds: [{ round: 1, openedAt: now - 9000, replied: true }] });
  state.recordExchange('magi-full0001', { kind: 'request', round: 1, from: 'claude', to: 'omp', task: 'Review the deck.\napi_key=hunter2hunter2 second line', text: 'PEER REQUEST magi/1 framed' });
  state.recordExchange('magi-full0001', { kind: 'reply', round: 1, from: 'omp', to: 'claude', text: `SUMMARY\n${'x'.repeat(13_000)}` });
  state.recordExchange('magi-full0001', { kind: 'note', round: 1, from: 'omp', text: 'Line one.\nLine two of the note.' });

  const r = spawnSync(process.execPath, [CLI, 'exchange', 'magi-full0001', '--json'], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout);
  assert.deepEqual({ taskId: t.taskId, mode: t.mode, from: t.from, to: t.to, omitted: t.omitted }, { taskId: 'magi-full0001', mode: 'REVIEW', from: 'claude', to: 'omp', omitted: 0 });
  assert.deepEqual(t.messages.map((m) => [m.kind, m.from, m.to]), [['request', 'claude', 'omp'], ['reply', 'omp', 'claude'], ['note', 'omp', 'claude']]);
  assert.match(t.messages[0].text, /^Review the deck\.\n/, 'the task, not the framed request');
  assert.ok(!t.messages[0].text.includes('hunter2hunter2'), 'redacted');
  assert.equal(t.messages[2].text, 'Line one.\nLine two of the note.', 'whole, not one cut line');
  assert.ok(t.messages[1].text.endsWith('… 1008 more characters (magi exchange magi-full0001)'), t.messages[1].text.slice(-80));

  const unknown = spawnSync(process.execPath, [CLI, 'exchange', 'magi-nope', '--json'], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: home } });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /UNKNOWN_TASK|No task magi-nope/);
});

test('magi status refuses an unknown --as with its code and the fix', () => {
  const ws = makeWorkspace();
  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--as', 'nobody'], { encoding: 'utf-8', timeout: 60000, env: { ...process.env, MAGI_HOME: join(ws, 'home') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BAD_REQUEST: Unknown --as "nobody"\. Use "magi status --json --as <claude\|codex\|omp>"/);
});

// Codex's two databases as 0.160.1 lays them out, cut to the columns read.
async function codexHomeWith(dir, threads) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(join(dir, 'thread-writer-locks'), { recursive: true });
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.exec('create table threads (id text primary key, name text, cwd text, preview text, git_branch text, model text, agent_nickname text, agent_role text, recency_at int, archived int, source text)');
  const history = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  history.exec(`create table thread_turns (thread_id text, turn_id text, rollout_ordinal int, status text, started_at int, completed_at int);
    create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal int, created_at_ms int, item_json text, item_type text);`);
  const thread = state.prepare('insert into threads values (?, ?, ?, null, null, null, null, null, ?, ?, ?)');
  const turn = history.prepare('insert into thread_turns values (?, ?, 0, ?, ?, ?)');
  const item = history.prepare("insert into thread_items values (?, ?, ?, 0, ?, '{}', 'agentMessage')");
  for (const t of threads) {
    thread.run(t.id, t.id, t.cwd, t.startedAt, t.archived ? 1 : 0, t.source ?? 'vscode');
    turn.run(t.id, `${t.id}-turn`, t.status, t.startedAt, t.completedAt ?? null);
    for (const [i, at] of (t.items ?? []).entries()) item.run(t.id, `${t.id}-turn`, `${t.id}-${i}`, at);
    if (t.locked) writeFileSync(join(dir, 'thread-writer-locks', `${t.id}.lock`), '');
  }
  state.close();
  history.close();
}

function statusIn(ws, codexHome) {
  const env = {
    ...process.env,
    MAGI_HOME: join(ws, 'home'),
    HOME: ws, USERPROFILE: ws,
    CLAUDE_CONFIG_DIR: join(ws, 'claude-cfg'), CLAUDE_APP_SESSIONS_DIR: join(ws, 'claude-app'), OMP_AGENT_DIR: join(ws, 'omp-agent'),
    CODEX_HOME: codexHome,
    // Any app-server spawn fails: a clean answer proves none was needed.
    CODEX_BIN: join(ws, 'absent-codex'),
  };
  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--cwd', ws], { encoding: 'utf-8', timeout: 60000, env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('magi status counts the project\'s Codex threads from its databases, by their last item, without an app-server', async (t) => {
  try { await import('node:sqlite'); } catch { t.skip('node:sqlite unavailable on this Node'); return; }
  const ws = makeWorkspace();
  const codexHome = join(ws, 'codex-home');
  const now = Date.now();
  const s = (ms) => Math.floor((now - ms) / 1000);
  const H = 3600_000;
  await codexHomeWith(codexHome, [
    // A turn two hours long whose last item is two minutes old, its path in Windows' long form.
    { id: 'long-turn', cwd: `\\\\?\\${ws}`, status: 'inProgress', startedAt: s(2 * H), items: [now - 2 * H, now - 2 * 60_000] },
    // Working, but in another project: not this deck's business.
    { id: 'elsewhere', cwd: `${ws}-other project`, status: 'inProgress', startedAt: s(60_000), items: [now - 30_000] },
    { id: 'idle-here', cwd: ws, status: 'completed', startedAt: s(20 * 60_000), completedAt: s(10 * 60_000) },
    // A process that died mid-turn: inProgress, nothing for two hours.
    { id: 'dead-turn', cwd: ws, status: 'inProgress', startedAt: s(3 * H), items: [now - 2 * H] },
    // Quiet for two days but held open by the desktop.
    { id: 'open-quiet', cwd: ws, status: 'completed', startedAt: s(49 * H), completedAt: s(48 * H), locked: true },
    { id: 'saved', cwd: ws, status: 'completed', startedAt: s(49 * H), completedAt: s(48 * H) },
    // Not interactive threads: a headless exec run and an archived one.
    { id: 'headless', cwd: ws, status: 'inProgress', startedAt: s(60_000), items: [now - 30_000], source: 'exec' },
    { id: 'archived', cwd: ws, status: 'inProgress', startedAt: s(60_000), items: [now - 30_000], archived: true },
  ]);

  const st = statusIn(ws, codexHome);
  assert.equal(st.liveError, null, 'the databases answered; no app-server was asked');
  const codex = st.units.find((u) => u.harness === 'codex');
  assert.deepEqual(
    { state: codex.state, sessions: codex.sessions, working: codex.working },
    { state: 'active', sessions: 3, working: 1 },
    'live: the long turn (working), the idle thread, the open one; not another project\'s, the dead turn, the saved thread, exec or archived',
  );
});

test('magi status falls back to thread/list when Codex\'s databases cannot be read, and says so', async (t) => {
  try { await import('node:sqlite'); } catch { t.skip('node:sqlite unavailable on this Node'); return; }
  const ws = makeWorkspace();
  const codexHome = join(ws, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'state_5.sqlite'), 'not a database');
  writeFileSync(join(codexHome, 'thread_history_1.sqlite'), 'not a database');
  const st = statusIn(ws, codexHome);
  assert.match(st.liveError ?? '', /^codex: /, 'the app-server fallback ran and its failure is reported');
  assert.equal(st.units.find((u) => u.harness === 'codex').sessions, 0);
});

// A session idle past the hour is listed but not live. The card on it once
// read "session not found right now" with no activity time.
test('magi status matches a worker\'s session that is listed but no longer live, with its real state and when it changed', async () => {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  const { setRecord } = await import('../src/store.mjs');
  const { setProvider } = await import('../src/providers.mjs');
  setProvider('codex', false);
  const now = Date.now();
  const idleSince = now - 2 * 60 * 60 * 1000;
  const sessions = join(ws, 'claude-cfg', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'sess-idle-0001', cwd: ws, kind: 'interactive', name: 'Idle worker',
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-idle', status: 'idle', statusUpdatedAt: idleSince,
  }));
  setRecord(home, 'tasks', 'magi-idle0001', {
    taskId: 'magi-idle0001', orchestrator: 'omp', peer: 'claude', mode: 'DELEGATE', maxRounds: 2, cwd: ws,
    rounds: [{ round: 1, openedAt: now - 3 * 60 * 60 * 1000 }],
    peerTarget: { agent: 'claude', sessionId: 'sess-idle-0001', name: 'Idle worker' },
  });
  const st = statusIn(ws, join(ws, 'codex-home'));
  const card = st.cards.find((c) => c.taskId === 'magi-idle0001');
  assert.deepEqual(
    [card.worker.name, card.worker.live, card.worker.state, card.worker.lastActivityAt],
    ['Idle worker', false, 'idle', idleSince],
    'matched although not live: its state is idle, its activity time when it went idle',
  );
  assert.equal(st.units.find((u) => u.harness === 'claude').sessions, 0, 'a unit still counts live sessions only');
});

test('a session title made from a Magi request keeps only the words before the protocol line', async () => {
  const { sessionNameForTest } = await import('../src/status.mjs');
  assert.equal(sessionNameForTest('omp', { id: '01a118ef-aaaa' }, { purpose: 'Run Selected Checks and Report: PEER REQUEST magi/1 task_id=magi-1' }), 'Run Selected Checks and Report');
  assert.equal(sessionNameForTest('omp', { id: '01a118ef-aaaa' }, { purpose: 'PEER REQUEST magi/1 task_id=magi-1' }), 'omp session 01a118ef');
});
