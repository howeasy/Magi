// How a headless Codex peer is launched and read. Shared by the server and
// the tests; its only side effect is the opt-in trace below.
//
// A headless Codex is a dedicated `codex app-server` for the length of one
// run, held on a channel (src/worker-channel.mjs) so a note on its card can
// steer the running turn. Dedicated, never the shared client in
// src/transport.mjs: this one runs with PEER_DEPTH=1 (runHeadless sets it) and
// the bridge's MCP servers disabled, and it answers the server's own requests.
// What `codex exec` took as flags travels as request parameters instead:
//
//   exec flag                        app-server
//   exec -                           turn/start input (the prompt)
//   -C <cwd>                         process cwd, thread/start|resume cwd, turn/start cwd
//   -m <model>                       thread/start|resume model
//   --sandbox, -c sandbox_mode       thread/start|resume sandbox, turn/start sandboxPolicy
//   -c approval_policy="never"       approvalPolicy "never" on the thread and the turn
//   resume <id>                      thread/resume {threadId}
//   --json                           the notifications themselves
//   --skip-git-repo-check            none: the trusted-directory check is exec's own
//   -c mcp_servers.<n>.enabled=false the same -c flags, on `codex app-server`
//   (exec's thread source)           thread/start threadSource "exec"
//
// Wire shapes and what was checked against which version:
// docs/transport-recon.md, "Codex `app-server` as a headless worker".
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { BridgeError } from './exec.mjs';
import { appServerRpc, APP_SERVER_ARGS, APP_SERVER_INITIALIZE, codexDisableBridgeFlags } from './transport.mjs';

// The peer must not be able to call back into this orchestrator. Everything
// else about the run is a request parameter, so the argv is the same for a
// review, a delegated edit and a resume.
export function headlessCodexArgs() {
  return [...APP_SERVER_ARGS, ...codexDisableBridgeFlags()];
}

// Set on the thread and again on the turn, every run including a resume: a
// resumed thread must not inherit whatever sandbox the user's config allows.
// The turn's policy is what the turn runs under; workspaceWrite carries no
// extra writable roots and Codex's default of no network. Spellings from
// `codex app-server generate-json-schema` on 0.160.1 (SandboxMode,
// SandboxPolicy).
const ACCESS = {
  read: { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  write: { sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
};

// Recorded as `codex exec` recorded its threads, so a finished worker is not
// listed as an interactive session: thread/list's default listing and
// codexPresence (source in ('cli','vscode')) leave it out, and the engine never
// queues a request into a thread no process has loaded. ThreadStartParams
// .threadSource, ThreadSourceKind "exec" (0.160.1 schema).
const THREAD_SOURCE = 'exec';

// ponytail: how long a finished worker waits for thread/unsubscribe before
// its process tree is stopped anyway. Raise it if a rollout is seen cut short.
const UNSUBSCRIBE_WAIT_MS = 5000;
// ponytail: how long a setup call (initialize, thread/start|resume,
// turn/start) or a steer may go unanswered. A setup call that times out stops
// the run with APPSERVER_TIMEOUT; a steer that does is left unconfirmed. Raise
// it if a cold app-server start is seen to need longer.
const REQUEST_WAIT_MS = 60_000;

// MAGI_CODEX_WORKER_TRACE=<file> appends every message the worker's
// app-server sends, per-token deltas excepted, one JSON line each: the record
// to read when a receipt or a reply is not what transport-recon section 4 says.
const TRACE_CAP = 8000;
function trace(frame) {
  const file = process.env.MAGI_CODEX_WORKER_TRACE;
  if (!file || /delta$/i.test(frame?.method ?? '')) return;
  const at = Date.now();
  const line = JSON.stringify({ at, frame });
  try { appendFileSync(file, (line.length > TRACE_CAP ? JSON.stringify({ at, truncated: line.slice(0, TRACE_CAP) }) : line) + '\n'); }
  catch { /* tracing is best effort */ }
}

const inputOf = (text) => [{ type: 'text', text, text_elements: [] }];
const textOf = (content) => (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : '');
const plain = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim();
// The breakdown thread/tokenUsage/updated carries in `total` and `last`.
const COUNTS = ['inputTokens', 'cachedInputTokens', 'outputTokens'];

const unanswered = (method) => new BridgeError('APPSERVER_TIMEOUT', `codex app-server did not answer ${method} within ${REQUEST_WAIT_MS / 1000} s and was stopped. Run \`codex app-server --listen stdio://\` by hand to see whether it starts and signs in, then retry the request.`);

// The conversation for one headless run. initialize, then thread/start (or
// thread/resume), then turn/start with the request; the reply is the request
// turn's final agentMessage. A note is turn/steer into that turn, keyed by its
// clientUserMessageId. The run is finished when the request turn has completed
// and every steer has its answer; the thread is then unsubscribed and the
// server stopped, because an app-server does not exit on its own when a turn
// ends. A run Magi has to stop (a setup call unanswered, stdout that is not
// JSON-RPC) finishes at once with that code; one whose process exits first is
// judged by runChannel from the exit.
export function codexAppServerSession({ send, finish, receipt }, { allowWrites = false, resumeThreadId, cwd, model } = {}) {
  const access = allowWrites ? ACCESS.write : ACCESS.read;
  const turns = new Map(); // id -> { final, last, status, error }
  const notes = new Map(); // clientUserMessageId -> { text, read, into: the turn that accepted it }
  const backlog = []; // steers written once the request turn has an id
  const errors = [];
  let code = null; // why Magi stopped the run, when it did
  let threadId = null;
  let requested = false; // turn/start sent
  let requestTurn = null;
  let active = null; // the turn in progress, the only one a note can join
  let steering = 0; // notes without a steer answer yet
  let finished = false;
  let lastError = null;
  let baseline = null;
  let usage = null;

  const rpc = appServerRpc({
    write: send,
    onNotification: ({ method, params }) => notification(method, params ?? {}),
    // The run asks for nothing (approvalPolicy "never"), and nobody is
    // attached to answer what it might ask anyway: an approval,
    // tool/requestUserInput, an MCP elicitation. Each is declined.
    onRequest: ({ method }) => ({ error: { code: -32000, message: `Declined: ${method} has nobody to answer it in a headless Magi worker.` } }),
  });

  const turn = (id) => {
    if (!turns.has(id)) turns.set(id, { final: null, last: null, status: null, error: null });
    return turns.get(id);
  };
  const requestSettled = () => Boolean(requestTurn && turns.get(requestTurn)?.status);
  const done = () => {
    if (finished || !(requestSettled() || errors.length) || active || steering) return;
    finished = true;
    // A server Magi gave up on is stopped without asking it anything more.
    const unsubscribed = threadId && !code
      ? rpc.request('thread/unsubscribe', { threadId }, { timeoutMs: UNSUBSCRIBE_WAIT_MS }).catch(() => {})
      : Promise.resolve();
    finish(unsubscribed);
  };
  // Each held steer answers now: into the turn, or refused because there is none.
  const release = () => {
    for (const steer of backlog.splice(0)) steer();
  };
  const fail = (message, why = 'PEER_FAILED') => {
    if (finished) return;
    errors.push(message);
    code ??= why;
    active = null;
    release();
    done();
  };
  const begin = (id) => {
    if (!id || !requested) return;
    requestTurn ??= id;
    if (!turn(id).status) active = id;
    release();
    done();
  };
  const read = (id, turnId) => {
    const n = notes.get(id);
    if (!n || n.read) return;
    n.read = true;
    receipt(id, turnId === requestTurn ? 'received_mid_turn' : 'received');
  };
  // A steered note's userMessage item: by the id it was sent with, under
  // either spelling, else by its text, since an id the item does carry may be
  // Codex's own rather than ours.
  const echoed = (item, turnId) => {
    for (const key of [item.clientId, item.clientUserMessageId]) if (key && notes.has(key)) return read(key, turnId);
    const text = plain(textOf(item.content));
    if (!text) return;
    for (const [id, n] of notes) {
      if (!n.read && (text === plain(n.text) || text.includes(plain(n.text)))) return read(id, turnId);
    }
  };

  function notification(method, p) {
    // A subagent's thread reports on the same connection; only ours counts.
    if (!threadId || (p.threadId && p.threadId !== threadId)) return;
    switch (method) {
      case 'turn/started':
        begin(p.turn?.id);
        return;
      case 'turn/completed': {
        const id = p.turn?.id;
        if (!id) return;
        const t = turn(id);
        t.status = p.turn.status ?? 'completed';
        t.error = p.turn.error?.message ?? lastError;
        // [INFERENCE] A turn does not complete with accepted input it has not
        // taken: a steer that Codex accepted into a turn that then completed
        // was read in it. The 2026-10-08 live probe (codex-cli 0.160.1)
        // replied to a steered note that no item matcher here caught; the
        // trace above is how to replace this with an observed item.
        if (t.status === 'completed') for (const [noteId, n] of notes) if (n.into === id) read(noteId, id);
        if (active === id) active = null;
        done();
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = p.item ?? {};
        const turnId = p.turnId ?? active ?? requestTurn;
        if (item.type === 'userMessage') echoed(item, turnId);
        else if (item.type === 'agentMessage' && method === 'item/completed' && turnId && typeof item.text === 'string') {
          const t = turn(turnId);
          t.last = item.text;
          if (item.phase === 'final_answer') t.final = item.text;
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        // Counted from this run's turns only: a resumed thread reports its
        // whole history in `total`, and what was there before is subtracted.
        const u = p.tokenUsage;
        if (!u?.total || !turns.has(p.turnId)) return;
        baseline ??= Object.fromEntries(COUNTS.map((k) => [k, (u.total[k] ?? 0) - (u.last?.[k] ?? 0)]));
        usage = { costUsd: null, ...Object.fromEntries(COUNTS.map((k) => [k, u.total[k] == null ? null : u.total[k] - baseline[k]])) };
        return;
      }
      case 'error':
        // A retried error is not the outcome; the last unretried one explains a failed turn.
        if (!p.willRetry && p.error?.message) lastError = p.error.message;
        return;
    }
  }

  const answer = async (method, params) => {
    const m = await rpc.request(method, params, { timeoutMs: REQUEST_WAIT_MS, onTimeout: () => unanswered(method) });
    if (m.error) throw new BridgeError('PEER_FAILED', `codex app-server refused ${method}: ${m.error.message ?? JSON.stringify(m.error)}. Compare the request with the installed Codex's schema (docs/transport-recon.md section 4).`);
    return m.result ?? {};
  };
  const malformed = (method, what) => new BridgeError('PROTOCOL_ERROR', `codex app-server answered ${method} without ${what}. Compare its reply with docs/transport-recon.md section 4 (MAGI_CODEX_WORKER_TRACE records it), then retry.`);

  async function open(text) {
    await answer('initialize', APP_SERVER_INITIALIZE);
    await rpc.notify('initialized', {});
    const thread = { cwd, approvalPolicy: 'never', sandbox: access.sandbox, ...(model ? { model } : {}) };
    const opened = resumeThreadId
      ? await answer('thread/resume', { threadId: resumeThreadId, ...thread })
      : await answer('thread/start', { ...thread, threadSource: THREAD_SOURCE });
    threadId = opened.thread?.id ?? null;
    if (!threadId) throw malformed(resumeThreadId ? 'thread/resume' : 'thread/start', 'a thread id');
    requested = true;
    const started = await answer('turn/start', {
      threadId,
      input: inputOf(text),
      clientUserMessageId: randomUUID(),
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: access.sandboxPolicy,
    });
    if (!started.turn?.id) throw malformed('turn/start', 'a turn id');
    begin(started.turn.id);
  }

  return {
    get finished() { return finished; },
    // A refusal or a timeout is the run's error. A failed write is not an
    // answer: the process is gone or going, and its exit (with its stderr) is
    // the verdict.
    start(text) {
      open(text).catch((e) => { if (e.code !== 'WORKER_CLOSED') fail(e.message, e.code ?? 'PEER_FAILED'); });
    },
    note(text) {
      const id = randomUUID();
      notes.set(id, { text, read: false, into: null });
      steering++;
      const sent = new Promise((resolve, reject) => {
        const steer = () => {
          const into = active;
          if (!into) {
            reject(errors.length || !requestTurn
              ? new BridgeError('DELIVERY_FAILED', 'The headless Codex worker failed before its turn began; the note was not sent. Send a follow-up request on this taskId.')
              : new BridgeError('WORKER_FINISHING', 'The request turn has ended.'));
            return;
          }
          rpc.request('turn/steer', { threadId, expectedTurnId: into, input: inputOf(text), clientUserMessageId: id }, {
            timeoutMs: REQUEST_WAIT_MS,
            onTimeout: () => new BridgeError('STEER_UNANSWERED', 'turn/steer got no answer.'),
          }).then((m) => {
            if (!m.error) {
              notes.get(id).into = into;
              receipt(id, 'queued_unread');
              // The answer is handled a microtask after its line, so the
              // turn's completion may already have been read past it.
              if (turns.get(into)?.status === 'completed') read(id, into);
              resolve();
              return;
            }
            const why = m.error.message ?? JSON.stringify(m.error);
            // The turn ended between our last look and Codex's: too late, not refused.
            if (turns.get(into)?.status || active !== into || /no active turn|expected.?turn/i.test(why)) reject(new BridgeError('WORKER_FINISHING', why));
            else reject(new BridgeError('DELIVERY_FAILED', `Codex refused the note (${why}); it was not delivered. Send it again, or send a follow-up request on this taskId.`));
          }, (e) => {
            // Written and never answered: it may be in the turn, so it is
            // neither failed nor received, and the run does not wait on it.
            if (e.code === 'STEER_UNANSWERED') resolve();
            else reject(e);
          });
        };
        if (active || requestSettled() || errors.length) steer();
        else backlog.push(steer);
      });
      const written = sent.finally(() => {
        steering--;
        done();
      });
      written.catch(() => {});
      return { id, sent: written };
    },
    line(frame) {
      trace(frame);
      rpc.handle(frame);
    },
    // A stdout line that is not JSON at all: the server is not speaking the
    // protocol this run depends on, so waiting for its turn would only time out.
    junk(line) {
      trace({ junk: line.slice(0, 2000) });
      fail(`codex app-server wrote a line that is not JSON-RPC and was stopped: ${line.slice(0, 200)}. Run \`codex app-server --listen stdio://\` by hand to see what it prints, then retry.`, 'PROTOCOL_ERROR');
    },
    // The process has exited: nothing still waiting for an answer will get one.
    close() {
      rpc.fail(new BridgeError('WORKER_CLOSED', 'The headless Codex worker has exited.'));
      // A steer still held for the request turn is refused, not left pending.
      release();
    },
    result() {
      const t = requestTurn ? turns.get(requestTurn) : null;
      const r = { message: t?.final ?? t?.last ?? '', sessionId: threadId, errors: [...errors] };
      if (t?.status === 'failed') r.errors.push(t.error ?? 'Codex reported a failed turn.');
      else if (t?.status === 'interrupted') r.errors.push('Codex interrupted the turn before it finished.');
      if (code) r.code = code;
      if (usage) r.usage = usage;
      return r;
    },
  };
}
