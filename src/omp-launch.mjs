// How a headless Oh My Pi peer is launched and read, and how its permission
// class is established. Side-effect free so the server and the tests share it.
import { openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runCli } from './exec.mjs';

// The permission class Claude Code's inbox gate understands. omp's `yolo`
// auto-approves every tool tier, which is Claude's bypassPermissions; `write`
// and `always-ask` still prompt for something, which Claude groups as
// prompting; so does `always-ask-cached` (omp 18.14.0), which prompts for every
// call until the user remembers a grant. A per-session `--approval-mode` is recorded by the extension;
// otherwise the configured default is asked of omp itself and cached, since
// it changes about as often as a thread is renamed.
const APPROVAL_TTL_MS = 5 * 60 * 1000;
let configured = null; // { at, value }

export async function ompConfiguredApprovalMode(query = async () => (await runCli('omp', ['config', 'get', 'tools.approvalMode'], { timeoutMs: 20000 })).stdout) {
  if (configured && Date.now() - configured.at < APPROVAL_TTL_MS) return configured.value;
  let value = null;
  try {
    const v = String(await query()).trim().split(/\r?\n/)[0]?.trim();
    if (['always-ask', 'always-ask-cached', 'write', 'yolo'].includes(v)) value = v;
  } catch {
    /* unknown stays unknown */
  }
  configured = { at: Date.now(), value };
  return value;
}

export function approvalToClass(mode) {
  if (mode === 'yolo') return 'bypass';
  if (mode === 'write' || mode === 'always-ask' || mode === 'always-ask-cached') return 'prompting';
  return null;
}

export async function ompPermissionClass(sender, query) {
  return approvalToClass(sender?.approvalMode ?? (sender?.headless ? null : await ompConfiguredApprovalMode(query)));
}

// A headless omp peer, held open in `--mode rpc` so a note can reach it
// while it works: commands go in on stdin and events come out on stdout, one
// JSON object per line. --no-ui keeps any UI request from being emitted. No
// extensions, so it does not register itself as a live session or carry the
// inbox; no skills, so it does not carry the peer skills. Its overlay disables
// Magi's own MCP servers before startup, preserving the user's disabled list.
// PEER_DEPTH=1 remains the backstop if another Magi server is discovered.
// Every launch flag here is listed by `omp --help` on omp 18.4.4; the wire is
// docs/transport-recon.md's.
export const OMP_REVIEW_TOOLS = ['read', 'grep', 'glob', 'web_search'];

// `allowCommands` (with allowWrites, under the operator's launch wrapper; the
// engine refuses it otherwise) is `--approval-mode yolo`: nothing asks, so a
// shell command runs. Listed by `omp --help` on 18.8.6 (always-ask|write|yolo);
// run on 18.10.3 under a bwrap wrapper (docs/security.md).
//
// `advisor` is `--advisor`: omp's own reviewer model reads each turn of the
// worker and steers it with notes. An RPC host's advisor default is soft: a
// configured `advisor.enabled` survives it (omp 18.10.4,
// config/settings.ts:1010-1014), so the run's overlay says on or off every
// time. Which model it runs on is chosen per run (src/omp-advisor.mjs). Run
// on omp 18.10.4 under this exact rpc launch: docs/transport-recon.md, "The
// advisor", has what came back.
//
// `advisorConfig` is the run's `--config` overlay (src/omp-advisor.mjs): on
// every run, the disabled MCP union, whether the advisor runs, its model when
// enabled, and the operator's syncBacklog only when set.
export function headlessOmpArgs({ allowWrites = false, allowCommands = false, resumeThreadId, cwd, model, advisor = false, advisorConfig } = {}) {
  const args = ['--mode', 'rpc', '--no-ui', '--no-extensions', '--no-skills', '--no-title'];
  if (cwd) args.push('--cwd', cwd);
  if (model) args.push('--model', model);
  if (resumeThreadId) args.push('--resume', resumeThreadId);
  if (advisor) args.push('--advisor');
  if (advisorConfig) args.push('--config', advisorConfig);
  if (allowWrites && allowCommands) args.push('--approval-mode', 'yolo');
  else if (allowWrites) args.push('--approval-mode', 'write');
  else args.push('--tools', OMP_REVIEW_TOOLS.join(','), '--approval-mode', 'always-ask');
  return args;
}

// The notes in an advisor's message: omp renders each as an XML-escaped
// <advisory severity="concern" advisor="Name"> element. A note without a
// severity is a nit. Capped, because a note is a model's text.
const ADVISORY = /<advisory\b([^>]*)>\n?([\s\S]*?)\n?<\/advisory>/g;
const MAX_ADVICE_NOTES = 20;
const MAX_ADVICE_CHARS = 2000;
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export function advisorNotes(message) {
  const text = contentText(message?.content);
  const notes = [];
  for (const m of text.matchAll(ADVISORY)) {
    const severity = /\bseverity="(nit|concern|blocker)"/.exec(m[1])?.[1] ?? 'nit';
    const note = unescapeXml(m[2]).trim();
    if (note) notes.push({ severity, note: note.length > MAX_ADVICE_CHARS ? `${note.slice(0, MAX_ADVICE_CHARS)}…` : note });
  }
  return notes;
}

// What a run said, from its events: message_end carries each complete
// message. `--mode json` and `--mode rpc` emit the same agent events, so both
// readers share this and a reply reads the same either way.
function ompMessages() {
  const r = { message: '', sessionId: null, errors: [] };
  const advice = []; // the advisor's notes; in the result only when there are some
  // Each message reports one model call's usage, so a run is their sum; the
  // last message alone undercounts any run that took more than one turn.
  let seen = false;
  let cost = 0;
  let input = 0;
  let output = 0;
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    event(ev) {
      if (ev.type === 'session' && typeof ev.id === 'string') r.sessionId = ev.id;
      else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const t = (Array.isArray(ev.message.content) ? ev.message.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (t.trim()) r.message = t;
        // omp reports per-message usage and cost when its provider does; both
        // are optional and read only if present.
        const u = ev.message.usage;
        if (u && typeof u === 'object') {
          seen = true;
          cost += num(u.cost?.total ?? u.cost);
          input += num(u.input ?? u.input_tokens) + num(u.cacheRead) + num(u.cacheWrite);
          output += num(u.output ?? u.output_tokens);
        }
        if (ev.message.stopReason === 'error' || ev.message.stopReason === 'aborted') this.error(ev.message.errorMessage ?? `omp turn ${ev.message.stopReason}`);
      } else if (ev.type === 'message_end' && ev.message?.role === 'custom' && ev.message.customType === 'advisor') {
        for (const note of advisorNotes(ev.message)) if (advice.length < MAX_ADVICE_NOTES) advice.push(note);
      } else if (ev.type === 'error') this.error(ev.error?.message ?? ev.message ?? 'unknown error');
    },
    error(text) {
      if (!r.errors.includes(text)) r.errors.push(text);
    },
    result() {
      // A provider with no price list reports a total of 0: unpriced, not free.
      return { ...r, errors: [...r.errors], ...(advice.length ? { advice: [...advice] } : {}), ...(seen ? { usage: { costUsd: cost > 0 ? cost : null, inputTokens: input || null, outputTokens: output || null } } : {}) };
    },
  };
}

// `--mode json` writes one event per line: a session header first, then the
// agent events.
export function parseOmpJsonl(text) {
  const messages = ompMessages();
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    messages.event(ev);
  }
  return messages.result();
}

// The rpc conversation for one headless run. On `ready` it negotiates protocol
// 2 (oversized frames arrive as rpc_chunk sequences instead of truncated),
// filters out the per-token message_update stream, sends the request as a
// prompt and asks get_state for the session id. A note is another prompt with
// streamingBehavior "steer": queued into the running turn, or a fresh turn
// when the agent is idle. Every prompt completes with exactly one
// prompt_result (or a response saying it finished locally); the run is done
// when every prompt has completed and the session is settled, so no queued
// note or background job can wake the agent again.
const RPC_EVENTS = ['agent_start', 'agent_end', 'message_end'];
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '';
}

export function ompRpcSession({ send, finish, receipt }) {
  const messages = ompMessages();
  const request = `magi-request-${randomUUID()}`;
  const stateId = `magi-state-${randomUUID()}`;
  const pending = new Set([request]); // prompts without an outcome yet
  const notes = new Map(); // id -> { marker, read }
  const backlog = []; // note writes held until the request has gone
  let ready = false;
  let prompt = null;
  let begun = false;
  let settled = false;
  let finished = false;
  let running = false;
  // User messages the current run has already taken: a note that is not its
  // run's first joined a turn in progress; one that is started a fresh turn.
  let usersInRun = 0;
  // The request's own answer, kept when Magi's wrap-up note arrived after it.
  let answered = null;
  let sessionId = null;
  let workerModel = null;
  let chunk = null;
  const quiet = (p) => p.catch(() => {}); // a failed write surfaces as the run's exit

  const done = (force = false) => {
    if (finished || (!force && (pending.size || !settled))) return;
    finished = true;
    finish();
  };
  const begin = () => {
    if (begun || !ready || prompt === null) return;
    begun = true;
    quiet(send({ id: 'magi-protocol', type: 'negotiate_protocol', protocolVersion: 2 }));
    quiet(send({ id: 'magi-filter', type: 'set_event_filter', events: RPC_EVENTS }));
    quiet(send({ id: request, type: 'prompt', message: prompt }));
    quiet(send({ id: stateId, type: 'get_state' }));
    for (const held of backlog.splice(0)) send(held.command).then(held.resolve, held.reject);
  };
  const lost = (why) => {
    chunk = null;
    messages.error(`omp sent a broken rpc_chunk sequence (${why}); a frame was lost`);
  };
  const reassemble = (f) => {
    if (!chunk) {
      if (f.index !== 0 || !(f.count >= 1) || !(f.byteLength >= 0) || f.byteLength > MAX_REASSEMBLED_BYTES) return lost('bad first chunk');
      chunk = { id: f.chunkId, count: f.count, byteLength: f.byteLength, parts: [], size: 0 };
    } else if (f.chunkId !== chunk.id) return lost('interleaved');
    if (f.index !== chunk.parts.length || f.count !== chunk.count || f.byteLength !== chunk.byteLength) return lost('out of order');
    const part = Buffer.from(String(f.data ?? ''), 'base64');
    chunk.size += part.length;
    if (chunk.size > chunk.byteLength) return lost('longer than declared');
    chunk.parts.push(part);
    if (chunk.parts.length < chunk.count) return;
    const whole = Buffer.concat(chunk.parts);
    const expected = chunk.byteLength;
    chunk = null;
    if (whole.length !== expected) return lost('shorter than declared');
    let frame;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(whole)); } catch { return lost('not UTF-8 JSON'); }
    handle(frame);
  };

  function handle(f) {
    switch (f.type) {
      case 'ready':
        ready = true;
        begin();
        return;
      case 'response':
        if (f.id === request) {
          // Refused before admission: there is no turn to wait for.
          if (f.success === false) {
            messages.error(f.error ?? 'omp refused the prompt');
            pending.delete(request);
            done(true);
          } else if (f.data?.agentInvoked === false) {
            pending.delete(request);
            settled = true;
            done();
          }
        } else if (notes.has(f.id)) {
          if (f.success === false) {
            receipt(f.id, 'failed');
            pending.delete(f.id);
            done();
          } else {
            receipt(f.id, 'queued_unread');
            if (f.data?.agentInvoked === false) { pending.delete(f.id); done(); }
          }
        } else if (f.id === stateId && f.success !== false && typeof f.data?.sessionId === 'string') {
          sessionId = f.data.sessionId;
          // The model the worker actually runs, as omp reports it: provider and id.
          if (typeof f.data.model?.id === 'string') workerModel = f.data.model.provider ? `${f.data.model.provider}/${f.data.model.id}` : f.data.model.id;
        }
        return;
      case 'prompt_result':
        if (!pending.delete(f.id)) return;
        if (f.status === 'error') messages.error(f.error?.message ?? 'omp reported a failed turn');
        else if (f.status === 'aborted') messages.error('omp aborted the turn');
        settled = f.sessionSettled === true;
        done();
        return;
      case 'session_settled':
        settled = true;
        done();
        return;
      case 'agent_start':
        if (!running) usersInRun = 0;
        running = true;
        return;
      case 'agent_end':
        if (f.yielded !== false) running = false;
        return;
      case 'message_end':
        messages.event(f);
        if (f.message?.role === 'user') {
          const text = contentText(f.message.content);
          for (const [id, n] of notes) {
            if (n.read || !text.includes(n.marker)) continue;
            n.read = true;
            // Magi's own note (the wrap-up) starting a fresh turn means the
            // request's turn had already ended: what it said is the answer,
            // and the short turn this note opens must not replace it.
            if (n.own && usersInRun === 0) {
              const before = messages.result();
              if (before.message && !before.errors.length) answered = before.message;
            }
            receipt(id, usersInRun > 0 ? 'received_mid_turn' : 'received');
          }
          usersInRun++;
        }
        return;
    }
  }

  return {
    get finished() { return finished; },
    start(text) {
      prompt = text;
      begin();
    },
    note(text, { own = false } = {}) {
      const id = `magi-note-${randomUUID()}`;
      const marker = `magi-delivery:${id}`;
      pending.add(id);
      settled = false;
      notes.set(id, { marker, read: false, own });
      const command = { id, type: 'prompt', message: `${text}\n<!-- ${marker} -->`, streamingBehavior: 'steer' };
      const written = (begun ? send(command) : new Promise((resolve, reject) => backlog.push({ command, resolve, reject })))
        .catch((e) => {
          pending.delete(id);
          done();
          throw e;
        });
      return { id, sent: written };
    },
    // The process has exited: a note still held for the request was never
    // written, and nothing else will settle it.
    close() {
      for (const held of backlog.splice(0)) held.reject(Object.assign(new Error('omp exited before the request was sent'), { code: 'WORKER_CLOSED' }));
    },
    line(f) {
      if (f.type === 'rpc_chunk') return reassemble(f);
      if (chunk) lost('interrupted');
      handle(f);
    },
    result() {
      const r = messages.result();
      r.sessionId = sessionId ?? r.sessionId;
      if (workerModel) r.model = workerModel;
      if (answered !== null) Object.assign(r, { message: answered, completeBeforeWrapUp: true });
      return r;
    },
  };
}

// What an omp session is about: its title, or its first prompt, read from the
// head of the session file the extension recorded.
export function ompSessionPurpose(session) {
  if (!session?.sessionFile) return null;
  let head;
  try {
    const fd = openSync(session.sessionFile, 'r');
    try {
      const buf = Buffer.alloc(128 * 1024);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let title = null;
  let prompt = null;
  for (const line of head.split(/\r?\n/)) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!title && (o.type === 'title' || o.type === 'session') && typeof o.title === 'string' && o.title.trim()) title = o.title.trim();
    if (!prompt && o.type === 'message' && o.message?.role === 'user') {
      const c = o.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
      const first = text.split(/\r?\n/).find((l) => l.trim());
      if (first) prompt = first.length > 140 ? `${first.slice(0, 140)}…` : first;
    }
    if (title && prompt) break;
  }
  return title && prompt ? `${title}: ${prompt}` : title ?? prompt;
}
