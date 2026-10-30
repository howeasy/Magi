// What a Claude session is doing right now, read from the tail of the
// transcript it writes for itself. No hook, no proxy: the JSONL carries
// per-turn usage. Only the last 64 KB is read, so a long session costs the
// same as a short one. (Codex keeps its live record in SQLite; see
// codex-history.mjs.)
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

// The first lines of a file, parsed; a sibling of tailLines for records a
// harness writes once at the start (omp's model_change).
export function headLines(file, bytes = 65536) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { lines: [] };
  }
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const raw = buf.subarray(0, n).toString('utf-8').split(/\r?\n/);
    const lines = [];
    for (const l of raw) {
      if (!l.trim()) continue;
      try { lines.push(JSON.parse(l)); } catch { /* the cut line */ }
    }
    return { lines };
  } finally {
    closeSync(fd);
  }
}

export function tailLines(file, bytes = 65536) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { lines: [], mtimeMs: null };
  }
  try {
    const { size, mtimeMs } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const raw = buf.subarray(0, n).toString('utf-8').split(/\r?\n/);
    if (start > 0) raw.shift(); // the first line is a fragment of one we cut
    const lines = [];
    for (const l of raw) {
      if (!l.trim()) continue;
      try {
        lines.push(JSON.parse(l));
      } catch {
        /* a line still being written */
      }
    }
    return { lines, mtimeMs };
  } finally {
    closeSync(fd);
  }
}

// Claude: the context is what the last assistant turn was billed for. The
// window is not in the transcript; callers show tokens alone.
export function claudeContextFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const u = lines[i]?.type === 'assistant' ? lines[i].message?.usage : null;
    if (!u) continue;
    return { tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
  }
  return null;
}

// The model a session is running: Claude stamps every assistant record with
// `message.model`; omp writes a `model_change` event when it picks one. The
// last of either in the tail is the active model.
export function modelFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l?.type === 'assistant' && typeof l.message?.model === 'string') return l.message.model;
    if (l?.type === 'model_change' && typeof l.model === 'string') return l.model;
  }
  return null;
}

// When a transcript last moved, by the records' own clock. The file's mtime
// is not that: the desktop app rewrites whole transcripts in bulk (twelve
// files of a July session, one second, 2026-09-20), so mtime says "now"
// about work that ended months ago.
export function lastRecordAt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.timestamp;
    if (typeof t === 'string') { const ms = Date.parse(t); if (!Number.isNaN(ms)) return ms; }
    if (typeof t === 'number') return t;
  }
  return null;
}

// omp's current title: the last `title_change` record, else the title the
// session record opened with; the extension API reports no name, and a peer
// addressed by its title should resolve.
export function titleFrom(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if ((l?.type === 'title_change' || l?.type === 'session') && typeof l.title === 'string' && l.title.trim()) return l.title.trim();
  }
  return null;
}

// The first thing the human said in a Claude transcript, read forwards from
// the start of the file and never from a window at the end: `magi spawn`
// correlates a session it opened by the marker at the head of this text.
// Leading <system-reminder> blocks the harness prepends to the same record
// are stripped; the record itself is never skipped. Returns { text } or
// { text: null, reason } with reason `none` (no complete user record yet:
// worth waiting for), `malformed` (a complete line before the first human
// record could not be parsed: not skipped, not worth waiting for) or
// `scan-limit` (the bound was read without a user record: not worth
// waiting for). Observed 2026-09-16, Claude desktop 2.110 / CLI 2.1.271:
// the app's first user record is `<system-reminder>…</system-reminder>\n\n<prompt>`.
export const FIRST_USER_SCAN_BYTES = 256 * 1024;
export function firstUserMessage(file, bytes = FIRST_USER_SCAN_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { text: null, reason: 'none' };
  }
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(Math.min(size, bytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.subarray(0, n).toString('utf-8');
    const lines = raw.split(/\r?\n/);
    // The last line counts only when the file ends on a newline: otherwise it
    // is still being written, or it is the line the bound cut in two.
    const complete = raw.endsWith('\n') ? lines.length : lines.length - 1;
    for (let i = 0; i < complete; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      let j;
      try {
        j = JSON.parse(l);
      } catch {
        return { text: null, reason: 'malformed' };
      }
      if (j?.type !== 'user') continue;
      const c = j.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '';
      if (!text.trim()) continue; // a tool result, not the human
      return { text: text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/, '').trim() };
    }
    return { text: null, reason: size > bytes ? 'scan-limit' : 'none' };
  } finally {
    closeSync(fd);
  }
}
