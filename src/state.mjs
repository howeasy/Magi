// Shared task ledger and mailbox. SQLite transactions span every state mutation.
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { redact, redactValue, parseReply } from './protocol.mjs';
import { database, statement, transaction, getRecord, setRecord, removeRecord, listRecords, assertTestHome } from './store.mjs';
import { processStartedAt } from '../omp/process-identity.js';

// A round cap keeps two eager agents from looping forever; it is a bound,
// not a budget. The default per task is small (2, or the mode's own), and
// an orchestrator raises it on a later round when the argument still has
// evidence left in it, up to this.
export const MAX_ROUNDS_CAP = 12;

// The next step for an error about a task that is not there: the usual cause is a
// mistyped or stale id, and the agent has no other feedback.
export const NEXT_TASK_HINT = 'Check taskId against the request or question header; `magi log` lists tasks.';
// A peer may ask this many clarifying questions per round before it must
// answer: a loop guard, not a talk limit. Six is more than any real question
// needs and stops two agents asking each other forever.
export const MAX_CLARIFIES_PER_ROUND = 6;

// Resolve the state directory without migrating or renaming legacy trees.
export function magiHome() {
  if (process.env.MAGI_TEST_HOME && !process.env.MAGI_HOME) {
    throw new LedgerError('TEST_HOME_REQUIRED', 'Tests require an explicit isolated MAGI_HOME; refusing the real home.');
  }
  const home = process.env.MAGI_HOME || join(homedir(), '.magi');
  assertTestHome(home);
  return home;
}

function dir(name) {
  const d = join(magiHome(), name);
  mkdirSync(d, { recursive: true });
  return d;
}

export function writeAtomic(path, text) {
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, text, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

function locked(key, action) {
  try { return transaction(magiHome(), action); }
  catch (error) {
    if (error.code === 'LEDGER_BUSY' && !(error instanceof LedgerError)) {
      throw new LedgerError(error.code, error.message);
    }
    throw error;
  }
}

function deadOwner(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export { locked as withStateLock };

export async function retryState(action, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return action(); }
    catch (error) {
      if (error.code !== 'LEDGER_BUSY') throw error;
      const expired = Date.now() >= deadline;
      // Even an exhausted busy wait yields once: a synchronous SQLite timeout
      // can use the whole deadline before timers or cancellation get a turn.
      await new Promise((resolve) => setTimeout(resolve, expired ? 0 : 10));
      if (expired) throw error;
    }
  }
}

// --- task ledger -----------------------------------------------------------
// Enforces: one orchestrator per task, rounds strictly increasing, bounded.

export function readTask(taskId) {
  return getRecord(magiHome(), 'tasks', taskId);
}

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Called by the orchestrator side before a request goes out.
export const CHANNEL_WINDOW_MS = 8 * 60 * 60 * 1000;

export function openRound(args) {
  return locked(`task-${args.taskId}`, () => openRoundUnlocked(args));
}

// null means one side has no verified session; same-harness callers must fail closed.
export function sameSession(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a.identityVerified === false || b.identityVerified === false) return null;
  if (a.agent && b.agent && a.agent !== b.agent) return false;
  const left = a.id ?? a.sessionId;
  const right = b.id ?? b.sessionId;
  if ((a.agent ?? b.agent) === 'omp') {
    const leftIds = [a.sessionId, a.id !== String(a.pid) ? a.id : null, ...(a.sessionAliases ?? [])].filter(Boolean);
    const rightIds = [b.sessionId, b.id !== String(b.pid) ? b.id : null, ...(b.sessionAliases ?? [])].filter(Boolean);
    if (leftIds.length && rightIds.length) return leftIds.some((id) => rightIds.includes(id));
    if (a.pid != null && b.pid != null && a.processStartedAt != null && b.processStartedAt != null) {
      return a.pid === b.pid && a.processStartedAt === b.processStartedAt;
    }
    return null;
  }
  return left && right ? left === right : null;
}

// A dispatch failure did not spend a round. Keep any reply that raced the error.
export function rollbackRound({ taskId, round, openedAt, previous }) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    const last = rec?.rounds.at(-1);
    if (!last || last.round !== round || last.openedAt !== openedAt || last.replied || last.clarifies || last.closedAt) return false;
    if (previous) {
      // A late reply to an older round may arrive while dispatch is in flight.
      // Remove only our round; restoring a snapshot would erase that reply.
      rec.rounds.pop();
      rec.maxRounds = previous.maxRounds;
      if (Object.hasOwn(previous, 'peerTarget')) rec.peerTarget = previous.peerTarget;
      else delete rec.peerTarget;
      setRecord(magiHome(), 'tasks', taskId, rec);
    } else removeRecord(magiHome(), 'tasks', taskId);
    return true;
  });
}

// `snapshot` is the artifact the round was opened against ({diffRef, diffSha256,
// treeSha, head}); a late reply is reconciled against the round it answered.
// `brief` is the first 400 characters of the task, redacted, so a pane can
// say what is in flight without the ledger carrying request bodies.
const BRIEF_CHARS = 400;
function briefOf(task) {
  const t = typeof task === 'string' ? redact(task).text.replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > BRIEF_CHARS ? `${t.slice(0, BRIEF_CHARS)}…` : t) : null;
}

// `allowCommands` on the task is the card's grant, set by its first round;
// each round records whether it ran with commands (a later round may narrow).
function openRoundUnlocked({ taskId, orchestrator, peer, mode, round, maxRounds, replyTo, orchestratorTarget, cwd, snapshot, task, liveCard = false, allowWrites = false, allowCommands = false }) {
  const cap = Math.min(maxRounds ?? 2, MAX_ROUNDS_CAP);
  if (!Number.isInteger(round) || round < 1 || !Number.isInteger(cap) || cap < 1) {
    throw new LedgerError('BAD_ROUND', 'round and maxRounds must be positive integers.');
  }
  const existing = readTask(taskId);

  if (!existing) {
    if (round !== 1) {
      throw new LedgerError('UNKNOWN_TASK', `Round ${round} was requested for unknown task ${taskId}. Start at round 1.`);
    }
    const rec = {
      taskId,
      orchestrator,
      peer,
      mode,
      maxRounds: cap,
      replyTo: replyTo ?? null,
      orchestratorTarget: orchestratorTarget ?? null,
      cwd: cwd ?? null,
      liveCard,
      allowWrites,
      allowCommands,
      ...(liveCard ? { channelExpiresAt: Date.now() + CHANNEL_WINDOW_MS } : {}),
      rounds: [{ round: 1, openedAt: Date.now(), replied: false, clarifies: 0, snapshot: snapshot ?? null, brief: briefOf(task), ...(allowCommands ? { allowCommands: true } : {}) }],
    };
    setRecord(magiHome(), 'tasks', taskId, rec);
    return rec;
  }

  // A peer must never be able to turn a task around and drive it.
  if (existing.orchestrator !== orchestrator || sameSession(existing.orchestratorTarget, orchestratorTarget) === false ||
    (existing.orchestrator === existing.peer && (orchestratorTarget?.identityVerified !== true ||
      sameSession(existing.orchestratorTarget, orchestratorTarget) !== true ||
      sameSession(existing.peerTarget && { agent: peer, ...existing.peerTarget }, orchestratorTarget) !== false))) {
    throw new LedgerError(
      'ROLE_VIOLATION',
      `Task ${taskId} belongs to its recorded ${existing.orchestrator} orchestrator session; this caller cannot open a round. ` +
        'Return to that orchestrator session. The peer answers with kind="reply".',
    );
  }
  if (existing.peer !== peer || (existing.mode != null && existing.mode !== mode)) {
    throw new LedgerError('CARD_FIXED', `Task ${taskId} uses ${existing.peer} in ${existing.mode} mode. Continue with that harness and mode, or open a new card without taskId.`);
  }
  if (existing.liveCard && Date.now() >= existing.channelExpiresAt) {
    throw new LedgerError('CHANNEL_EXPIRED', `Task ${taskId}'s 8-hour conversation window ended. Record one outcome for its answered turns, then open a new card without taskId.`);
  }
  const last = existing.rounds[existing.rounds.length - 1];
  // Raising the cap on a later round is the orchestrator's call; lowering
  // it is not, since rounds already opened stand.
  if (cap > existing.maxRounds) existing.maxRounds = cap;
  if (!existing.liveCard && round > existing.maxRounds) {
    throw new LedgerError(
      'ROUNDS_EXHAUSTED',
      `Task ${taskId} allows at most ${existing.maxRounds} round(s); round ${round} was requested. ` +
        (existing.maxRounds < MAX_ROUNDS_CAP ? `Pass maxRounds up to ${MAX_ROUNDS_CAP} with the request to keep going, or reconcile ` : 'That is the hard cap: reconcile ') +
        'the evidence yourself and report the remaining disagreement as unresolved.',
    );
  }
  if (round !== last.round + 1) {
    throw new LedgerError('BAD_ROUND', `Task ${taskId} is at round ${last.round}; the next round must be ${last.round + 1}, got ${round}.`);
  }
  if (!last.replied && !last.closedAt) {
    throw new LedgerError('ROUND_PENDING', `Round ${last.round} of task ${taskId} must be answered before opening another round.`);
  }
  if (allowCommands && !existing.allowCommands) {
    throw new LedgerError('BAD_REQUEST', `Task ${taskId} was opened without allowCommands; a continuation cannot add it. Open a new DELEGATE card with allowCommands: true.`);
  }
  // Writes, unlike commands, may be granted on a later turn, and the grant stays:
  // a card sent read-only by mistake is fixed once, not on every turn after.
  if (allowWrites && !existing.allowWrites) existing.allowWrites = true;
  existing.rounds.push({ round, openedAt: Date.now(), replied: false, clarifies: 0, snapshot: snapshot ?? null, brief: briefOf(task), ...(allowCommands ? { allowCommands: true } : {}) });
  setRecord(magiHome(), 'tasks', taskId, existing);
  return existing;
}

// Framing receipts live on the delivered turn, so channels remain derived from
// cards and a failed dispatch never teaches the pair a protocol it did not see.
export function recordRequestDelivery(taskId, round, delivery) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    const turn = rec?.rounds.find((r) => r.round === round);
    if (!turn) throw new LedgerError('UNKNOWN_TASK', `No turn ${round} on ${taskId}. Inspect magi exchange before retrying.`);
    turn.framing = delivery;
    setRecord(magiHome(), 'tasks', taskId, rec);
  });
}

// Keep receipts on the delivered turn, not as synthetic conversation messages.
// A later read (fleet.refreshChannelDeliveries) refines the projection without writing this ledger.
// One slot per direction: equal harness names use explicit recorded roles so
// the peer's reply home cannot erase the request's receipt.
export function recordCardDelivery(taskId, round, delivery) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    const turn = rec?.rounds.find((r) => r.round === round);
    if (!turn) throw new LedgerError('UNKNOWN_TASK', `No turn ${round} on ${taskId}. Inspect magi exchange before retrying.`);
    const at = delivery.at ?? Date.now();
    const slots = roundDeliveries(turn);
    const key = rec.orchestrator === rec.peer ? delivery.toRole : delivery.to ?? 'unknown';
    if (!key || (rec.orchestrator === rec.peer && !['peer', 'orchestrator'].includes(key))) {
      throw new LedgerError('ROLE_VIOLATION', `Task ${taskId} needs a peer or orchestrator delivery role; its harness names do not distinguish directions.`);
    }
    // A fast reply/note can finish while an older request is still confirming.
    if (slots[key]?.at > at) return;
    turn.deliveries = { ...slots, [key]: { ...delivery, at } };
    delete turn.delivery;
    setRecord(magiHome(), 'tasks', taskId, rec);
  });
}

// A round's receipts by direction. Rounds recorded before the per-direction
// slots hold a single `delivery`; it is read as the slot of its own `to`.
export function roundDeliveries(round) {
  if (round?.deliveries) return round.deliveries;
  const legacy = round?.delivery;
  return legacy ? { [legacy.to ?? 'unknown']: legacy } : {};
}

// Remembers where the request actually went, so a clarify can be answered.
export function setPeerTarget(taskId, target, round) {
  return locked(`task-${taskId}`, () => setPeerTargetUnlocked(taskId, target, round));
}

// The remote's copy of a card whose orchestrator is on another machine
// (src/relay.mjs). The orchestrator's own ledger is the record and has
// already applied every policy (round cap, debt, roles); this copy exists so
// the session here that works the card can reply, ask and talk through its
// own Magi tool, which checks the card's peer and round. So it opens round
// `round` as given, closing any earlier round left open (its answer or close
// was the orchestrator's to record, over there), and names the worker.
export function mirrorRound({ taskId, orchestrator, peer, mode, round, maxRounds, orchestratorTarget, peerTarget, cwd, task, attemptId = null }) {
  return locked(`task-${taskId}`, () => {
    const now = Date.now();
    const rec = readTask(taskId) ?? { taskId, orchestrator, peer, mode, maxRounds: maxRounds ?? null, replyTo: null, orchestratorTarget, cwd: cwd ?? null, liveCard: false, allowWrites: false, allowCommands: false, mirror: true, rounds: [] };
    if (rec.orchestrator !== orchestrator || rec.peer !== peer) throw new LedgerError('CARD_FIXED', `Task ${taskId} here is ${rec.orchestrator} to ${rec.peer}; a relayed ${orchestrator} to ${peer} round cannot reuse it.`);
    // A card of this machine's own, or one mirrored for another machine, is never taken over.
    if (!rec.mirror || rec.orchestratorTarget?.remote !== orchestratorTarget?.remote) throw new LedgerError('CARD_FIXED', `Task ${taskId} here is not a card ${orchestratorTarget?.remote ?? 'that machine'} runs; a relayed round cannot reuse it.`);
    // A repeated round keeps its worker and lifecycle. If another delivery
    // joined it, the creating attempt can no longer prove rollback is safe.
    const existing = rec.rounds.find((entry) => entry.round === round);
    if (existing) {
      if (attemptId && existing.mirrorAttemptId && existing.mirrorAttemptId !== attemptId) {
        existing.mirrorAttemptId = null;
        setRecord(magiHome(), 'tasks', taskId, rec);
      }
      return rec;
    }
    const newest = rec.rounds.reduce((n, entry) => Math.max(n, entry.round), 0);
    if (round < newest) throw new LedgerError('ROUND_STALE', `Task ${taskId} here is already at round ${newest}; round ${round} arrived late and was not mirrored. Nothing to do.`);
    for (const entry of rec.rounds) if (entry.round < round && !entry.replied && !entry.closedAt) Object.assign(entry, { closedAt: now, closeReason: 'superseded' });
    rec.rounds.push({ round, openedAt: now, replied: false, clarifies: 0, snapshot: null, brief: briefOf(task), ...(attemptId ? { mirrorAttemptId: attemptId } : {}) });
    const current = rec.rounds.find((entry) => entry.round === round);
    current.peerTarget = peerTarget;
    rec.peerTarget = peerTarget;
    rec.orchestratorTarget = orchestratorTarget;
    rec.maxRounds = maxRounds ?? rec.maxRounds;
    setRecord(magiHome(), 'tasks', taskId, rec);
    return rec;
  });
}

// Only the attempt that created a mirror may remove it, and only before any
// other attempt or worker activity used it. Never restore an old snapshot.
export function rollbackMirrorRound({ taskId, round, attemptId }) {
  if (!attemptId) return false;
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    const last = rec?.rounds.at(-1);
    if (!rec?.mirror || !last || last.round !== round || last.mirrorAttemptId !== attemptId ||
      last.replied || last.clarifies || last.closedAt) return false;
    rec.rounds.pop();
    if (!rec.rounds.length) removeRecord(magiHome(), 'tasks', taskId);
    else {
      rec.peerTarget = rec.rounds.at(-1).peerTarget;
      setRecord(magiHome(), 'tasks', taskId, rec);
    }
    return true;
  });
}

// `reason` says which way the round ended; `code` and `detail` say why. Without
// the last two a delivery failure is indistinguishable from any other, and the
// round is the only record that survives the process that failed.
export const MAX_CLOSE_DETAIL_CHARS = 300;

export function closeRound({ taskId, round, reason, code, detail, ifOpenedBefore }) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    if (!rec) throw new LedgerError('UNKNOWN_TASK', `No open task ${taskId}. ${NEXT_TASK_HINT}`);
    const current = rec.rounds.find((entry) => entry.round === round);
    if (!current) throw new LedgerError('BAD_ROUND', `No round ${round} on task ${taskId}. Use the round in the request header; \`magi exchange ${taskId}\` lists them.`);
    // ifOpenedBefore: the automatic pass re-checks, under the lock, that the round
    // is still open and still old, so it never overwrites a manual close.
    if (ifOpenedBefore != null && (current.closedAt || current.replied || current.openedAt >= ifOpenedBefore)) return rec;
    if (!current.replied && !current.closedAt) {
      current.closedAt = Date.now();
      current.closeReason = reason;
      if (code) current.closeCode = String(code);
      if (detail) current.closeDetail = redact(String(detail)).text.slice(0, MAX_CLOSE_DETAIL_CHARS);
      setRecord(magiHome(), 'tasks', taskId, rec);
      recordExchange(taskId, { kind: 'closed', round, from: rec.orchestrator, reason, code: code ? String(code) : undefined, text: detail ? String(detail) : undefined });
    }
    return rec;
  });
}

function setPeerTargetUnlocked(taskId, target, round) {
  const rec = readTask(taskId);
  if (!rec) return null;
  const current = round == null ? rec.rounds.at(-1) : rec.rounds.find((entry) => entry.round === round);
  if (!current) throw new LedgerError('BAD_ROUND', `No round ${round} on task ${taskId}. Use the round in the request header.`);
  // Preserve the only known worker for legacy rounds before changing the route.
  for (const entry of rec.rounds) {
    if (entry !== current && !Object.hasOwn(entry, 'peerTarget')) entry.peerTarget = rec.peerTarget ?? null;
  }
  current.peerTarget = target ?? null;
  if (current === rec.rounds.at(-1)) rec.peerTarget = target ?? null;
  if (target?.headless && rec.liveCard && rec.rounds.length === 1) {
    rec.liveCard = false;
    delete rec.channelExpiresAt;
  }
  setRecord(magiHome(), 'tasks', taskId, rec);
  return rec;
}

// What reconciliation decided, recorded by the orchestrator after it checked
// the peer's findings against the source. A reply proves the peer answered;
// this is the only record of whether it was right, and the only way the
// evidence-over-agreement rule is ever measured rather than asserted.
export const MAX_OUTCOME_NOTES_CHARS = 2000;

// `by` names who recorded it when that is not the orchestrator itself (a
// human at a pane); the log prints it so the tally stays honest.
export function recordOutcome({ taskId, from, accepted, rejected, open, notes, by }) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    if (!rec) throw new LedgerError('UNKNOWN_TASK', `No task ${taskId}.`);
    if (rec.orchestrator !== from) {
      throw new LedgerError('ROLE_VIOLATION', `Task ${taskId} is orchestrated by ${rec.orchestrator}; only the orchestrator records the outcome.`);
    }
    for (const [k, v] of Object.entries({ accepted, rejected, open })) {
      if (!Number.isInteger(v) || v < 0) throw new LedgerError('BAD_REQUEST', `${k} must be a non-negative integer.`);
    }
    rec.outcome = {
      accepted,
      rejected,
      open,
      notes: notes ? redact(String(notes)).text.slice(0, MAX_OUTCOME_NOTES_CHARS) : null,
      // The round whose reply this verdict is about: the latest one answered,
      // not one still open.
      round: [...rec.rounds].reverse().find((r) => r.replied)?.round ?? rec.rounds.at(-1)?.round ?? 1,
      at: Date.now(),
      // How many replies had arrived: the verdict covers those and no later one.
      seq: rec.replySeq ?? 0,
      seen: rec.rounds.filter((r) => r.replied).map((r) => r.round),
      ...(by && by !== from ? { by } : {}),
    };
    setRecord(magiHome(), 'tasks', taskId, rec);
    recordExchange(taskId, { kind: 'outcome', round: rec.outcome.round, from: rec.outcome.by ?? from, accepted, rejected, open, text: notes ? String(notes) : undefined });
    return rec;
  });
}

// Reconciliation nobody did, done by the clock, WITHOUT a verdict. A round
// with no reply after STALE_OPEN_MS is closed as abandoned (a late reply is
// still recorded). An answered reply nobody checked after UNCHECKED_MS is
// marked `expired` on the task: that clears the debt and the RECONCILE_FIRST
// hold, but it is not an outcome. `outcome` stays what the asker recorded, so
// held-rate and the scored counts only ever see real verdicts, and an expiry
// never overwrites one. It covers exactly the rounds answered when it was
// written; a later reply owes again. A real outcome supersedes it.
export const STALE_OPEN_MS = 8 * 60 * 60 * 1000;
export const UNCHECKED_MS = 24 * 60 * 60 * 1000;
export function expiredCovers(rec) {
  const seen = rec?.expired?.seen;
  return Array.isArray(seen) && (rec.rounds ?? []).filter((r) => r.replied).every((r) => seen.includes(r.round));
}
function expireUnchecked(taskId, now, uncheckedMs) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    if (!rec || !reconciliationOwed(rec)) return false;
    // Every answered round must be old: a fresh late reply is not expired by an older one's age.
    const answered = rec.rounds.filter((r) => r.replied);
    if (answered.some((r) => !r.repliedAt || now - r.repliedAt <= uncheckedMs)) return false;
    rec.expired = { at: now, seen: answered.map((r) => r.round), by: 'auto' };
    setRecord(magiHome(), 'tasks', taskId, rec);
    return true;
  });
}
// The expiry windows are hours, so a ten-minute lag changes nothing.
// ponytail: throttled per process; use shared database metadata if many
// short-lived processes make the same full-ledger pass too often.
export const AUTO_RECONCILE_EVERY_MS = 10 * 60 * 1000;
let lastAutoReconcile = 0;
export function autoReconcile({ now = Date.now(), staleOpenMs = STALE_OPEN_MS, uncheckedMs = UNCHECKED_MS, force = false } = {}) {
  const done = { closed: 0, expired: 0 };
  if (!force && Date.now() - lastAutoReconcile < AUTO_RECONCILE_EVERY_MS) return done;
  const tasks = listTasks();
  lastAutoReconcile = Date.now();
  for (const t of tasks) {
    try {
      const last = t.rounds.at(-1);
      if (last && !last.replied && !last.closedAt && now - last.openedAt > staleOpenMs) {
        const after = closeRound({ taskId: t.taskId, round: last.round, reason: 'abandoned', code: 'STALE', detail: `no reply in ${Math.round(staleOpenMs / 3600000)}h; closed automatically`, ifOpenedBefore: now - staleOpenMs });
        if (after.rounds.find((r) => r.round === last.round)?.closeCode === 'STALE') done.closed++;
      }
      if (reconciliationOwed(readTask(t.taskId) ?? t) && expireUnchecked(t.taskId, now, uncheckedMs)) done.expired++;
    } catch { /* a busy lock or unreadable record: the next call tries again */ }
  }
  return done;
}

// Every task on disk, most recently opened first.
export function listTasks() {
  return listRecords(magiHome(), 'tasks')
    .filter((r) => Array.isArray(r?.rounds))
    .sort((a, b) => (b.rounds.at(-1)?.openedAt ?? 0) - (a.rounds.at(-1)?.openedAt ?? 0));
}

// Whether a recorded outcome speaks to one answered round, by evidence in this
// order. Arrival sequence: each reply is numbered under the task lock and a
// verdict records how many it had seen, so no clock is involved. Reply time, for
// records from before the sequence existed (strictly after: a tie is not proof).
// The round number last, which older code stamped even while a round was still
// open, so it cannot be trusted where a time exists.
export function covers(outcome, round) {
  if (!outcome) return false;
  // A verdict recorded now names the answered rounds it had in front of it, under
  // the task lock. A round replies once, so its number identifies the reply:
  // nothing here depends on a clock or on a reply having been numbered.
  if (Array.isArray(outcome.seen)) return outcome.seen.includes(round?.round);
  if (typeof round?.replySeq === 'number') return (outcome.seq ?? -1) >= round.replySeq;
  if (typeof round?.repliedAt === 'number' && typeof outcome.at === 'number') return outcome.at > round.repliedAt;
  return (outcome.round ?? 1) >= (round?.round ?? 1);
}

// The answered round whose reply arrived last: by sequence, else by time, else by
// round number. A late reply to an older, timed-out round is the newest one.
export function newestAnswered(rounds) {
  const answered = (rounds ?? []).filter((r) => r.replied);
  const by = (field) => {
    const have = answered.filter((r) => typeof r[field] === 'number');
    return have.length ? have.reduce((a, b) => (b[field] > a[field] ? b : a)) : null;
  };
  const numbered = by('replySeq');
  const timed = by('repliedAt');
  // A server that has not restarted since the numbering began records replies
  // without a number. One of those, recorded after the numbered ones, is the
  // newest; judge it by its time.
  if (numbered && timed && timed !== numbered && typeof timed.replySeq !== 'number' && timed.repliedAt > (numbered.repliedAt ?? -1)) return timed;
  return numbered ?? timed ?? answered.reduce((a, b) => (!a || b.round > a.round ? b : a), null);
}

// Whether the orchestrator owes a verdict on an answer: some round was answered,
// the newest answer is not covered, and no round is still being worked on (while
// the next round is open the argument is in progress, and the verdict comes when
// it ends). The last round being unanswered, because it timed out or was closed,
// does not hide an earlier answer nobody checked.
export function reconciliationOwed(rec) {
  if (!newestAnswered(rec?.rounds) || outcomeCovers(rec) || expiredCovers(rec)) return false;
  const last = rec.rounds.at(-1);
  return !!(last.replied || last.closedAt);
}

// Whether the recorded outcome speaks to EVERY answered reply, each judged by its
// own best evidence. Picking one "newest" reply let a record mixing numbered and
// unnumbered replies be judged by the clock and lose the stronger sequence
// evidence of another reply. A verdict on round 1 does not reconcile a round 2
// answered after it. An archived record answers for itself: it stored the result
// when the evidence was in hand, and a line that kept none is never covered.
export function outcomeCovers(rec) {
  if (!rec?.outcome) return false;
  if (rec.coverageUnknown) return false;
  if (typeof rec.archivedCovered === 'boolean') return rec.archivedCovered;
  return (rec.rounds ?? []).filter((r) => r.replied).every((r) => covers(rec.outcome, r));
}

// Replies this orchestrator received and never reconciled (no outcome
// recorded for the latest answered round): the protocol's last step, skipped. Only tasks whose exchange
// was kept count, since those are the ones the agent can still read back
// (`magi exchange <task>`); a debt nobody can inspect is not a debt. Named
// on the next request, and past MAX_UNRECONCILED the next request waits.
export const MAX_UNRECONCILED = 3;
// `tasks`: a listTasks() the caller already read, to parse the ledger once.
export function unreconciledFor(orchestrator, { cwd, except, session, limit = Infinity, tasks = listTasks() } = {}) {
  const key = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const scoped = Boolean(session && session.identityVerified !== false &&
    (session.id || session.sessionId || (session.agent === 'omp' && session.pid != null && session.processStartedAt != null)));
  return tasks
    .filter((t) => t.orchestrator === orchestrator && t.taskId !== except && reconciliationOwed(t) &&
      (scoped ? sameSession(t.orchestratorTarget, session) === true
        : sameSession(t.orchestratorTarget, session) !== false && (!cwd || key(t.cwd) === key(cwd))))
    .filter((t) => readExchange(t.taskId).some((e) => e.kind === 'reply'))
    .slice(0, limit)
    .map((t) => t.taskId);
}

// One line's worth of facts about a task, for `magi log`.
export function taskSummary(rec) {
  const last = rec.rounds.at(-1) ?? {};
  const status = last.replied ? 'replied' : last.closedAt ? `${last.closeReason}${last.closeCode ? ` (${last.closeCode})` : ''}` : Date.now() - last.openedAt > STALE_OPEN_MS ? 'stale' : 'open';
  return {
    taskId: rec.taskId,
    mode: rec.mode,
    orchestrator: rec.orchestrator,
    peer: rec.peer,
    round: `${last.round ?? 0}/${rec.maxRounds}`,
    status,
    // What the peer said about its own turn (resolved, blocked, failed), or null.
    peerStatus: last.status?.state ?? null,
    peerStatusReason: last.status?.reason ?? null,
    openedAt: last.openedAt ?? null,
    diff: last.snapshot?.diffSha256?.slice(0, 12) ?? null,
    via: last.via ?? null,
    // Rounds a worker ran with shell commands allowed (allowCommands).
    commands: (rec.rounds ?? []).filter((r) => r.allowCommands).length,
    costUsd: last.usage?.costUsd ?? null,
    tokens: (last.usage?.inputTokens ?? 0) + (last.usage?.outputTokens ?? 0) || null,
    outcome: rec.outcome ? `${rec.outcome.accepted}/${rec.outcome.rejected}/${rec.outcome.open}${rec.coverageUnknown ? ' (archived without coverage; whether it covered the newest reply is unknown)' : outcomeCovers(rec) ? '' : ' (does not cover every reply; an answered round is unchecked)'}` : null,
  };
}

// Called by the peer side when it needs something before it can answer.
export function recordClarify(args) {
  return locked(`task-${args.taskId}`, () => recordClarifyUnlocked(args));
}

function recordClarifyUnlocked({ taskId, from, round, body, files, id }) {
  const rec = readTask(taskId);
  if (!rec) throw new LedgerError('UNKNOWN_TASK', `No open task ${taskId}. ${NEXT_TASK_HINT}`);
  // `id`: a question relayed from another machine keeps the id it has there;
  // the same one again is the same question, filed once and charged once.
  if (id && statement(magiHome(), 'SELECT 1 FROM questions WHERE task_id=? AND id=?').get(taskId, id)) return id;
  if (rec.peer !== from) {
    throw new LedgerError('ROLE_VIOLATION', `${from} orchestrates task ${taskId}; only the peer asks for clarification.`);
  }
  const last = rec.rounds[rec.rounds.length - 1];
  if ((round ?? 1) !== last.round) throw new LedgerError('BAD_ROUND', `Clarification must identify current round ${last.round}.`);
  if (last.closedAt) throw new LedgerError('ROUND_CLOSED', `Round ${last.round} is closed. Stop here; the orchestrator opens another round if it wants more.`);
  if (last.replied) {
    throw new LedgerError('ALREADY_REPLIED', `Round ${last.round} of task ${taskId} is already answered. The orchestrator opens another round if it wants more.`);
  }
  if ((last.clarifies ?? 0) >= MAX_CLARIFIES_PER_ROUND) {
    throw new LedgerError(
      'CLARIFY_LIMIT',
      `Round ${last.round} of task ${taskId} has already used its ${MAX_CLARIFIES_PER_ROUND} clarifying questions. ` +
        'Answer with your best reading of the request and state the assumption you made; if the missing input is essential, say what it is in your reply.',
    );
  }
  // `files`: what the question was sent with (src/artifacts.mjs metadata).
  const question = { id: id ?? randomUUID(), taskId, round: last.round, askedAt: Date.now(), answeredAt: null, body: redact(body ?? '').text, from, ...(files?.length ? { files } : {}) };
  statement(magiHome(), 'INSERT INTO questions(id,task_id,round,value) VALUES(?,?,?,?)')
    .run(question.id, taskId, last.round, JSON.stringify(question));
  last.clarifies = (last.clarifies ?? 0) + 1;
  setRecord(magiHome(), 'tasks', taskId, rec);
  insertQuestionExchange(taskId, { kind: 'question', questionId: question.id, round: last.round, from, to: rec.orchestrator, text: question.body });
  return question.id;
}

function insertQuestionExchange(taskId, entry) {
  statement(magiHome(), 'INSERT INTO exchanges(task_id,value) VALUES(?,?)')
    .run(taskId, JSON.stringify({ at: Date.now(), ...entry, text: entry.text.length > EXCHANGE_CHARS ? `${entry.text.slice(0, EXCHANGE_CHARS)}\n…` : entry.text }));
}

export function readQuestion(taskId, questionId) {
  const row = statement(magiHome(), 'SELECT value FROM questions WHERE task_id=? AND id=?').get(taskId, questionId);
  return row ? JSON.parse(row.value) : null;
}

export function listQuestions(taskId, round) {
  const rows = round === undefined
    ? statement(magiHome(), 'SELECT value FROM questions WHERE task_id=? ORDER BY sequence').all(taskId)
    : statement(magiHome(), 'SELECT value FROM questions WHERE task_id=? AND round=? ORDER BY sequence').all(taskId, round);
  return rows.map((row) => JSON.parse(row.value));
}

export function recordClarifyAnswer({ taskId, from, round, questionId, body }) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    if (!rec) throw new LedgerError('UNKNOWN_TASK', `No open task ${taskId}. ${NEXT_TASK_HINT}`);
    if (rec.orchestrator !== from) throw new LedgerError('ROLE_VIOLATION', `Only ${rec.orchestrator} answers questions on task ${taskId}.`);
    const last = rec.rounds.at(-1);
    if (!questionId) {
      const openIds = listQuestions(taskId).filter((q) => q.answeredAt === null).map((q) => q.id);
      throw new LedgerError('BAD_REQUEST', `clarify_answer requires questionId. Open question ids: ${openIds.join(', ') || '(none)'}. Every PEER QUESTION frame carries question_id; copy it into questionId and answer that question once.`);
    }
    const question = readQuestion(taskId, questionId);
    if (!question) throw new LedgerError('NO_PENDING_QUESTION', 'No pending question. Wait for the worker to ask before answering.');
    if (question.answeredAt !== null) throw new LedgerError('ALREADY_ANSWERED', `Question ${question.id} was answered at ${new Date(question.answeredAt).toISOString()}. Send kind:"note" to add to that answer; do not answer it again.`);
    if (question.round !== last.round || (round !== undefined && round !== question.round)) throw new LedgerError('BAD_ROUND', `Answer the question on current round ${last.round}; use its questionId.`);
    if (last.replied || last.closedAt) throw new LedgerError('NO_PENDING_QUESTION', 'The round has ended. Send a note to add information instead.');
    question.answeredAt = Date.now();
    question.answer = redact(body ?? '').text;
    statement(magiHome(), 'UPDATE questions SET value=? WHERE id=?').run(JSON.stringify(question), question.id);
    insertQuestionExchange(taskId, { kind: 'clarification', questionId: question.id, round: question.round, from, to: rec.peer, text: question.answer });
    return question;
  });
}

export function setRoundWaiting(taskId, round, waiting) {
  return locked(`task-${taskId}`, () => {
    const rec = readTask(taskId);
    const current = rec?.rounds.find((r) => r.round === round);
    if (!current) return;
    current.awaitingClarification = waiting;
    setRecord(magiHome(), 'tasks', taskId, rec);
  });
}

export function claimQuestionDelivery(taskId, questionId) {
  return locked(`question-${questionId}`, () => {
    const row = statement(magiHome(), 'SELECT * FROM questions WHERE task_id=? AND id=?').get(taskId, questionId);
    if (!row || !row.pending || isWaiting(taskId, row.round)) return null;
    const question = JSON.parse(row.value);
    if (question.deliveryClaim && !deadOwner(question.deliveryClaim)) return null;
    question.deliveryClaim = { id: randomUUID(), pid: process.pid };
    statement(magiHome(), 'UPDATE questions SET value=? WHERE id=?').run(JSON.stringify(question), questionId);
    return question;
  });
}

export function markQuestionDelivered(taskId, questionId) {
  return locked(`question-${questionId}`, () => {
    const question = readQuestion(taskId, questionId);
    if (!question) return;
    question.deliveredAt = Date.now();
    delete question.deliveryClaim;
    statement(magiHome(), 'UPDATE questions SET value=?,pending=0 WHERE id=?').run(JSON.stringify(question), questionId);
  });
}

export function releaseQuestionDelivery(taskId, questionId, claimId) {
  return locked(`question-${questionId}`, () => {
    const question = readQuestion(taskId, questionId);
    if (question?.deliveryClaim?.id !== claimId) return;
    delete question.deliveryClaim;
    statement(magiHome(), 'UPDATE questions SET value=? WHERE id=?').run(JSON.stringify(question), questionId);
  });
}

// The open rounds waiting on `peer` to reply: what a peer owes. Read when
// a reply names a task that does not exist (a mistyped id is the common
// case, and the answer to it is the id that was meant) and when a peer
// sends a note while it still owes a reply.
export function repliesOwedBy(peer, tasks = listTasks()) {
  return tasks.filter((t) => t.peer === peer && t.rounds.at(-1) && !t.rounds.at(-1).replied && !t.rounds.at(-1).closedAt);
}

function owedText(peer) {
  const owed = repliesOwedBy(peer);
  if (!owed.length) return '';
  return ` Open task(s) waiting on your reply: ${owed.map((t) => `${t.taskId} (round ${t.rounds.at(-1).round}, from ${t.orchestrator}, ${t.mode})`).join('; ')}.`;
}

// Called by the peer side when a reply is submitted.
export function recordReply(args) {
  return locked(`task-${args.taskId}`, () => recordReplyUnlocked(args));
}

// `statusFrom`: the reply text when it is not filed as a payload (an inline headless reply).
function recordReplyUnlocked({ taskId, from, round, payload, via, usage, statusFrom }) {
  const rec = readTask(taskId);
  if (!rec) throw new LedgerError('UNKNOWN_TASK', `No task ${taskId}: check the task_id against the request header.${owedText(from)} A reply must answer a request that was actually sent.`);
  if (rec.peer !== from) {
    throw new LedgerError('ROLE_VIOLATION', `${from} orchestrates task ${taskId} and cannot also reply to it. Wait for its peer's reply, then record kind:"outcome".`);
  }
  if (round === undefined && rec.rounds.length > 1) throw new LedgerError('BAD_ROUND', 'Replies after round 1 must identify their round explicitly.');
  const last = rec.rounds.find((entry) => entry.round === (round ?? 1));
  if (!last) throw new LedgerError('BAD_ROUND', `No round ${round} on task ${taskId}. Use the round in the request header; \`magi exchange ${taskId}\` lists them.`);
  if (last.replied) {
    throw new LedgerError('ALREADY_REPLIED', `Round ${last.round} of task ${taskId} already has a reply. Wait for the orchestrator to open another round.`);
  }
  // Filed as not yet delivered; the sender marks it once the orchestrator
  // has it. A waiter consumes the mailbox row instead. Rows without the field
  // predate it and say nothing either way.
  if (payload) putReply(taskId, { ...payload, from, round: last.round, delivered: false });
  last.replied = true;
  last.repliedAt = Date.now();
  // Arrival order, counted under the task lock, so a verdict can say which
  // replies it had seen without leaning on the wall clock.
  rec.replySeq = (rec.replySeq ?? 0) + 1;
  last.replySeq = rec.replySeq;
  // How the round was answered and what a headless run cost; a live reply
  // carries neither, its session paid for itself.
  if (via) last.via = via;
  if (usage) last.usage = usage;
  // The peer's own STATUS line, kept so `magi log` can say how the round ended
  // without reading the reply again. Absent when it named none: unknown, not success.
  const status = parseReply(payload?.body ?? statusFrom).status;
  if (status) last.status = { state: status.state, reason: redact(status.reason).text.slice(0, 160) };
  setRecord(magiHome(), 'tasks', taskId, rec);
  return rec;
}

// --- notes ------------------------------------------------------------------
// A note opens no task and spends no round, so the round cap cannot bound it.
// These are the same protections Claude Code applies to its own peer messages:
// a per-sender rate limit, suppression of identical repeats, and a queue cap.

export const NOTE_LIMITS = {
  maxPerWindow: 5,
  windowMs: 60000,
  dedupeMs: 300000,
};


// A note relayed from another machine takes none of this here: it was
// admitted on its sender's machine, and its event's claim owns it (peer.mjs).
export function reserveNote(sender, text, limits = NOTE_LIMITS) {
  return locked(`note-${sender}`, () => {
    const now = Date.now();
    const log = (getRecord(magiHome(), 'notes', sender) ?? []).filter((e) =>
      e.pending ? !deadOwner(e) : now - e.at < Math.max(limits.windowMs, limits.dedupeMs));
    const hash = createHash('sha256').update(redact(text ?? '').text).digest('hex').slice(0, 16);
    if (log.some((e) => e.hash === hash && (e.pending || now - e.at < limits.dedupeMs))) {
      throw new LedgerError('NOTE_DUPLICATE', 'This sender already sent that note recently, or its delivery is in flight. Say something new or wait for that delivery.');
    }
    const recent = log.filter((e) => e.pending || now - e.at < limits.windowMs).length;
    if (recent >= limits.maxPerWindow) {
      throw new LedgerError('NOTE_RATE_LIMIT', `This sender has ${recent} notes sent or in flight in the last minute. Batch what is left, or wait.`);
    }
    const reservation = { id: randomUUID(), pid: process.pid, at: now, hash, pending: true };
    log.push(reservation);
    setRecord(magiHome(), 'notes', sender, log);
    return { sender, id: reservation.id };
  });
}

export function settleNote(reservation, delivered) {
  return locked(`note-${reservation.sender}`, () => {
    const log = getRecord(magiHome(), 'notes', reservation.sender) ?? [];
    const entry = log.find((e) => e.id === reservation.id);
    if (!entry) return;
    if (delivered && entry.pending) {
      entry.pending = false;
      entry.at = Date.now();
    } else if (!delivered && entry.pending) log.splice(log.indexOf(entry), 1);
    setRecord(magiHome(), 'notes', reservation.sender, log);
  });
}

// --- named persistent headless peers ---------------------------------------
// A long-lived collaborator the ORCHESTRATOR creates for itself, so a project
// can keep context without a human opening a session for it. The bridge stores
// the session id each headless run produces and resumes it next time, so the
// conversation accumulates instead of starting cold. Scoped by agent and
// working directory and destination harness as well as name: the same name in
// another project, or aimed at another harness, is a different peer, and a
// session is never resumed into the wrong tree or the wrong harness. A record
// from before the destination was part of the key has no `peer` and is not
// resumed by anyone: its session could belong to either harness.
function personaKey(agent, cwd, name, peer) {
  return `${agent}|${peer}|${(cwd ?? '').toLowerCase()}|${name}`;
}

export function readPersona(agent, cwd, name, peer) {
  return getRecord(magiHome(), 'personas', personaKey(agent, cwd, name, peer));
}

// Called after a headless run: remember the session it produced (or keep the
// existing one when the run reported none) so the next request resumes it.
export function savePersona(agent, cwd, name, sessionId, peer) {
  return locked('personas', () => {
    const prev = readPersona(agent, cwd, name, peer);
    if (!sessionId && !prev) return null;
    const rec = {
      agent,
      peer,
      cwd: cwd ?? null,
      name,
      sessionId: sessionId ?? prev.sessionId,
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      runs: (prev?.runs ?? 0) + 1,
    };
    setRecord(magiHome(), 'personas', personaKey(agent, cwd, name, peer), rec);
    return rec;
  });
}

export function listPersonas(agent, cwd, peer) {
  return listRecords(magiHome(), 'personas')
    .filter((rec) => rec && (!agent || rec.agent === agent) && (!peer || rec.peer === peer)
      && (!cwd || (rec.cwd ?? '').toLowerCase() === cwd.toLowerCase()))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// --- reply mailbox ---------------------------------------------------------
// Receipts, not message prefixes, establish which queued items Magi owns.
export const QUEUE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_TERMINAL_RECEIPTS = 200;

function compactReceipts(record, now = Date.now()) {
  const terminal = new Set(['superseded', 'not_pending', 'relinquished']);
  const recentTerminal = record.entries.filter((entry) => terminal.has(entry.state)
    && now - (entry.updatedAt ?? entry.createdAt) <= QUEUE_RECEIPT_RETENTION_MS)
    .sort((a, b) => b.sequence - a.sequence).slice(0, QUEUE_TERMINAL_RECEIPTS);
  const keep = new Set(recentTerminal.map((entry) => entry.clientId));
  record.entries = record.entries.filter((entry) => terminal.has(entry.state) ? keep.has(entry.clientId)
    : !['reserved', 'unconfirmed'].includes(entry.state) || now - entry.createdAt <= QUEUE_RECEIPT_RETENTION_MS);
  return record;
}

export function compactQueueReceipts(threadId) {
  return locked(`queue-${threadId}`, () => {
    const record = compactReceipts(readQueueReceipts(threadId));
    setRecord(magiHome(), 'queue-receipts', threadId, record);
    return record;
  });
}

export function readQueueReceipts(threadId) {
  const record = getRecord(magiHome(), 'queue-receipts', threadId);
  if (record === null) return { nextSequence: 1, entries: [] };
  if (!record || !Array.isArray(record.entries) || !Number.isInteger(record.nextSequence)) {
    throw new LedgerError('QUEUE_LEDGER_CORRUPT', 'Queue receipt ledger is unreadable; no cleanup is authorized.');
  }
  return record;
}

export function reserveQueueNote({ threadId, senderId, senderAgent, kind, queueKey, payloadHash }) {
  if (!['note', 'watch'].includes(kind) || !senderId) throw new LedgerError('BAD_REQUEST', 'Only identified notes and watches can be coalesced.');
  return locked(`queue-${threadId}`, () => {
    const record = compactReceipts(readQueueReceipts(threadId));
    const entry = { clientId: randomUUID(), sequence: record.nextSequence++, threadId, senderId, senderAgent, kind, queueKey: queueKey ?? null, payloadHash, createdAt: Date.now(), state: 'reserved' };
    record.entries.push(entry);
    setRecord(magiHome(), 'queue-receipts', threadId, record);
    return entry;
  });
}

export function updateQueueReceipt(threadId, clientId, update) {
  return locked(`queue-${threadId}`, () => {
    const record = readQueueReceipts(threadId);
    const entry = record.entries.find((item) => item.clientId === clientId);
    if (!entry) throw new LedgerError('UNKNOWN_QUEUE_RECEIPT', 'No owned receipt for this queue item. Leave it unchanged; `magi queue-clean --thread <id>` without --apply previews what Magi owns.');
    // A delayed add acknowledgement cannot resurrect an already replaced item.
    const changes = { ...update };
    if (['superseded', 'not_pending', 'relinquished'].includes(entry.state)) delete changes.state;
    Object.assign(entry, changes);
    compactReceipts(record);
    setRecord(magiHome(), 'queue-receipts', threadId, record);
    return entry;
  });
}

// Each invocation owns a waiter row; clearing one cannot cancel another.
const manualWaiters = new Map();
function addWaiter(taskId, round, deadline = null) {
  const id = randomUUID();
  locked('waiter', () => {
    statement(magiHome(), 'INSERT INTO waiters(id,task_id,round,pid,deadline) VALUES(?,?,?,?,?)')
      .run(id, taskId, round ?? 0, process.pid, deadline);
  });
  return id;
}
function removeWaiter(id) {
  statement(magiHome(), 'DELETE FROM waiters WHERE id=?').run(id);
}
function activeWaiters(taskId) {
  const rows = statement(magiHome(), 'SELECT * FROM waiters WHERE task_id=?').all(taskId);
  return rows.filter((row) => !deadOwner(row) && (row.deadline === null || row.deadline >= Date.now()));
}
function acquireWaiter(taskId, round, deadline) {
  // The engine reserves before sending so a fast reply cannot go out of band.
  // Adopt exactly one reservation when polling starts; siblings own other rows.
  const key = `${magiHome()}|${taskId}`;
  const rows = manualWaiters.get(key) ?? [];
  const index = rows.findLastIndex((row) => round === undefined || row.round === round);
  if (index < 0) return addWaiter(taskId, round, deadline);
  const { id } = rows[index];
  locked('waiter', () => statement(magiHome(), 'UPDATE waiters SET round=?,deadline=? WHERE id=?').run(round ?? 0, deadline, id));
  rows.splice(index, 1);
  if (!rows.length) manualWaiters.delete(key);
  return id;
}
export function markWaiting(taskId, round = 1) {
  const key = `${magiHome()}|${taskId}`;
  const rows = manualWaiters.get(key) ?? [];
  rows.push({ id: addWaiter(taskId, round), round });
  manualWaiters.set(key, rows);
}
export function clearWaiting(taskId, round) {
  const key = `${magiHome()}|${taskId}`;
  const rows = manualWaiters.get(key) ?? [];
  const index = rows.findLastIndex((row) => round === undefined || row.round === round);
  if (index < 0) return;
  locked('waiter', () => removeWaiter(rows[index].id));
  rows.splice(index, 1);
  if (!rows.length) manualWaiters.delete(key);
}
export function isWaiting(taskId, round) {
  return activeWaiters(taskId).some((row) => round === undefined || row.round === 0 || row.round === round);
}
export function putReply(taskId, payload) {
  return locked(`mail-${taskId}`, () => {
    statement(magiHome(), 'INSERT INTO mail(task_id,slot,value) VALUES(?,?,?) ON CONFLICT(task_id,slot) DO UPDATE SET value=excluded.value')
      .run(taskId, payload.round ?? 0, JSON.stringify(payload));
  });
}
// Claim the out-of-band handoff under the same lock as waiter registration.
// A cancellation and the replying process may both discover the retained mail.
export function claimReplyDelivery(taskId, round) {
  return locked(`mail-${taskId}`, () => {
    if (isWaiting(taskId, round)) return null;
    const row = findMail(taskId, round);
    if (!row) return null;
    const payload = JSON.parse(row.value);
    if (payload.delivered || (payload.deliveryClaim && !deadOwner(payload.deliveryClaim))) return null;
    payload.deliveryClaim = { id: randomUUID(), pid: process.pid };
    statement(magiHome(), 'UPDATE mail SET value=? WHERE task_id=? AND slot=?').run(JSON.stringify(payload), taskId, row.slot);
    return payload;
  });
}
export function releaseReplyDelivery(taskId, round, claim) {
  return locked(`mail-${taskId}`, () => {
    const row = findMail(taskId, round);
    if (!row) return;
    const payload = JSON.parse(row.value);
    if (payload.deliveryClaim?.id !== claim) return;
    delete payload.deliveryClaim;
    statement(magiHome(), 'UPDATE mail SET value=? WHERE task_id=? AND slot=?').run(JSON.stringify(payload), taskId, row.slot);
  });
}
export function markReplyDelivered(taskId, round) {
  return locked(`mail-${taskId}`, () => {
    const row = statement(magiHome(), 'SELECT value FROM mail WHERE task_id=? AND slot=?').get(taskId, round ?? 0);
    if (!row) return null;
    const payload = JSON.parse(row.value);
    payload.delivered = Date.now();
    delete payload.deliveryClaim;
    statement(magiHome(), 'UPDATE mail SET value=? WHERE task_id=? AND slot=?').run(JSON.stringify(payload), taskId, round ?? 0);
    return payload;
  });
}
export function takeReply(taskId, round) {
  return locked(`mail-${taskId}`, () => takeReplyUnlocked(taskId, round));
}
export function listMail(taskId) {
  const rows = taskId
    ? statement(magiHome(), 'SELECT * FROM mail WHERE task_id=? ORDER BY slot').all(taskId)
    : statement(magiHome(), 'SELECT * FROM mail ORDER BY task_id,slot').all();
  const replies = rows.map((row) => {
    const payload = JSON.parse(row.value);
    return { taskId: row.task_id, ...payload, round: payload.round ?? (row.slot || 1) };
  });
  const questions = taskId
    ? statement(magiHome(), 'SELECT value FROM questions WHERE task_id=? AND pending=1 ORDER BY sequence').all(taskId)
    : statement(magiHome(), 'SELECT value FROM questions WHERE pending=1 ORDER BY sequence').all();
  return [...replies, ...questions.map((row) => questionMail(JSON.parse(row.value)))];
}
function findMail(taskId, round) {
  const rows = round === undefined
    ? statement(magiHome(), 'SELECT * FROM mail WHERE task_id=? ORDER BY slot').all(taskId)
    : statement(magiHome(), 'SELECT * FROM mail WHERE task_id=? AND slot IN (?,0) ORDER BY CASE WHEN slot=? THEN 0 ELSE 1 END').all(taskId, round, round);
  return rows.find((row) => round === undefined || (JSON.parse(row.value).round ?? 1) === round) ?? null;
}
function takeReplyUnlocked(taskId, round) {
  const row = findMail(taskId, round);
  if (!row) return null;
  statement(magiHome(), 'DELETE FROM mail WHERE task_id=? AND slot=?').run(taskId, row.slot);
  return JSON.parse(row.value);
}

function questionMail(question) {
  return { ...question, kind: 'clarify', questionId: question.id };
}

function findQuestionMail(taskId, round) {
  const rows = round === undefined
    ? statement(magiHome(), 'SELECT * FROM questions WHERE task_id=? AND pending=1 ORDER BY sequence').all(taskId)
    : statement(magiHome(), 'SELECT * FROM questions WHERE task_id=? AND round=? AND pending=1 ORDER BY sequence').all(taskId, round);
  return rows.find((row) => {
    const question = JSON.parse(row.value);
    return !question.deliveryClaim || deadOwner(question.deliveryClaim);
  }) ?? null;
}
function peekWaiter(id, taskId, round, signal) {
  signal?.throwIfAborted();
  const own = statement(magiHome(), 'SELECT result FROM waiters WHERE id=?').get(id);
  return own && (own.result !== null || findQuestionMail(taskId, round) !== null || findMail(taskId, round) !== null);
}
function pollWaiter(id, taskId, round, signal) {
  return locked(`mail-${taskId}`, () => {
    signal?.throwIfAborted();
    const own = statement(magiHome(), 'SELECT result FROM waiters WHERE id=?').get(id);
    if (!own) return null;
    if (own.result !== null) {
      removeWaiter(id);
      return JSON.parse(own.result);
    }
    const questionRow = findQuestionMail(taskId, round);
    if (questionRow) {
      const question = JSON.parse(questionRow.value);
      const payload = questionMail(question);
      const value = JSON.stringify(payload);
      for (const waiter of activeWaiters(taskId)) {
        if (waiter.round === 0 || waiter.round === question.round) {
          statement(magiHome(), 'UPDATE waiters SET result=? WHERE id=? AND result IS NULL').run(value, waiter.id);
        }
      }
      question.receivedAt = Date.now();
      statement(magiHome(), 'UPDATE questions SET value=?,pending=0 WHERE id=?').run(JSON.stringify(question), question.id);
      removeWaiter(id);
      return payload;
    }
    const mail = findMail(taskId, round);
    if (!mail) return null;
    const payload = JSON.parse(mail.value);
    if (payload.deliveryClaim && !deadOwner(payload.deliveryClaim)) return null;
    const replyRound = payload.round ?? 1;
    for (const waiter of activeWaiters(taskId)) {
      if (waiter.round === 0 || waiter.round === replyRound) {
        statement(magiHome(), 'UPDATE waiters SET result=? WHERE id=? AND result IS NULL').run(mail.value, waiter.id);
      }
    }
    statement(magiHome(), 'DELETE FROM mail WHERE task_id=? AND slot=?').run(taskId, mail.slot);
    removeWaiter(id);
    return payload;
  });
}
// The optional signal lets lifecycle callers cancel without consuming mail.
export async function waitForReply(taskId, timeoutMs, onTick, round, signal) {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const id = acquireWaiter(taskId, round, deadline + 500);
  let wake;
  const abort = () => wake?.();
  signal?.addEventListener('abort', abort, { once: true });
  let consumed = false;
  try {
    let ticks = 0;
    while (Date.now() < deadline) {
      const ready = await retryState(() => locked('waiter', () => peekWaiter(id, taskId, round, signal)), Math.max(0, deadline - Date.now()));
      // No await between cancellation check, consumption and returning the reply.
      try {
        const reply = ready ? pollWaiter(id, taskId, round, signal) : null;
        if (reply) { consumed = true; return reply; }
      } catch (error) {
        if (error.code !== 'LEDGER_BUSY') throw error;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        wake = () => { clearTimeout(timer); resolve(); };
        if (signal?.aborted) wake();
      });
      signal?.throwIfAborted();
      if (onTick && ++ticks % 20 === 0) onTick(Math.round((deadline - Date.now()) / 1000));
    }
    signal?.throwIfAborted();
    try {
      const reply = pollWaiter(id, taskId, round, signal);
      consumed = reply !== null;
      return reply;
    } catch (error) {
      if (signal?.aborted || error.code !== 'LEDGER_BUSY') throw error;
      return null;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    // The row has a deadline and is swept anyway; a busy ledger here must not
    // turn a timed-out wait into an error.
    if (!consumed) await retryState(() => locked('waiter', () => removeWaiter(id))).catch(() => {});
  }
}

// Oversized live requests go to a file the peer is told to read.
export function putRequestBody(taskId, text) {
  setRecord(magiHome(), 'requests', taskId, text);
  // A live peer needs a readable file. This is a transport artifact, not state.
  const p = join(dir('spill'), `${encodeURIComponent(taskId)}.md`);
  writeAtomic(p, text);
  return p;
}

// --- exchanges --------------------------------------------------------------
// Ordered conversation rows; task facts and exchanges share the same database.
export const EXCHANGE_CHARS = 16000;

export function recordExchange(taskId, entry) {
  const clip = (v) => {
    if (typeof v !== 'string') return undefined;
    const t = redact(v).text;
    return t.length > EXCHANGE_CHARS ? `${t.slice(0, EXCHANGE_CHARS)}\n…` : t;
  };
  const row = redactValue({ at: Date.now(), ...entry, text: clip(entry.text), task: clip(entry.task), context: clip(entry.context) });
  try {
    locked(`exchange-${taskId}`, () => {
      statement(magiHome(), 'INSERT INTO exchanges(task_id,value) VALUES(?,?)').run(taskId, JSON.stringify(row));
    });
    return true;
  } catch {
    // Best-effort callers may ignore this; delivered notes surface a warning.
    return false;
  }
}

export function readExchange(taskId) {
  return statement(magiHome(), 'SELECT value FROM exchanges WHERE task_id=? ORDER BY sequence')
    .all(taskId).map((row) => JSON.parse(row.value));
}

// The newest exchange rows across every card, newest first: the sequence is
// one counter for the whole table.
export function recentExchanges(limit) {
  return statement(magiHome(), 'SELECT task_id, value FROM exchanges ORDER BY sequence DESC LIMIT ?')
    .all(limit).map((row) => ({ taskId: row.task_id, ...JSON.parse(row.value) }));
}

// --- headless workers -------------------------------------------------------
// A headless peer is a child of a server process and would otherwise be
// invisible: it has no session registry entry. The server records it here
// for the length of the run; a row whose server died is ignored and swept.
// The server's birth marker makes the row an address: a note for the worker
// goes to that server only while pid and birth both still match.

// Read once per process; on Windows it is a PowerShell call, so the server
// pays it before a busy-retry window starts rather than inside one.
let serverBirth;
export function ownProcessStartedAt() {
  if (serverBirth === undefined) serverBirth = processStartedAt(process.pid);
  return serverBirth;
}

// `pid` and `processStartedAt` name the server that owns the row (and so who
// may sweep it). `wrapper` is the launch wrapper's argv[0] when one runs the
// worker; `childPid` and `childStartedAt` (recordWorkerChild) name the process
// spawned for it, so a supervisor can watch the worker itself end.
export function registerWorker({ taskId, harness, bin, cwd, round, timeoutMs, wrapper = null, allowCommands = false, host = null }) {
  const birth = ownProcessStartedAt();
  // `host`: the remote the worker runs on (its childPid is then the local ssh).
  return locked('workers', () => setRecord(magiHome(), 'workers', taskId, { taskId, harness, bin, cwd, round: round ?? 1, pid: process.pid, processStartedAt: birth, startedAt: Date.now(), timeoutMs: timeoutMs ?? Number(process.env.MAGI_TIMEOUT_MS ?? 2400000), wrapper, allowCommands, host, childPid: null, childStartedAt: null }));
}

// The spawned process, once known; a row already gone (the run ended) stays gone.
export function recordWorkerChild(taskId, { childPid, childStartedAt = null }) {
  return locked('workers', () => {
    const rec = getRecord(magiHome(), 'workers', taskId);
    if (!rec || rec.pid !== process.pid) return null;
    const next = { ...rec, childPid, ...(childStartedAt != null || rec.childStartedAt == null ? { childStartedAt } : {}) };
    setRecord(magiHome(), 'workers', taskId, next);
    return next;
  });
}

export function unregisterWorker(taskId) {
  return locked('workers', () => removeRecord(magiHome(), 'workers', taskId));
}

export function readWorker(taskId) {
  return getRecord(magiHome(), 'workers', taskId);
}

export function listWorkers() {
  return locked('workers', () => {
    const out = [];
    for (const w of listRecords(magiHome(), 'workers')) {
      if (!w) continue;
      if (deadOwner(w)) { removeRecord(magiHome(), 'workers', w.taskId); continue; }
      out.push(w);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  });
}

// --- notices ----------------------------------------------------------------
// An agent's note to the human: a decision only they can make, or a finding
// they must act on. Nothing waits on it; `magi notices` shows it until it is
// marked read. ponytail: nothing announces a new notice; a toast in the Claude
// Code mod would be the upgrade.

export function putNotice({ from, sender, cwd, body, taskId }) {
  const id = `n-${randomUUID().slice(0, 8)}`;
  const rec = redactValue({ id, from, sender: sender ?? null, cwd: cwd ?? null, taskId: taskId ?? null, body, at: Date.now(), readAt: null });
  locked('notices', () => setRecord(magiHome(), 'notices', id, rec));
  return rec;
}

export function listNotices({ unreadOnly = false } = {}) {
  const out = listRecords(magiHome(), 'notices').filter((rec) => !unreadOnly || !rec.readAt);
  // Unread first, newest first within each.
  return out.sort((a, b) => (a.readAt ? 1 : 0) - (b.readAt ? 1 : 0) || b.at - a.at);
}

export function markNoticeRead(id) {
  return locked(`notice-${id}`, () => {
    const rec = getRecord(magiHome(), 'notices', id);
    if (!rec) throw new LedgerError('UNKNOWN_NOTICE', `No notice ${id}. Run "magi notices" for the ids on record.`);
    if (!rec.readAt) {
      rec.readAt = Date.now();
      setRecord(magiHome(), 'notices', id, rec);
    }
    return rec;
  });
}

function sweepUsageDir(maxAgeMs) {
  const home = magiHome();
  transaction(home, () => {
    for (const row of statement(home, "SELECT key,value FROM records WHERE namespace='usage-claude'").all()) {
      if (Date.now() - JSON.parse(row.value).at > maxAgeMs) removeRecord(home, 'usage-claude', row.key);
    }
  });
}

// --- imported outcome history -----------------------------------------------
// Task-shaped records for what the archive keeps, so `magi log` and the
// ledger stats read them like any other task. Not for the engine: they carry
// no snapshot, no cwd, no round history.
function archivedAsTasks(skipIds) {
  return listRecords(magiHome(), 'archive')
    .filter((a) => !skipIds.has(a.taskId))
    .map((a) => {
      const round = { round: a.answeredRound ?? 1, replied: a.replied || a.answeredRound != null, ...(typeof a.repliedAt === 'number' ? { repliedAt: a.repliedAt } : {}), ...(typeof a.replySeq === 'number' ? { replySeq: a.replySeq } : {}) };
      // A line that stored its result (covered) answers for itself. An older line
      // kept the evidence of one reply only: that can prove the verdict did NOT
      // cover it, never that it covered the replies that were discarded. So an
      // older line is uncovered when its one reply proves it, and unknown otherwise,
      // as is a line that kept no evidence at all.
      const coverage = typeof a.covered === 'boolean'
        ? { archivedCovered: a.covered }
        : a.answeredRound != null || a.repliedAt != null || a.replySeq != null
          ? covers(a.outcome, round) ? { coverageUnknown: true } : { archivedCovered: false }
          : { coverageUnknown: true };
      return {
      taskId: a.taskId, orchestrator: a.orchestrator, peer: a.peer, mode: a.mode, maxRounds: a.maxRounds, archived: true,
      ...coverage,
      outcome: a.outcome,
      rounds: [{ round: a.answeredRound ?? 1, openedAt: a.openedAt, replied: a.replied || a.answeredRound != null, ...(typeof a.repliedAt === 'number' ? { repliedAt: a.repliedAt } : {}), ...(typeof a.replySeq === 'number' ? { replySeq: a.replySeq } : {}), ...(typeof a.costUsd === 'number' ? { usage: { costUsd: a.costUsd } } : {}) }],
      };
    });
}

// Full tasks take precedence over imported archive summaries of the same id.
export function listTasksWithArchive() {
  const live = listTasks();
  const ids = new Set(live.map((t) => t.taskId));
  return [...live, ...archivedAsTasks(ids)].sort((a, b) => (b.rounds.at(-1)?.openedAt ?? 0) - (a.rounds.at(-1)?.openedAt ?? 0));
}

export const SWEEP_TASKS_PER_RUN = 100;

// Magi's own temporary files: the throwaway git index a diff snapshot uses
// (magi-index-*), the config folder `magi install` registers through
// (magi-register-*) and the config overlay that names one run's advisor model
// (magi-advisor-*). Each is removed in a `finally`; a process killed mid-way
// skips that, so every server start removes those older than a day.
const TEMP_LEFTOVER = /^magi-(index|register|advisor)-/;
function sweepTempLeftovers(now) {
  let names;
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    if (!TEMP_LEFTOVER.test(name)) continue;
    const path = join(tmpdir(), name);
    try {
      if (now - statSync(path).mtimeMs > 86400000) rmSync(path, { recursive: true, force: true });
    } catch { /* in use or gone; the next start tries again */ }
  }
}


export const RELAY_OUTBOX_DAYS = 14;
export const RELAY_APPLIED_DAYS = 30;
export function sweep(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  database(magiHome());
  // Statusline rows of sessions that stopped rendering.
  try { sweepUsageDir(maxAgeMs); } catch { /* next sweep */ }
  // A read notice is done with; an unread one stays until someone reads it.
  try {
    locked('maintenance', () => {
      for (const rec of listRecords(magiHome(), 'notices')) {
        if (rec.readAt && now - rec.readAt > maxAgeMs) removeRecord(magiHome(), 'notices', rec.id);
      }
      for (const row of statement(magiHome(), "SELECT key FROM records WHERE namespace='queue-receipts'").all()) {
        try { compactQueueReceipts(row.key); } catch { /* unreadable ownership is never guessed */ }
      }
      for (const waiter of statement(magiHome(), 'SELECT * FROM waiters').all()) {
        if (deadOwner(waiter) || (waiter.deadline !== null && waiter.deadline < now)) removeWaiter(waiter.id);
      }
      listWorkers();
    });
  } catch (error) {
    if (error.code !== 'LEDGER_BUSY') throw error; // maintenance can wait for the next start
  }
  for (const row of statement(magiHome(), 'SELECT DISTINCT to_pid FROM frames').all()) {
    // A busy ledger skips this row, not the rest of the sweep.
    if (deadOwner({ pid: row.to_pid })) try { statement(magiHome(), 'DELETE FROM frames WHERE to_pid=?').run(row.to_pid); } catch { /* next sweep */ }
  }
  const spill = join(magiHome(), 'spill');
  if (existsSync(spill)) for (const name of readdirSync(spill)) {
    const path = join(spill, name);
    try {
      const stat = statSync(path);
      if (stat.isFile() && now - stat.mtimeMs > 7 * 86400000) unlinkSync(path);
    } catch { /* Next sweep retries locked files. */ }
  }
  // Stamped relay events (src/relay.mjs) wait at most RELAY_OUTBOX_DAYS;
  // their apply records live longer, so an expired event cannot be replayed
  // after its deduplication record is gone. Unstamped legacy rows are held
  // for exact-round recovery/manual reconciliation, never age-pruned.
  for (const row of statement(magiHome(), "SELECT key,value FROM records WHERE namespace='relay-applied'").all()) {
    try { if (now - JSON.parse(row.value).at > RELAY_APPLIED_DAYS * 86400000) removeRecord(magiHome(), 'relay-applied', row.key); }
    catch { /* Next sweep retries. */ }
  }
  // How a worker on another machine last stood (refreshRemoteState): status reads two minutes of it; a day is plenty.
  for (const row of statement(magiHome(), "SELECT key,value FROM records WHERE namespace='remote-state'").all()) {
    try { if (now - JSON.parse(row.value).observedAt > 86400000) removeRecord(magiHome(), 'remote-state', row.key); }
    catch { /* Next sweep retries. */ }
  }
  for (const row of statement(magiHome(), "SELECT key,value FROM records WHERE namespace='relay-outbox'").all()) {
    try {
      const event = JSON.parse(row.value);
      if (event.worker != null && now - event.at > RELAY_OUTBOX_DAYS * 86400000) removeRecord(magiHome(), 'relay-outbox', row.key);
    }
    catch { /* Next sweep retries. */ }
  }
  // Copies of files sent with card traffic (src/artifacts.mjs); the cards keep
  // their metadata. ponytail: by age only, not by whether a card still needs one.
  const blobs = join(magiHome(), 'artifacts', 'blobs');
  if (existsSync(blobs)) for (const name of readdirSync(blobs)) {
    try { if (now - statSync(join(blobs, name)).mtimeMs > 30 * 86400000) unlinkSync(join(blobs, name)); }
    catch { /* Next sweep retries. */ }
  }
  sweepTempLeftovers(now);
  // Startup callers need not await retention; failures never lose bodies or
  // become unhandled rejections. Explicit callers can await its completion.
  const home = magiHome();
  return trimClosedCards(home, now).catch((error) => {
    console.warn(`magi: RETENTION_FAILED: card bodies retained; repair storage or embeddings and retry sweep (${error.code ?? error.message}).`);
  });
}

function closedAt(task) {
  const last = task.rounds?.at(-1);
  if (!last || (!last.replied && !last.closedAt)) return null;
  if (!last.replied) return last.closedAt;
  if (outcomeCovers(task)) return Math.max(task.outcome.at ?? 0, last.repliedAt ?? 0, last.openedAt ?? 0);
  return null; // Unchecked replies are not closed cards.
}

const retentionRuns = new Map();
function trimClosedCards(home, now) {
  if (retentionRuns.has(home)) return retentionRuns.get(home);
  const run = (async () => {
    const { summarizeCard } = await import('./memory.mjs');
    const candidates = listRecords(home, 'tasks').filter((task) => !task.bodiesTrimmedAt && closedAt(task) && now - closedAt(task) > 30 * 86400000)
      .sort((a, b) => closedAt(a) - closedAt(b)).slice(0, SWEEP_TASKS_PER_RUN);
    for (const task of candidates) {
      // MAGI_HOME is process-wide; never trim a different home after an await.
      if (magiHome() !== home) return;
      const { id } = await summarizeCard(task);
      if (magiHome() !== home) return;
      transaction(home, () => {
        const current = getRecord(home, 'tasks', task.taskId);
        if (!current || current.bodiesTrimmedAt || closedAt(current) !== closedAt(task) || now - closedAt(current) <= 30 * 86400000) return;
        const marker = `[trimmed after 30 days; summary in memory ${id}]`;
        for (const row of statement(home, 'SELECT sequence,value FROM exchanges WHERE task_id=?').all(task.taskId)) {
          const value = JSON.parse(row.value);
          if (value.kind !== 'outcome') for (const field of ['text', 'task', 'context']) {
            if (typeof value[field] === 'string') value[field] = marker;
          }
          statement(home, 'UPDATE exchanges SET value=? WHERE sequence=?').run(JSON.stringify(value), row.sequence);
        }
        current.bodiesTrimmedAt = now;
        current.summaryMemoryId = id;
        setRecord(home, 'tasks', task.taskId, current);
      });
    }
  })();
  retentionRuns.set(home, run);
  return run.finally(() => retentionRuns.delete(home));
}
