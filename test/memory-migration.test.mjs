import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './helpers/harness.mjs';
import { database, migrateLegacy } from '../src/store.mjs';
import * as memory from '../src/memory.mjs';

function fresh() {
  const ws = makeWorkspace();
  const home = join(ws, 'home');
  process.env.MAGI_HOME = home;
  process.env.MAGI_TEST_HOME = home;
  mkdirSync(home, { recursive: true });
  return { ws, home, db: database(home) };
}
function legacy(home, bank, file = 'm-legacy.md', body = 'Storage migrations preserve evidence.') {
  const directory = join(home, 'memory', bank);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  const text = `---\nid: m-legacy\nat: 2026-10-01T00:00:00.000Z\nfrom: claude\ntags: storage, evidence\ntask: magi-old\nuntil: 2099-01-01\n---\n${body}\n`;
  writeFileSync(path, text);
  return { path, text };
}

test('only explicit migration imports markdown, preserves metadata and banks, and runs once', async () => {
  const { ws, home, db } = fresh();
  const source = legacy(home, memory.bankFor(ws));
  const global = legacy(home, '_global', 'm-global.md', 'Shared global evidence.');
  assert.deepEqual(await memory.recall({ query: 'storage', cwd: ws }), []);
  assert.equal(readFileSync(source.path, 'utf8'), source.text);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 0);
  const counts = migrateLegacy(home);
  assert.equal(counts.tables.memory, 2);
  assert.equal(existsSync(source.path), false);
  assert.equal(existsSync(global.path), false);
  const hit = (await memory.recall({ query: 'storage', cwd: ws }))[0];
  assert.equal(hit.id, 'm-legacy');
  assert.equal(hit.from, 'claude');
  assert.deepEqual(hit.tags, ['storage', 'evidence']);
  const row = db.prepare('SELECT value,vector FROM memory WHERE bank=?').get(memory.bankFor(ws));
  assert.equal(JSON.parse(row.value).taskId, 'magi-old');
  assert.equal(JSON.parse(row.value).validUntil, '2099-01-01');
  assert.equal(row.vector, null);
  assert.equal((await memory.recall({ query: 'global', scope: 'global', cwd: ws }))[0].content, 'Shared global evidence.');
  assert.equal(migrateLegacy(home).tables.memory, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 2);
});

test('a home already migrated by the core cutover can import memory explicitly', async () => {
  const { ws, home, db } = fresh();
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('legacy-import', JSON.stringify({ counts: { tables: {}, namespaces: {} }, manifest: [] }));
  const source = legacy(home, memory.bankFor(ws));
  assert.equal(migrateLegacy(home).tables.memory, 1);
  assert.equal(existsSync(source.path), false);
  assert.equal((await memory.recall({ query: 'storage', cwd: ws }))[0].id, 'm-legacy');
});

test('migration redacts bodies tags and source metadata before database persistence', () => {
  const { ws, home, db } = fresh();
  const source = legacy(home, memory.bankFor(ws));
  writeFileSync(source.path, '---\nid: m-legacy\nat: 2026-10-01T00:00:00.000Z\nfrom: token=sourcesecret\ntags: storage, token="tagsecret,tailsecret"\ntask: token=tasksecret\n---\nconst safe = true;\npassword=bodysecret\n');
  migrateLegacy(home);
  const value = db.prepare('SELECT value FROM memory WHERE bank=? AND id=?').get(memory.bankFor(ws), 'm-legacy').value;
  assert.doesNotMatch(value, /sourcesecret|tagsecret|tailsecret|tasksecret|bodysecret/);
  const unit = JSON.parse(value);
  assert.equal(unit.from, '[REDACTED]');
  assert.deepEqual(unit.tags, ['storage', '[REDACTED]']);
  assert.equal(unit.taskId, '[REDACTED]');
  assert.equal(unit.content, 'const safe = true;\n[REDACTED]');
  assert.equal(existsSync(source.path), false);
});

test('populated memory refuses import without changing current data or deleting sources', async () => {
  const { ws, home, db } = fresh();
  const item = await memory.remember({ body: 'Current database evidence is authoritative.', cwd: ws });
  const source = legacy(home, memory.bankFor(ws));
  assert.throws(() => migrateLegacy(home), (error) => error.code === 'MIGRATION_FAILED' && /populated/.test(error.message));
  assert.equal(readFileSync(source.path, 'utf8'), source.text);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 1);
  assert.equal((await memory.recall({ query: 'authoritative', cwd: ws }))[0].id, item.id);
});

test('malformed markdown rolls back both core state and memory, keeping every source', () => {
  const { ws, home, db } = fresh();
  const source = legacy(home, memory.bankFor(ws));
  const invalid = join(home, 'memory', memory.bankFor(ws), 'invalid.md');
  writeFileSync(invalid, 'not a memory unit');
  mkdirSync(join(home, 'tasks'));
  const task = join(home, 'tasks', 'task.json');
  writeFileSync(task, JSON.stringify({ taskId: 'task' }));
  assert.throws(() => migrateLegacy(home), { code: 'MIGRATION_FAILED' });
  assert.equal(readFileSync(source.path, 'utf8'), source.text);
  assert.equal(existsSync(invalid), true);
  assert.equal(existsSync(task), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 0);
});

test('duplicate memory keys refuse the whole import', () => {
  const { ws, home, db } = fresh();
  const first = legacy(home, memory.bankFor(ws), 'one.md');
  const second = legacy(home, memory.bankFor(ws), 'two.md');
  assert.throws(() => migrateLegacy(home), (error) => error.code === 'MIGRATION_FAILED' && /collision/.test(error.message));
  assert.equal(existsSync(first.path), true);
  assert.equal(existsSync(second.path), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 0);
});

test('interrupted memory cleanup resumes without importing a second copy', () => {
  const { ws, home, db } = fresh();
  const source = legacy(home, memory.bankFor(ws));
  db.exec("CREATE TRIGGER interrupt_memory BEFORE UPDATE ON metadata WHEN NEW.key='memory-import' BEGIN SELECT RAISE(ABORT,'interrupted memory cleanup'); END");
  assert.throws(() => migrateLegacy(home), /interrupted memory cleanup/);
  assert.equal(existsSync(source.path), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 1);
  db.exec('DROP TRIGGER interrupt_memory');
  assert.equal(migrateLegacy(home).tables.memory, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory').get().n, 1);
});

test('the memory CLI reports fallback and exports markdown without overwriting', async () => {
  const { ws, home } = fresh();
  const item = await memory.remember({ body: 'A release needs the signed artifact.', tags: ['release'], cwd: ws });
  const cli = fileURLToPath(new URL('../bin/magi.mjs', import.meta.url));
  const run = (args) => execFileSync(process.execPath, [cli, 'memory', ...args, '--cwd', ws], { encoding: 'utf8', env: { ...process.env, MAGI_HOME: home, MAGI_TEST_HOME: home } });
  assert.match(run(['recall', 'release']), /MEMORY_KEYWORD_ONLY/);
  const directory = join(ws, 'export');
  assert.match(run(['export', '--out', directory]), /Exported 1 memory units/);
  const file = join(directory, readdirSync(directory)[0]);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(`id: ${item.id}\nbank: ${memory.bankFor(ws)}\n`));
  assert.match(text, /tags: release\n---\nA release needs the signed artifact\./);
  assert.throws(() => run(['export', '--out', directory]), /MEMORY_EXPORT_EXISTS/);
  assert.equal(readFileSync(file, 'utf8'), text);
});
