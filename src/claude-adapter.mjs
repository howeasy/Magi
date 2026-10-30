// Loaded by Codex CLI (or any harness with --as): Claude Code is the peer.
import { claudeStreamSession } from './exec.mjs';
import { listClaudeSessions, remoteClaudeSessions, deliverToClaude, claudeSessionPurpose, claudeTranscriptPath } from './transport.mjs';
import { tailLines, claudeContextFrom, modelFrom } from './session-tail.mjs';
import { claudeSessionStatus } from './usage.mjs';
import { headlessClaudeArgs } from './claude-launch.mjs';
import { confirmClaude } from './delivery-confirm.mjs';

export const adapter = {
  peer: 'claude',
  display: 'Claude Code',
  tool: 'claude_peer',
  selfDefault: 'codex',
  replyTool: () => 'codex_peer',
  schema: { deliveries: ['auto', 'live', 'headless'], peerHint: 'Live Claude session name, id or pid' },
  // Activity comes from the registry; the context size from the transcript
  // tail, or, when the statusline hook is installed, from its JSON, which also
  // knows the window and whether the prompt cache is warm.
  sessions: async ({ observe = false } = {}) => {
    const local = listClaudeSessions({ observe });
    return [...local, ...remoteClaudeSessions({ known: local })]
      .filter((s) => s.kind !== 'daemon')
      .map((s) => {
        const st = claudeSessionStatus(s.sessionId);
        const lines = st?.contextTokens != null && st?.model ? null : tailLines(claudeTranscriptPath(s) ?? '').lines;
        const context = st?.contextTokens != null ? { tokens: st.contextTokens, window: st.contextSize ?? null } : claudeContextFrom(lines ?? []);
        return { ...s, context, model: st?.model ?? (lines ? modelFrom(lines) : null), cache: st?.cacheWarm == null ? null : st.cacheWarm ? 'warm' : 'cold', costUsd: st?.costUsd ?? null };
      });
  },
  // The user's title for the session and its first prompt, from the transcript.
  purpose: claudeSessionPurpose,
  headless: {
    bin: 'claude',
    args: ({ allowWrites, allowCommands, resumeThreadId, model }) => headlessClaudeArgs({ allowWrites, allowCommands, resumeThreadId, model }),
    channel: claudeStreamSession,
  },

  // `sender` is the calling session as the engine resolved it; it becomes the
  // envelope's from-name / from-session / from-mode, which is what lets a
  // bypass-class Claude receiver deliver instead of holding, and what its user
  // sees as "Message from @codex:<thread>".
  async deliverLive({ text, target, progress, sender }) {
    const label = target.name ?? String(target.pid);
    const receipt = await deliverToClaude({ target, text, from: null, sender });
    const deliveryStatus = await confirmClaude({ session: target, ...receipt });
    const statusText = deliveryStatus === 'received' ? 'The Claude transcript records the peer message as a user turn.'
      : deliveryStatus === 'received_mid_turn' ? 'The Claude transcript records the peer message absorbed mid-turn.'
      : deliveryStatus === 'queued_unread' ? 'The Claude transcript records the message queued; consumption is unconfirmed.'
      : 'The Claude socket write completed; model receipt is unconfirmed.';
    progress?.(`written to live claude session "${label}"; ${deliveryStatus}`);
    return { ...receipt, via: `live:${label}`, label, deliveryStatus, statusText };
  },
};
