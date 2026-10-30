import { appendFileSync } from 'node:fs';

const DIRECT_KEYS = ['threadId', 'thread_id', 'openai/threadId', 'codexThreadId', 'codex_thread_id'];
const TURN_KEYS = ['X-Codex-Turn-Metadata', 'x-codex-turn-metadata'];

// Request metadata is supplied by the MCP client, separately from model tool
// arguments. Conflicting aliases are an error, not an invitation to guess.
export function codexCaller(meta) {
  const ids = new Set();
  const keys = [];
  const add = (value, key) => {
    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim());
      keys.push(key);
    }
  };
  if (meta && typeof meta === 'object') {
    for (const key of DIRECT_KEYS) add(meta[key], key);
    for (const key of TURN_KEYS) {
      let turn = meta[key];
      if (typeof turn === 'string') {
        try { turn = JSON.parse(turn); } catch { continue; }
      }
      if (turn && typeof turn === 'object') add(turn.thread_id, key);
    }
  }
  if (ids.size > 1) throw Object.assign(new Error('Conflicting originating task ids in MCP request metadata.'), { code: 'ORIGIN_MISMATCH' });
  const sessionId = typeof meta?.sessionId === 'string' && meta.sessionId.trim() ? meta.sessionId.trim() : null;
  return { threadId: [...ids][0] ?? null, sessionId, keys, source: ids.size ? 'mcp_request_meta' : 'unknown' };
}

export function traceCodexCaller(caller, kind) {
  const path = process.env.MAGI_IDENTITY_TRACE_FILE;
  if (!path) return;
  // Never dump _meta: it may contain unrelated context or credentials.
  const event = {
    at: new Date().toISOString(), pid: process.pid, kind,
    threadId: caller.threadId, source: caller.source,
    keys: caller.keys.filter((key) => DIRECT_KEYS.includes(key) || TURN_KEYS.includes(key)),
  };
  try { appendFileSync(path, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 }); }
  catch (error) { console.error(`[magi] identity trace unavailable (${error.code ?? 'write error'})`); }
}
