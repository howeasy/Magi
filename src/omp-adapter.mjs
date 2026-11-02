// Loaded by Claude Code, Codex or another omp session (--as says which).
// Live delivery goes through the inbox the omp extension polls; the
// fallback is a fresh `omp --mode rpc`, which takes notes while it works.
import { listAgentSessions, deliverToAgentInbox, ownClaudeInbox, ownAgentSession } from './transport.mjs';
import { headlessOmpArgs, ompRpcSession, ompSessionPurpose } from './omp-launch.mjs';
import { advisorDefaultOn, planAdvisor, writeAdvisorOverlay, advisorLine } from './omp-advisor.mjs';
import { tailLines, headLines, modelFrom } from './session-tail.mjs';
import { randomUUID } from 'node:crypto';
import { confirmOmp, deliveryCursor } from './delivery-confirm.mjs';

export const adapter = {
  peer: 'omp',
  display: 'Oh My Pi (omp)',
  tool: 'omp_peer',
  // Discovery is lazy: importing an adapter must not create a remote ledger.
  // A registered OMP ancestor identifies the harness, regardless of model.
  get selfDefault() {
    return process.env.MAGI_AS?.trim() || (ownAgentSession('omp') ? 'omp' : ownClaudeInbox() ? 'claude' : 'codex');
  },
  // The tool names the originating harness; the ledger selects its session.
  replyTool: (self) => self === 'omp' ? 'omp_peer' : self === 'claude' ? 'claude_peer' : 'codex_peer',
  schema: {
    deliveries: ['auto', 'live', 'headless', 'steer'],
    peerHint: 'Live omp session name, id or pid',
    steerHint: 'a working session, when the message changes what it does now (new spec, stop, blocking question); read at once',
    advisor: true,
  },
  // Registry listing resolves the same transcript title used for caller checks;
  // the adapter adds the last model_change event.
  sessions: async ({ includeHelpers = false, observe = false } = {}) =>
    listAgentSessions('omp', { includeHelpers, observe }).map((s) => {
      // 256 KiB: a title_change can sit behind a few large tool results.
      const tail = s.sessionFile ? tailLines(s.sessionFile, 256 * 1024).lines : [];
      const head = s.sessionFile ? headLines(s.sessionFile).lines : [];
      return { ...s, model: modelFrom(tail) ?? modelFrom(head) };
    }),
  purpose: ompSessionPurpose,
  headless: {
    bin: 'omp', args: headlessOmpArgs, channel: ompRpcSession,
    // Windows SQLite can fail truncating its WAL during startup. Retry only
    // before any RPC input or note; never replay a possibly executed request.
    retryStartup: ({ beforeInput, exitCode, stderr, parsed }) =>
      beforeInput === true && exitCode !== 0 && !parsed.message && /\bSQLITE_IOERR_TRUNCATE\b/.test(stderr),
  },
  // omp's own reviewer on a headless run. `plan` picks its model (never the
  // worker's own), `overlay` tells omp which, `describe` says so to the caller.
  advisor: { defaultOn: advisorDefaultOn, plan: planAdvisor, overlay: writeAdvisorOverlay, describe: advisorLine },

  // The extension turns the frame into a user turn: a new turn when idle, an
  // aside at the next step boundary when busy, a steer when asked.
  async deliverLive({ text, target, progress, sender, delivery }) {
    const deliverAs = delivery === 'steer' ? 'steer' : 'aside';
    const marker = `magi-delivery:${randomUUID()}`;
    const cursor = deliveryCursor(target.sessionFile);
    const r = deliverToAgentInbox({ target, text: `${text}\n<!-- ${marker} -->`, deliverAs, sender });
    const label = target.name ?? String(target.pid);
    const deliveryStatus = await confirmOmp({ session: target, cursor, marker, frameId: r.messageId });
    progress?.(`written to omp session "${label}" inbox (${deliverAs}); ${deliveryStatus}`);
    const statusText = deliveryStatus === 'received' ? 'The omp session file records the peer message as a user turn.'
      : deliveryStatus === 'queued_unread' ? 'The frame is queued or submitted to omp; session receipt is unconfirmed.'
      : deliveryStatus === 'failed' ? 'DELIVERY_FAILED: omp rejected this frame; inspect the failed inbox record before any manual resend.'
      : 'The omp inbox write completed; consumption is unconfirmed.';
    return { via: `live:${label}`, label, target, messageId: r.messageId, marker, cursor, sessionFile: target.sessionFile, deliveryStatus, statusText };
  },
};
