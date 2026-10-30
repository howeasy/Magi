import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as state from '../src/state.mjs';
import { database, getRecord, setRecord, migrateLegacy } from '../src/store.mjs';

function home() {
  const path = mkdtempSync(join(tmpdir(), 'magi-store-'));
  const profile = join(path, 'profile');
  Object.assign(process.env, {
    MAGI_HOME: path, MAGI_TEST_HOME: path, HOME: profile, USERPROFILE: profile,
    APPDATA: join(profile, 'AppData'), CLAUDE_CONFIG_DIR: join(profile, 'claude'),
    CODEX_HOME: join(profile, 'codex'), OMP_AGENT_DIR: join(profile, 'omp'),
    CLAUDE_APP_SESSIONS_DIR: join(profile, 'claude-sessions'),
  });
  return path;
}
function legacy(path, directory, name, value) {
  mkdirSync(join(path, directory), { recursive: true });
  writeFileSync(join(path, directory, name), typeof value === 'string' ? value : JSON.stringify(value));
}
const task = (taskId) => ({ taskId, orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, rounds: [{ round: 1, openedAt: 1, replied: false }] });
const stateUrl = new URL('../src/state.mjs', import.meta.url).href;

function child(source, path) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { env: { ...globalThis.process.env, MAGI_HOME: path }, windowsHide: true });
  let stderr = '';
  let stdout = '';
  process.stderr.on('data', (data) => stderr += data);
  process.stdout.on('data', (data) => stdout += data);
  const done = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  return { process, done };
}

test('verified import preserves every legacy record type, text and historical verdicts exactly once', () => {
  const path = home();
  const id = 'cx-id / unicode-é';
  legacy(path, 'tasks', `${encodeURIComponent(id)}.json`, task(id));
  legacy(path, 'mail', `${encodeURIComponent(id)}.round-1.json`, { round: 1, body: 'answer' });
  legacy(path, 'mail', `${encodeURIComponent(id)}.request.md`, 'large request');
  legacy(path, 'mail', `${encodeURIComponent(id)}.waiting`, { pid: process.pid, round: 1, at: 1 });
  legacy(path, 'exchanges', `${encodeURIComponent(id)}.jsonl`, JSON.stringify({ kind: 'request', text: 'original', at: 1 }) + '\n{"torn":');
  legacy(path, 'notes', 'target.json', [{ at: 1, hash: 'abc' }]);
  legacy(path, 'queue-receipts', 'thread.json', { nextSequence: 2, entries: [{ clientId: 'receipt', state: 'pending', sequence: 1 }] });
  legacy(path, 'personas', `${encodeURIComponent('claude|omp|e:/repo|worker')}.json`, { agent: 'claude', peer: 'omp', cwd: 'E:/repo', name: 'worker', sessionId: 'session', runs: 2 });
  legacy(path, 'notices', 'n-old.json', { id: 'n-old', body: 'notice', at: 1, readAt: null });
  legacy(path, 'workers', 'worker.json', { taskId: 'worker', pid: process.pid, startedAt: 1 });
  writeFileSync(join(path, 'outcomes.jsonl'), JSON.stringify({ taskId: 'archived', peer: 'omp', orchestrator: 'claude', openedAt: 1, outcome: { accepted: 1, rejected: 0, open: 0 } }) + '\n');
  const counts = migrateLegacy(path);
  assert.equal(counts.namespaces.tasks, 1);
  assert.equal(counts.tables.exchanges, 1);
  assert.equal(counts.tables.mail, 1);

  assert.deepEqual(state.readTask(id), task(id));
  assert.equal(state.listMail(id)[0].body, 'answer');
  assert.equal(state.readExchange(id)[0].text, 'original');
  assert.equal(state.readPersona('claude', 'E:/repo', 'worker', 'omp').sessionId, 'session');
  assert.equal(state.readQueueReceipts('thread').entries[0].clientId, 'receipt');
  assert.equal(state.listNotices()[0].body, 'notice');
  assert.equal(state.listWorkers()[0].taskId, 'worker');
  assert.equal(getRecord(path, 'notes', 'target')[0].hash, 'abc');
  assert.equal(getRecord(path, 'requests', id), 'large request');
  assert.equal(state.isWaiting(id), false, 'old callbacks cannot resume in the new store');
  assert.equal(state.listTasksWithArchive().find((row) => row.taskId === 'archived').outcome.accepted, 1);
  for (const directory of ['tasks', 'mail', 'exchanges', 'notes', 'queue-receipts', 'personas', 'notices', 'workers']) assert.equal(existsSync(join(path, directory)), false);
  assert.equal(existsSync(join(path, 'outcomes.jsonl')), false);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as s from ${JSON.stringify(stateUrl)}; console.log(JSON.stringify([s.listTasks().length,s.readExchange(${JSON.stringify(id)}).length]));`], { env: { ...process.env, MAGI_HOME: path }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [1, 1]);
});

test('failed import rolls back every row and retains all source files for repair', () => {
  const path = home();
  legacy(path, 'tasks', 'a.json', task('a'));
  legacy(path, 'tasks', 'b.json', '{broken');
  assert.throws(() => migrateLegacy(path), { code: 'MIGRATION_FAILED' });
  assert.equal(existsSync(join(path, 'tasks', 'a.json')), true);
  assert.equal(existsSync(join(path, 'tasks', 'b.json')), true);
  const db = new DatabaseSync(join(path, 'magi.db'));
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM records').get().count, 0); } finally { db.close(); }
  writeFileSync(join(path, 'tasks', 'b.json'), JSON.stringify(task('b')));
  migrateLegacy(path);
  assert.deepEqual(state.listTasks().map((row) => row.taskId).sort(), ['a', 'b']);
});

test('reply publication rolls back when its ledger update fails', () => {
  const path = home();
  state.openRound({ taskId: 'atomic', orchestrator: 'claude', peer: 'omp', round: 1 });
  const db = database(path);
  db.exec("CREATE TEMP TRIGGER reject_update BEFORE UPDATE ON records WHEN NEW.namespace='tasks' BEGIN SELECT RAISE(ABORT,'write failed'); END;");
  assert.throws(() => state.recordReply({ taskId: 'atomic', from: 'omp', payload: { body: 'not committed' } }), /write failed/);
  assert.equal(state.readTask('atomic').rounds[0].replied, false);
  assert.deepEqual(state.listMail('atomic'), []);
  db.exec('DROP TRIGGER reject_update');
  state.recordReply({ taskId: 'atomic', from: 'omp', payload: { body: 'committed' } });
  assert.equal(state.takeReply('atomic', 1).body, 'committed');
});

test('concurrent waiters on one round receive the same reply without clearing one another', async () => {
  home();
  const first = state.waitForReply('shared', 3000, undefined, 1);
  const second = state.waitForReply('shared', 3000, undefined, 1);
  state.putReply('shared', { round: 1, body: 'both' });
  assert.deepEqual((await Promise.all([first, second])).map((reply) => reply.body), ['both', 'both']);
  assert.equal(state.isWaiting('shared'), false);
  assert.deepEqual(state.listMail('shared'), []);
});

test('a cancelled waiter never drains a reply, including cancellation at an async poll boundary', async () => {
  home();
  state.putReply('cancel', { round: 1, body: 'retained' });
  const controller = new AbortController();
  const waiting = state.waitForReply('cancel', 3000, undefined, 1, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(state.isWaiting('cancel'), false);
  assert.equal(state.takeReply('cancel', 1).body, 'retained');
});

test('cancelling one waiter leaves another live waiter and its round untouched', async () => {
  home();
  const controller = new AbortController();
  const cancelled = state.waitForReply('separate', 3000, undefined, 1, controller.signal);
  const other = state.waitForReply('separate', 3000, undefined, 1);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(state.isWaiting('separate', 1), true);
  state.putReply('separate', { round: 2, body: 'later' });
  state.putReply('separate', { round: 1, body: 'current' });
  assert.equal((await other).body, 'current');
  assert.equal(state.takeReply('separate', 2).body, 'later');
});

test('multi-process waiters share a committed reply without consuming another round', async () => {
  const path = home();
  database(path);
  const source = `import * as s from ${JSON.stringify(stateUrl)}; const pending=s.waitForReply('multi',5000,undefined,1); console.log('ready'); const reply=await pending; console.log(JSON.stringify(reply));`;
  const a = child(source, path);
  const b = child(source, path);
  await Promise.all([a, b].map(({ process: proc }) => new Promise((resolve, reject) => {
    proc.stdout.once('data', resolve);
    proc.once('error', reject);
    proc.once('exit', () => reject(new Error('waiter exited early')));
  })));
  state.putReply('multi', { round: 1, body: 'shared across processes' });
  state.putReply('multi', { round: 2, body: 'next round' });
  for (const output of await Promise.all([a.done, b.done])) assert.equal(JSON.parse(output.trim().split('\n').at(-1)).body, 'shared across processes');
  assert.equal(state.takeReply('multi', 2).body, 'next round');
});

test('record retention leaves reply order and reconciliation evidence intact', () => {
  const path = home();
  const rec = task('retained');
  rec.rounds[0] = { round: 1, openedAt: 1, replied: true, repliedAt: 2, replySeq: 1 };
  rec.replySeq = 1;
  setRecord(path, 'tasks', 'retained', rec);
  state.recordExchange('retained', { kind: 'reply', round: 1, text: 'evidence' });
  state.putReply('retained', { round: 10, body: 'ten' });
  state.putReply('retained', { round: 2, body: 'two' });
  state.sweep(0);
  assert.deepEqual(state.readTask('retained'), rec);
  assert.deepEqual(state.unreconciledFor('claude'), ['retained']);
  assert.equal(state.takeReply('retained').body, 'two');
  assert.equal(state.takeReply('retained').body, 'ten');
});

test('a round-scoped drain prefers its numbered reply over the matching legacy slot', () => {
  const path = home();
  legacy(path, 'mail', 'same.json', { round: 1, body: 'legacy' });
  legacy(path, 'mail', 'same.round-1.json', { round: 1, body: 'numbered' });
  migrateLegacy(path);
  assert.equal(state.takeReply('same', 1).body, 'numbered');
  assert.equal(state.takeReply('same', 1).body, 'legacy');
});

test('simultaneous explicit migrations import history once and serialize verified deletion', async () => {
  const path = home();
  for (let i = 0; i < 20; i++) {
    legacy(path, 'tasks', `task-${i}.json`, task(`task-${i}`));
    legacy(path, 'exchanges', `task-${i}.jsonl`, JSON.stringify({ kind: 'request', text: `body-${i}` }) + '\n');
  }
  const storeUrl = new URL('../src/store.mjs', import.meta.url).href;
  const source = `import * as s from ${JSON.stringify(stateUrl)}; import {migrateLegacy} from ${JSON.stringify(storeUrl)}; await s.retryState(()=>migrateLegacy(s.magiHome()),5000); console.log(JSON.stringify([s.listTasks().length,s.readExchange('task-0').length]));`;
  const children = Array.from({ length: 4 }, () => child(source, path));
  for (const output of await Promise.all(children.map((item) => item.done))) assert.deepEqual(JSON.parse(output), [20, 1]);
  assert.equal(existsSync(join(path, 'tasks')), false);
  assert.equal(existsSync(join(path, 'exchanges')), false);
});

test('migration refuses a populated destination namespace without overwriting newer records or deleting sources', () => {
  const path = home();
  const newer = { ...task('a'), revision: 'newer SQLite record' };
  setRecord(path, 'tasks', 'a', newer);
  legacy(path, 'tasks', 'a.json', task('a'));
  legacy(path, 'exchanges', 'a.jsonl', '{"kind":"request","text":"legacy"}\n');
  assert.throws(() => migrateLegacy(path), (error) => error.code === 'MIGRATION_FAILED' && /populated/i.test(error.message) && error.message.includes('tasks'));
  assert.deepEqual(getRecord(path, 'tasks', 'a'), newer);
  assert.deepEqual(database(path).prepare('SELECT * FROM exchanges').all(), []);
  assert.equal(readFileSync(join(path, 'tasks', 'a.json'), 'utf8'), JSON.stringify(task('a')));
  assert.equal(readFileSync(join(path, 'exchanges', 'a.jsonl'), 'utf8'), '{"kind":"request","text":"legacy"}\n');
  assert.equal(database(path).prepare("SELECT value FROM metadata WHERE key='legacy-import'").get(), undefined);
});

test('decoded legacy key collisions cannot hide behind unrelated preexisting records', () => {
  const path = home();
  const unrelated = { body: 'retain unrelated destination record' };
  setRecord(path, 'notices', 'unrelated', unrelated);
  legacy(path, 'tasks', 'a.json', task('a'));
  legacy(path, 'tasks', '%61.json', { ...task('a'), revision: 'duplicate file' });
  assert.throws(() => migrateLegacy(path), (error) => error.code === 'MIGRATION_FAILED' && /collision/i.test(error.message));
  assert.equal(getRecord(path, 'tasks', 'a'), null);
  assert.deepEqual(getRecord(path, 'notices', 'unrelated'), unrelated);
  assert.equal(readFileSync(join(path, 'tasks', 'a.json'), 'utf8'), JSON.stringify(task('a')));
  assert.equal(readFileSync(join(path, 'tasks', '%61.json'), 'utf8'), JSON.stringify({ ...task('a'), revision: 'duplicate file' }));
});

test('migration into an empty namespace preserves unrelated namespaces and accepts repeated archive summaries', () => {
  const path = home();
  const unrelated = { body: 'newer notice' };
  setRecord(path, 'notices', 'unrelated', unrelated);
  legacy(path, 'tasks', 'a.json', task('a'));
  const first = { taskId: 'archived', outcome: { accepted: 0, rejected: 1, open: 0 } };
  const last = { taskId: 'archived', outcome: { accepted: 1, rejected: 0, open: 0 } };
  writeFileSync(join(path, 'outcomes.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`);
  const counts = migrateLegacy(path);
  assert.deepEqual(getRecord(path, 'tasks', 'a'), task('a'));
  assert.deepEqual(getRecord(path, 'notices', 'unrelated'), unrelated);
  assert.deepEqual(getRecord(path, 'archive', 'archived'), last);
  assert.equal(counts.tables.records, 2);
  assert.deepEqual(counts.namespaces, { tasks: 1, archive: 1 });
  assert.equal(existsSync(join(path, 'tasks', 'a.json')), false);
  assert.equal(existsSync(join(path, 'outcomes.jsonl')), false);
});

test('decoded key collisions report both legacy files and retain an empty destination', () => {
  const path = home();
  legacy(path, 'tasks', 'a.json', task('a'));
  legacy(path, 'tasks', '%61.json', task('a'));
  assert.throws(() => migrateLegacy(path), (error) => error.code === 'MIGRATION_FAILED' && /collision/i.test(error.message) && error.message.includes('a.json') && error.message.includes('%61.json'));
  assert.equal(existsSync(join(path, 'tasks', 'a.json')), true);
  assert.equal(existsSync(join(path, 'tasks', '%61.json')), true);
  assert.deepEqual(database(path).prepare('SELECT * FROM records').all(), []);
});

test('relative-home migration resumes cleanup from another cwd without deleting lookalike files', () => {
  const root = home();
  const originalCwd = process.cwd();
  const firstCwd = join(root, 'first');
  const secondCwd = join(root, 'second');
  const path = join(firstCwd, 'legacy');
  const source = join(path, 'tasks', 'resume.json');
  const original = JSON.stringify(task('resume'));
  mkdirSync(firstCwd, { recursive: true });
  mkdirSync(secondCwd, { recursive: true });
  legacy(path, 'tasks', 'resume.json', original);
  legacy(path, 'exchanges', 'resume.jsonl', '{"kind":"request","text":"only once"}\n');
  legacy(join(secondCwd, 'legacy'), 'tasks', 'resume.json', original);
  const lookalike = join(secondCwd, 'legacy', 'tasks', 'resume.json');
  const db = database(path);
  db.function('interrupt_before_unlink', () => {
    writeFileSync(source, JSON.stringify({ ...task('resume'), interrupted: true }));
    return 0;
  });
  db.exec("CREATE TEMP TRIGGER interrupt_manifest AFTER INSERT ON metadata WHEN NEW.key='legacy-import' BEGIN SELECT interrupt_before_unlink(); END;");
  try {
    process.chdir(firstCwd);
    assert.throws(() => migrateLegacy('legacy'), (error) => error.code === 'MIGRATION_FAILED' && /changed after import/.test(error.message));
    assert.equal(existsSync(source), true, 'interruption must precede the first source unlink');
    assert.equal(existsSync(join(path, 'exchanges', 'resume.jsonl')), true);
    assert.deepEqual(getRecord(path, 'tasks', 'resume'), task('resume'), 'the original import was committed');
    const committed = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='legacy-import'").get().value);
    db.exec('DROP TRIGGER interrupt_manifest');
    writeFileSync(source, original);
    process.chdir(secondCwd);
    migrateLegacy(relative(secondCwd, path));
    assert.equal(existsSync(source), false, 'resume cleans the original source rather than caller-relative paths');
    assert.equal(readFileSync(lookalike, 'utf8'), original, 'unrelated lookalike files must survive');
    assert.deepEqual(db.prepare('SELECT value FROM exchanges').all().map((row) => JSON.parse(row.value).text), ['only once']);
    assert.equal(committed.manifest.every((file) => isAbsolute(file.path)), true);
  } finally {
    process.chdir(originalCwd);
    db.exec('DROP TRIGGER IF EXISTS interrupt_manifest');
  }
});

test('rerunning explicit migration resumes its committed deletion manifest without duplicating exchanges', () => {
  const path = home();
  legacy(path, 'tasks', 'resume.json', task('resume'));
  legacy(path, 'exchanges', 'resume.jsonl', JSON.stringify({ kind: 'request', text: 'only once' }) + '\n');
  const db = new DatabaseSync(join(path, 'magi.db'));
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TRIGGER interrupt_cleanup BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'interrupted cleanup'); END;");
  db.close();
  assert.throws(() => migrateLegacy(path), /interrupted cleanup/);
  assert.equal(existsSync(join(path, 'tasks', 'resume.json')), false, 'files were removed after the import committed');
  const repair = new DatabaseSync(join(path, 'magi.db'));
  repair.exec('DROP TRIGGER interrupt_cleanup');
  repair.close();
  migrateLegacy(path);
  assert.deepEqual(state.readTask('resume'), task('resume'));
  assert.deepEqual(state.readExchange('resume').map((entry) => entry.text), ['only once']);
});

test('a library read without MAGI_HOME leaves the legacy home format untouched', () => {
  for (const directory of ['.magi']) {
    const profile = mkdtempSync(join(tmpdir(), 'magi-sandbox-profile-'));
    const path = join(profile, directory);
    legacy(path, 'tasks', 'untouched.json', task('untouched'));
    legacy(path, 'mail', 'untouched.json', { body: 'untouched reply' });
    legacy(path, 'exchanges', 'untouched.jsonl', '{"kind":"request","text":"untouched"}\n');
    const source = `import {homedir} from 'node:os'; import {resolve} from 'node:path'; if(resolve(homedir())!==resolve(${JSON.stringify(profile)})) throw new Error('Sandbox home not active; refusing state access'); const s=await import(${JSON.stringify(stateUrl)}); console.log(JSON.stringify([s.readTask('untouched'),s.listMail(),s.readExchange('untouched')]));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, MAGI_HOME: '', MAGI_TEST_HOME: '', USERPROFILE: profile, HOME: profile, NODE_OPTIONS: '' },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), [null, [], []]);
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'tasks', 'untouched.json'), 'utf8')), task('untouched'));
    assert.equal(JSON.parse(readFileSync(join(path, 'mail', 'untouched.json'), 'utf8')).body, 'untouched reply');
    assert.equal(readFileSync(join(path, 'exchanges', 'untouched.jsonl'), 'utf8'), '{"kind":"request","text":"untouched"}\n');
  }
});

test('test state access refuses missing isolation and the real home before opening storage', () => {
  const previous = { home: process.env.MAGI_HOME, marker: process.env.MAGI_TEST_HOME };
  try {
    process.env.MAGI_TEST_HOME = previous.marker || 'guard-regression';
    delete process.env.MAGI_HOME;
    assert.throws(() => state.readTask('forbidden'), { code: 'TEST_HOME_REQUIRED' });
    assert.throws(() => database(join(homedir(), '.magi')), { code: 'TEST_HOME_FORBIDDEN' });
    process.env.MAGI_HOME = join(homedir(), '.magi');
    assert.throws(() => state.magiHome(), { code: 'TEST_HOME_FORBIDDEN' });
  } finally {
    for (const [key, value] of [['MAGI_HOME', previous.home], ['MAGI_TEST_HOME', previous.marker]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the migration CLI requires a named home and imports only that explicit tree', () => {
  const path = home();
  legacy(path, 'tasks', 'cli.json', task('cli'));
  const cli = fileURLToPath(new URL('../bin/magi.mjs', import.meta.url));
  const counts = JSON.parse(execFileSync(process.execPath, [cli, 'migrate', '--home', path], { env: process.env, encoding: 'utf8' }));
  assert.equal(counts.namespaces.tasks, 1);
  assert.deepEqual(state.readTask('cli'), task('cli'));
  assert.throws(() => execFileSync(process.execPath, [cli, 'migrate'], { env: process.env, encoding: 'utf8', stdio: 'pipe' }), /MIGRATION_HOME_REQUIRED/);
});
