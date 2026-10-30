// A session's own transcript, read the way the wall reads it: the same
// files the state comes from, never the harness's live channel. A leaf so
// the server can read it for `peers` and `transcript` without importing the
// fleet, which imports the server.
import { claudeTranscriptPath } from './transport.mjs';
import { tailLines } from './session-tail.mjs';
import { codexRecentMessages } from './codex-history.mjs';
import { redact } from './protocol.mjs';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Lifecycle markers are scanned from the full frame's receipt position, not a
// tail window: a busy worker can append arbitrarily much before its next turn.
function transcriptFile(row) {
  if (row.harness === 'codex') return null;
  return row.harness === 'claude'
    ? row.transcript ?? claudeTranscriptPath({ sessionId: row.id, cwd: row.cwd })
    : row.sessionFile ?? null;
}

export function transcriptPosition(row) {
  const file = transcriptFile(row);
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    const buffer = Buffer.alloc(8192);
    let offset = stat.size;
    // Include a record that was only partly written when the frame was sent.
    while (offset > 0) {
      const start = Math.max(0, offset - buffer.length);
      const n = readSync(fd, buffer, 0, offset - start, start);
      const newline = buffer.subarray(0, n).lastIndexOf(10);
      if (newline >= 0) { offset = start + newline + 1; break; }
      offset = start;
    }
    return { file, offset, size: stat.size, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
  } catch { return null; }
  finally { if (fd != null) closeSync(fd); }
}

// With a cursor, Infinity means context was invalidated after that receipt,
// regardless of marker clock accuracy. Without one, retain timestamp lookup.
export function compactionAt(row, cursor = null) {
  const file = transcriptFile(row);
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (cursor && (cursor.file !== file || cursor.dev !== stat.dev ||
      cursor.ino !== stat.ino || cursor.birthtimeMs !== stat.birthtimeMs ||
      stat.size < cursor.size)) return Infinity;
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let offset = cursor?.offset ?? 0;
    let pending = '';
    let latest = null;
    const inspect = (line) => {
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      if (!(entry.type === 'compaction' || (entry.type === 'system' && entry.subtype === 'compact_boundary'))) return;
      const at = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp);
      latest = cursor || !Number.isFinite(at) ? Infinity : Math.max(latest ?? -Infinity, at);
    };
    while (offset < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!n) break;
      offset += n;
      pending += decoder.write(buffer.subarray(0, n));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        inspect(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (latest === Infinity) return latest;
    }
    inspect(pending + decoder.end());
    return latest;
  } catch { return cursor ? Infinity : null; }
  finally { if (fd != null) closeSync(fd); }
}

// The last entries as { role, text, at }: what the agent is doing between
// replies.
export async function transcriptTail(row, { limit = 40 } = {}) {
  if (row.harness === 'codex') return codexRecentMessages(row.id, limit);
  const file = row.harness === 'claude' ? row.transcript ?? claudeTranscriptPath({ sessionId: row.id, cwd: row.cwd }) : row.sessionFile ?? null;
  if (!file) return [];
  const { lines } = tailLines(file, 256 * 1024);
  const out = [];
  for (const l of lines) {
    const msg = row.harness === 'claude' ? (l.type === 'user' || l.type === 'assistant' ? l.message : null) : l.type === 'message' ? l.message : null;
    if (!msg) continue;
    const c = msg.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
    if (!text.trim()) continue; // tool calls and results are not the conversation
    if (msg.role === 'user' && text.trimStart().startsWith('<')) continue; // harness notifications, not the user
    out.push({ role: msg.role ?? l.type, text, at: l.timestamp ? Date.parse(l.timestamp) : null });
  }
  return out.slice(-limit);
}

// One line for a row on the wall or in `peers`: the last thing said, either
// way round, clipped. `at` is null when the transcript carries no clock.
export async function lastSaid(row, { chars = 240 } = {}) {
    const last = (await transcriptTail(row, { limit: 1 }))[0];
    if (!last) return null;
    const flat = redact(last.text).text.replace(/\s+/g, ' ').trim();
    return { role: last.role, text: flat.length > chars ? flat.slice(0, chars - 1) + '\u2026' : flat, at: last.at };
}
