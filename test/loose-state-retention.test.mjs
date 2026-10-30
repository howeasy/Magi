import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeWorkspace } from './helpers/harness.mjs';
import { getRecord, setRecord, statement, migrateLegacy } from '../src/store.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import * as state from '../src/state.mjs';
import magi from '../omp/magi-omp-extension.js';

function isolated(t) {
  const home = join(makeWorkspace('loose storage'), 'home');
  mkdirSync(home, { recursive: true });
  const saved = { MAGI_HOME: process.env.MAGI_HOME, MAGI_TEST_HOME: process.env.MAGI_TEST_HOME };
  process.env.MAGI_HOME = home;
  process.env.MAGI_TEST_HOME = home;
  setEmbedder(async () => Float32Array.of(1, 0));
  t.after(() => {
    setEmbedder(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return home;
}
function legacy(home, relative, value) {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}
function closed(home, id, at = Date.now() - 31 * 86400000) {
  const task = { taskId: id, cwd: home, orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, rounds: [{ round: 1, openedAt: at - 2, replied: true, repliedAt: at - 1 }], outcome: { accepted: 1, rejected: 0, open: 0, notes: 'held after reproducing', at, seen: [1] } };
  setRecord(home, 'tasks', id, task);
  state.recordExchange(id, { kind: 'request', task: `Inspect ${id}`, context: 'Important context', round: 1 });
  state.recordExchange(id, { kind: 'reply', text: 'Reproduced stale cache', round: 1, evidence: 'fixture' });
  return task;
}

test('explicit migration upgrades already-migrated homes, verifies loose records and preserves failed frames', (t) => {
  const home = isolated(t);
  // The ledger was migrated before this release; its marker must not suppress the new import.
  setRecord(home, 'tasks', 'existing', { taskId: 'existing', rounds: [] });
  migrateLegacy(home);
  statement(home, 'DELETE FROM metadata WHERE key=?').run('loose-state-import');
  const status = { sessionId: '12345678', at: Date.now(), rateLimits: { five_hour: { used_percentage: 18 } } };
  const files = [
    legacy(home, 'usage/claude/12345678.json', status),
    legacy(home, 'statusline-chain.json', { command: 'my-statusline' }),
    legacy(home, 'agents/456.json', { agent: 'omp', pid: 456, heartbeat: true }),
    legacy(home, 'inbox/456/a.json', { id: 'a', text: 'queued body', at: 1 }),
    legacy(home, 'inbox/456/processing/b.json', { id: 'b', text: 'uncertain body', at: 2 }),
    legacy(home, 'inbox/456/failed/c.json', { id: 'c', text: 'failed body', at: 3 }),
    legacy(home, 'inbox/456/d.json', '{broken'),
  ];
  const oldRequest = legacy(home, 'request-artifacts/request.md', 'read this request');
  const oldQueue = legacy(home, 'mail/queue.queue.md', 'read this queued message');
  assert.equal(getRecord(home, 'usage-claude', '12345678'), null, 'ordinary database reads do not import');
  const counts = migrateLegacy(home);
  assert.equal(counts.tables.looseRecords, 3);
  assert.equal(counts.tables.frames, 4);
  assert.deepEqual(getRecord(home, 'usage-claude', '12345678'), status);
  assert.equal(getRecord(home, 'settings', 'statusline-chain').command, 'my-statusline');
  assert.equal(getRecord(home, 'agents', '456').pid, 456);
  assert.deepEqual(statement(home, 'SELECT id,state FROM frames ORDER BY id').all().map((row) => [row.id, row.state]), [['a', 'queued'], ['b', 'processing'], ['c', 'failed'], ['d', 'failed']]);
  for (const path of files) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(join(home, 'spill', 'request.md'), 'utf8'), 'read this request');
  assert.equal(readFileSync(join(home, 'spill', 'queue.queue.md'), 'utf8'), 'read this queued message');
  assert.equal(existsSync(oldRequest), false);
  assert.equal(existsSync(oldQueue), false);
  migrateLegacy(home);
  assert.equal(statement(home, 'SELECT count(*) AS n FROM frames').get().n, 4);
  assert.equal(getRecord(home, 'tasks', 'existing').taskId, 'existing');
});

test('malformed usage and conflicting destinations refuse deletion and retain the destination', (t) => {
  const home = isolated(t);
  const source = legacy(home, 'usage/claude/12345678.json', '{broken');
  const taskFile = legacy(home, 'tasks/core.json', { taskId: 'core', rounds: [] });
  assert.throws(() => migrateLegacy(home), { code: 'MIGRATION_FAILED' });
  assert.equal(readFileSync(source, 'utf8'), '{broken');
  assert.equal(getRecord(home, 'tasks', 'core'), null, 'failed loose import rolls back core import too');
  assert.equal(existsSync(taskFile), true);
  writeFileSync(source, JSON.stringify({ sessionId: '12345678', at: 1 }));
  setRecord(home, 'usage-claude', '12345678', { sessionId: '12345678', at: 2 });
  assert.throws(() => migrateLegacy(home), { code: 'MIGRATION_FAILED' });
  assert.equal(getRecord(home, 'usage-claude', '12345678').at, 2);
  assert.equal(existsSync(source), true);
});

test('usage and uninstall chain use one legacy snapshot without modifying legacy sources', async (t) => {
  const home = isolated(t);
  const id = '12345678';
  const source = legacy(home, `usage/claude/${id}.json`, { sessionId: id, at: Date.now(), contextWindow: { used_percentage: 12 } });
  const chain = legacy(home, 'statusline-chain.json', { command: 'original' });
  const usage = await import('../src/usage.mjs?' + Math.random());
  assert.equal(usage.claudeSessionStatus(id).contextPercent, 12);
  assert.deepEqual(usage.readChain(), { command: 'original' });
  writeFileSync(source, JSON.stringify({ sessionId: id, at: Date.now(), contextWindow: { used_percentage: 99 } }));
  writeFileSync(chain, JSON.stringify({ command: 'replaced' }));
  assert.equal(usage.claudeSessionStatus(id).contextPercent, 12, 'legacy fallback is read once');
  usage.recordClaudeStatus({ session_id: id, context_window: { used_percentage: 31 } });
  assert.equal(usage.claudeSessionStatus(id).contextPercent, 31, 'database wins over fallback');
  usage.writeChain(null);
  assert.equal(usage.readChain(), null, 'uninstall never resurrects legacy command');
  const restarted = await import('../src/usage.mjs?' + Math.random());
  assert.equal(restarted.readChain(), null);
  assert.equal(existsSync(source), true);
  assert.equal(readFileSync(chain, 'utf8'), JSON.stringify({ command: 'replaced' }));
});

test('spill sweep deletes only files older than seven days and preserves database requests', async (t) => {
  const home = isolated(t);
  const old = state.putRequestBody('old', 'exact request\n%literal%');
  const fresh = state.putRequestBody('fresh', 'fresh request');
  assert.equal(dirname(old), join(home, 'spill'));
  assert.equal(readFileSync(old, 'utf8'), 'exact request\n%literal%');
  utimesSync(old, new Date(0), new Date(Date.now() - 8 * 86400000));
  const status = { sessionId: 'stale', at: 0 };
  setRecord(home, 'usage-claude', 'stale', status);
  await state.sweep();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(getRecord(home, 'requests', 'old'), 'exact request\n%literal%');
  assert.equal(getRecord(home, 'usage-claude', 'stale'), null);
});

test('retention awaits a persisted embedding and refuses to trim a reopened card', async (t) => {
  const home = isolated(t);
  closed(home, 'old');
  let embedStarted;
  const started = new Promise((resolve) => { embedStarted = resolve; });
  let finish;
  setEmbedder(() => { embedStarted(); return new Promise((resolve) => { finish = resolve; }); });
  const run = state.sweep();
  await started;
  assert.equal(state.readExchange('old')[1].text, 'Reproduced stale cache');
  state.openRound({ taskId: 'old', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', round: 2 });
  finish(Float32Array.of(1, 0));
  await run;
  assert.equal(state.readExchange('old')[1].text, 'Reproduced stale cache');
  assert.equal(state.readTask('old').bodiesTrimmedAt, undefined);
  assert.ok(statement(home, 'SELECT vector FROM memory').get().vector);
});

test('embedding failure retains bodies and a later sweep retries the same summary', async (t) => {
  const home = isolated(t);
  const task = closed(home, 'retry');
  setEmbedder(async () => { throw new Error('offline'); });
  const warn = console.warn;
  console.warn = () => {};
  try { await state.sweep(); } finally { console.warn = warn; }
  assert.deepEqual(state.readTask('retry'), task);
  assert.equal(state.readExchange('retry')[1].text, 'Reproduced stale cache');
  setEmbedder(async () => Float32Array.of(1, 0));
  await state.sweep();
  const after = state.readTask('retry');
  assert.equal(state.readExchange('retry')[1].text, `[trimmed after 30 days; summary in memory ${after.summaryMemoryId}]`);
  assert.equal(statement(home, 'SELECT count(*) AS n FROM memory').get().n, 1);
  assert.deepEqual(after.outcome, task.outcome);
});

test('retention is bounded and leaves the exact thirty-day boundary intact', async (t) => {
  const home = isolated(t);
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (let i = 0; i <= state.SWEEP_TASKS_PER_RUN; i++) closed(home, `old-${i}`);
    const boundary = closed(home, 'boundary', now - 30 * 86400000);
    await state.sweep();
    assert.equal(state.listTasks().filter((task) => task.bodiesTrimmedAt).length, state.SWEEP_TASKS_PER_RUN);
    assert.deepEqual(state.readTask('boundary'), boundary);
    await state.sweep();
    assert.equal(state.listTasks().filter((task) => task.bodiesTrimmedAt).length, state.SWEEP_TASKS_PER_RUN + 1);
    assert.equal(statement(home, 'SELECT count(*) AS n FROM memory').get().n, state.SWEEP_TASKS_PER_RUN + 1);
  } finally { Date.now = realNow; }
});

test('two drains cannot submit the same claimed row and malformed rows fail once', async (t) => {
  const home = isolated(t);
  const ticks = [], shutdowns = [];
  let calls = 0, finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  for (let i = 0; i < 2; i++) {
    const handlers = {};
    magi({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage: () => { calls++; return pending; }, logger: { warn() {} } });
    const ctx = { cwd: home, isIdle: () => true, sessionManager: { getSessionId: () => 'same-session' }, setInterval: (fn) => { ticks.push(fn); return () => {}; } };
    handlers.session_start({}, ctx);
    shutdowns.push(() => handlers.session_shutdown({}, ctx));
  }
  t.after(() => { for (const shutdown of shutdowns) shutdown(); });
  const insert = statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)");
  insert.run(process.pid, 'good', JSON.stringify({ id: 'good', text: 'one message' }), 1);
  for (const [id, body] of [['broken', '{broken'], ['empty', '{"id":"empty","text":"  "}'], ['wrong', '{"id":"another","text":"message"}']]) insert.run(process.pid, id, body, 2);
  const first = ticks[0]();
  await ticks[1]();
  assert.equal(calls, 1);
  assert.equal(statement(home, 'SELECT state FROM frames WHERE id=?').get('good').state, 'processing');
  finish();
  await first;
  await ticks[0]();
  await ticks[1]();
  assert.equal(calls, 1);
  assert.equal(statement(home, 'SELECT state FROM frames WHERE id=?').get('good'), undefined);
  for (const id of ['broken', 'empty', 'wrong']) assert.equal(statement(home, 'SELECT state FROM frames WHERE id=?').get(id).state, 'failed');
});

test('extension and bridge upgrade the old records schema without losing settings', (t) => {
  const home = isolated(t);
  const old = new DatabaseSync(join(home, 'magi.db'));
  old.exec('CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),PRIMARY KEY(namespace,key))');
  old.prepare('INSERT INTO records VALUES(?,?,?)').run('settings', 'other', '{"keep":true}');
  old.close();
  const handlers = {};
  magi({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage() {}, logger: { warn() {} } });
  const ctx = { cwd: home, sessionManager: { getSessionId: () => 'upgraded' }, setInterval: () => () => {} };
  handlers.session_start({}, ctx);
  t.after(() => handlers.session_shutdown({}, ctx));
  assert.deepEqual(getRecord(home, 'settings', 'other'), { keep: true });
  assert.equal(getRecord(home, 'agents', String(process.pid)).sessionId, 'upgraded');
  const heartbeat = statement(home, "SELECT updated_at FROM records WHERE namespace='agents' AND key=?").get(String(process.pid));
  assert.ok(heartbeat.updated_at > 0);
});
