import { deliverToCodex, steerCodexThread, deliverReplyToOrigin, originOf, MAX_QUEUE_INLINE } from './transport.mjs';
import { BridgeError } from './exec.mjs';
import { makeHygienicQueue } from './queue-hygiene.mjs';
import { composeSpill } from './protocol.mjs';
import { confirmCodex } from './delivery-confirm.mjs';

import { UUID, resolveSteerTarget } from './codex-target.mjs';
export { resolveSteerTarget } from './codex-target.mjs';

// A Codex target is a thread; `codex queue` takes its name or id. The engine
// may hand over the thread object it recorded, or the string a caller typed.
// The id goes first: pickSession already matched the name uniquely, and codex
// 0.155.1 refuses a name once its thread list spans more than one page
// ("Cannot verify a unique session label across server pages").
export function codexAddress(target) {
  if (typeof target === 'string') return target;
  return target?.id ?? target?.name ?? null;
}

export function makeCodexLiveDelivery({ queue = deliverToCodex, steer = steerCodexThread, hygienicQueue = makeHygienicQueue() } = {}) {
  return async ({ text, target, taskId, round, putRequestBody, progress, delivery, sender, kind, args = {} }) => {
    const address = codexAddress(target);
    if (delivery === 'steer') {
      // Stdio has no argv-size constraint. Preserve the full provenance header
      // and body, and let every transport error escape without a downgrade.
      const id = await resolveSteerTarget(typeof target === 'object' && UUID.test(target?.id ?? '') ? target.id : address);
      const receipt = await steer({ thread: id, text });
      const threadId = receipt?.threadId ?? id;
      // A daemon steer is joined by its client id, a desktop one by its marker.
      const byDaemon = typeof receipt?.clientId === 'string';
      const deliveryStatus = byDaemon ? await confirmCodex({ threadId, clientId: receipt.clientId })
        : receipt?.marker && Number.isFinite(receipt?.cursor) ? await confirmCodex({ threadId, marker: receipt.marker, cursor: receipt.cursor })
        : 'accepted';
      progress?.(`${byDaemon ? 'Codex app-server daemon' : 'desktop tool'} accepted steer delivery for "${id}"; ${deliveryStatus}`);
      return { ...receipt, threadId, via: `steer:${id}`, label: id, target: id, deliveryStatus,
        statusText: byDaemon
          ? (deliveryStatus === 'received' || deliveryStatus === 'received_mid_turn' ? 'The Codex thread history records the steer in the running turn.'
            : 'The Codex app-server daemon accepted the steer; the thread history does not show it yet. Do not resend it.')
          : deliveryStatus === 'received' ? 'The Codex thread history records the steer as a new turn the model has read.'
          : deliveryStatus === 'received_mid_turn' ? 'The Codex thread history records the steer absorbed mid-turn and read by the model.'
          : deliveryStatus === 'queued_unread' ? 'The steer is in the Codex thread history; the model has not read it yet. Do not resend it.'
          : 'The desktop app accepted the message; peer receipt is unconfirmed. Do not resend it.' };
    }
    let body = text;
    if (body.length > MAX_QUEUE_INLINE) {
      if (!taskId) throw new BridgeError('NOTE_TOO_LARGE', 'An oversized note cannot use the task request-file path.');
      body = composeSpill({ taskId, round: round ?? args.round, path: putRequestBody(taskId, text), replyTool: 'claude_peer' });
    }
    const identified = sender?.id ?? sender?.sessionId;
    const queueKey = args.queueKey;
    if (['note', 'watch'].includes(kind) && queueKey !== undefined && !identified) {
      throw new BridgeError(
        'QUEUE_IDENTITY_REQUIRED',
        'queueKey replaces your own older queued update, which needs your session identified, and this one could not be ' +
          '(a session without a registry entry; for omp, the magi extension is not loaded in it). ' +
          'Omit queueKey to send the note unidentified, or restart the session with the extension. Nothing was queued.',
      );
    }
    const receipt = ['note', 'watch'].includes(kind) && identified
      ? await hygienicQueue({ target: address, text: body, sender, kind, queueKey })
      : await queue({ thread: address, text: body });
    const shown = target?.name ?? address;
    const deliveryStatus = await confirmCodex({ threadId: receipt.threadId ?? address, clientId: receipt.clientId });
    progress?.(`queued for Codex task "${shown}" (${receipt.messageId}); ${deliveryStatus}`);
    const hygiene = receipt.queueHygiene;
    return {
      via: `live:${shown}`,
      label: shown,
      target: receipt.threadId ?? address,
      messageId: receipt.messageId ?? null,
      threadId: receipt.threadId ?? address,
      clientId: receipt.clientId,
      deliveryStatus,
      statusText: deliveryStatus === 'received' ? 'The Codex thread history records the queued message as a user turn.'
        : deliveryStatus === 'received_mid_turn' ? 'The Codex thread history records the queued message absorbed mid-turn.'
        : 'Queued for the Codex task; consumption is unconfirmed. Do not resend it.',
      warning: hygiene?.status === 'incomplete' ? `The message is queued, but cleanup of your older queued update is incomplete (${hygiene.error}); do not resend it.` : undefined,
      queueHygiene: hygiene,
    };
  };
}

export function makeCodexReplyDelivery({ queueReply = deliverReplyToOrigin, steer = steerCodexThread } = {}) {
  return async ({ text, task, sender, delivery }) => {
    if (delivery !== 'steer') return queueReply({ text, task, sender });
    const origin = originOf(task);
    // An omp origin steers through its inbox; deliverTo refuses a Claude one.
    if (origin && origin.agent !== 'codex') return queueReply({ text, task, sender, steer: true });
    if (!UUID.test(origin?.id ?? '')) throw new BridgeError('NO_REPLY_ROUTE', 'Steer reply requires the recorded originating Codex UUID.');
    const receipt = await steer({ thread: origin.id, text });
    return { ...receipt, threadId: receipt?.threadId ?? origin.id, target: origin.id, via: 'steer', deliveryStatus: 'accepted' };
  };
}
