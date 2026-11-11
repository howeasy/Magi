import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync, rmdirSync, renameSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { redact } from './protocol.mjs';

const connections = new Map();
const namespaces = ['tasks', 'notes', 'queue-receipts', 'personas', 'notices', 'workers'];
const hash = (text) => createHash('sha256').update(text).digest('hex');

export class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function translate(error) {
  if (error.errcode === 5 || error.errcode === 6 || /database is (?:locked|busy)/i.test(error.message)) {
    return new StoreError('LEDGER_BUSY', 'SQLite ledger is busy; retry after the current transaction finishes.');
  }
  return error;
}
export function assertTestHome(home) {
  if (!process.env.MAGI_TEST_HOME) return;
  if (typeof home !== 'string' || !home) {
    throw new StoreError('TEST_HOME_REQUIRED', 'Tests require an explicit isolated MAGI_HOME; refusing the real home.');
  }
  const normalize = (path) => {
    const value = resolve(path).replace(/\\/g, '/');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  const candidate = normalize(home);
  for (const name of ['.magi']) {
    const real = normalize(join(homedir(), name));
    if (candidate === real || candidate.startsWith(real + '/')) {
      throw new StoreError('TEST_HOME_FORBIDDEN', 'Tests cannot access the real Magi home; select a temporary MAGI_HOME.');
    }
  }
}


export function database(home) {
  assertTestHome(home);
  const key = resolve(home);
  if (connections.has(key)) return connections.get(key).db;
  mkdirSync(key, { recursive: true });
  const db = new DatabaseSync(join(key, 'magi.db'));
  const connection = { db, statements: new Map(), depth: 0 };
  let initializing = false;
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    // Serialize additive schema upgrades with extension startup as well.
    db.exec('BEGIN IMMEDIATE');
    initializing = true;
    db.exec(`CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,key)
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value))
      );
      CREATE INDEX IF NOT EXISTS exchanges_task ON exchanges(task_id,sequence);
      CREATE TABLE IF NOT EXISTS mail (
        task_id TEXT NOT NULL, slot INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(task_id,slot)
      );
      CREATE TABLE IF NOT EXISTS questions (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
        round INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), pending INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS questions_task ON questions(task_id,round,sequence);
      CREATE TABLE IF NOT EXISTS waiters (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, round INTEGER NOT NULL, pid INTEGER NOT NULL,
        deadline INTEGER, result TEXT CHECK(result IS NULL OR json_valid(result))
      );
      CREATE INDEX IF NOT EXISTS waiters_task ON waiters(task_id,round);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory (
        bank TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        vector BLOB, model TEXT, PRIMARY KEY(bank,id)
      );
      CREATE TABLE IF NOT EXISTS memory_sent (
        coordinator TEXT NOT NULL, worker TEXT NOT NULL, bank TEXT NOT NULL,
        memory_id TEXT NOT NULL, sent_at INTEGER NOT NULL,
        PRIMARY KEY(coordinator,worker,bank,memory_id)
      );
      CREATE INDEX IF NOT EXISTS memory_sent_timestamp ON memory_sent(sent_at);
      CREATE TABLE IF NOT EXISTS frames (
        to_pid INTEGER NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','processing','failed')), created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS frames_recipient ON frames(to_pid,state,created_at,id);
    `);
    if (!db.prepare('PRAGMA table_info(records)').all().some((column) => column.name === 'updated_at')) {
      db.exec('ALTER TABLE records ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    }
    db.exec('COMMIT');
    initializing = false;
    connections.set(key, connection);
    // Short synchronous waits keep retryState's async backoff responsive.
    db.exec('PRAGMA busy_timeout=25');
    return db;
  } catch (error) {
    connections.delete(key);
    if (initializing) db.exec('ROLLBACK');
    db.close();
    throw translate(error);
  }
}

export function statement(home, sql) {
  const db = database(home);
  const cache = connections.get(resolve(home)).statements;
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
}

export function transaction(home, action) {
  const db = database(home);
  const connection = connections.get(resolve(home));
  if (connection.depth) {
    // A savepoint keeps an inner failure atomic even when its caller catches it.
    const name = `nested_${connection.depth++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = action();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw translate(error);
    } finally { connection.depth--; }
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    connection.depth = 1;
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (connection.depth) db.exec('ROLLBACK');
    throw translate(error);
  } finally { connection.depth = 0; }
}

export function getRecord(home, namespace, key) {
  const row = statement(home, 'SELECT value FROM records WHERE namespace=? AND key=?').get(namespace, key);
  return row ? JSON.parse(row.value) : null;
}
// A write made outside transaction() meets the same 25 ms busy window; it
// says LEDGER_BUSY like one made inside, so retryState retries it and no
// caller is handed a bare "database is locked".
export function setRecord(home, namespace, key, value) {
  try {
    statement(home, 'INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(namespace, key, JSON.stringify(value), Date.now());
  } catch (error) { throw translate(error); }
}
export function removeRecord(home, namespace, key) {
  try { statement(home, 'DELETE FROM records WHERE namespace=? AND key=?').run(namespace, key); }
  catch (error) { throw translate(error); }
}
export function listRecords(home, namespace) {
  return statement(home, 'SELECT value FROM records WHERE namespace=? ORDER BY key').all(namespace).map((row) => JSON.parse(row.value));
}

function parseLegacy(path, text) {
  try { return JSON.parse(text); }
  catch {
    throw new StoreError('MIGRATION_FAILED', `Unreadable legacy record ${path}; repair or move it aside, then restart. No legacy files were deleted.`);
  }
}

export function migrateLegacy(home) {
  assertTestHome(home);
  home = resolve(home);
  const imported = statement(home, 'SELECT value FROM metadata WHERE key=?').get('legacy-import');
  if (imported && JSON.parse(imported.value).manifest.length === 0) {
    const counts = JSON.parse(imported.value).counts;
    return { ...counts, tables: { ...counts.tables, memory: migrateMemory(home), ...migrateLooseState(home) } };
  }
  transaction(home, () => {
    const meta = statement(home, 'SELECT value FROM metadata WHERE key=?');
    if (meta.get('legacy-import')) return;
    const manifest = [];
    const expected = new Map();
    const actions = [];
    const recordKeys = new Map();
    const exchangeKeys = new Map();
    const mailKeys = new Map();
    const add = (table, action, count = 1) => {
      actions.push(action);
      expected.set(table, (expected.get(table) ?? 0) + count);
    };
    const decoded = (key, path) => {
      try { return decodeURIComponent(key); }
      catch {
        throw new StoreError('MIGRATION_FAILED', `Invalid encoded legacy key in ${path}; repair the filename and retry. No destination records changed or legacy files deleted.`);
      }
    };
    const claim = (keys, key, path) => {
      if (keys.has(key)) {
        throw new StoreError('MIGRATION_FAILED', `Decoded key collision between ${keys.get(key)} and ${path}; reconcile the duplicate files and retry. No destination records changed or legacy files deleted.`);
      }
      keys.set(key, path);
    };
    const record = (namespace, key, value, path, latestSummary = false) => {
      if (!recordKeys.has(namespace)) recordKeys.set(namespace, new Map());
      const keys = recordKeys.get(namespace);
      const present = keys.has(key);
      if (!latestSummary || !present) claim(keys, key, path);
      add('records', () => setRecord(home, namespace, key, value), present ? 0 : 1);
    };
    const consume = (path, action) => {
      const text = readFileSync(path, 'utf8');
      action(text);
      manifest.push({ path, hash: hash(text) });
    };
    const locks = join(home, 'locks');
    if (existsSync(locks)) for (const entry of readdirSync(locks, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(locks, entry.name);
      for (const name of readdirSync(directory)) {
        if (!/\.json(?:\.number|\.released)?$/.test(name)) continue;
        consume(join(directory, name), (text) => {
          if (!name.endsWith('.json') || existsSync(join(directory, name + '.released'))) return;
          let owner;
          try { owner = JSON.parse(text); } catch { /* unknown owner is unsafe */ }
          if (!Number.isInteger(owner?.pid) || owner.pid <= 0) {
            throw new StoreError('MIGRATION_FAILED', `Unreadable legacy lock ${join(directory, name)}; stop old servers and repair it before restart. No files deleted.`);
          }
          try { process.kill(owner.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') return; }
          throw new StoreError('LEDGER_BUSY', `Legacy server ${owner.pid} still owns a lock; stop old Magi servers before migrating.`);
        });
      }
    }
    for (const namespace of namespaces) {
      const dir = join(home, namespace);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        consume(join(dir, name), (text) => {
          const value = parseLegacy(join(dir, name), text);
          record(namespace, decoded(name.slice(0, -5), join(dir, name)), value, join(dir, name));
        });
      }
    }
    for (const namespace of ['exchanges', 'archive']) {
      const paths = namespace === 'archive'
        ? (existsSync(join(home, 'outcomes.jsonl')) ? [join(home, 'outcomes.jsonl')] : [])
        : (existsSync(join(home, 'exchanges')) ? readdirSync(join(home, 'exchanges')).filter((n) => n.endsWith('.jsonl')).map((n) => join(home, 'exchanges', n)) : []);
      for (const path of paths) consume(path, (text) => {
        const taskId = namespace === 'exchanges' ? decoded(basename(path).slice(0, -6), path) : null;
        if (namespace === 'exchanges') claim(exchangeKeys, taskId, path);
        text.split('\n').filter(Boolean).forEach((line, index) => {
          let value;
          try { value = JSON.parse(line); } catch {
            // Preserve torn historic lines, but never expose them as exchanges.
            record('legacy-fragments', `${path}:${index}`, line, path);
            return;
          }
          if (namespace === 'exchanges') add('exchanges', () => statement(home, 'INSERT INTO exchanges(task_id,value) VALUES(?,?)').run(taskId, JSON.stringify(value)));
          else {
            if (typeof value?.taskId !== 'string' || !value.outcome) {
              record('legacy-fragments', `${path}:${index}`, line, path);
            } else {
              // outcomes.jsonl is a history of summaries: the last task summary wins.
              record('archive', value.taskId, value, path, true);
            }
          }
        });
      });
    }
    const mail = join(home, 'mail');
    if (existsSync(mail)) for (const name of readdirSync(mail)) {
      const match = /^(.*?)(?:\.round-(\d+))?\.json$/.exec(name);
      if (match) consume(join(mail, name), (text) => {
        const value = parseLegacy(join(mail, name), text);
        const path = join(mail, name);
        const taskId = decoded(match[1], path);
        const slot = Number(match[2] ?? 0);
        claim(mailKeys, JSON.stringify([taskId, slot]), path);
        add('mail', () => statement(home, 'INSERT INTO mail(task_id,slot,value) VALUES(?,?,?)').run(taskId, slot, JSON.stringify(value)));
      });
      else if (name.endsWith('.request.md')) consume(join(mail, name), (text) => record('requests', decoded(name.slice(0, -11), join(mail, name)), text, join(mail, name)));
      else if (name.endsWith('.waiting')) consume(join(mail, name), (text) => {
        // A pre-cutover waiter cannot resume against this API. Preserve its
        // marker as history, not an active subscription that strands new mail.
        record('legacy-waiters', decoded(name.slice(0, -8), join(mail, name)), parseLegacy(join(mail, name), text), join(mail, name));
      });
    }
    // Validate the complete plan before writing. Unrelated namespaces may coexist,
    // but every destination namespace/table receiving legacy rows must be empty.
    const refuse = (target) => {
      throw new StoreError('MIGRATION_FAILED', `Destination ${target} is populated; preserve this database and import into a fresh home, or reconcile its records before retrying. No destination records changed or legacy files deleted.`);
    };
    for (const namespace of recordKeys.keys()) {
      if (statement(home, 'SELECT 1 FROM records WHERE namespace=? LIMIT 1').get(namespace)) refuse(`namespace ${namespace}`);
    }
    for (const table of ['exchanges', 'mail']) {
      if (expected.has(table) && dbCount(home, table)) refuse(`table ${table}`);
    }
    for (const action of actions) action();
    const namespaceCounts = Object.fromEntries([...recordKeys.keys()].map((namespace) => [
      namespace,
      Number(statement(home, 'SELECT count(*) AS count FROM records WHERE namespace=?').get(namespace).count),
    ]));
    for (const [table, count] of expected) {
      const actual = table === 'records' ? Object.values(namespaceCounts).reduce((total, count) => total + count, 0) : dbCount(home, table);
      if (actual !== count) throw new StoreError('MIGRATION_FAILED', `Legacy ${table} count ${count} differs from imported count ${actual}; inspect magi.db and retry. No legacy files were deleted.`);
    }
    const counts = {
      tables: Object.fromEntries(expected),
      namespaces: namespaceCounts,
    };
    // Memory participates in the same import transaction, but not file cleanup.
    // A malformed/populated memory target must roll back the core import too.
    migrateMemory(home, false);
    migrateLooseState(home, false);
    statement(home, 'INSERT INTO metadata(key,value) VALUES(?,?)').run('legacy-import', JSON.stringify({ counts, manifest }));
  });
  // Crash recovery repeats only cleanup, not import. Never unlink a file altered
  // since verification: a still-running old server must be stopped first.
  transaction(home, () => {
    const record = JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get('legacy-import').value);
    for (const file of record.manifest) {
      if (!existsSync(file.path)) continue;
      if (hash(readFileSync(file.path, 'utf8')) !== file.hash) {
        throw new StoreError('MIGRATION_FAILED', `Legacy file changed after import: ${file.path}; stop old Magi servers and reconcile it before restart. File retained.`);
      }
      unlinkSync(file.path);
    }
    for (const namespace of [...namespaces, 'mail', 'exchanges']) {
      try { rmdirSync(join(home, namespace)); } catch { /* unrelated artifacts stay */ }
    }
    const locks = join(home, 'locks');
    if (existsSync(locks)) for (const entry of readdirSync(locks, { withFileTypes: true })) {
      if (entry.isDirectory()) { try { rmdirSync(join(locks, entry.name)); } catch { /* unrelated artifacts stay */ } }
    }
    try { rmdirSync(locks); } catch { /* unrelated artifacts stay */ }
    record.manifest = [];
    statement(home, 'UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(record), 'legacy-import');
  });
  const counts = JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get('legacy-import').value).counts;
  return { ...counts, tables: { ...counts.tables, memory: migrateMemory(home), ...migrateLooseState(home) } };
}

// Separate marker upgrades homes that already completed the ledger migration.
function migrateLooseState(home, cleanup = true) {
  const marker = 'loose-state-import';
  transaction(home, () => {
    if (statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker)) return;
    const manifest = [], rows = [], frames = [], spillTargets = new Map();
    const consume = (path, action) => {
      const text = readFileSync(path, 'utf8');
      action(text);
      manifest.push({ path, hash: hash(text) });
    };
    for (const [directory, namespace] of [['usage/claude', 'usage-claude'], ['agents', 'agents']]) {
      const root = join(home, directory);
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (!name.endsWith('.json')) continue;
        const path = join(root, name);
        consume(path, (text) => rows.push({ namespace, key: name.slice(0, -5), value: parseLegacy(path, text) }));
      }
    }
    const chain = join(home, 'statusline-chain.json');
    if (existsSync(chain)) consume(chain, (text) => rows.push({ namespace: 'settings', key: 'statusline-chain', value: parseLegacy(chain, text) }));
    const inbox = join(home, 'inbox');
    if (existsSync(inbox)) for (const pid of readdirSync(inbox)) {
      if (!/^\d+$/.test(pid)) continue;
      for (const [sub, state] of [['', 'queued'], ['processing', 'processing'], ['failed', 'failed']]) {
        const root = join(inbox, pid, sub);
        if (!existsSync(root)) continue;
        for (const name of readdirSync(root)) {
          if (!name.endsWith('.json')) continue;
          consume(join(root, name), (body) => {
            let frame;
            try { frame = JSON.parse(body); } catch { /* Preserve malformed rows as failed. */ }
            const valid = frame && typeof frame.text === 'string' && frame.text.trim();
            frames.push({ pid: Number(pid), id: name.slice(0, -5), body, state: valid ? state : 'failed', at: Number.isFinite(frame?.at) ? frame.at : Date.now() });
          });
        }
      }
    }
    for (const [directory, suffix] of [['request-artifacts', '.md'], ['mail', '.queue.md']]) {
      const root = join(home, directory);
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (!name.endsWith(suffix)) continue;
        const path = join(root, name), destination = join(home, 'spill', name);
        const digest = hash(readFileSync(path, 'utf8'));
        if (spillTargets.has(destination) && spillTargets.get(destination) !== digest) throw new StoreError('MIGRATION_FAILED', `Legacy spills collide at ${destination}; reconcile their bodies and retry magi migrate. Files retained.`);
        spillTargets.set(destination, digest);
        if (existsSync(destination) && hash(readFileSync(destination, 'utf8')) !== digest) throw new StoreError('MIGRATION_FAILED', `Spill collision at ${destination}; reconcile both files and retry magi migrate. Files retained.`);
        manifest.push({ path, destination, hash: digest });
      }
    }
    for (const row of rows) {
      const existing = getRecord(home, row.namespace, row.key);
      if (existing !== null && JSON.stringify(existing) !== JSON.stringify(row.value)) {
        throw new StoreError('MIGRATION_FAILED', `Destination ${row.namespace}/${row.key} differs; reconcile the legacy file and database, then retry magi migrate. Files retained.`);
      }
    }
    for (const frame of frames) {
      const existing = statement(home, 'SELECT * FROM frames WHERE id=?').get(frame.id);
      if (existing && (existing.to_pid !== frame.pid || existing.body !== frame.body || existing.state !== frame.state || existing.created_at !== frame.at)) {
        throw new StoreError('MIGRATION_FAILED', `Frame ${frame.id} conflicts with the database; reconcile it before retrying magi migrate. Files retained.`);
      }
    }
    for (const row of rows) {
      setRecord(home, row.namespace, row.key, row.value);
      if (JSON.stringify(getRecord(home, row.namespace, row.key)) !== JSON.stringify(row.value)) throw new StoreError('MIGRATION_FAILED', 'Record verification failed; inspect magi.db and retry. Files retained.');
    }
    for (const frame of frames) {
      statement(home, 'INSERT OR IGNORE INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,?,?)').run(frame.pid, frame.id, frame.body, frame.state, frame.at);
      const saved = statement(home, 'SELECT * FROM frames WHERE id=?').get(frame.id);
      if (!saved || saved.body !== frame.body || saved.state !== frame.state || saved.to_pid !== frame.pid || saved.created_at !== frame.at) throw new StoreError('MIGRATION_FAILED', 'Frame verification failed; inspect magi.db and retry. Files retained.');
    }
    statement(home, 'INSERT INTO metadata(key,value) VALUES(?,?)').run(marker, JSON.stringify({ manifest, counts: { looseRecords: rows.length, frames: frames.length } }));
  });
  if (!cleanup) return JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value).counts;
  transaction(home, () => {
    const record = JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value);
    for (const file of record.manifest) {
      if (!existsSync(file.path)) continue;
      if (hash(readFileSync(file.path, 'utf8')) !== file.hash) throw new StoreError('MIGRATION_FAILED', `Legacy file changed: ${file.path}; stop old servers and reconcile before retrying magi migrate. File retained.`);
      if (file.destination) {
        mkdirSync(dirname(file.destination), { recursive: true });
        if (existsSync(file.destination)) {
          if (hash(readFileSync(file.destination, 'utf8')) !== file.hash) throw new StoreError('MIGRATION_FAILED', `Spill changed: ${file.destination}; reconcile both files and retry magi migrate. Source retained.`);
          unlinkSync(file.path);
        } else renameSync(file.path, file.destination);
      } else unlinkSync(file.path);
    }
    record.manifest = [];
    statement(home, 'UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(record), marker);
  });
  const inbox = join(home, 'inbox');
  if (existsSync(inbox)) for (const pid of readdirSync(inbox)) {
    if (!/^\d+$/.test(pid)) continue;
    for (const sub of ['processing', 'failed', '']) {
      try { rmdirSync(join(inbox, pid, sub)); } catch { /* Only verified empty directories. */ }
    }
  }
  for (const directory of ['inbox', 'agents', 'usage/claude', 'usage', 'request-artifacts', 'mail']) {
    try { rmdirSync(join(home, directory)); } catch { /* Unrelated files stay. */ }
  }
  return JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value).counts;
}

function dbCount(home, table) {
  return Number(statement(home, `SELECT count(*) AS count FROM ${table}`).get().count);
}

// A separate marker lets homes already migrated by the state cutover import
// memory once, with the same crash-safe manifest and no read-time migration.
function migrateMemory(home, cleanup = true) {
  const marker = 'memory-import';
  transaction(home, () => {
    if (statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker)) return;
    const root = join(home, 'memory');
    const rows = [], manifest = [], keys = new Map();
    if (existsSync(root)) for (const bank of readdirSync(root, { withFileTypes: true })) {
      if (!bank.isDirectory()) continue;
      const directory = join(root, bank.name);
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue;
        const path = join(directory, file.name), text = readFileSync(path, 'utf8');
        const unit = parseMemory(text, file.name, path);
        const key = JSON.stringify([bank.name, unit.id]);
        if (keys.has(key)) throw new StoreError('MIGRATION_FAILED', `Memory key collision between ${keys.get(key)} and ${path}; reconcile both files and retry. No memory files deleted.`);
        keys.set(key, path);
        rows.push({ bank: bank.name, unit });
        manifest.push({ path, hash: hash(text) });
      }
    }
    if (rows.length && dbCount(home, 'memory')) throw new StoreError('MIGRATION_FAILED', 'Destination memory table is populated; preserve the database and reconcile or import into a fresh home. No memory rows changed or files deleted.');
    for (const row of rows) statement(home, 'INSERT INTO memory(bank,id,value) VALUES(?,?,?)').run(row.bank, row.unit.id, JSON.stringify(row.unit));
    if (rows.length && dbCount(home, 'memory') !== rows.length) throw new StoreError('MIGRATION_FAILED', 'Memory import count differs; inspect magi.db and retry. No memory files deleted.');
    statement(home, 'INSERT INTO metadata(key,value) VALUES(?,?)').run(marker, JSON.stringify({ count: rows.length, manifest }));
  });
  if (!cleanup) return JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value).count;
  transaction(home, () => {
    const record = JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value);
    // Validate every source before the first unlink, so changed input fails closed.
    for (const file of record.manifest) if (existsSync(file.path) && hash(readFileSync(file.path, 'utf8')) !== file.hash) {
      throw new StoreError('MIGRATION_FAILED', `Legacy memory changed after import: ${file.path}; stop old Magi servers and reconcile before retrying. File retained.`);
    }
    for (const file of record.manifest) if (existsSync(file.path)) unlinkSync(file.path);
    for (const directory of new Set(record.manifest.map((file) => dirname(file.path)))) {
      try { rmdirSync(directory); } catch { /* unrelated files stay */ }
    }
    try { rmdirSync(join(home, 'memory')); } catch { /* unrelated files stay */ }
    record.manifest = [];
    statement(home, 'UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(record), marker);
  });
  return JSON.parse(statement(home, 'SELECT value FROM metadata WHERE key=?').get(marker).value).count;
}

function parseMemory(text, file, path) {
  const fail = () => { throw new StoreError('MIGRATION_FAILED', `Unreadable legacy memory ${path}; repair its markdown metadata and retry. No memory rows changed or files deleted.`); };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return fail();
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) return fail();
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const id = meta.id || file.slice(0, -3), at = Date.parse(meta.at);
  if (!/^[a-z0-9_-]+$/i.test(id) || !Number.isFinite(at) || !match[2].trim() || (meta.until && !Number.isFinite(Date.parse(meta.until)))) return fail();
  return { id, at, from: meta.from ? redact(meta.from).text : null, tags: meta.tags ? redact(meta.tags).text.split(',').map((tag) => tag.trim()).filter(Boolean) : [], taskId: meta.task ? redact(meta.task).text : null, validUntil: meta.until || null, content: redact(match[2]).text.trim() };
}
