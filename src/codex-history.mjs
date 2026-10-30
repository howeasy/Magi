// What a Codex thread is doing, from the store Codex itself keeps current.
//
// The live record is ~/.codex/thread_history_1.sqlite: `thread_turns` has one
// row per turn with status inProgress / completed / failed / interrupted and
// epoch-second timestamps, and `thread_items` holds the turn's items
// (userMessage, agentMessage, ...) as JSON with `created_at_ms`. The rollout
// JSONL under ~/.codex/sessions was a one-shot snapshot at codex-cli 0.153.4
// and is appended live at 0.160.x; nothing here reads it either way.
// `codexPresence` adds ~/.codex/state_5.sqlite, the thread index the
// app-server's own thread/list reads. Read-only, short queries; both databases
// are WAL so a reader never blocks Codex. Pinned private format:
// docs/transport-recon.md is the repair guide when the schema moves.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// An inProgress turn whose newest item is this old belongs to a process that
// died mid-turn, not to a working peer. Measured from the last item, not the
// turn's start, so a long turn that keeps producing items stays busy.
// ponytail: one tool call silent for longer than this (a long build, a long
// wait) still reads unknown until its item lands; a heartbeat source would be
// the upgrade, and none exists on disk at 0.160.1.
const STALE_TURN_MS = 15 * 60_000;

const TURN_SQL = 'select turn_id, status, started_at, completed_at from thread_turns where thread_id = ? order by started_at desc limit 1';
const LAST_ITEM_SQL = 'select max(created_at_ms) as at from thread_items where thread_id = ? and turn_id = ?';

let sqlite = null;
async function lib() {
  // ponytail: node:sqlite needs Node 22.13+; older Nodes read Codex as unknown.
  if (sqlite === null) {
    // The module announces itself as experimental on stderr, which an MCP
    // host reads as noise; the announcement is muted, nothing else is.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => {
      if (String(w).includes('SQLite')) return;
      emit.call(process, w, ...rest);
    };
    try {
      sqlite = await import('node:sqlite');
    } catch {
      sqlite = false;
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite || null;
}

const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');
const historyPath = () => join(codexHome(), 'thread_history_1.sqlite');

async function withDb(fn) {
  const s = await lib();
  const path = historyPath();
  if (!s || !existsSync(path)) return null;
  let db;
  try {
    db = new s.DatabaseSync(path, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// { status: 'busy' | 'idle' | null, statusAt: ms | null } from prepared
// TURN_SQL and LAST_ITEM_SQL statements on the history database.
function turnState(turn, lastItem, threadId, now) {
  const row = turn.get(threadId);
  if (!row) return { status: null, statusAt: null };
  const startedAt = row.started_at ? row.started_at * 1000 : null;
  if (row.status === 'inProgress') {
    const lastAt = lastItem.get(threadId, row.turn_id)?.at ?? startedAt;
    if (lastAt && now - lastAt > STALE_TURN_MS) return { status: null, statusAt: lastAt };
    return { status: 'busy', statusAt: startedAt };
  }
  return { status: 'idle', statusAt: row.completed_at ? row.completed_at * 1000 : startedAt };
}

export async function codexTurnState(threadId) {
  if (!threadId) return { status: null, statusAt: null };
  const state = await withDb((db) => turnState(db.prepare(TURN_SQL), db.prepare(LAST_ITEM_SQL), threadId, Date.now()));
  return state ?? { status: null, statusAt: null };
}

// Codex records cwd as a Windows verbatim path (`\\?\E:\repo`,
// `\\?\UNC\host\share`); everything else here compares the plain form.
const plainPath = (p) => (typeof p === 'string' ? p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') : null);

// The threads thread/list returns by default, read from Codex's own state
// database without an app-server: not archived, from an interactive source
// (cli, vscode; `exec` rows are headless runs, subagents belong to a parent),
// most recent first, with each one's turn state. `open` is set when
// thread-writer-locks/<id>.lock exists, which on desktop 26.930.7945.0 held
// exactly the threads the desktop had open (and their subagents): an
// inference from one observation, not a documented contract.
// Null when the databases cannot be read, so the caller asks thread/list.
export async function codexPresence({ limit = 40, now = Date.now() } = {}) {
  const s = await lib();
  const home = codexHome();
  const statePath = join(home, 'state_5.sqlite');
  if (!s || !existsSync(statePath) || !existsSync(historyPath())) return null;
  let state, history;
  try {
    state = new s.DatabaseSync(statePath, { readOnly: true });
    const threads = state
      .prepare("select id, name, cwd, preview, git_branch, model, agent_nickname, agent_role, recency_at from threads where archived = 0 and source in ('cli', 'vscode') order by recency_at desc limit ?")
      .all(limit);
    history = new s.DatabaseSync(historyPath(), { readOnly: true });
    const turn = history.prepare(TURN_SQL);
    const lastItem = history.prepare(LAST_ITEM_SQL);
    return threads.map((t) => ({
      id: t.id,
      name: t.name ?? null,
      cwd: plainPath(t.cwd),
      preview: t.preview ?? null,
      branch: t.git_branch ?? null,
      model: t.model ?? null,
      agentNickname: t.agent_nickname ?? null,
      agentRole: t.agent_role ?? null,
      recencyAt: t.recency_at ?? null,
      open: existsSync(join(home, 'thread-writer-locks', `${t.id}.lock`)),
      ...turnState(turn, lastItem, t.id, now),
    }));
  } catch {
    return null;
  } finally {
    for (const db of [state, history]) {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
}

// The last `limit` user and agent messages of a thread, oldest first, as
// { role, text, at }. What a pane shows as the thread's transcript.
export async function codexRecentMessages(threadId, limit = 40) {
  if (!threadId) return [];
  const rows = await withDb((db) =>
    db
      .prepare("select item_type, item_json, created_at_ms from thread_items where thread_id = ? and item_type in ('userMessage', 'agentMessage') order by created_at_ms desc limit ?")
      .all(threadId, limit),
  );
  if (!rows) return [];
  return rows
    .map((r) => {
      let j;
      try {
        j = JSON.parse(r.item_json);
      } catch {
        return null;
      }
      const text = typeof j.text === 'string' ? j.text : Array.isArray(j.content) ? j.content.map((c) => c.text ?? '').join('') : '';
      return text ? { role: r.item_type === 'userMessage' ? 'user' : 'assistant', text, at: r.created_at_ms } : null;
    })
    .filter(Boolean)
    .reverse();
}

// The first thing the human said in a thread: the earliest userMessage row,
// which is where `magi spawn` looks for its marker. Not the recent window
// above, whose oldest row is only the oldest of the last forty.
export async function codexFirstUserMessage(threadId) {
  if (!threadId) return { text: null, reason: 'none' };
  const row = await withDb((db) => db.prepare("select item_json from thread_items where thread_id = ? and item_type = 'userMessage' order by created_at_ms asc limit 1").get(threadId));
  if (!row) return { text: null, reason: 'none' };
  let j;
  try {
    j = JSON.parse(row.item_json);
  } catch {
    return { text: null, reason: 'malformed' };
  }
  const text = typeof j.text === 'string' ? j.text : Array.isArray(j.content) ? j.content.map((c) => c.text ?? '').join('') : '';
  return text.trim() ? { text: text.trim() } : { text: null, reason: 'none' };
}

// Receipt identity, not queue disappearance, proves consumption. A prior item
// in this same turn records mid-turn absorption even after the turn finishes.
// rollout_ordinal is the thread's own write order (unique per thread);
// created_at_ms disagrees with it for items that started before an earlier
// write finished, so it never decides order here.
export async function codexDeliveryState(threadId, clientId) {
  if (!threadId || typeof clientId !== 'string' || !clientId) return 'unconfirmed';
  const row = await withDb((db) => db.prepare(`
    select exists (
      select 1 from thread_items earlier
      where earlier.thread_id = item.thread_id and earlier.turn_id = item.turn_id
        and earlier.rollout_ordinal < item.rollout_ordinal
    ) as mid_turn
    from thread_items item
    where item.thread_id = ? and item.item_type = 'userMessage'
      and json_extract(case when json_valid(item.item_json) then item.item_json else '{}' end, '$.clientId') = ?
    order by item.rollout_ordinal asc limit 1
  `).get(threadId, clientId));
  return row ? (row.mid_turn ? 'received_mid_turn' : 'received') : 'queued_unread';
}

// The thread's highest rollout_ordinal before a steer is sent, so its receipt
// is looked for only in what was written afterwards. -1 for a thread with no
// items yet; null when the history cannot be read.
export async function codexThreadCursor(threadId) {
  if (!threadId) return null;
  const row = await withDb((db) => db.prepare('select max(rollout_ordinal) as cursor from thread_items where thread_id = ?').get(threadId));
  return row ? (row.cursor ?? -1) : null;
}

// Desktop steer (send_message_to_thread) returns only {threadId}. The steered
// text lands in the target thread as a functionCallOutput item whose output
// is a <codex_delegation> envelope with the text XML-escaped, so the receipt
// is the bare `magi-delivery:<uuid>` token the sender appended, searched only
// after the pre-send cursor. Landing is not reading: the model has read it
// once a later reasoning or agentMessage item exists in that turn, or a
// later tool call that started after it (a command already running when the
// steer landed can finish after it and proves nothing). A landed steer the
// model has not read stays queued_unread even when its turn then failed or
// ended (usage limits, capacity): the item stays stored in the thread, so a
// resend risks a duplicate rather than repairing a loss.
// ponytail: no 'failed' here. The native-lane rejection
// (unsupported_native_inflight_message) was not found in any store Magi can
// read (docs/transport-recon.md); when Codex records it, map it to 'failed'.
// 'accepted' | 'queued_unread' | 'received' | 'received_mid_turn'
export async function codexSteerState(threadId, marker, cursor) {
  if (!threadId || typeof marker !== 'string' || !marker || !Number.isFinite(cursor)) return 'accepted';
  // Malformed JSON would make json_extract raise and hide every other row, so
  // it is replaced by '{}' first, as in codexDeliveryState.
  const row = await withDb((db) => db.prepare(`
    select
      exists (
        select 1 from thread_items earlier
        where earlier.thread_id = item.thread_id and earlier.turn_id = item.turn_id
          and earlier.rollout_ordinal < item.rollout_ordinal
      ) as mid_turn,
      exists (
        select 1 from thread_items later
        where later.thread_id = item.thread_id and later.turn_id = item.turn_id
          and later.rollout_ordinal > item.rollout_ordinal
          and (later.item_type in ('reasoning', 'agentMessage')
            or (later.item_type in ('commandExecution', 'mcpToolCall') and later.created_at_ms >= item.created_at_ms))
      ) as consumed
    from (
      select thread_id, turn_id, rollout_ordinal, created_at_ms,
        case when json_valid(item_json) then item_json else '{}' end as j
      from thread_items
      where thread_id = ? and rollout_ordinal > ? and item_type = 'functionCallOutput'
    ) item
    where json_extract(item.j, '$.name') = 'send_message_to_thread'
      and json_extract(item.j, '$.namespace') = 'codex_app'
      and instr(json_extract(item.j, '$.output'), ?) > 0
    order by item.rollout_ordinal asc limit 1
  `).get(threadId, cursor, marker));
  if (!row) return 'accepted';
  if (!row.consumed) return 'queued_unread';
  return row.mid_turn ? 'received_mid_turn' : 'received';
}
