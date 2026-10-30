import { appServer } from './transport.mjs';
import { BridgeError } from './exec.mjs';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Steering changes an active task: require a deliberate target and resolve a
// name uniquely over every matching page. Never pick the most recent task.
export async function resolveSteerTarget(peer, query = appServer) {
  if (typeof peer !== 'string' || !peer.trim()) throw new BridgeError('STEER_NEEDS_PEER', 'Steer delivery requires an explicit peer UUID or exact task name.');
  if (UUID.test(peer)) return peer;
  const matches = new Map();
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const [response] = await query([{ method: 'thread/list', params: { searchTerm: peer, archived: false, limit: 100, ...(cursor ? { cursor } : {}) } }]);
    if (response?.error || !Array.isArray(response?.result?.data)) throw new BridgeError('STEER_LOOKUP_FAILED', 'Could not resolve the requested Codex task name. Pass its UUID as peer, or run `magi doctor` to check the Codex app-server is reachable.');
    for (const thread of response.result.data) if (thread.name === peer && UUID.test(thread.id)) matches.set(thread.id, thread);
    if (matches.size > 1) throw new BridgeError('AMBIGUOUS_PEER', `Several Codex tasks are named "${peer}"; pass the target UUID.`);
    cursor = response.result.nextCursor;
    if (cursor == null) {
      if (!matches.size) throw new BridgeError('NO_LIVE_PEER', `No Codex task named "${peer}" was found; pass an existing target UUID.`);
      return [...matches.keys()][0];
    }
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new BridgeError('STEER_LOOKUP_FAILED', 'Codex task pagination did not advance. Pass the target UUID as peer.');
    seen.add(cursor);
  }
  throw new BridgeError('STEER_LOOKUP_FAILED', 'Task lookup exceeded its page limit; pass the target UUID.');
}
