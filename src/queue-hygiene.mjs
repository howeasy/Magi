import { createHash } from 'node:crypto';
import { codexQueueAdd, codexQueueList, codexQueueDelete } from './transport.mjs';
import { resolveSteerTarget } from './codex-target.mjs';
import { readQueueReceipts, reserveQueueNote, updateQueueReceipt, retryState } from './state.mjs';
import { BridgeError } from './exec.mjs';

export const queuePayloadHash = (text) => createHash('sha256').update(text).digest('hex');

function ownedEntry(entry, threadId) {
  return entry && entry.threadId === threadId && ['note', 'watch'].includes(entry.kind)
    && typeof entry.clientId === 'string' && typeof entry.senderId === 'string' && entry.senderId.length > 0
    && ['claude', 'codex'].includes(entry.senderAgent) && Number.isInteger(entry.sequence) && entry.sequence > 0
    && (entry.queueKey === null || (typeof entry.queueKey === 'string' && entry.queueKey.length > 0))
    && /^[a-f0-9]{64}$/.test(entry.payloadHash ?? '') && ['reserved', 'queued', 'unconfirmed'].includes(entry.state);
}

function unchanged(entry, item) {
  if (!item || item.clientUserMessageId !== entry.clientId || (entry.messageId && item.id !== entry.messageId)) return false;
  if (!Array.isArray(item.input) || item.input.length !== 1) return false;
  const input = item.input[0];
  if (!input || input.type !== 'text' || typeof input.text !== 'string') return false;
  if (Object.keys(input).some((key) => !['type', 'text', 'text_elements'].includes(key))) return false;
  if (input.text_elements !== undefined && (!Array.isArray(input.text_elements) || input.text_elements.length)) return false;
  return queuePayloadHash(input.text) === entry.payloadHash;
}

function group(entry) {
  return JSON.stringify([entry.senderAgent, entry.senderId, entry.kind,
    entry.queueKey === null ? ['identical', entry.payloadHash] : ['topic', entry.queueKey]]);
}

// Only known client ids + payload hashes authorize cleanup. A header that says
// via=magi, an age, or a matching sender name never suffices.
export async function cleanupOwnedQueue(threadId, { dryRun = true, scope, list = codexQueueList, remove = codexQueueDelete, batchLimit = 20 } = {}) {
  // Read receipts first: an add confirmed after this snapshot must not be
  // retired because a preceding queue snapshot did not contain it yet.
  const record = readQueueReceipts(threadId);
  const rows = await list(threadId);
  if (!dryRun) {
    for (const entry of record.entries) {
      if (entry.state !== 'queued' || !entry.messageId) continue;
      const row = rows.find((item) => item.id === entry.messageId || item.clientUserMessageId === entry.clientId);
      if (!row || !unchanged(entry, row)) {
        await retryState(() => updateQueueReceipt(threadId, entry.clientId, { state: row ? 'relinquished' : 'not_pending', updatedAt: Date.now() }));
      }
    }
  }
  const eligible = record.entries.filter((entry) => ownedEntry(entry, threadId) && (!scope || group(entry) === group(scope)));
  const pending = eligible.flatMap((entry) => {
    const item = rows.find((row) => unchanged(entry, row));
    return item ? [{ entry, item }] : [];
  });
  const newest = new Map();
  for (const pair of pending) {
    const key = group(pair.entry);
    if (!newest.has(key) || newest.get(key).entry.sequence < pair.entry.sequence) newest.set(key, pair);
  }
  const result = { threadId, status: dryRun ? 'preview' : 'complete', candidates: [], removed: [], deferred: [], preservedChanged: [], preservedUnmatched: rows.length - pending.length };
  let attempts = 0;
  for (const old of pending) {
    const replacement = newest.get(group(old.entry));
    if (replacement.entry.sequence <= old.entry.sequence) continue;
    result.candidates.push(old.item.id);
    if (dryRun) continue;
    if (attempts++ >= batchLimit) { result.deferred.push(old.item.id); result.status = 'partial'; continue; }
    // Verify both bodies again immediately before deletion. The public queue
    // API has no compare-and-delete primitive; concurrent manual edits are not
    // an atomic transaction with this check.
    const current = await list(threadId);
    const stillOld = current.find((item) => item.id === old.item.id && unchanged(old.entry, item));
    const stillReplacement = current.find((item) => item.id === replacement.item.id && unchanged(replacement.entry, item));
    if (!stillOld || !stillReplacement) {
      result.preservedChanged.push(old.item.id);
      result.status = 'partial';
      continue;
    }
    const deleted = await remove({ threadId, messageId: old.item.id });
    await retryState(() => updateQueueReceipt(threadId, old.entry.clientId, { state: deleted ? 'superseded' : 'not_pending', supersededBy: replacement.entry.clientId, updatedAt: Date.now() }));
    if (deleted) result.removed.push(old.item.id);
  }
  return result;
}

export function makeHygienicQueue({ resolve = resolveSteerTarget, add = codexQueueAdd, list = codexQueueList, remove = codexQueueDelete } = {}) {
  return async ({ target, text, sender, kind, queueKey }) => {
    const threadId = await resolve(target);
    const senderId = sender?.id ?? sender?.sessionId;
    // The caller checks this too; a missing sender must be a refusal here as
    // well, not a TypeError from the line below.
    if (!senderId || !sender?.agent) throw new BridgeError('QUEUE_IDENTITY_REQUIRED', 'Queue replacement needs an identified sender; nothing was queued.');
    const entry = await retryState(() => reserveQueueNote({ threadId, senderId, senderAgent: sender.agent, kind, queueKey, payloadHash: queuePayloadHash(text) }));
    // Reservation order defines replacement order, even when concurrent add
    // acknowledgements return out of order. Never delete before add succeeds.
    let receipt;
    try { receipt = await add({ threadId, text, clientId: entry.clientId }); }
    catch (error) {
      // An error may follow a successful persistence. Retain the client id for
      // reconciliation instead of rolling it back or retrying the add.
      try { await retryState(() => updateQueueReceipt(threadId, entry.clientId, { state: 'unconfirmed', updatedAt: Date.now() })); } catch { /* original failure remains authoritative */ }
      throw error;
    }
    let hygiene;
    try {
      await retryState(() => updateQueueReceipt(threadId, entry.clientId, { messageId: receipt.messageId, state: 'queued', updatedAt: Date.now() }));
      hygiene = await cleanupOwnedQueue(threadId, { dryRun: false, scope: entry, list, remove });
    } catch (error) {
      // The new message is already queued. Report cleanup failure separately so
      // a caller does not resend a successfully submitted message.
      hygiene = { status: 'incomplete', error: error.code ?? 'QUEUE_CLEANUP_FAILED', removed: [] };
    }
    return { ...receipt, clientId: entry.clientId, queueHygiene: hygiene };
  };
}
