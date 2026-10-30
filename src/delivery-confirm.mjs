import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { claudeTranscriptPath, listClaudeSessions } from './transport.mjs';
import { magiHome } from './state.mjs';
import { codexDeliveryState, codexSteerState } from './codex-history.mjs';

const INSPECTION_BYTES = 256 * 1024;

// Capture before dispatch, not when confirmation starts: a fast receiver may
// already have appended its evidence by then.
export function deliveryCursor(path) {
  try { return statSync(path).size; } catch { return 0; }
}

export function confirmWaitMs(value) {
  const ms = Number(value ?? process.env.MAGI_CONFIRM_MS ?? 3000);
  return Number.isFinite(ms) && ms >= 0 ? ms : 3000;
}

async function poll(inspect, timeoutMs, initialStatus = 'unconfirmed') {
  const deadline = Date.now() + confirmWaitMs(timeoutMs);
  let status = initialStatus;
  let first = true;
  do {
    if (!first && Date.now() >= deadline) return status;
    first = false;
    try {
      const observed = await inspect(deadline);
      if (['received', 'received_mid_turn', 'failed'].includes(observed)) return observed;
      status = observed;
    } catch { /* Missing, locked or not-yet-flushed evidence is not receipt. */ }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return status;
    await delay(Math.min(50, remaining));
  } while (true);
}

function contentHas(content, marker) {
  return typeof content === 'string' ? content.includes(marker)
    : Array.isArray(content) && content.some((part) => typeof part?.text === 'string' && part.text.includes(marker));
}

// Both transports scan only this write's suffix. Never rewind into history on
// truncation: a reused marker there cannot establish receipt of this write.
function appendedRecords(cursor, inspectRecord) {
  const buffer = Buffer.alloc(16 * 1024);
  const decoder = new StringDecoder('utf8');
  let offset = cursor;
  let pending = '';
  return async (path, deadline) => {
    if (!path) return;
    const fd = openSync(path, 'r');
    try {
      const endOffset = fstatSync(fd).size;
      let inspected = 0;
      while (offset < endOffset && inspected < INSPECTION_BYTES) {
        // A zero deadline still allows one bounded chunk inspection.
        if (inspected > 0 && Date.now() >= deadline) break;
        const size = readSync(fd, buffer, 0, Math.min(buffer.length, INSPECTION_BYTES - inspected, endOffset - offset), offset);
        if (!size) break;
        offset += size;
        inspected += size;
        pending += decoder.write(buffer.subarray(0, size));
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (inspectRecord(record)) return;
        }
        // Do not monopolize the event loop even within a single inspection.
        await yieldTurn();
      }
    } finally { closeSync(fd); }
  };
}

export async function confirmClaude({ sessionId, cwd, session, transcriptPath, cursor = 0, marker, timeoutMs } = {}) {
  if (typeof marker !== 'string' || !marker) return 'unconfirmed';
  const destination = session ?? (cwd ? { sessionId, cwd }
    : sessionId ? listClaudeSessions({ includeUnaddressable: true }).find((entry) => entry.sessionId === sessionId) : null);
  const path = transcriptPath ?? destination?.transcript ?? claudeTranscriptPath(destination);
  if (!path) return 'unconfirmed';
  const ids = new Set();
  let status = 'unconfirmed';
  const remember = (record) => {
    for (const key of ['uuid', 'commandUuid', 'deliveryId', 'delivery_id']) {
      if (record[key]) ids.add(record[key]);
    }
  };
  const scan = appendedRecords(cursor, (record) => {
    if (record.type === 'user' && record.origin?.kind === 'peer' && contentHas(record.message?.content ?? record.content, marker)) {
      status = 'received';
    } else if (record.type === 'attachment' && record.attachment?.type === 'queued_command'
      && record.attachment.origin?.kind === 'peer'
      && contentHas(record.attachment.content, marker)) {
      remember(record.attachment);
    } else if (record.type === 'queue-operation') {
      const matched = contentHas(record.content, marker);
      if (record.operation === 'enqueue' && matched) {
        remember(record);
        if (status === 'unconfirmed') status = 'queued_unread';
      } else if (record.operation === 'remove' && record.reason === 'absorbed_mid_turn'
        && (matched || [record.commandUuid, record.deliveryId].some((id) => id && ids.has(id)))) {
        if (status !== 'received') status = 'received_mid_turn';
      }
    }
    return status === 'received' || status === 'received_mid_turn';
  });
  return poll(async (deadline) => {
    await scan(path, deadline);
    return status;
  }, timeoutMs);
}

export async function confirmOmp({ pid, sessionId, session, sessionFile, cursor, marker, frameId = marker, timeoutMs } = {}) {
  if (typeof marker !== 'string' || !marker) return 'unconfirmed';
  pid ??= session?.pid;
  sessionId ??= session?.sessionId;
  sessionFile ??= session?.sessionFile;
  const home = magiHome();
  let db;
  let receiptQuery;
  let frameQuery;
  let receipt;
  let received = false;
  let scan;
  const matches = (record) => record && record.pid === pid && (!sessionId || record.sessionId === sessionId);
  try {
    return await poll(async (deadline) => {
      let frameState;
      // Read-only receipt lookup avoids store migrations and its cold busy wait
      // on this deadline-sensitive path. A missing DB is never created here.
      try {
        if (!db && existsSync(join(home, 'magi.db'))) {
          db = new DatabaseSync(join(home, 'magi.db'), { readOnly: true });
          db.exec('PRAGMA busy_timeout=0');
        }
        if (db && !receiptQuery) receiptQuery = db.prepare('SELECT value FROM records WHERE namespace=? AND key=?');
        if (db && !frameQuery) frameQuery = db.prepare('SELECT state FROM frames WHERE to_pid=? AND id=?');
        frameState = frameQuery?.get(pid, frameId)?.state;
        if (frameState === 'failed') return 'failed';
        const row = receiptQuery?.get('delivery-acks', frameId);
        const ack = row ? JSON.parse(row.value) : null;
        if (matches(ack) && ack.status === 'submitted') receipt = ack;
      } catch { /* A locked receipt cannot establish submission. */ }
      const path = sessionFile ?? receipt?.sessionFile;
      if (path && !scan) scan = appendedRecords(cursor ?? receipt?.cursor ?? 0, (record) => {
        if (record.type === 'message' && record.message?.role === 'user' && contentHas(record.message.content, marker)) received = true;
        return received;
      });
      try { await scan?.(path, deadline); } catch { /* Session evidence may not be flushed. */ }
      if (received) return 'received';
      return receipt || frameState === 'queued' || frameState === 'processing' ? 'queued_unread' : 'unconfirmed';
    }, timeoutMs);
  } finally { db?.close(); }
}

// A note for a headless worker another server launched waits in that
// server's inbox (frames.to_pid). The server claims it, writes it to its
// worker, and records under delivery-acks, keyed by frame id, what the worker
// has done with it: submitted, received, received_mid_turn or failed.
export async function confirmHeadlessNote({ pid, frameId, timeoutMs } = {}) {
  const home = magiHome();
  let db;
  let frameQuery;
  let ackQuery;
  try {
    return await poll(async () => {
      if (!db && existsSync(join(home, 'magi.db'))) {
        db = new DatabaseSync(join(home, 'magi.db'), { readOnly: true });
        db.exec('PRAGMA busy_timeout=0');
      }
      if (!db) return 'unconfirmed';
      frameQuery ??= db.prepare('SELECT state FROM frames WHERE to_pid=? AND id=?');
      ackQuery ??= db.prepare('SELECT value FROM records WHERE namespace=? AND key=?');
      const frameState = frameQuery.get(pid, frameId)?.state;
      if (frameState === 'failed') return 'failed';
      const row = ackQuery.get('delivery-acks', frameId);
      const ack = row ? JSON.parse(row.value) : null;
      if (ack?.pid === pid) return ack.status === 'submitted' ? 'queued_unread' : ack.status;
      return frameState ? 'queued_unread' : 'unconfirmed';
    }, timeoutMs);
  } finally { db?.close(); }
}

// A queue receipt carries the client id Codex stores on the userMessage; a
// desktop steer receipt carries the marker it appended and the thread's
// rollout_ordinal cursor from before the send (codexSteerState).
export async function confirmCodex({ threadId, clientId, marker, cursor, timeoutMs } = {}) {
  if (threadId && typeof marker === 'string' && marker && Number.isFinite(cursor)) {
    return poll(() => codexSteerState(threadId, marker, cursor), timeoutMs, 'accepted');
  }
  if (!threadId || typeof clientId !== 'string' || !clientId) return 'unconfirmed';
  return poll(() => codexDeliveryState(threadId, clientId), timeoutMs, 'queued_unread');
}
