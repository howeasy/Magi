// Live sessions on another machine as this orchestrator's workers. The card
// is this machine's: the ledger, verified origin, policy and reconciliation
// stay here. What crosses is card traffic only (a request, a note, an answer
// one way; a reply, a question, a note the other), never a transcript, a
// spawn or free input: Magi carries its own protocol between machines, it
// does not remote-control a session.
//
// One ssh child per remote in use, `magi relay` on the far end
// (src/remote-worker.mjs), JSON lines both ways: calls with an id and their
// answers, and events the far end pushes. The far end keeps a mirror of each
// relayed card (mirrorRound) so the session there replies through its own
// Magi tool, which checks the card's peer and round; its server then files
// the answer in an outbox addressed to this machine, which the relay drains.
// This side replays each event through an engine on the worker's side of the
// card (src/serve.mjs applyRelayEvent), so the ledger here takes the same
// transitions a local worker's tool call would. docs/architecture.md, "A live
// session on another machine".
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, spawnChannel } from './exec.mjs';
import { remoteConfig, remoteCommand, sshArgs, unreachable, REMOTE_PROTOCOL } from './remote.mjs';
import { RELAY_OUTBOX_DAYS, magiHome, readTask, sameSession, withStateLock } from './state.mjs';
import { originOf } from './transport.mjs';
import { statSync } from 'node:fs';
import { CHUNK_BYTES, assertFilesEnabled, blobPath, hasBlob, putBlob, readChunk } from './artifacts.mjs';
import { getRecord, setRecord, removeRecord, listRecords } from './store.mjs';

const CALL_TIMEOUT_MS = 120000;
// A relay that has not said hello by then is stopped, so a hung ssh or a far
// end that never starts cannot hold a request before its own timeout runs.
const readyTimeoutMs = () => Number(process.env.MAGI_RELAY_READY_MS) || 30000; // the variable is for the tests
// A claimed event not acked this long is offered again, to any relay,
// its claimant's too: the ack may have been lost. Applying it again is a
// no-op (the applied-event record in serve.mjs applyRelayEvent). ponytail: a
// single apply longer than this (a large file over a slow link) is offered
// twice and the second waits on the first's record; a renewed lease is the upgrade.
const CLAIM_STALE_MS = 60000;

/**
 * This machine as a remote addresses it: its host name and its MAGI_HOME, so
 * two homes here (a test home, a second user setup) never take each other's
 * replies. Named in the mirror card's origin and in each outbox event.
 */
export function localAddress() {
  return `${hostname()}:${createHash('sha256').update(magiHome()).digest('hex').slice(0, 8)}`;
}

// --- the outbox (written and drained on the worker's machine) ---------------

const OUTBOX = 'relay-outbox';

// A stamp comes only from this mirror's concrete round, not the current
// card target: a later round may already belong to another worker.
function roundWorker(card, entry) {
  const target = entry?.peerTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target) || !card.peer ||
    target.identityVerified === false || (target.agent && target.agent !== card.peer)) return null;
  for (const key of ['id', 'sessionId']) {
    if (target[key] != null && (typeof target[key] !== 'string' || !target[key].trim())) return null;
  }
  if (target.sessionAliases != null && (!Array.isArray(target.sessionAliases) ||
    target.sessionAliases.some((id) => typeof id !== 'string' || !id.trim()))) return null;
  if (target.pid != null && (!Number.isInteger(target.pid) || target.pid <= 0)) return null;
  if (target.processStartedAt != null && (typeof target.processStartedAt !== 'string' || !target.processStartedAt.trim())) return null;
  // Other harnesses name one session; omp may record both a process id and
  // its session id, and aliases established by that same process.
  if (card.peer !== 'omp' && target.id && target.sessionId && target.id !== target.sessionId) return null;
  const worker = {
    agent: card.peer,
    ...Object.fromEntries(['id', 'sessionId', 'sessionAliases', 'pid', 'processStartedAt']
      .filter((key) => target[key] != null).map((key) => [key, target[key]])),
  };
  return sameSession(worker, worker) === true ? worker : null;
}

function mirrorBoundTo(card, taskId, to) {
  return card?.mirror === true && card.taskId === taskId && typeof to === 'string' && to.length > 0 &&
    originOf(card)?.remote === to;
}

function revokeMirrorRollback(card, entry) {
  if (entry.mirrorAttemptId == null) return;
  entry.mirrorAttemptId = null;
  setRecord(magiHome(), 'tasks', card.taskId, card);
}

function holdLegacyEvent(ev, reason) {
  // Persist the diagnostic with the held event, so every relay's 750ms poll
  // (and reconnects) does not repeat it. A repaired round is retried normally.
  const changed = ev.legacyHold !== reason;
  if (ev.claim || changed) setRecord(magiHome(), OUTBOX, ev.id, { ...ev, claim: null, legacyHold: reason });
  if (changed) console.warn(`[magi] RELAY_LEGACY_EVENT_HELD event_id=${ev.id} task_id=${ev.taskId} round=${ev.round ?? '(missing)'} home=${magiHome()}: ${reason}. Retained unclaimed; inspect \`magi exchange ${ev.taskId}\` on both machines and repair the exact mirror round/binding before retrying. Expired events require manual reconciliation; do not resend blindly.`);
}

/** Files one event for the orchestrator machine `to`; the relay from there drains it. */
export function queueRelayEvent({ to, action, taskId, round = null, body = null, questionId = null, files = [] }) {
  return withStateLock(`task-${taskId}`, () => {
    const card = readTask(taskId);
    if (!card) throw Object.assign(new BridgeError('UNKNOWN_TASK', `No card ${taskId} here; no relay event was queued.`), { dispatchUncertain: false });
    const rounds = Array.isArray(card.rounds) ? card.rounds : [];
    const selected = round == null ? rounds.at(-1)?.round : round;
    const entries = Number.isInteger(selected) && selected > 0 ? rounds.filter((entry) => entry.round === selected) : [];
    if (entries.length !== 1) throw Object.assign(new BridgeError('BAD_ROUND', `No unique round ${selected ?? '(latest)'} on ${taskId}; no relay event was queued.`), { dispatchUncertain: false });
    const entry = entries[0];
    if (!mirrorBoundTo(card, taskId, to)) throw Object.assign(new BridgeError('ROLE_VIOLATION', `Card ${taskId} is not a mirror for ${to}; no relay event was queued.`), { dispatchUncertain: false });
    // Bind identity to the recorded worker, never caller-supplied fields.
    const worker = roundWorker(card, entry);
    if (!worker) throw Object.assign(new BridgeError('ROLE_VIOLATION', `Round ${entry.round} on ${taskId} has no unambiguous recorded worker; no relay event was queued.`), { dispatchUncertain: false });
    // Admission is worker activity. Revocation and insertion share this
    // SQLite transaction, so a failed insert leaves rollback eligible.
    revokeMirrorRollback(card, entry);
    const id = randomUUID();
    // Metadata only; file copies stay in this machine's store until fetched.
    setRecord(magiHome(), OUTBOX, id, { id, to, action, taskId, round: entry.round, worker, body, questionId, files, at: Date.now(), claim: null });
    return id;
  });
}

/** The events for `to` not under a fresh claim, oldest first, claimed for `owner` ({pid}) under the state lock. */
export function claimRelayEvents(to, owner, { now = Date.now(), staleMs = CLAIM_STALE_MS } = {}) {
  return withStateLock(OUTBOX, () => {
    const out = [];
    for (const ev of listRecords(magiHome(), OUTBOX)) {
      if (!ev || ev.to !== to) continue;
      const expired = now - ev.at > RELAY_OUTBOX_DAYS * 86400000;
      if (ev.worker == null) {
        // Never infer an old event's round or borrow a newer round's worker.
        // Keep expired legacy data unstamped too: stamping it would let the
        // next poll/sweep delete it, and offering it bypasses replay safety.
        if (expired) { holdLegacyEvent(ev, 'legacy event is past the replay-retention lifetime'); continue; }
        const card = readTask(ev.taskId);
        const entries = Array.isArray(card?.rounds) && Number.isInteger(ev.round) && ev.round > 0
          ? card.rounds.filter((entry) => entry.round === ev.round) : [];
        let reason = !mirrorBoundTo(card, ev.taskId, ev.to) ? 'missing or invalid mirror binding to this orchestrator'
          : entries.length !== 1 ? 'missing or ambiguous exact mirror round' : null;
        const worker = reason ? null : roundWorker(card, entries[0]);
        if (!reason && !worker) reason = 'exact mirror round has no unambiguous recorded worker identity';
        if (reason) { holdLegacyEvent(ev, reason); continue; }
        revokeMirrorRollback(card, entries[0]);
        ev.worker = worker;
        delete ev.legacyHold;
        setRecord(magiHome(), OUTBOX, ev.id, ev);
      }
      // Stamped events retain their ordinary lifetime: the other machine's
      // apply record may be gone after this, so offering could land twice.
      if (expired) { removeRecord(magiHome(), OUTBOX, ev.id); continue; }
      if (ev.claim && now - ev.claim.at < staleMs) continue;
      ev.claim = { ...owner, at: now };
      setRecord(magiHome(), OUTBOX, ev.id, ev);
      out.push(ev);
    }
    return out.sort((a, b) => a.at - b.at);
  });
}

/**
 * A worker's reply or question, delivered to its orchestrator: through the
 * outbox when that orchestrator is on another machine, else by `local`. The
 * one rule for every path a worker answers by (its Magi tool's server, the
 * `magi reply` fallback).
 */
export function deliverWorkerMessage(o, local) {
  const origin = o.task ? originOf(o.task) : null;
  if (!origin?.remote) return local(o);
  queueRelayEvent({ to: origin.remote, action: o.relay?.action ?? 'reply', taskId: o.task.taskId, round: o.relay?.round ?? null, body: o.relay?.body ?? null, questionId: o.relay?.questionId ?? null, files: o.relay?.files ?? [] });
  return { via: 'relay', deliveryStatus: 'queued_unread', statusText: 'Filed for the orchestrator on another machine; its relay carries it there.' };
}

/** Removes the events the orchestrator machine has applied, or refused for good. */
export function ackRelayEvents(ids) {
  return withStateLock(OUTBOX, () => {
    for (const id of ids ?? []) {
      const ev = getRecord(magiHome(), OUTBOX, id);
      // A pre-upgrade in-flight ack cannot erase an unresolved legacy row.
      if (ev?.worker != null) removeRecord(magiHome(), OUTBOX, id);
    }
  });
}

/** Gives back events the orchestrator machine could not apply yet, to be offered again at once. */
export function releaseRelayEvents(ids) {
  return withStateLock(OUTBOX, () => {
    for (const id of ids ?? []) {
      const ev = getRecord(magiHome(), OUTBOX, id);
      if (ev) setRecord(magiHome(), OUTBOX, id, { ...ev, claim: null });
    }
  });
}

// --- the near end (this machine, the orchestrator's) ------------------------

const relays = new Map(); // host -> { ready, call, close }
let onEvent = null;

/** What applies a relayed event here; set once by the server (src/serve.mjs). */
export function setRelayEventHandler(fn) {
  onEvent = fn;
}

function openRelay(host) {
  const remote = remoteConfig(host);
  const pending = new Map();
  const callFailure = (call, error, serverRefusal = false) => {
    // A received, explicit refusal can prove the far end did not dispatch.
    // An absent/unknown error flag, pipe rejection or ssh exit cannot undo
    // the uncertainty once bytes for a mutating delivery were written.
    const dispatchUncertain = call.mutating && call.written && !(serverRefusal && error?.dispatchUncertain === false);
    const message = String(error?.message ?? error ?? 'the relay call failed');
    const inspect = call.taskId
      ? `Inspect \`magi exchange ${call.taskId}\` and \`magi mail --task ${call.taskId}\`, and the recipient session history${call.round != null ? ` for round ${call.round}` : ''}`
      : 'Inspect the recipient session history and card exchange';
    return Object.assign(new BridgeError(error?.code ?? 'REMOTE_FAILED', dispatchUncertain
      ? `${message} Dispatch is uncertain: the delivery may already have reached the peer. ${inspect}; do not resend blindly.`
      : message), { dispatchUncertain });
  };
  let hello = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  let chain = Promise.resolve();
  const payload = { protocol: REMOTE_PROTOCOL, as: localAddress() };
  const child = spawnChannel('ssh', sshArgs(remote, remoteCommand(remote, 'relay', payload)), {
    onLine: (frame) => {
      if (!hello) {
        hello = frame;
        if (frame?.type === 'magi_relay' && frame.ok) readyResolve();
        else readyReject(new BridgeError(frame?.code ?? 'REMOTE_FAILED', `On remote "${host}": ${frame?.message ?? 'the relay did not start'}`));
        return;
      }
      if (frame?.event) {
        // One at a time, in the order the far end sent them; each is acked
        // once applied, so a crash here leaves it to be offered again.
        // Only an event applied here, or refused for good (`terminal`), is
        // acked and so deleted there; any other failure gives it back to be
        // offered again, so a transient error never costs an answer.
        const ev = frame.event;
        chain = chain.then(async () => {
          let op = 'ack';
          try { await onEvent?.(ev, host); }
          catch (e) {
            console.error(`[magi] RELAY_EVENT_FAILED host=${host} task_id=${ev.taskId} ${ev.action}: ${e.code ?? 'FAILED'}: ${e.message}${e.terminal ? ' (dropped)' : ' (offered again)'}`);
            if (!e.terminal) op = 'release';
          }
          // A lost ack or release leaves the claim to go stale and the event to come back.
          await relay.call(op, { ids: [ev.id] }).catch(() => {});
        });
        return;
      }
      const call = pending.get(frame?.id);
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.ok) call.resolve(frame.result);
      else call.reject(callFailure(call, Object.assign(new BridgeError(frame.error?.code ?? 'REMOTE_FAILED', `On remote "${host}": ${frame.error?.message ?? 'the call failed'}`),
        typeof frame.error?.dispatchUncertain === 'boolean' ? { dispatchUncertain: frame.error.dispatchUncertain } : {}), true));
    },
  });
  const relay = { host, ready, pid: child.pid };
  const readyTimer = setTimeout(() => {
    readyReject(new BridgeError('REMOTE_UNREACHABLE', `Remote "${host}" did not start its relay within ${readyTimeoutMs() / 1000} s; it was stopped. Check \`ssh ${remote.ssh.join(' ')}\` and that ${remote.magi} runs there, then retry.`));
    child.kill();
  }, readyTimeoutMs());
  readyTimer.unref?.();
  ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
  child.exited.then((res) => res, (e) => ({ exitCode: 1, stderr: e.message })).then((res) => {
    if (relays.get(host) === relay) relays.delete(host);
    const why = res.exitCode === 255 ? unreachable(remote, res.stderr)
      : new BridgeError('REMOTE_FAILED', `The relay to remote "${host}" ended (exit ${res.exitCode}: ${String(res.stderr ?? '').trim().slice(0, 300) || 'no output'}). Retry; the next call opens a new one.`);
    readyReject(why);
    const ended = new BridgeError(why.code, `The relay to remote "${host}" ended (exit ${res.exitCode}: ${String(res.stderr ?? '').trim().slice(0, 300) || 'no output'}).`);
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(callFailure(call, ended)); }
    pending.clear();
  });
  relay.call = async (op, args, timeoutMs = CALL_TIMEOUT_MS) => {
    const call = { op, mutating: op === 'deliver', written: false, taskId: args?.taskId, round: args?.round };
    try { await ready; }
    catch (error) { throw callFailure(call, error); }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(callFailure(call, new BridgeError('REMOTE_FAILED', `Remote "${host}" did not answer ${op} within ${Math.round(timeoutMs / 1000)} s.`)));
      }, timeoutMs);
      Object.assign(call, { resolve, reject, timer });
      pending.set(id, call);
      const failed = (error) => {
        if (pending.get(id) !== call) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(callFailure(call, error));
      };
      try {
        child.send({ id, op, ...args }, { onWrite: () => {
          // A timeout while queued is definite only if the queued frame can
          // no longer be written after its caller rolls back the round.
          if (pending.get(id) !== call) throw new BridgeError('REMOTE_FAILED', 'The relay call ended before its queued write; nothing was sent.');
          call.written = true;
        } }).catch(failed);
      }
      catch (error) { failed(error); }
    });
  };
  relay.close = () => { child.end(); child.kill(); };
  return relay;
}

/** The relay to `host`, opened on first use and reopened after it ends. */
export function relayTo(host) {
  let relay = relays.get(host);
  if (!relay) {
    relay = openRelay(host);
    relays.set(host, relay);
  }
  return relay;
}

/** One call over the relay to `host`. */
export async function relayCall(host, op, args, timeoutMs) {
  let relay;
  try { relay = relayTo(host); }
  catch (error) { error.dispatchUncertain = false; throw error; }
  return relay.call(op, args, timeoutMs);
}

/**
 * The copies of `files` on `host`, sent there first where it lacks them:
 * {sha256: path there}. Each file crosses in CHUNK_BYTES pieces and the far
 * end checks the whole by hash before it keeps it (FILE_CORRUPT otherwise).
 */
export async function pushFiles(host, files) {
  if (!files?.length) return {};
  // Sending is checked again at the send, and before every piece read for
  // it: the switch may have been turned off since the files were attached,
  // or while an answer from the other machine was awaited.
  assertFilesEnabled();
  const shas = [...new Set(files.map((f) => f.sha256))];
  const { paths } = await relayCall(host, 'has', { shas });
  // Copies already there are files sent too: none is named once files are off.
  assertFilesEnabled();
  for (const sha256 of shas.filter((s) => !paths[s])) {
    const size = statSync(blobPath(sha256)).size;
    let offset = 0;
    do {
      assertFilesEnabled();
      const chunk = readChunk(sha256, offset, CHUNK_BYTES);
      const res = await relayCall(host, 'put', { sha256, offset, size, data: chunk.toString('base64') });
      offset += chunk.length;
      if (res.path) paths[sha256] = res.path;
    } while (offset < size);
  }
  return paths;
}

/** Brings the copies of `files` that this machine lacks from `host`, each checked by hash. */
export async function pullFiles(host, files) {
  for (const f of files ?? []) {
    if (hasBlob(f.sha256)) continue;
    const parts = [];
    let offset = 0;
    let size = f.size;
    do {
      // Taking files in is checked before every piece too.
      assertFilesEnabled();
      const res = await relayCall(host, 'get', { sha256: f.sha256, offset });
      const chunk = Buffer.from(res.data, 'base64');
      size = res.size;
      parts.push(chunk);
      offset += chunk.length;
      if (!chunk.length) break;
    } while (offset < size);
    putBlob(f.sha256, Buffer.concat(parts));
  }
}

/** Every relay this process holds, closed (tests, shutdown). */
export function closeRelays() {
  for (const relay of relays.values()) relay.close();
  relays.clear();
}
