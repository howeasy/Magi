// Loaded by Claude Code (or any harness with --as): Codex is the peer.
import { listCodexThreads } from './transport.mjs';
import { headlessCodexArgs, codexAppServerSession } from './codex-launch.mjs';
import { codexPresence, codexTurnState } from './codex-history.mjs';
import { resolveSteerTarget, makeCodexLiveDelivery, makeCodexReplyDelivery } from './codex-delivery.mjs';

// Liveness cannot be read from `thread/list`: the bridge's own app-server
// reads the saved-thread database and reports everything "notLoaded", even a
// session that is open and accepting input. So every addressable thread is a
// candidate, and the queue arbitrates: `codex queue` takes a thread by id or
// exact name and the process that has it loaded picks the message up.
// Whether a thread is mid-turn comes from Codex's own turn table instead.
// ponytail: no live per-request usage source outside the process that owns
// the thread at 0.153.4, so a Codex row carries no context size.
function purposeOf(t) {
  const first = (t.preview ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const p = first.length > 140 ? `${first.slice(0, 140)}…` : first;
  const who = [t.agentNickname, t.agentRole].filter(Boolean).join(' / ');
  return [who ? `(${who})` : null, p || null].filter(Boolean).join(' ') || null;
}

function ago(at) {
  if (!at) return null;
  const s = Math.max(0, Math.round(Date.now() / 1000 - at));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// One session row, from thread/list or from Codex's own databases.
const rowOf = (t, state) => ({ name: t.name, id: t.id, cwd: t.cwd, purpose: purposeOf(t), branch: t.branch, lastActive: ago(t.recencyAt), recencyAt: t.recencyAt ?? null, parentThreadId: t.parentThreadId ?? null, agentNickname: t.agentNickname ?? null, agentRole: t.agentRole ?? null, model: t.model ?? null, ...state });

export const adapter = {
  peer: 'codex',
  display: 'Codex',
  tool: 'codex_peer',
  selfDefault: 'claude',
  // The tool named for the orchestrator: a Codex session's own server serves
  // one per peer, and a card note is refused on any other (CARD_FIXED).
  replyTool: (self) => (self === 'omp' ? 'omp_peer' : 'claude_peer'),
  schema: {
    deliveries: ['auto', 'live', 'headless', 'steer'],
    peerHint: 'Live Codex thread name or id',
    steerHint: 'a working task, when the message changes what it does now (new spec, stop, blocking question); explicit peer, no fallback',
    queueKey: true,
  },
  // thread/list is filtered by cwd server-side (its own default order is
  // created_at); listCodexThreads re-sorts by recencyAt, most recent first.
  // An unreachable app-server reads as "nobody" for the engine, which then
  // falls back to headless; `magi peers` asks with `strict` to be told instead.
  async sessions({ cwd, strict = false }) {
    let threads = [];
    try {
      threads = await listCodexThreads({ cwd });
    } catch (e) {
      if (strict) throw e;
      return [];
    }
    const rows = threads.filter((t) => t.canAcceptDirectInput !== false);
    const states = await Promise.all(rows.map((t) => codexTurnState(t.id)));
    return rows.map((t, i) => rowOf(t, states[i]));
  },
  // Every interactive thread on the machine, read from Codex's databases with
  // no app-server: what `magi status` counts. `open` marks a thread the
  // desktop holds a writer lock on. Null when the databases cannot be read;
  // the caller then asks thread/list.
  async presence() {
    const threads = await codexPresence();
    return threads && threads.map((t) => rowOf(t, { status: t.status, statusAt: t.statusAt, open: t.open }));
  },
  // Steering changes an active task: it needs a deliberate target, resolved
  // uniquely, never the most recent thread.
  steerTarget: (target) => resolveSteerTarget(typeof target === 'string' ? target : target?.id ?? target?.name),
  // A dedicated `codex app-server` per run, held open so a note on the card
  // steers the running turn (src/codex-launch.mjs).
  headless: { bin: 'codex', args: headlessCodexArgs, channel: codexAppServerSession },
  deliverLive: makeCodexLiveDelivery(),
  // Only reached out of band; a blocking orchestrator takes the mailbox.
  deliverReply: makeCodexReplyDelivery(),
};
