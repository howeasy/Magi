// Magi inbox for Oh My Pi (omp).
//
// omp has no cross-process way to hand a running session a message, but an
// extension runs inside the session and gets `pi.sendUserMessage`, which is
// the same primitive Claude Code's inbox socket exposes. This extension does
// two things and nothing else:
//
//   1. registers the session in the shared database's agents namespace;
//   2. claims queued frames and hands each to the model as a user turn:
//      a new turn when idle, an aside at the next step boundary when busy,
//      or a steer when the sender asked for one.
//
// Installed by `magi install --omp` into ~/.omp/agent/extensions/magi/.
// Any other harness with an equivalent hook can implement the same contract.
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { processStartedAt } from './process-identity.js';

const AGENT = 'omp';
const POLL_MS = 750;
// Heartbeat age reports responsiveness; OS process birth detects PID reuse.
const HEARTBEAT_MS = 5000;

function home() {
  return process.env.MAGI_HOME || join(homedir(), '.magi');
}

// Installed by copy, so this extension cannot import the checkout's store.
const { DatabaseSync: NodeDatabase, Database: BunDatabase } = await import(
  typeof Bun === 'undefined' ? 'node:sqlite' : 'bun:sqlite'
);
function withDatabase(action, root) {
  mkdirSync(root, { recursive: true });
  const db = new (NodeDatabase ?? BunDatabase)(join(root, 'magi.db'));
  let begun = false;
  try {
    db.exec('PRAGMA busy_timeout=25; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    db.exec(`CREATE TABLE IF NOT EXISTS records (
        namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(namespace,key)
      );
      CREATE TABLE IF NOT EXISTS frames (
        to_pid INTEGER NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','processing','failed')), created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS frames_recipient ON frames(to_pid,state,created_at,id);`);
    if (!db.prepare('PRAGMA table_info(records)').all().some((column) => column.name === 'updated_at')) {
      db.exec('ALTER TABLE records ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    }
    const result = action(db);
    db.exec('COMMIT');
    begun = false;
    return result;
  } catch (error) {
    if (begun) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
function writeDeliveryAck(frameId, record, current, root) {
  if (!current()) return;
  withDatabase((db) => db.prepare('INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run('delivery-acks', frameId, JSON.stringify(record), Date.now()), root);
}
// omp's approval modes; `always-ask-cached` is new in 18.14.0.
const APPROVAL_MODES = ['always-ask', 'always-ask-cached', 'write', 'yolo'];
// The session's approval mode when it was set on the command line; the
// extension API exposes no settings, so the configured default is read by
// the bridge itself. Claude's inbox gate needs the real class of the sender.
function approvalModeFromArgv(argv = process.argv) {
  // `--yolo` is omp's alias for `--auto-approve` (args.ts, 18.11.3).
  if (argv.includes('--auto-approve') || argv.includes('--yolo')) return 'yolo';
  const i = argv.findIndex((a) => a === '--approval-mode' || a.startsWith('--approval-mode='));
  if (i < 0) return null;
  const v = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  return APPROVAL_MODES.includes(v) ? v : null;
}

export default function magi(pi) {
  const pid = process.pid;
  const birth = processStartedAt(pid);
  const sessionHome = home();
  const inDatabase = (action) => withDatabase(action, sessionHome);
  let polling = null;
  let stopped = false;
  let cancelPolling = null;
  let lastBeat = 0;
  let draining = false;
  let generation = 0;
  let activeContext = null;

  // The record as last written, so a status change rewrites it whole.
  let rec = null;
  // Process-wide, not per copy: omp rebinds this extension's factory into
  // each task subagent's own runtime in the same process, so a per-closure
  // set left the subagent's copy blind to its parent. Seen 2026-10-08 (pid
  // 11108): a subagent copy rewrote the `agents` row with its own session id,
  // the bridge refused the parent's replies (ROLE_VIOLATION), and a frame was
  // drained into the subagent (ack muzuwp61-0001-b9fadecf).
  const rootFiles = (globalThis[Symbol.for('magi.omp.rootFiles')] ??= new Set());

  function writeRegistry() {
    if (stopped) return;
    try {
      inDatabase((db) => db.prepare('INSERT INTO records(namespace,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .run('agents', String(pid), JSON.stringify(rec), Date.now()));
    } catch (e) {
      pi.logger?.warn?.('magi: could not register session', { error: String(e) });
    }
  }

  // A subagent (omp's task tool) runs inside this same process and fires the
  // same session events with its own session manager. Its session file lives
  // under the parent's: `<parent>.jsonl` becomes the directory `<parent>/`.
  // Registering it would replace this session's id and file in the registry,
  // and the bridge would then find no live session by the id it had just
  // been talking to. Observed on omp 18.1.19: the registry rewritten to
  // `<parent>/BagOracleV34.jsonl` mid-review, NO_LIVE_PEER for the parent
  // until restart.
  function isSubagentOf(parentFile, file) {
    const normalized = (path) => path?.replace(/\\/g, '/');
    return Boolean(parentFile && file && file !== parentFile && normalized(file).startsWith(normalized(parentFile).replace(/\.jsonl$/, '') + '/'));
  }


  function parentOf(sessionFile) {
    if (!sessionFile) return null;
    let fd;
    try {
      fd = openSync(sessionFile, 'r');
      const buf = Buffer.alloc(16 * 1024);
      const size = readSync(fd, buf, 0, buf.length, 0);
      const header = JSON.parse(buf.toString('utf8', 0, size).split('\n', 1)[0]);
      // A normal fork also records parentSession; only a nested task file is a
      // helper. A root fork remains a routable worker.
      if (header.type === 'session' && typeof header.parentSession === 'string' && isSubagentOf(header.parentSession, sessionFile)) return header.parentSession;
    } catch { /* a session may not have flushed its header yet */ }
    finally { if (fd !== undefined) closeSync(fd); }
    const parentFile = `${dirname(sessionFile)}.jsonl`;
    return existsSync(parentFile) ? parentFile : null;
  }

  function helperFile(file) {
    for (const parent of rootFiles) if (isSubagentOf(parent, file)) return true;
    if (isSubagentOf(rec?.sessionFile, file)) return true;
    // Also by its place alone, for a copy that shares nothing with the
    // parent's: a task file sits in a directory named after its parent's
    // `<parent>.jsonl`. A root session's directory never has such a sibling.
    return Boolean(file && existsSync(`${dirname(file)}.jsonl`));
  }

  function ownsContext(ctx) {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return !helperFile(file);
  }
  function register(ctx) {
    const sm = ctx.sessionManager;
    const sessionFile = sm?.getSessionFile?.() ?? null;
    if (helperFile(sessionFile)) return;
    const sessionId = sm?.getSessionId?.() ?? null;
    const parentSession = parentOf(sessionFile);
    if (sessionFile && !parentSession) rootFiles.add(sessionFile);
    if (rec?.sessionId !== sessionId || rec?.sessionFile !== sessionFile) {
      generation++;
      // Another session now: what the last one waited on is not this one's.
      pendingApprovals.clear();
      // ...and its clock starts now, or a fresh session reads as idle for hours.
      if (rec) rec = { ...rec, status: 'idle', waitingFor: null, statusUpdatedAt: Date.now() };
    }
    activeContext = ctx;
    rec = {
      agent: AGENT,
      pid,
      processStartedAt: birth,
      sessionId,
      sessionAliases: [...new Set([...(rec?.sessionAliases ?? []), rec?.sessionId, sessionId].filter(Boolean))],
      parentSession,
      name: sm?.getSessionName?.() ?? null,
      // The bridge reads the title and first prompt from here for `peers`.
      sessionFile,
      cwd: ctx.cwd,
      approvalMode: approvalModeFromArgv(),
      heartbeat: true,
      startedAt: rec?.startedAt ?? Date.now(),
      // busy while the agent loop runs, idle between turns; the bridge shows it
      // in `peers` and steers a request away from a busy or blocked session.
      status: rec?.status ?? 'idle',
      waitingFor: rec?.waitingFor ?? null,
      statusUpdatedAt: rec?.statusUpdatedAt ?? Date.now(),
    };
    writeRegistry();
  }

  function setStatus(status, extra = {}) {
    if (!rec) return;
    rec = { ...rec, ...extra, status, statusUpdatedAt: Date.now() };
    writeRegistry();
  }

  // Tool calls waiting on this session's user to approve them (omp emits
  // tool_approval_* only to a registered handler, 18.10.4 and later). While
  // any waits the session is blocked: the bridge routes a request around it,
  // and a steer would deny the pending call (omp 18.11), so frames go as
  // asides until it is answered.
  const pendingApprovals = new Map();
  const blockedOn = () => {
    const names = [...new Set(pendingApprovals.values())];
    return `approval of ${names.join(', ')}`;
  };

  function unregister() {
    try { inDatabase((db) => db.prepare("DELETE FROM records WHERE namespace='agents' AND key=?").run(String(pid))); }
    catch (e) { pi.logger?.warn?.('magi: REGISTRY_REMOVE_FAILED: stale row will be checked against process liveness', { error: String(e) }); }
  }

  async function drain(ctx) {
    if (stopped || draining) return;
    const startedGeneration = generation;
    const current = () => !stopped && generation === startedGeneration;
    draining = true;
    try {
      const registered = inDatabase((db) => db.prepare("SELECT 1 FROM records WHERE namespace='agents' AND key=?").get(String(pid)));
      if (!registered || Date.now() - lastBeat > HEARTBEAT_MS) {
        lastBeat = Date.now();
        if (rec) writeRegistry(); // Upsert also repairs a missing heartbeat row.
      }
      const rows = inDatabase((db) => db.prepare("SELECT id FROM frames WHERE to_pid=? AND state='queued' ORDER BY created_at,id LIMIT 100").all(pid));
      for (const row of rows) {
        if (!current()) return;
        const claimed = inDatabase((db) => {
          const frame = db.prepare("SELECT body FROM frames WHERE to_pid=? AND id=? AND state='queued'").get(pid, row.id);
          if (!frame) return null;
          db.prepare("UPDATE frames SET state='processing' WHERE to_pid=? AND id=? AND state='queued'").run(pid, row.id);
          return frame;
        });
        if (!claimed) continue;
        let frame;
        try {
          frame = JSON.parse(claimed.body);
          if (!frame || frame.id !== row.id || typeof frame.text !== 'string' || !frame.text.trim()) throw new Error('MALFORMED_FRAME: expected matching id and nonempty text; repair the failed row before manual resend.');
        } catch (error) {
          inDatabase((db) => db.prepare("UPDATE frames SET state='failed',body=? WHERE to_pid=? AND id=?")
            .run(JSON.stringify({ raw: claimed.body, failure: { status: 'failed', error: String(error) } }), pid, row.id));
          continue;
        }
        if (!current()) return;
        // A steer while a tool waits on approval would deny it: an aside instead, read at the next step.
        const blocked = pendingApprovals.size > 0;
        const deliverAs = ctx.isIdle?.() ? undefined : frame.deliverAs === 'steer' && !blocked ? 'steer' : 'aside';
        const sessionFile = rec?.sessionFile ?? null;
        let cursor = 0;
        try { cursor = statSync(sessionFile).size; } catch { /* Session file not created yet. */ }
        const receipt = {
          pid, sessionId: rec?.sessionId ?? null, sessionFile, cursor,
          marker: frame.text.match(/<!-- (magi-delivery:[^\s]+) -->\s*$/)?.[1] ?? null,
          status: 'submitted', at: Date.now(),
          ...(blocked && frame.deliverAs === 'steer' ? { deliveredAs: 'aside', because: `blocked on ${blockedOn()}; a steer would deny it` } : {}),
        };
        try {
          // omp 18.4.4 returns void here; awaiting it is NOT runtime receipt.
          await pi.sendUserMessage(frame.text, deliverAs ? { deliverAs } : undefined);
          if (!current()) return;
        } catch (e) {
          const stillCurrent = current();
          try {
            inDatabase((db) => db.prepare("UPDATE frames SET state='failed',body=? WHERE to_pid=? AND id=?")
              .run(JSON.stringify({ ...frame, failure: { ...receipt, status: 'failed', error: String(e) } }), pid, row.id));
          } catch (error) {
            pi.logger?.warn?.('magi: DELIVERY_FAILURE_RECORD_FAILED: inspect the processing frame row; do not automatically resend', { error: String(error) });
          }
          pi.logger?.warn?.('magi: DELIVERY_FAILED: inspect the failed inbox record before any manual resend', { error: String(e) });
          if (!stillCurrent) return;
          continue;
        }
        inDatabase((db) => db.prepare("DELETE FROM frames WHERE to_pid=? AND id=? AND state='processing'").run(pid, row.id));
        if (!current()) return;
        if (typeof frame.id === 'string' && frame.id) {
          try { await writeDeliveryAck(frame.id, receipt, current, sessionHome); }
          catch (e) {
            pi.logger?.warn?.('magi: DELIVERY_ACK_FAILED: receipt unconfirmed; do not resend solely for a missing ack', { error: String(e) });
          }
          if (!current()) return;
        }
      }
    } catch (e) {
      pi.logger?.warn?.('magi: INBOX_DRAIN_FAILED: inspect magi.db and retry on the next poll', { error: String(e) });
    } finally { draining = false; }
  }

  pi.on('session_start', (_event, ctx) => {
    if (helperFile(ctx?.sessionManager?.getSessionFile?.())) return;
    stopped = false;
    generation++;
    register(ctx);
    // Helper events must not supply the context used to deliver to the parent.
    if (ownsContext(ctx) && !polling) {
      polling = (ctx.setInterval ?? setInterval)(() => drain(activeContext), POLL_MS);
      cancelPolling = typeof polling === 'function' ? polling : () => (ctx.clearInterval ?? clearInterval)(polling);
    }
  });
  pi.on('session_switch', (_event, ctx) => register(ctx));
  pi.on('agent_start', (_event, ctx) => { if (ownsContext(ctx)) setStatus('busy'); });
  pi.on('agent_end', (_event, ctx) => {
    if (!ownsContext(ctx)) return;
    pendingApprovals.clear();
    setStatus('idle', { waitingFor: null });
  });
  // This session's own calls only: a subagent's approval is the subagent's,
  // and an event naming another session is that session's, context or not.
  const ownsApproval = (event, ctx) => (!event?.sessionId || event.sessionId === rec?.sessionId) && (!ctx || ownsContext(ctx));
  pi.on('tool_approval_requested', (event, ctx) => {
    if (!rec || !ownsApproval(event, ctx)) return;
    pendingApprovals.set(event?.toolCallId ?? `call-${pendingApprovals.size}`, event?.toolName ?? 'a tool');
    // The mode the session actually runs in, once it has asked: better than the command line.
    const approvalMode = APPROVAL_MODES.includes(event?.approvalMode) ? event.approvalMode : rec.approvalMode;
    setStatus('blocked', { waitingFor: blockedOn(), approvalMode });
  });
  pi.on('tool_approval_resolved', (event, ctx) => {
    if (!rec || !ownsApproval(event, ctx)) return;
    pendingApprovals.delete(event?.toolCallId);
    if (pendingApprovals.size) setStatus('blocked', { waitingFor: blockedOn() });
    else setStatus('busy', { waitingFor: null });
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (!ownsContext(ctx)) return;
    stopped = true;
    generation++;
    activeContext = null;
    cancelPolling?.();
    cancelPolling = null;
    polling = null;
    rec = null;
    unregister();
  });
}
