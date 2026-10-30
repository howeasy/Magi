// Shared SQLite memory; bank identity is preserved across the file-store cutover.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from './exec.mjs';
import { magiHome, readExchange } from './state.mjs';
import { statement, transaction } from './store.mjs';
import { embeddingsFor, cosine, vectorBlob, vectorFromBlob } from './embeddings.mjs';
import { redact } from './protocol.mjs';

export const MAX_MEMORY_CHARS = 600;
export const DIGEST_CHARS = 4000;
const SENT_WINDOW_MS = 8 * 60 * 60 * 1000;
const normPath = (cwd) => String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const slugOf = (norm) => norm.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function bankFor(cwd, scope) {
  if (scope === 'global') return '_global';
  const norm = normPath(cwd);
  if (!norm) return '_root';
  // A dot cannot occur in a legacy slug, preventing cross-project key collisions.
  return `${slugOf(norm) || '_'}.${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
}

// Only imported rows are read; reads never inspect legacy markdown.
export function legacyBankFor(cwd, scope) {
  if (scope === 'global') return '_global';
  return slugOf(normPath(cwd)) || '_root';
}

const WORKTREES_TTL_MS = 60000;
const worktreeCache = new Map();
function worktreesOf(cwd) {
  const hit = worktreeCache.get(cwd);
  if (hit && Date.now() - hit.at < WORKTREES_TTL_MS) return hit.paths;
  let paths = [];
  try {
    const out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    paths = out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice(9)));
  } catch { /* outside git: use the directory's own bank */ }
  worktreeCache.set(cwd, { at: Date.now(), paths });
  return paths;
}
function banksFor(cwd, scope) {
  if (scope === 'global') return ['_global'];
  const trees = cwd ? worktreesOf(cwd) : [];
  const dirs = trees.length ? [trees[0], cwd, ...trees.slice(1)] : [cwd];
  return [...new Set([bankFor(dirs[0]), ...dirs.flatMap((d) => [bankFor(d), legacyBankFor(d)])])];
}

function serialize(u) {
  const field = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const head = [`id: ${field(u.id)}`, `bank: ${field(u.bank)}`, `at: ${new Date(u.at).toISOString()}`, `from: ${field(u.from)}`, `tags: ${(u.tags ?? []).map(field).join(', ')}`];
  if (u.taskId) head.push(`task: ${field(u.taskId)}`);
  if (u.validUntil) head.push(`until: ${field(u.validUntil)}`);
  return `---\n${head.join('\n')}\n---\n${u.content}\n`;
}
function readBank(cwd, scope, home = magiHome()) {
  const out = [];
  for (const bank of banksFor(cwd, scope)) {
    for (const row of statement(home, 'SELECT value,vector,model FROM memory WHERE bank=?').all(bank)) {
      const unit = JSON.parse(row.value);
      out.push({ ...unit, bank, vector: row.vector, model: row.model });
    }
  }
  return out;
}
function queueVectors(home, units) {
  const service = embeddingsFor(home);
  const keyOf = (unit) => JSON.stringify([unit.bank, unit.id]);
  const missing = units.filter((unit) => (!unit.vector || unit.model !== service.model) && !service.queued.has(keyOf(unit)));
  if (!missing.length) { service.start(); return; }
  for (const unit of missing) service.queued.add(keyOf(unit));
  service.enqueue(async (embed, model) => {
    for (const unit of missing) {
      const vector = vectorBlob(await embed(`${unit.content} ${unit.tags.join(' ')}`));
      transaction(home, () => statement(home, 'UPDATE memory SET vector=?,model=? WHERE bank=? AND id=? AND (vector IS NULL OR model IS NOT ?)')
        .run(vector, model, unit.bank, unit.id, model));
      service.queued.delete(keyOf(unit));
    }
  });
}
function saveUnit(home, bank, unit) {
  unit = { ...unit, content: redact(unit.content).text, tags: unit.tags.map((tag) => redact(String(tag)).text.trim()).filter(Boolean), from: redact(unit.from).text, taskId: unit.taskId == null ? null : redact(unit.taskId).text };
  transaction(home, () => statement(home, 'INSERT INTO memory(bank,id,value) VALUES(?,?,?)').run(bank, unit.id, JSON.stringify(unit)));
  queueVectors(home, [{ ...unit, bank }]);
  return { id: unit.id, unit };
}

const tokens = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []);
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'what', 'when', 'where', 'which', 'how', 'does', 'did', 'has', 'have', 'not', 'you', 'your', 'its', 'our', 'about', 'into', 'over', 'than', 'then', 'them', 'they', 'there', 'here', 'should', 'would', 'could', 'will', 'can']);
function score(unit, q) {
  const body = tokens(unit.content), tags = tokens(unit.tags.join(' '));
  let result = 0;
  for (const t of q) {
    if (STOP.has(t)) continue;
    if (tags.has(t)) result += 2;
    else if (body.has(t)) result += 1;
  }
  return result;
}

export async function remember({ body, tags = [], scope, cwd, validUntil, source, taskId }) {
  if (!body || !body.trim()) throw new BridgeError('BAD_REQUEST', 'A memory needs "body".');
  if (body.length > MAX_MEMORY_CHARS) throw new BridgeError('MEMORY_TOO_LONG', `A memory is capped at ${MAX_MEMORY_CHARS} characters (this one is ${body.length}): say one claim; put the detail in a file and name it.`);
  const unit = { id: `m-${randomUUID().slice(0, 8)}`, at: Date.now(), from: source ?? 'magi', tags, taskId: taskId ?? null, validUntil: validUntil ?? null, content: redact(body).text.trim().replace(/\s+/g, ' ') };
  return saveUnit(magiHome(), banksFor(cwd, scope)[0], unit);
}

export async function recall({ query, limit = 8, cwd, scope }) {
  if (!query || !query.trim()) throw new BridgeError('BAD_REQUEST', 'A recall needs "body": the question.');
  const home = magiHome(), service = embeddingsFor(home), units = readBank(cwd, scope, home);
  queueVectors(home, units);
  let queryVector = null, notice = service.notice();
  if (service.embed && !service.error) {
    try { queryVector = await service.embed(query); }
    catch { notice = 'query embedding failed; restart Magi to retry'; }
  }
  const q = tokens(query), now = Date.now();
  const rows = units.filter((u) => !u.validUntil || Date.parse(u.validUntil) >= now).map((u) => {
    const keywordScore = score(u, q);
    const similarity = queryVector && u.model === service.model ? cosine(queryVector, vectorFromBlob(u.vector)) : 0;
    const semanticScore = 3 * Math.min(1, Math.max(0, (similarity - 0.2) / 0.3));
    return { id: u.id, bank: u.bank, content: u.content, score: keywordScore + semanticScore, keywordScore, similarity, tags: u.tags, createdAt: u.at, from: u.from };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score || b.createdAt - a.createdAt).slice(0, limit);
  const semantic = Boolean(queryVector && units.some((u) => u.vector && u.model === service.model));
  Object.defineProperties(rows, {
    embeddingStatus: { value: semantic ? 'semantic' : 'keyword-only' },
    embeddingNotice: { value: semantic && !notice ? null : `MEMORY_KEYWORD_ONLY: ${notice || 'unit embeddings pending in background'}. Recall uses keyword scoring; retry after background embedding completes.` },
  });
  return rows;
}

export async function forget({ memoryId, cwd, scope }) {
  if (!memoryId) throw new BridgeError('BAD_REQUEST', 'A forget needs "memoryId".');
  const home = magiHome();
  transaction(home, () => {
    let removed = 0;
    for (const bank of banksFor(cwd, scope)) {
      removed += Number(statement(home, 'DELETE FROM memory WHERE bank=? AND id=?').run(bank, memoryId).changes);
      statement(home, 'DELETE FROM memory_sent WHERE bank=? AND memory_id=?').run(bank, memoryId);
    }
    if (!removed) throw new BridgeError('UNKNOWN_MEMORY', `No memory ${memoryId} in this bank. Run kind:"recall" for the ids.`);
  });
  return { forgotten: memoryId };
}
export async function stats({ cwd, scope } = {}) {
  if (scope === 'all') {
    const row = statement(magiHome(), 'SELECT COUNT(*) AS units, COUNT(DISTINCT bank) AS banks FROM memory').get();
    return { units: row.units, banks: row.banks, database: join(magiHome(), 'magi.db') };
  }
  const units = readBank(cwd, scope);
  return { bank: banksFor(cwd, scope)[0], units: units.length, database: join(magiHome(), 'magi.db'), newest: units.length ? new Date(Math.max(...units.map((u) => u.at))).toISOString() : null };
}

export async function digestFor({ task, cwd, peerTarget, coordinator, onSelected }) {
  let rows;
  try { rows = await recall({ query: task.slice(0, 2000), limit: Infinity, cwd }); }
  catch { return null; }
  const home = magiHome();
  const cutoff = Date.now() - SENT_WINDOW_MS;
  // Pruning is housekeeping, and this runs after the round is open: a busy
  // ledger must not fail the request. Rows past the cutoff are ignored below.
  try { statement(home, 'DELETE FROM memory_sent WHERE sent_at<=?').run(cutoff); } catch { /* the next digest prunes */ }
  const identity = (target) => typeof target === 'string' ? target : target?.id ?? null;
  const worker = identity(peerTarget), sender = identity(coordinator) ?? '_unspecified';
  const lines = [], sent = [];
  const question = tokens(task);
  let used = rows.embeddingNotice ? rows.embeddingNotice.length + 1 : 0;
  for (const m of rows) {
    // Mode/peer framing is not evidence that an outcome's notes are relevant.
    if (m.tags.includes('outcome') && score({ content: m.content.replace(/^\S+ \S+: /, ''), tags: [] }, question) < 3 && m.similarity < 0.45) continue;
    if (worker) {
      const prior = statement(home, 'SELECT sent_at FROM memory_sent WHERE coordinator=? AND worker=? AND bank=? AND memory_id=?').get(sender, worker, m.bank, m.id);
      if (prior && prior.sent_at > cutoff) continue;
    }
    const line = `- ${m.content}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''} (${m.id})`;
    if (used + line.length + 1 > DIGEST_CHARS) continue;
    lines.push(line); used += line.length + 1; sent.push(m);
    if (sent.length === 8) break;
  }
  if (!lines.length) return null;
  if (onSelected) onSelected(sent);
  else markMemoriesSent({ items: sent, peerTarget, coordinator, home });
  if (rows.embeddingNotice) lines.push(rows.embeddingNotice);
  return lines.join('\n');
}

export function markMemoriesSent({ items, peerTarget, coordinator, home = magiHome(), sentAt = Date.now() }) {
  const identity = (target) => typeof target === 'string' ? target : target?.id ?? null;
  const worker = identity(peerTarget), sender = identity(coordinator) ?? '_unspecified';
  if (!worker || !items.length) return;
  transaction(home, () => {
    statement(home, 'DELETE FROM memory_sent WHERE sent_at<=?').run(Date.now() - SENT_WINDOW_MS);
    for (const m of items) statement(home, 'INSERT INTO memory_sent(coordinator,worker,bank,memory_id,sent_at) VALUES(?,?,?,?,?) ON CONFLICT(coordinator,worker,bank,memory_id) DO UPDATE SET sent_at=excluded.sent_at')
      .run(sender, worker, m.bank, m.id, sentAt);
  });
}
export async function available() { return true; }
export async function close() {}

export async function rememberOutcome({ mode, peer, notes, cwd, from, taskId }) {
  if (!notes || !notes.trim()) return null;
  try {
    return await remember({ body: redact(`${mode} ${peer}: ${notes}`).text.slice(0, MAX_MEMORY_CHARS), tags: ['outcome', String(mode).toLowerCase()], cwd, source: from, taskId, validUntil: new Date(Date.now() + 14 * 86400000).toISOString() });
  } catch { return null; /* an outcome is recorded even if memory fails */ }
}

export async function exportMemory({ cwd, scope, directory } = {}) {
  const home = magiHome(), bank = banksFor(cwd, scope)[0];
  directory = resolve(directory ?? join(home, 'memory-export', bank));
  mkdirSync(directory, { recursive: true });
  const files = [];
  for (const unit of readBank(cwd, scope, home)) {
    const key = createHash('sha256').update(JSON.stringify([unit.bank, unit.id])).digest('hex');
    const file = join(directory, `${unit.id.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)}-${key}.md`);
    try { writeFileSync(file, serialize(unit), { flag: 'wx' }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new BridgeError('MEMORY_EXPORT_EXISTS', `Export refuses to overwrite ${file}; choose a new --out directory.`);
      throw error;
    }
    files.push(file);
  }
  return { directory, units: files.length, files };
}

// Retention must await this helper before deleting a card's message bodies.
export async function summarizeCard(task) {
  if (!task?.taskId) throw new BridgeError('BAD_REQUEST', 'A card summary needs taskId; pass the stored task before trimming its messages.');
  const home = magiHome(), bank = banksFor(task.cwd)[0];
  const id = `m-card-${createHash('sha256').update(task.taskId).digest('hex').slice(0, 16)}`;
  const summary = transaction(home, () => {
    const existing = statement(home, 'SELECT value FROM memory WHERE bank=? AND id=?').get(bank, id);
    if (existing) return { id, unit: JSON.parse(existing.value) };
    const exchanges = task.exchanges ?? readExchange(task.taskId);
    const ask = task.task ?? exchanges.find((e) => e.kind === 'request')?.task ?? task.rounds?.[0]?.brief ?? 'not recorded';
    const reply = task.reply ?? [...exchanges].reverse().find((e) => e.kind === 'reply')?.text ?? 'no reply recorded';
    const verdict = task.outcome ? `${task.outcome.accepted} accepted, ${task.outcome.rejected} rejected, ${task.outcome.open} open; ${task.outcome.notes ?? ''}` : 'not reconciled';
    const clip = (text, limit) => redact(String(text)).text.replace(/\s+/g, ' ').trim().slice(0, limit);
    const content = `Card ${clip(task.taskId, 64)}. Asked: ${clip(ask, 155)}. Reply: ${clip(reply, 155)}. Verdict: ${clip(verdict, 155)}`.slice(0, MAX_MEMORY_CHARS);
    const unit = { id, at: Date.now(), from: redact(task.orchestrator ?? 'magi').text, tags: ['card-summary', redact(String(task.mode ?? 'card').toLowerCase()).text], taskId: redact(task.taskId).text, validUntil: null, content };
    statement(home, 'INSERT INTO memory(bank,id,value) VALUES(?,?,?)').run(bank, id, JSON.stringify(unit));
    return { id, unit };
  });
  const service = embeddingsFor(home);
  const stored = statement(home, 'SELECT vector,model FROM memory WHERE bank=? AND id=?').get(bank, id);
  if (!stored?.vector || stored.model !== service.model) {
    service.start();
    // Keep this awaited retention operation alive through background initialization.
    if (!service.embed && !service.loading && !service.error) await new Promise((resolve) => setTimeout(resolve, 0));
    if (service.loading) await service.loading;
    if (!service.embed) throw new BridgeError('EMBEDDING_UNAVAILABLE', 'Card bodies retained: local embedding model unavailable; repair MAGI_HOME/models or network access and restart Magi.');
    const vector = vectorBlob(await service.embed(`${summary.unit.content} ${summary.unit.tags.join(' ')}`));
    transaction(home, () => statement(home, 'UPDATE memory SET vector=?,model=? WHERE bank=? AND id=?').run(vector, service.model, bank, id));
  }
  return summary;
}
