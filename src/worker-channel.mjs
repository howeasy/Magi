// A headless peer that stays reachable while it works. The adapter's channel
// speaks the harness's own line protocol (omp --mode rpc, Claude stream-json,
// a dedicated codex app-server's JSON-RPC); this module owns the process
// around it, the runs this server holds open, and the notes that reach them,
// from this server or, through the frames inbox, from any other process on
// the machine.
//
// A run is running until its channel says every message it was sent has been
// answered and the session is settled, then finishing (stdin closed, the reply
// being read) until the process exits, then closed. A note is taken only while
// running; during finishing it is refused, because the reply it would change
// has already been written.
import { randomUUID } from 'node:crypto';
import { spawnChannel, BridgeError, HEARTBEAT_MS, cancelledError, stoppedError, timeoutError, timeoutLimit } from './exec.mjs';
import { statement, transaction, getRecord, setRecord } from './store.mjs';
import { magiHome, readWorker } from './state.mjs';
import { confirmHeadlessNote, confirmWaitMs } from './delivery-confirm.mjs';
import { processStartedAt } from '../omp/process-identity.js';

// The omp extension polls its inbox at the same rate.
export const FRAME_POLL_MS = 750;
// ponytail: a worker that has answered but does not exit once its stdin
// closes is stopped after this long and its answer kept. Raise it if a
// harness is seen needing longer to flush its session on exit. A remote
// worker's far end (src/remote-worker.mjs) gives its CLI the same.
export const FINISH_GRACE_MS = 30_000;

const FINAL = new Set(['received', 'received_mid_turn', 'failed']);
const RANK = { unconfirmed: 0, queued_unread: 1, received_mid_turn: 2, received: 2, failed: 3 };
const STATUS_TEXT = {
  received: 'The headless worker took the note as a new turn.',
  received_mid_turn: 'The headless worker took the note inside its running turn.',
  queued_unread: 'The headless worker has the note queued and has not read it yet. Do not resend it.',
  unconfirmed: 'The note was written to the headless worker; its receipt is unconfirmed. Do not resend it.',
  failed: 'DELIVERY_FAILED: the headless worker refused the note.',
};

const runs = new Map(); // taskId -> run, for the runs this process launched
let poller = null;
let draining = false;

const definite = (error) => Object.assign(error, { dispatchUncertain: false });

function finishingError(taskId, name) {
  return definite(new BridgeError('WORKER_FINISHING', `Task ${taskId}'s headless ${name} worker has answered and the reply is being taken; this note was not sent. Send a follow-up request on this taskId, which resumes the thread.`));
}

function notRunningError(taskId) {
  return definite(new BridgeError('NO_LIVE_PEER', `Task ${taskId} has no running headless worker: it has answered, failed, or its server exited. Send a follow-up request on this taskId, which resumes the thread.`));
}

export function runState(taskId) {
  return runs.get(taskId)?.state ?? null;
}

function advance(run, id, status) {
  const current = run.receipts.get(id) ?? 'unconfirmed';
  if ((RANK[status] ?? 0) <= RANK[current]) return;
  run.receipts.set(id, status);
  // The same record a cross-process note gets, so a later read of the card
  // (magi status, the deck) sees the receipt advance after the call returned.
  if (run.taskId) writeAck(id, run.taskId, status);
  try { run.listeners.get(id)?.(status); } catch { /* a receipt record is best effort */ }
  for (const wake of [...run.changed]) wake();
}

function waitReceipt(run, id, ms) {
  const settled = () => FINAL.has(run.receipts.get(id)) || run.state === 'closed';
  const status = () => run.receipts.get(id) ?? 'unconfirmed';
  if (settled() || ms <= 0) return Promise.resolve(status());
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      run.changed.delete(wake);
      resolve(status());
    };
    const wake = () => { if (settled()) done(); };
    const timer = setTimeout(done, ms);
    run.changed.add(wake);
  });
}

function register(taskId, run) {
  runs.set(taskId, run);
  if (!poller) {
    poller = setInterval(() => { drainFrames(); }, FRAME_POLL_MS);
    poller.unref?.();
  }
}

function unregister(taskId, run) {
  if (runs.get(taskId) === run) runs.delete(taskId);
  // A queued stop for a run that is over has nothing left to stop.
  failQueued((frame) => frame.taskId === taskId, (frame) => (frame.op === 'stop' ? notRunningError(taskId) : finishingError(taskId, run.name)));
  if (!runs.size && poller) {
    clearInterval(poller);
    poller = null;
  }
}

// One headless run on a channel. Resolves with what the channel parsed and how
// the process ended; the verdict on that is runHeadless's, as for runCli.
// `spawn` is the program to start when it is not `name` itself: ssh, for a
// worker on another machine, while messages keep saying "omp on devbox".
export async function runChannel({ name, spawn, args, text, cwd, env, timeoutMs, signal, progress, taskId, open, wrapper, onSpawn }) {
  if (signal?.aborted) throw cancelledError(name);
  const limit = timeoutLimit(timeoutMs);
  let session;
  const child = spawnChannel(spawn ?? name, args, { cwd, env, wrapper, onLine: (frame) => session.line(frame), onJunk: (line) => session.junk?.(line) });
  // A caller that records the worker learns its pid; a throw there is not this run's failure.
  try { if (child.pid) onSpawn?.(child.pid); } catch { /* the record is best effort */ }
  const run = { name, taskId, state: 'running', receipts: new Map(), listeners: new Map(), changed: new Set() };
  let finishTimer = null;
  let stopped = false;
  let timedOut = false;
  let cancelled = false;
  // `stopAfter`, from a channel whose process does not exit when its work is
  // done (a codex app-server), stops the tree once that promise settles;
  // otherwise stdin is closed and the process given FINISH_GRACE_MS to exit.
  const finish = (stopAfter) => {
    if (run.state !== 'running') return;
    run.state = 'finishing';
    if (stopAfter) {
      // Not once the process is gone: its pid may already be someone else's.
      Promise.resolve(stopAfter).catch(() => {}).then(() => {
        if (run.state === 'closed') return;
        stopped = true;
        child.end();
        child.kill();
      });
      return;
    }
    child.end();
    finishTimer = setTimeout(() => { stopped = true; child.kill(); }, FINISH_GRACE_MS);
  };
  session = open({ send: child.send, finish, receipt: (id, status) => advance(run, id, status) });
  // The orchestrator's stop. Once the answer is complete (finishing) there is
  // nothing to stop and the answer stands, as it does when the clock runs out.
  run.stop = () => {
    if (run.state === 'closed') return 'ended';
    if (run.state === 'finishing') return 'finishing';
    run.stopRequested = true;
    child.kill();
    return 'stopped';
  };
  run.note = async (noteText, onReceipt) => {
    if (run.state === 'finishing') throw finishingError(taskId, name);
    if (run.state !== 'running') throw notRunningError(taskId);
    const { id, sent } = session.note(noteText);
    run.receipts.set(id, 'unconfirmed');
    if (onReceipt) run.listeners.set(id, onReceipt);
    try { await sent; }
    catch (e) {
      advance(run, id, 'failed');
      // The channel's own verdict, when it has one: too late, or refused.
      if (e.code === 'WORKER_FINISHING') throw finishingError(taskId, name);
      if (e.code === 'DELIVERY_FAILED') throw definite(e);
      throw definite(new BridgeError('DELIVERY_FAILED', `The headless ${name} worker's input closed before the note was written (${e.message}). Send a follow-up request on this taskId, which resumes the thread.`));
    }
    return id;
  };
  if (taskId) register(taskId, run);

  const timer = setTimeout(() => { timedOut = true; child.kill(); }, limit);
  const abort = () => { cancelled = true; child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  // MCP clients abort a tool call that goes quiet; see runCli.
  const started = Date.now();
  const heartbeat = progress
    ? setInterval(() => progress(`${name} still working (${Math.round((Date.now() - started) / 1000)}s)`), HEARTBEAT_MS)
    : null;
  let out;
  try {
    session.start(text);
    out = await child.exited;
  } finally {
    clearTimeout(timer);
    clearTimeout(finishTimer);
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', abort);
    run.state = 'closed';
    // Whatever the channel still waits on will never be answered now.
    try { session.close?.(); } catch { /* the run is over either way */ }
    for (const wake of [...run.changed]) wake();
    if (taskId) unregister(taskId, run);
  }
  if (cancelled) throw cancelledError(name);
  if (run.stopRequested && !session.finished) throw stoppedError(name);
  // An answer already complete when the clock ran out is still the answer.
  if (timedOut && !session.finished) throw timeoutError(name, limit);
  const parsed = session.result();
  if (!session.finished) parsed.errors.push(`${name} exited before it had answered every message it was sent.`);
  return { parsed, stderr: out.stderr, exitCode: session.finished && (stopped || timedOut) ? 0 : out.exitCode };
}

// A note for a card whose worker is headless. The worker row names the server
// that launched it: this one hands the note straight to its channel; another
// one gets it through the frames inbox it polls while it holds runs open.
export async function deliverHeadlessNote({ taskId, text, progress }) {
  const worker = readWorker(taskId);
  if (!worker) throw notRunningError(taskId);
  const label = `headless ${worker.harness}`;
  const via = `headless:${worker.harness}`;
  if (worker.pid === process.pid) {
    const run = runs.get(taskId);
    if (!run) throw definite(new BridgeError('NO_LIVE_PEER', `Task ${taskId}'s headless ${worker.harness} worker takes no notes: ${worker.bin} runs one prompt and exits. Wait for its reply, then send a follow-up request on this taskId.`));
    const id = await run.note(text);
    const deliveryStatus = await waitReceipt(run, id, confirmWaitMs());
    progress?.(`written to the ${label} worker on ${taskId}; ${deliveryStatus}`);
    return { via, label, messageId: id, workerPid: process.pid, deliveryStatus, statusText: STATUS_TEXT[deliveryStatus] };
  }
  // A pid alone is not the server: a reused pid would never poll for it.
  if (!worker.processStartedAt || processStartedAt(worker.pid) !== worker.processStartedAt) throw notRunningError(taskId);
  const home = magiHome();
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const at = Date.now();
  try {
    transaction(home, () => statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)")
      .run(worker.pid, id, JSON.stringify({ id, taskId, text, at }), at));
  } catch (error) { throw definite(error); }
  const deliveryStatus = await confirmHeadlessNote({ pid: worker.pid, frameId: id });
  if (deliveryStatus === 'failed') {
    let failure = null;
    try { failure = JSON.parse(statement(home, 'SELECT body FROM frames WHERE to_pid=? AND id=?').get(worker.pid, id)?.body ?? 'null')?.failure ?? null; }
    catch { /* the failed row is the record; its detail is optional */ }
    if (failure?.code) throw definite(new BridgeError(failure.code, failure.message));
  }
  progress?.(`queued for the ${label} worker on ${taskId} (server pid ${worker.pid}); ${deliveryStatus}`);
  return { via, label, messageId: id, workerPid: worker.pid, deliveryStatus, statusText: STATUS_TEXT[deliveryStatus] };
}

// ponytail: a stop sent to another server waits this long for that server's
// next inbox poll (FRAME_POLL_MS) to take it; past it the answer is "queued",
// not "stopped". Raise it if a busy server is seen missing the window.
export const STOP_WAIT_MS = 5000;

// Stop the headless worker on a card: the process tree, not a request to it. A
// run held by this server is stopped directly; one held by another server is
// asked to through the frames inbox, and its ack says what it did. Resolves
// { stopped, outcome, workerPid }: outcome is 'stopped', 'finishing' (the answer
// is complete, so it stands) or 'queued' (taken by no poll within STOP_WAIT_MS).
export async function stopHeadlessWorker({ taskId, waitMs = STOP_WAIT_MS }) {
  const worker = readWorker(taskId);
  if (!worker) throw notRunningError(taskId);
  if (worker.pid === process.pid) {
    const outcome = runs.get(taskId)?.stop() ?? 'ended';
    if (outcome === 'ended') throw notRunningError(taskId);
    return { stopped: outcome === 'stopped', outcome, workerPid: process.pid };
  }
  // A pid alone is not the server: a reused pid would never poll for it.
  if (!worker.processStartedAt || processStartedAt(worker.pid) !== worker.processStartedAt) throw notRunningError(taskId);
  const home = magiHome();
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  try {
    transaction(home, () => statement(home, "INSERT INTO frames(to_pid,id,body,state,created_at) VALUES(?,?,?,'queued',?)")
      .run(worker.pid, id, JSON.stringify({ id, taskId, op: 'stop', at: Date.now() }), Date.now()));
  } catch (error) { throw definite(error); }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ack = getRecord(home, 'delivery-acks', id);
    if (ack) return { stopped: ack.status === 'stopped', outcome: ack.status, workerPid: worker.pid };
    const row = statement(home, 'SELECT state,body FROM frames WHERE to_pid=? AND id=?').get(worker.pid, id);
    if (row?.state === 'failed') {
      let failure = null;
      try { failure = JSON.parse(row.body)?.failure ?? null; } catch { /* the failed row is the record; its detail is optional */ }
      throw definite(new BridgeError(failure?.code ?? 'NO_LIVE_PEER', failure?.message ?? `Task ${taskId}'s headless worker could not be stopped.`));
    }
    if (Date.now() >= deadline) return { stopped: false, outcome: 'queued', workerPid: worker.pid };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- the frames inbox --------------------------------------------------------
// Polled only while this process holds a run open; a frame for a run that is
// not here fails with the reason, so its sender stops waiting.

const ackStatus = (status) => (status === 'unconfirmed' || status === 'queued_unread' ? 'submitted' : status);

function writeAck(frameId, taskId, status) {
  try { setRecord(magiHome(), 'delivery-acks', frameId, { pid: process.pid, taskId, status: ackStatus(status), at: Date.now() }); }
  catch (e) { console.error(`[magi] NOTE_ACK_FAILED frame=${frameId}: ${e.code ?? 'STATE_FAILED'}: ${e.message}. The note was sent; its sender sees it as unconfirmed and must not resend it.`); }
}

function failFrame(id, frame, error) {
  const home = magiHome();
  statement(home, "UPDATE frames SET state='failed',body=? WHERE to_pid=? AND id=?")
    .run(JSON.stringify({ ...frame, failure: { code: error.code ?? 'DELIVERY_FAILED', message: error.message } }), process.pid, id);
}

function queuedFrames() {
  return statement(magiHome(), "SELECT id,body FROM frames WHERE to_pid=? AND state='queued' ORDER BY created_at,id LIMIT 100").all(process.pid)
    .map((row) => {
      let frame = null;
      try { frame = JSON.parse(row.body); } catch { /* malformed: failed by the caller */ }
      return { id: row.id, body: row.body, frame };
    });
}

function failQueued(match, error) {
  try {
    for (const row of queuedFrames()) if (row.frame && match(row.frame)) failFrame(row.id, row.frame, error(row.frame));
  } catch (e) { console.error(`[magi] NOTE_FRAME_CLEANUP_FAILED: ${e.code ?? 'STATE_FAILED'}: ${e.message}. A queued note may wait until this server exits; its sender sees it as queued.`); }
}

async function drainFrames() {
  if (draining) return;
  draining = true;
  try {
    const home = magiHome();
    for (const row of queuedFrames()) {
      const { frame } = row;
      if (frame?.op === 'stop') {
        if (typeof frame.taskId !== 'string') {
          failFrame(row.id, frame, { code: 'MALFORMED_FRAME', message: 'A stop frame needs a taskId. Send kind:"close" with stop:true on the card again.' });
          continue;
        }
        const target = runs.get(frame.taskId);
        if (!target) {
          // Registered and still starting; the next poll finds it.
          if (readWorker(frame.taskId)?.pid === process.pid) continue;
          failFrame(row.id, frame, notRunningError(frame.taskId));
          continue;
        }
        // One transaction: the ack and the frame's removal stand or fall together.
        transaction(home, () => {
          if (statement(home, "UPDATE frames SET state='processing' WHERE to_pid=? AND id=? AND state='queued'").run(process.pid, row.id).changes !== 1) return;
          setRecord(home, 'delivery-acks', row.id, { pid: process.pid, taskId: frame.taskId, op: 'stop', status: target.stop(), at: Date.now() });
          statement(home, "DELETE FROM frames WHERE to_pid=? AND id=? AND state='processing'").run(process.pid, row.id);
        });
        continue;
      }
      if (!frame || typeof frame.taskId !== 'string' || typeof frame.text !== 'string' || !frame.text.trim()) {
        failFrame(row.id, frame ?? { raw: row.body }, { code: 'MALFORMED_FRAME', message: 'A headless note frame needs taskId and nonempty text. Send the note again with kind:"note".' });
        continue;
      }
      const run = runs.get(frame.taskId);
      if (!run) {
        // Registered and still starting; the next poll finds it.
        if (readWorker(frame.taskId)?.pid === process.pid) continue;
        failFrame(row.id, frame, notRunningError(frame.taskId));
        continue;
      }
      const claimed = transaction(home, () => statement(home, "UPDATE frames SET state='processing' WHERE to_pid=? AND id=? AND state='queued'").run(process.pid, row.id).changes === 1);
      if (!claimed) continue;
      let noteId;
      try {
        noteId = await run.note(frame.text, (status) => writeAck(row.id, frame.taskId, status));
      } catch (e) {
        failFrame(row.id, frame, e);
        continue;
      }
      transaction(home, () => {
        statement(home, "DELETE FROM frames WHERE to_pid=? AND id=? AND state='processing'").run(process.pid, row.id);
        if (!getRecord(home, 'delivery-acks', row.id)) writeAck(row.id, frame.taskId, run.receipts.get(noteId) ?? 'unconfirmed');
      });
    }
  } catch (e) {
    console.error(`[magi] NOTE_FRAME_DRAIN_FAILED: ${e.code ?? 'STATE_FAILED'}: ${e.message}. Notes for this server's headless workers wait in magi.db; the next poll retries.`);
  } finally {
    draining = false;
  }
}
