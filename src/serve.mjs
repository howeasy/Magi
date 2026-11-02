// The one MCP server behind every peer tool. What differs per harness is an
// adapter record; everything the three servers used to copy lives here.
//
// adapter = {
//   peer:        'codex' | 'claude' | 'omp'      the harness this server reaches
//   display:     'Codex'                          how the tool description names it
//   tool:        'codex_peer'                     the tool this server exposes
//   selfDefault: 'claude'                         who loaded me, when --as is absent
//   replyTool:   (self) => 'claude_peer'          the tool the peer answers with
//   schema:      { deliveries, peerHint, steerHint?, queueKey? }
//   sessions:    async ({ cwd }) => [session]     live peers: {name, id|sessionId, pid?, cwd, purpose?, branch?, lastActive?}
//   purpose?:    (session) => string | null       read on demand when a session carries none
//   steerTarget?: async (target) => id            a harness whose steer needs an explicit, resolved target
//   headless:    { bin, args({allowWrites, allowCommands, resumeThreadId, cwd, model, advisor, advisorConfig}), parse(stdout) => {message, sessionId, errors, usage?, advice?, model?} }
//   advisor?:    { defaultOn() => bool, plan({model, resuming}) => {ok, model, ...}|{ok:false, code, message}, overlay(model) => {path, cleanup}, describe(plan, workerModel) => text }
//                a reviewer the harness ships (omp's); the engine asks it which model, never names one
//                or, for a peer that takes notes while it works, channel({send, finish, receipt}, {allowWrites, allowCommands, resumeThreadId, cwd, model}) => session
//                in place of parse (src/worker-channel.mjs; ompRpcSession, claudeStreamSession and codexAppServerSession are the examples)
//   deliverLive: async ({ text, target, taskId, putRequestBody, progress, delivery, sender, kind, args }) => { via, label, target, messageId?, deliveryStatus, statusText?, warning? }
//   deliverReply?: async ({ text, task, sender, delivery })  default: the recorded origin
// }
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { makeEngine, toolError, makeProgress, selfName } from './peer.mjs';
import { z } from 'zod';
import { peerInputSchema, peerToolDescription } from './peer-schema.mjs';
import { runCli, killTrackedChildren, classifyFailure, looksLikeAuthFailure, authError, BridgeError, timeoutLimit, timeoutError } from './exec.mjs';
import { runChannel, deliverHeadlessNote, stopHeadlessWorker } from './worker-channel.mjs';
import { resolveOrigin, deliverReplyToOrigin } from './transport.mjs';
import { relayCall, relayTo, localAddress, queueRelayEvent, setRelayEventHandler, deliverWorkerMessage, pushFiles, pullFiles } from './relay.mjs';
import { FILES_OFF_HINT, filesBlock, fileMeta, filesEnabled } from './artifacts.mjs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexCaller, traceCodexCaller } from './mcp-caller.mjs';
import { sweep, autoReconcile, registerWorker, unregisterWorker, recordWorkerChild, retryState, sameSession, ownProcessStartedAt, readTask, listTasks, magiHome, withStateLock } from './state.mjs';
import { getRecord, setRecord, removeRecord } from './store.mjs';
import { workerWrapper, workerEnv, WRAPPER_ENV } from './worker-wrapper.mjs';
import { remoteConfig, prepareWorkspace, collectWorkspace, remoteFooter, remoteCommand, sshArgs, unreachable, REMOTE_PROTOCOL } from './remote.mjs';
import { STATE_BATCH } from './remote-worker.mjs';
import { processStartedAtAsync } from '../omp/process-identity.js';
import { resolve } from 'node:path';
import { spawnPeer } from './spawn.mjs';
import { transcriptTail, lastSaid, compactionAt, transcriptPosition } from './transcript.mjs';
import { getProviders, providerEnabled, recordProviderHealth, recordProviderFailure } from './providers.mjs';

function requireProvider(name) {
  if (!providerEnabled(name)) throw new BridgeError('PROVIDER_DISABLED', `${name} is disabled. Run "magi provider enable ${name}" and restart the harness to restore its tool.`);
}

async function observeProvider(name, action) {
  const observedAt = Date.now();
  try { return await action(); }
  catch (e) { recordProviderFailure(name, e, observedAt); throw e; }
}

async function discoverSessions(adapter, options) {
  const observedAt = Date.now();
  try { return await adapter.sessions({ ...options, strict: true }); }
  catch (error) {
    recordProviderFailure(adapter.peer, error, observedAt);
    // Codex discovery traditionally falls back to headless when unreachable.
    // Ask for its strict error first so that fallback cannot hide auth health.
    if (adapter.peer === 'codex') return [];
    throw error;
  }
}

// One rule for "same directory": slashes and case differ between how each
// harness records a cwd and how the caller spells it.
export function sameDir(a, b) {
  const n = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return Boolean(a && b) && n(a) === n(b);
}

const idOf = (s) => s.id ?? s.sessionId ?? null;

// One vocabulary for what a session is doing, whatever its harness reports:
// Claude's registry status and waitingFor, Codex's rollout tail, the omp
// shim's busy/idle. `blocked` means a human must act before the session can
// read anything, which is the one state a request should route around.
export function peerState(s) {
  const status = s?.status ?? null;
  const state = s?.waitingFor || status === 'waiting' ? 'blocked' : status === 'busy' || status === 'shell' ? 'working' : status === 'idle' ? 'idle' : 'unknown';
  const idleMs = state === 'idle' && s.statusAt ? Math.max(0, Date.now() - s.statusAt) : null;
  return {
    state, idleMs, waitingFor: s?.waitingFor ?? (state === 'blocked' ? 'input' : null),
    // What it needs from its user, in words, where the harness says (Claude's registry `needs`).
    ...(state === 'blocked' && s?.needs ? { needs: s.needs } : {}),
    context: s?.context ?? null, cache: s?.cache ?? null, ...(s?.open === true ? { open: true } : {}),
  };
}

function fmtIdle(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 90 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

// The short label `peers` prints and a progress line quotes; takes the
// {state, idleMs, waitingFor, context} that peerState returns and rows carry.
export function describeState(p) {
  const label = p.state === 'blocked' ? `blocked: ${p.waitingFor}${p.needs ? ` (${p.needs})` : ''}` : p.state === 'idle' ? (p.idleMs != null ? `idle ${fmtIdle(p.idleMs)}` : 'idle') : p.state;
  const ctx = p.context?.tokens != null
    ? `ctx ${Math.round(p.context.tokens / 1000)}k` + (p.context.window ? `/${Math.round(p.context.window / 1000)}k (${Math.round((100 * p.context.tokens) / p.context.window)}%)` : '')
    : null;
  const cache = p.cache === 'warm' ? 'cache warm' : p.cache === 'cold' ? 'cache cold' : null;
  return [label, ctx, cache].filter(Boolean).join(', ');
}

// Which live session a request goes to. Named: exact id or pid, then a unique
// name; several sessions answering to one name are refused rather than sorted.
// Unnamed: the first session in this working directory, never one elsewhere,
// because a request about one project delivered into a session working on
// another is worse than no delivery.
// A session is live when it is doing something or could be asked something
// now: working, blocked, idle for less than an hour, or held open by its app
// (`open`, a Codex thread with a desktop writer lock). A Codex thread with
// no recent turn is otherwise a saved conversation the desktop may never open
// again; a request queued into it waits until the timeout. The wall lists
// such a thread as recent, and the picker below never chooses it on its own.
export const LIVE_IDLE_MS = 60 * 60_000;
export function isLive(harness, st) {
  if (st.state === 'working' || st.state === 'blocked' || st.open) return true;
  if (st.state === 'idle') return st.idleMs == null || st.idleMs < LIVE_IDLE_MS;
  return harness !== 'codex'; // a registered Claude/omp session is live even when its state is unknown
}

export function pickSession(sessions, target, cwd, peer) {
  // A model that has seen `from=codex id=<uuid>` in a header will try
  // `codex:<uuid>` as an address; the prefix is this peer's own name, so accept it.
  if (typeof target === 'string' && target.startsWith(`${peer}:`)) target = target.slice(peer.length + 1);
  if (target) {
    const exact = sessions.filter((s) => idOf(s) === target || s.sessionAliases?.includes(target) || (s.pid != null && String(s.pid) === target));
    if (exact.length === 1) return remoteRefused(exact[0], peer);
    if (exact.length > 1) throw new BridgeError('AMBIGUOUS_PEER', `Address "${target}" belongs to ${exact.length} ${peer} sessions. Use the stable pid from kind:"peers".`);
    const named = sessions.filter((s) => s.name === target);
    if (named.length === 1) return remoteRefused(named[0], peer);
    if (named.length > 1) {
      throw new BridgeError(
        'AMBIGUOUS_PEER',
        `${named.length} live ${peer} sessions answer to "${target}": ` +
          named.map((s) => `${s.pid != null ? `pid ${s.pid}` : idOf(s)} in ${s.cwd ?? 'unknown cwd'}`).join('; ') +
          '. Address one by its id' + (named.some((s) => s.pid != null) ? ' or pid' : '') + '.',
      );
    }
    return null;
  }
  return sessions.find((s) => !s.remote && !s.parentSession && sameDir(s.cwd, cwd) && isLive(peer, peerState(s))) ?? null;
}

// A session running elsewhere (the desktop app's cloud sessions) has no
// inbox here; naming it is answered, not silently routed around.
function remoteRefused(s, peer) {
  if (!s.remote) return s;
  throw new BridgeError('NO_LIVE_PEER', `${peer} session "${s.name ?? idOf(s)}" runs remotely (no local process or inbox); it can be watched on the board but not messaged from here.`);
}

// The first line `magi worker` prints, held back from the harness's own
// channel session, which never sees it. `seen.hello` is that line once read.
function remoteGate(session, seen) {
  return {
    get finished() { return session.finished; },
    start: (t) => session.start(t),
    note: (t) => session.note(t),
    line(ev) {
      if (!seen.hello && ev?.type === 'magi_worker') { seen.hello = ev; return; }
      session.line(ev);
    },
    junk: (l) => session.junk?.(l),
    result: () => session.result(),
    close: () => session.close?.(),
  };
}

// A fresh process as the peer. Every harness reports the same three things
// through its parser; the verdict on them is the same too.
// `advisor` is the plan for the adapter's own reviewer ({ model }), or null.
// `host` names a remote in remotes.json: the same run, with the worker on that
// machine behind ssh (src/remote.mjs) and everything else here.
export async function runHeadless(adapter, { text, cwd, allowWrites, allowCommands = false, resumeThreadId, model, advisor = null, timeoutMs, progress, taskId, round, signal, host = null }) {
  // Admission is checked at dispatch; disabling later cannot strand this work.
  const observedAt = Date.now();
  const { bin, args, parse, channel, retryStartup } = adapter.headless;
  const remote = host ? remoteConfig(host) : null;
  if (remote && !channel) throw new BridgeError('BAD_REQUEST', `A ${adapter.peer} worker cannot run on another machine: it is not held on a channel. Drop host.`);
  // The operator's wrapper, validated at startup; the engine refused
  // allowCommands without one, so this only re-reads the same value. It
  // contains a worker on this machine, so a remote worker is not under it.
  const wrapper = remote ? null : workerWrapper();
  if (allowCommands && !wrapper) throw new BridgeError('COMMANDS_REQUIRE_WRAPPER', `allowCommands needs ${WRAPPER_ENV} on this server; set it and restart, or send the request without allowCommands.`);
  const label = remote ? `${bin} on ${host}` : bin;
  if (progress) progress(`starting headless ${label}${wrapper ? ' under the launch wrapper' : ''}`);
  // On the board for as long as it runs; the wall has no other way to see it.
  if (taskId) {
    ownProcessStartedAt(); // once per process, outside the busy-retry budget below
    await retryState(() => registerWorker({ taskId, harness: adapter.peer, bin, cwd, round, timeoutMs, wrapper: wrapper?.[0] ?? null, allowCommands, host }));
  }
  // The process spawned for the worker (the wrapper, or the worker itself),
  // recorded off the critical path: on Windows its start time is a slow read.
  const onSpawn = taskId ? (pid) => {
    void retryState(() => recordWorkerChild(taskId, { childPid: pid })).catch(() => {});
    void processStartedAtAsync(pid).then((childStartedAt) => childStartedAt && retryState(() => recordWorkerChild(taskId, { childPid: pid, childStartedAt }))).catch(() => {});
  } : undefined;
  let reply;
  // The temp file that names this run's advisor model; gone when the run is.
  let overlay = null;
  // The remote worktree this run works in, and what came back from it.
  let workspace = null;
  let collected = null;
  try {
    if (remote) {
      if (progress) progress(`copying this tree to ${host}`);
      workspace = await prepareWorkspace({ remote, taskId, cwd, signal });
    }
    // Every run of a harness with an advisor gets its overlay (on or off, and
    // the model when on). A remote worker's is written there, by `magi worker`.
    overlay = adapter.advisor && !remote ? await adapter.advisor.overlay(advisor?.model ?? null, { cwd }) : null;
    // For a remote worker these are only read here (the approval mode); the
    // remote builds its own from the same adapter.
    // The worker starts where the request was made, inside its copy of the tree.
    const workCwd = workspace ? (workspace.rel ? `${workspace.work}/${workspace.rel}` : workspace.work) : null;
    const launchArgs = args({ allowWrites, allowCommands, resumeThreadId, cwd: workCwd ?? cwd, model, advisor: Boolean(advisor), advisorConfig: overlay?.path });
    const approvalAt = launchArgs.indexOf('--approval-mode');
    const approvalMode = approvalAt < 0 ? null : launchArgs[approvalAt + 1];
    const env = {
      PEER_DEPTH: '1',
      PEER_ROLE: 'peer',
      // The wrapper's own setting is the server's; a worker has no use for it.
      [WRAPPER_ENV]: undefined,
      ...(wrapper ? workerEnv({ taskId, round, harness: adapter.peer, cwd: resolve(cwd ?? process.cwd()), allowCommands, config: overlay?.path }) : {}),
    };
    let parsed;
    let res;
    if (remote) {
      // The same channel session, over ssh; the remote's run settings (Codex
      // reads cwd from here) name the remote worktree.
      const launch = { allowWrites, allowCommands: false, resumeThreadId, cwd: workCwd, model };
      const payload = { protocol: REMOTE_PROTOCOL, allowWrites, resumeThreadId: resumeThreadId ?? null, model: model ?? null, advisorModel: advisor?.model ?? null, workspace: { repo: workspace.repo, work: workspace.work, rel: workspace.rel ?? '', taskId } };
      const seen = { hello: null };
      ({ parsed, ...res } = await runChannel({ name: label, spawn: 'ssh', args: sshArgs(remote, remoteCommand(remote, `worker ${adapter.peer}`, payload)), text, cwd, env, timeoutMs, signal, progress, taskId, onSpawn, open: (io) => remoteGate(channel(io, launch), seen) }));
      if (!seen.hello) {
        if (res.exitCode === 255) throw unreachable(remote, res.stderr);
        throw new BridgeError('REMOTE_FAILED', `${remote.magi} on remote "${host}" did not start a worker (exit ${res.exitCode}: ${res.stderr.trim().slice(0, 400) || 'no output'}). Check that it is a Magi with \`magi worker\` and that "node" in remotes.json runs there.`);
      }
      if (!seen.hello.ok) throw new BridgeError(seen.hello.code ?? 'REMOTE_FAILED', `On remote "${host}": ${seen.hello.message}`);
    } else if (channel) {
      // Held open, so a note on this taskId reaches it while it works. A
      // channel whose run settings are not argv (Codex) reads them here.
      const launch = { allowWrites, allowCommands, resumeThreadId, cwd, model };
      const limit = timeoutLimit(timeoutMs);
      const deadline = Date.now() + limit;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timeoutError(bin, limit);
        ({ parsed, ...res } = await runChannel({ name: bin, args: launchArgs, text, cwd, env, timeoutMs: remaining, signal, progress, taskId, wrapper, onSpawn, open: (io) => channel(io, launch) }));
        if (attempt > 0 || !retryStartup?.({ ...res, parsed })) break;
        progress?.(`${bin} hit a transient SQLite startup failure before receiving input; retrying once`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } else {
      res = await runCli(bin, launchArgs, { cwd, stdin: text, timeoutMs, signal, env, wrapper, onSpawn, onProgress: progress });
      parsed = parse(res.stdout);
    }
    if (res.exitCode !== 0) throw classifyFailure(bin, { stderr: res.stderr, errors: parsed.errors, exitCode: res.exitCode });
    if (parsed.errors.length) {
      if (looksLikeAuthFailure(parsed.errors.join('; '))) throw authError(bin, parsed.errors.join('; '));
      // A channel that stopped the run itself names why (APPSERVER_TIMEOUT, PROTOCOL_ERROR).
      throw new BridgeError(parsed.code ?? 'PEER_FAILED', parsed.errors.join('; '));
    }
    if (!parsed.message) throw new BridgeError('EMPTY_REPLY', `${bin} returned no assistant message.`);
    // An auth error in an otherwise successful CLI response is not a reply.
    if (looksLikeAuthFailure(parsed.message) && parsed.message.length < 400) throw authError(bin, parsed.message);
    // A writing remote worker's edits come home as a branch. A failed fetch
    // costs the footer, never the reply: the work is still committed there.
    let footer = '';
    if (remote && allowWrites) {
      try {
        if (progress) progress(`fetching the worker's changes from ${host}`);
        collected = await collectWorkspace({ remote, taskId, round, workspace, signal });
        footer = remoteFooter(host, collected);
      } catch (e) {
        footer = `\n\n[magi] ${e.code}: ${e.message}`;
      }
    } else if (remote) {
      footer = `\n\n[magi] The worker ran on ${host}, read-only, in a copy of this tree at ${workspace.base.slice(0, 12)}${workspace.dirty ? ' (HEAD plus uncommitted changes)' : ''}.`;
    }
    reply = { inlineReply: parsed.message, via: 'headless', threadId: parsed.sessionId, usage: parsed.usage ?? null, approvalMode, ...(allowCommands ? { allowCommands: true } : {}), ...(parsed.advice?.length ? { advice: parsed.advice } : {}), ...(advisor && parsed.model ? { workerModel: parsed.model } : {}), ...(remote ? { host, remoteFooter: footer, ...(collected?.changed ? { branch: collected.branch, commit: collected.commit } : {}) } : {}) };
  } catch (e) {
    // Provider health is this machine's; a remote's failure says nothing about it.
    if (!remote) recordProviderFailure(adapter.peer, e, observedAt);
    // The remedy in a harness's error ("run omp login") is for that machine.
    if (remote && e instanceof BridgeError && !/^REMOTE_|^UNKNOWN_HOST$/.test(e.code ?? '')) {
      e.message += ` (This worker ran on remote "${host}": fix it there, over \`ssh ${remote.ssh.join(' ')}\`.`;
      // Seen on a Mac: signed in for the desktop login, signed out to an ssh command.
      if (e.code === 'AUTH_REQUIRED' && remote.shell === 'posix') e.message += ' If it is a Mac, a sign-in kept in the login Keychain may not be readable from an ssh session; check what the CLI uses and sign it in for ssh use (docs/usage.md, macOS).';
      e.message += ')';
    }
    throw e;
  } finally {
    try { overlay?.cleanup(); } catch { /* sweep removes a leftover */ }
    if (taskId) {
      try { await retryState(() => unregisterWorker(taskId)); }
      catch (error) {
        // The row belongs to this server PID; restart makes it sweepable.
        console.error(`[magi] WORKER_CLEANUP_FAILED task_id=${taskId}: ${error.code ?? 'STATE_FAILED'}: ${error.message}. Restart this Magi server, then run magi sweep after the ledger is writable.`);
      }
    }
  }
  // Best effort and after the reply is secured: health never changes the outcome.
  if (!remote) recordProviderHealth(adapter.peer, { down: null });
  return reply;
}

// A name that matched nothing is usually a near miss ("web-api" for
// "web-api-2"), and the caller has no other way to see what is there: name the
// sessions the adapter lists, the close ones first, so the retry is one call.
function listedNames(peer, sessions, target, kind = 'request') {
  // Only a request can fall back to headless; a note or a watch needs a live session.
  const otherwise = kind === 'request' ? 'use delivery:"headless"' : 'ask the user to open one';
  const t = String(target).toLowerCase();
  const label = (s) => String(s.name ?? idOf(s) ?? s.pid);
  const close = (s) => { const n = label(s).toLowerCase(); return n.includes(t) || t.includes(n); };
  const shown = [...sessions.filter(close), ...sessions.filter((s) => !close(s))].slice(0, 8);
  if (!shown.length) return `No ${peer} session is registered at all; ${kind === 'request' ? 'use delivery:"headless", or ask the user to open one' : 'ask the user to open one'}.`;
  const more = sessions.length > shown.length ? `, and ${sessions.length - shown.length} more (kind:"peers" lists them)` : '';
  return `Listed ${peer} sessions: ${shown.map((s) => `"${label(s)}"${close(s) ? ' (close)' : ''}`).join(', ')}${more}. Retry with one of them, or ${otherwise}.`;
}

export function makePickDelivery(adapter) {
  const peer = adapter.peer;
  return async function pickDelivery({ delivery, target, cwd, kind = 'request', caller }) {
    if (delivery === 'headless') return { mode: 'headless' };
    if (delivery === 'steer' && adapter.steerTarget) return { mode: 'live', target: await adapter.steerTarget(target) };
    // A named peer is looked up wherever it is; the directory only decides
    // the default, so a caller who typed a name is never told "not here".
    let sessions = await discoverSessions(adapter, { cwd: target ? undefined : cwd });
    const sameHarness = peer === 'omp' && caller?.agent === peer;
    if (sameHarness) {
      if (caller.identityVerified !== true || sameSession(caller, caller) !== true) {
        throw new BridgeError('AMBIGUOUS_ORIGIN', 'OMP-to-OMP selection requires the verified caller session. Restart Magi from the registered OMP session.');
      }
      const isOther = (session) => sameSession(caller, { agent: peer, ...session }) === false &&
        !(caller.pid != null && caller.pid === session.pid);
      if (target) {
        const named = pickSession(sessions, target, cwd, peer);
        if (named && !isOther(named)) {
          throw new BridgeError(sameSession(caller, { agent: peer, ...named }) === true || caller.pid != null && caller.pid === named.pid ? 'SELF_TARGET' : 'AMBIGUOUS_ORIGIN',
            'An OMP peer must be a verified session distinct from the caller. Select another session.');
        }
      }
      sessions = sessions.filter(isOther);
    }
    const session = pickSession(sessions, target, cwd, peer);
    if (session) {
      const st = peerState(session);
      // A caller who named a saved Codex thread gets it, told what it is. A
      // registered Claude or omp session is a running process however long it
      // has idled, and reads its inbox at once (devbox and Mac CLI workers idle
      // 17 h took a `magi send` as a turn immediately, 2026-10-22).
      if (target && peer === 'codex' && !isLive(peer, st)) return { mode: 'live', target: session, warning: `${peer} session "${session.name ?? idOf(session)}" is ${describeState(st)}, a saved conversation; it reads this only when its desktop opens it again.` };
      if (st.state !== 'blocked') return { mode: 'live', target: session };
      // A session waiting on its human reads nothing until they answer. A
      // request on `auto` takes a fresh peer instead of waiting on a dialog;
      // a note or watch still lands, since the inbox holds it.
      const label = session.name ?? idOf(session) ?? String(session.pid);
      const why = `${peer} session "${label}" is blocked on ${st.waitingFor}`;
      if (kind === 'request' && delivery === 'auto') return { mode: 'headless', reason: 'PEER_BLOCKED', detail: `${why}; using a fresh headless ${peer} instead` };
      return { mode: 'live', target: session, warning: `${why}; it reads this after its user answers.` };
    }
    const stale = sessions.filter((s) => sameDir(s.cwd, cwd)).length;
    if (delivery === 'live' || delivery === 'steer') {
      if (target) throw new BridgeError('NO_LIVE_PEER', `No live ${peer} session answers to "${target}". ${listedNames(peer, sessions, target, kind)}`);
      if (stale) throw new BridgeError('NO_LIVE_PEER', `${stale} saved ${peer} session(s) in ${cwd} have had no turn in the last hour and would not read this. Name one with peer:"<name>" to queue into it anyway${kind === 'request' ? ', or use delivery:"headless"' : ''}.`);
      const others = sessions.filter((s) => !sameDir(s.cwd, cwd));
      const hint = others.length
        ? ` ${others.length} live session(s) are working elsewhere: ` +
          others.map((s) => `${s.name ?? idOf(s) ?? s.pid} in ${s.cwd ?? 'unknown'}`).join('; ') +
          '. Name one with peer:"<name>" if you meant it.'
        : ' Start one, or run "magi peers".';
      throw new BridgeError('NO_LIVE_PEER', `No live ${peer} session in ${cwd}.${hint}`);
    }
    if (stale) return { mode: 'headless', reason: 'NO_LIVE_PEER', detail: `${stale} saved ${peer} session(s) here have had no turn in the last hour; using a fresh headless ${peer} instead` };
    return { mode: 'headless' };
  };
}

// `magi send`: text into a named live session from a script, outside any card
// (no ledger round, nothing owed back). The target is found exactly as
// `peer:` finds it for a note, and delivered and confirmed by the adapter's
// own live path. A script has no permission class, so none is asserted:
// Claude's inbox gate then lets a prompting-class receiver (default, auto,
// acceptEdits, plan) take it and holds it at a bypass receiver for its user
// (docs/transport-recon.md, "The inbound gate"). Claiming a class to get past
// that gate is what the envelope must never do.
export async function sendLive(adapter, { to, text, name = 'magi send' }) {
  if (!to) throw new BridgeError('BAD_REQUEST', 'Name the session to send to with --to <name | session id | pid>; `magi peers` lists them.');
  if (!String(text ?? '').trim()) throw new BridgeError('BAD_REQUEST', 'Nothing to send: pass --text <text> or --file <path> with some text in it.');
  const decision = await makePickDelivery(adapter)({ delivery: 'live', target: to, cwd: process.cwd(), kind: 'note' });
  const sender = { agent: 'script', name, id: null };
  const used = await adapter.deliverLive({ text, target: decision.target, sender, delivery: 'live' });
  const t = decision.target;
  return {
    agent: adapter.peer,
    to: { name: t.name ?? null, sessionId: t.sessionId ?? t.id ?? null, pid: t.pid ?? null, cwd: t.cwd ?? null },
    via: used.via,
    messageId: used.messageId ?? null,
    deliveryStatus: used.deliveryStatus ?? 'unconfirmed',
    statusText: used.statusText ?? null,
    ...(decision.warning ? { warning: decision.warning } : {}),
  };
}

// Hosts whose replies already land at the next step boundary: no steer channel.
const NO_STEER_HOSTS = new Set(['claude']);

// Combined adapters share one server process and one background allowance.
let backgroundRuns = 0;
function deliverHeadless(adapter, options) {
  // The files a request carries reach the worker's machine inside the
  // admitted run, so the cap below still refuses before anything starts.
  const run = () => (options.files?.length
    ? filesFor(options.host, options.files).then((block) => runHeadless(adapter, { ...options, text: options.text + block }))
    : runHeadless(adapter, options));
  if (!options.background) return run();
  const cap = Number(process.env.MAGI_MAX_BACKGROUND ?? 4);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new BridgeError('BAD_CONFIG', 'MAGI_MAX_BACKGROUND must be a positive integer. Set it to 4 and restart the Magi server.');
  }
  if (backgroundRuns >= cap) {
    throw new BridgeError('BACKGROUND_LIMIT', `This server already has ${cap} background headless runs. Wait for one to finish, use wait:true, or raise MAGI_MAX_BACKGROUND and restart the harness.`);
  }
  backgroundRuns++;
  return run().finally(() => { backgroundRuns--; });
}

// The shape transcriptTail reads, from a session as the adapter lists it.
function transcriptRow(adapter, s) {
  return { harness: adapter.peer, id: idOf(s), cwd: s.cwd, transcript: s.transcript ?? null, sessionFile: s.sessionFile ?? null };
}

/**
 * The adapter's live sessions as kind:"peers" lists them: those in `cwd`
 * first (all of them when none is there, or when `cwd` is unset), each with
 * what it last said, its state and how to reach it.
 */
export async function listPeerRows(adapter, { cwd } = {}) {
  const peer = adapter.peer;
  const live = await observeProvider(peer, () => discoverSessions(adapter, { cwd }));
  const here = cwd ? live.filter((s) => sameDir(s.cwd, cwd)) : [];
  const rows = await Promise.all((here.length ? here : live).map(async (s) => ({
    name: s.name ?? idOf(s) ?? String(s.pid),
    // What it last said, so a peer can see where a colleague is
    // before asking; read from the transcript, never sent by it.
    saying: await lastSaid(transcriptRow(adapter, s)).catch(() => null),
    id: idOf(s),
    cwd: s.cwd,
    purpose: s.purpose ?? adapter.purpose?.(s) ?? null,
    branch: s.branch ?? null,
    lastActive: s.lastActive ?? null,
    ...peerState(s),
    stateText: describeState(peerState(s)),
    kind: s.kind ?? null,
    detail: s.remote ? 'remote (cloud) session: visible, not messageable' : here.length ? (s.pid != null ? `pid=${s.pid}` : null) : cwd ? `${s.pid != null ? `pid=${s.pid} ` : ''}(different directory; name it explicitly to use it)` : null,
  })));
  if (cwd && !here.length && rows.length) rows.note = `None are working in ${cwd}.`;
  return rows;
}

// The mirror the far end keeps of a card relayed to a live session there
// (state.mjs mirrorRound): who asks whom, which round, and the origin as that
// machine addresses this one.
function mirrorOf(taskId, round) {
  const card = readTask(taskId);
  if (!card) return null;
  const o = card.orchestratorTarget ?? {};
  return {
    taskId, round, orchestrator: card.orchestrator, peer: card.peer, mode: card.mode, maxRounds: card.maxRounds,
    task: card.rounds.find((r) => r.round === round)?.brief ?? null,
    orchestratorTarget: { agent: card.orchestrator, remote: localAddress(), name: o.name ?? null, id: o.id ?? o.sessionId ?? null, machine: hostname() },
  };
}

// The FILES block for a worker on this machine, or on `host` once the files
// have crossed to it, naming that machine's copies.
async function filesFor(host, files) {
  if (!files?.length) return '';
  if (!host) return filesBlock(files);
  const paths = await pushFiles(host, files);
  return filesBlock(files, (sha) => paths[sha]);
}

// A remote's receipt says how it went there; `via` says it went by relay.
const relayed = (host, used) => ({ ...used, via: `relay:${host}${used?.via ? `:${used.via}` : ''}` });
// A card traffic event for an orchestrator on another machine, filed in this
// machine's outbox for its relay (src/relay.mjs).
const queued = (to, event) => {
  queueRelayEvent({ to, ...event });
  return { via: 'relay', deliveryStatus: 'queued_unread', statusText: 'Filed for the orchestrator on another machine; its relay carries it there.' };
};

/**
 * One harness's engine on this server. `self` and `resolveOrigin` replace the
 * identity and the caller lookup, for the engine that replays a relayed
 * worker's reply, question or note on this side (applyRelayEvent).
 */
export function makeServerEngine(adapter, { self: selfOverride, resolveOrigin: originOverride } = {}) {
  const self = selfOverride ?? selfName(adapter.selfDefault, adapter.peer);
  const peer = adapter.peer;
  const pickDelivery = makePickDelivery(adapter);

  return {
    self,
    engine: makeEngine({
      orchestrator: self,
      peerName: peer,
      replyTool: adapter.replyTool(self),
      resolveOrigin: originOverride ?? ((args) => resolveOrigin(self, args)),
      // What this host cannot do is an adapter-layer fact, so the engine only asks.
      refuseRequest: (a) => (a.steerReply && NO_STEER_HOSTS.has(self)
        ? new BridgeError('STEER_UNSUPPORTED', 'A Claude session has no steer channel; its replies already land at the next step boundary. Omit steerReply.')
        : null),

      // A remote's sessions are listed there, over its relay, named with their host.
      async listPeers({ cwd, host }) {
        if (!host) return listPeerRows(adapter, { cwd });
        // The far end lists names and state only; what a session said or was
        // first asked stays on its machine.
        const rows = await relayCall(host, 'peers', { harness: peer });
        return rows.map((r) => ({ ...r, host, detail: `on ${host}${r.detail ? `; ${r.detail}` : ''}; name it with peer and host` }));
      },

      transcript: (session, { limit }) => transcriptTail(transcriptRow(adapter, session), { limit }),
      compactionAt: (session, cursor) => compactionAt(transcriptRow(adapter, session), cursor),
      transcriptPosition: (session) => transcriptPosition(transcriptRow(adapter, session)),

      // A live session on another machine is found there and recorded with its host.
      pickDelivery: async (args) => {
        if (!args.host) return observeProvider(peer, () => pickDelivery(args));
        const picked = await relayCall(args.host, 'pick', { harness: peer, target: args.target, kind: args.kind });
        return { mode: 'live', target: { ...picked.target, host: args.host }, ...(picked.warning ? { warning: picked.warning } : {}) };
      },
      async resolveClarifyTarget({ target }) {
        // The far end resolves a remote worker when it delivers; an
        // orchestrator on another machine is reached through the outbox.
        if (target?.host || target?.remote) return target;
        const sessions = await observeProvider(peer, () => discoverSessions(adapter, { includeHelpers: true }));
        const matches = sessions.filter((session) => typeof target === 'string'
          ? idOf(session) === target || session.sessionAliases?.includes(target)
          : sameSession(target && { agent: peer, ...target }, { agent: peer, ...session }) === true);
        if (matches.length !== 1) {
          throw new BridgeError(matches.length ? 'AMBIGUOUS_PEER' : 'NO_LIVE_PEER', `The recorded ${peer} worker has ${matches.length} current routes. Check its session id and magi peers; do not substitute another worker.`);
        }
        return remoteRefused(matches[0], peer);
      },

      async clarifyDelivery({ target, cwd }) {
        // Automatic clarification stays queued across machines. Only an explicit
        // Codex steer chooses the remote daemon and its no-fallback contract.
        if (target?.host || target?.remote) return 'live';
        if (!adapter.schema.deliveries.includes('steer')) return 'live';
        const sessions = await observeProvider(peer, () => discoverSessions(adapter, { cwd: target ? undefined : cwd, includeHelpers: true }));
        const address = typeof target === 'object' && target !== null ? idOf(target) ?? target.name ?? String(target.pid) : target;
        const session = pickSession(sessions, address, cwd, peer);
        return session && peerState(session).state === 'working' ? 'steer' : 'live';
      },

      // The adapter's own reviewer, when it has one (omp's advisor).
      advisor: adapter.advisor,

      deliverLive: async (o) => {
        // From a worker here to its orchestrator on another machine, before
        // anything else: that route is the outbox, whatever else the target names.
        if (o.target?.remote) return queued(o.target.remote, { action: o.kind === 'note' ? 'note' : o.kind ?? 'note', taskId: o.taskId, round: o.round ?? null, body: o.args?.body ?? null, files: fileMeta(o.files) });
        // To a worker on another machine: the request mirrors the card there first.
        if (o.target?.host) {
          await pushFiles(o.target.host, o.files);
          const used = await relayCall(o.target.host, 'deliver', {
            harness: peer, kind: o.kind ?? 'request', text: o.text, target: o.target, taskId: o.taskId ?? null, round: o.round ?? null,
            mirror: o.kind ? null : mirrorOf(o.taskId, o.round), sender: o.sender ?? null, delivery: o.delivery,
            files: fileMeta(o.files),
          });
          return relayed(o.target.host, used);
        }
        // A session here reads the copies here.
        return observeProvider(peer, () => adapter.deliverLive({ ...o, text: o.text + filesBlock(o.files) }));
      },
      deliverHeadless: (o) => deliverHeadless(adapter, o),
      // Only a peer held on a channel can take a note while it works.
      deliverHeadlessNote: adapter.headless?.channel
        ? async (o) => deliverHeadlessNote({ ...o, text: o.text + await filesFor(readTask(o.taskId)?.peerTarget?.host, o.files) })
        : undefined,
      // A stop reaches the worker's process, so it needs the same held channel.
      stopHeadless: adapter.headless?.channel ? (o) => stopHeadlessWorker(o) : undefined,
      spawn: (o) => observeProvider(peer, () => spawnPeer({ harness: peer, sessions: adapter.sessions, ...o })),
      // A reply or question from a worker here, for an orchestrator here or elsewhere.
      deliverReply: (o) => deliverWorkerMessage(o, adapter.deliverReply ?? (({ text, task, sender, delivery }) => deliverReplyToOrigin({ text, task, sender, steer: delivery === 'steer' }))),
    }),
  };
}

// The adapter records, loaded when a relayed event needs the orchestrator's.
const adapterModules = { claude: './claude-adapter.mjs', codex: './codex-adapter.mjs', omp: './omp-adapter.mjs' };

/**
 * A reply, question or note a worker on another machine sent through its own
 * Magi tool, replayed here on the card's worker side, so this ledger takes the
 * same transition and the orchestrator hears it by the same route a local
 * worker's tool call would take. The caller is the worker the card recorded
 * for that round: the far end verified it, and ssh is the boundary.
 */
export async function applyRelayEvent(ev, host) {
  const terminal = (e) => Object.assign(e, { terminal: true });
  // Whose event it is comes first, before any claim is touched: a card not
  // here is dropped there, and an event for another name of that machine is
  // left for its own relay.
  const card = readTask(ev.taskId);
  if (!card) throw terminal(new BridgeError('UNKNOWN_TASK', `No card ${ev.taskId} here for an event from ${host}; it was dropped.`));
  const round = ev.round ?? card.rounds.at(-1)?.round ?? 1;
  const entry = card.rounds.find((r) => r.round === round);
  if (!entry) throw terminal(new BridgeError('BAD_ROUND', `No round ${round} on ${ev.taskId}; this event was dropped.`));
  const worker = Object.hasOwn(entry, 'peerTarget') ? entry.peerTarget : card.peerTarget;
  if (!worker?.host || worker.host !== host) throw new BridgeError('ROLE_VIOLATION', `Card ${ev.taskId}'s round ${round} worker is not on ${host}; its event is left for that machine's relay.`);
  if (!ev.worker || sameSession({ agent: card.peer, ...worker }, { agent: card.peer, ...ev.worker }) !== true) {
    throw terminal(new BridgeError('ROLE_VIOLATION', `Event ${ev.id ?? '(unidentified)'} for ${ev.taskId} round ${round} names a different or unknown worker; it was dropped, not attributed to this round's worker. Inspect both ledgers before retrying.`));
  }

  // Applying is claimed before it starts and recorded when it ends, under the
  // state lock, by a token of this call: a claim held by a live call, in
  // another server or in this one, is busy; only its own call finishes or
  // gives it back. A call holds its claim by a lease it renews while it runs,
  // and by its process (pid and birth time, so a reused pid holds nothing):
  // a claim whose lease ran out, or whose process died, is taken over, so a
  // call that ended without writing its end (the ledger busy past every
  // retry) blocks the event for one lease, not for the life of its server.
  // A lapsed lease does not prove its call ended (it may only be stalled), so
  // what is applied again must stand two attempts: a reply or a question is
  // idempotent in the ledger, and a note (which this claim alone owns here;
  // it takes no note reservation) may arrive twice rather
  // than not at all (notes across machines are at least once).
  const token = randomUUID();
  const mine = { state: 'applying', token, pid: process.pid, startedAt: ownProcessStartedAt(), at: Date.now(), leaseUntil: Date.now() + relayLeaseMs(), taskId: ev.taskId, action: ev.action };
  const busy = () => new BridgeError('RELAY_EVENT_BUSY', `Event ${ev.id} for ${ev.taskId} is being applied here already; it is offered again once that is done.`);
  if (ev.id) {
    const seen = getRecord(magiHome(), 'relay-applied', ev.id);
    if (seen && seen.state !== 'applying') return { duplicate: true };
    // Liveness is read outside the lock (a birth time can take a process spawn on Windows).
    if (seen && await ownerAlive(seen)) throw busy();
    const claim = withStateLock('relay-applied', () => {
      const rec = getRecord(magiHome(), 'relay-applied', ev.id);
      if (rec && rec.state !== 'applying') return 'done';
      // Taken over only as it was seen: the same token and the same lease. A
      // renewal in between (its call was slow, not gone) keeps it.
      if (rec && (rec.token !== seen?.token || rec.leaseUntil !== seen?.leaseUntil)) return 'theirs';
      setRecord(magiHome(), 'relay-applied', ev.id, mine);
      return 'mine';
    });
    if (claim === 'done') return { duplicate: true };
    if (claim === 'theirs') throw busy();
  }
  // Writes to this call's own claim, retried while the ledger is busy.
  const ours = async (fn) => {
    if (!ev.id) return;
    await retryState(() => withStateLock('relay-applied', () => {
      const rec = getRecord(magiHome(), 'relay-applied', ev.id);
      if (rec?.token === token) fn(rec);
    }), RELAY_CLEANUP_RETRY_MS);
  };
  const renew = ev.id ? setInterval(() => {
    ours((rec) => setRecord(magiHome(), 'relay-applied', ev.id, { ...rec, leaseUntil: Date.now() + relayLeaseMs() })).catch(() => { /* the next renewal tries again */ });
  }, relayLeaseMs() / 4) : null;
  renew?.unref();
  // An end that could not be written leaves the claim to lapse with its lease.
  const finish = async (state) => {
    clearInterval(renew);
    await ours(() => setRecord(magiHome(), 'relay-applied', ev.id, { state, at: Date.now(), taskId: ev.taskId, action: ev.action }));
  };
  const giveBack = async (e) => {
    clearInterval(renew);
    try { await ours(() => removeRecord(magiHome(), 'relay-applied', ev.id)); } catch { /* lapses with its lease */ }
    return e;
  };
  let res;
  try {
    const { adapter } = await import(adapterModules[card.orchestrator] ?? `./${card.orchestrator}-adapter.mjs`);
    const target = { ...worker, ...ev.worker, agent: card.peer, identityVerified: true, identitySource: 'ssh_relay' };
    const { engine } = makeServerEngine(adapter, { self: card.peer, resolveOrigin: async () => ({ target, replyTo: null, identityVerified: true, identitySource: 'ssh_relay' }) });
    // Its files cross first, checked by hash, so the message names copies
    // here. With files off here they are left there and the message still
    // lands, saying so: the reply matters more than its attachments.
    let files = ev.files ?? [];
    let body = ev.body ?? '';
    if (files.length && !filesEnabled()) {
      body += `\n\n(${files.length} file${files.length === 1 ? '' : 's'} sent with this stayed on ${host}: receiving files is off on this machine. ${FILES_OFF_HINT})`;
      files = [];
    }
    try { await pullFiles(host, files); }
    catch (e) {
      // Files were turned off, there or here, after this was filed: the
      // message still lands, without them.
      if (e.code !== 'FILES_OFF') throw e;
      const where = /^On remote /.test(e.message) ? 'sending files is off there now' : 'receiving files is off on this machine now';
      body += `\n\n(${files.length} file${files.length === 1 ? '' : 's'} sent with this stayed on ${host}: ${where}.)`;
      files = [];
    }
    const args = { taskId: ev.taskId, round, body };
    // The question keeps the id it has there, so a repeat files nothing new;
    // a note is owned by this event's claim, not a note reservation.
    const ctx = { files, questionId: ev.questionId ?? null, relayEventId: ev.id ?? null };
    res = ev.action === 'reply' ? await engine.handleReply(args, ctx)
      : ev.action === 'clarify' ? await engine.handleClarify(args, ctx)
        : await engine.handleNote({ taskId: ev.taskId, body }, ctx);
  } catch (e) {
    throw await giveBack(e);
  }
  if (res.isError) {
    const text = res.content?.[0]?.text ?? '';
    const code = /\b([A-Z][A-Z_]{3,})\b/.exec(text)?.[1] ?? 'REFUSED';
    const disposition = relayDisposition(ev, code);
    if (disposition === 'retry') throw await giveBack(new BridgeError('RELAY_EVENT_RETRY', `${code}: ${text.slice(0, 300)}`));
    if (disposition === 'refused') { await finish('refused'); throw terminal(new BridgeError('RELAY_EVENT_REFUSED', text.slice(0, 400))); }
  }
  // If this write fails the event is not acked: it is offered again, taken
  // over once the lease lapses, and the ledger refuses it as already applied.
  await finish('applied');
  return res;
}

// How long a claim on a relayed event holds without its call renewing it,
// and how long that call keeps retrying the write of its end.
// The variable is for the tests.
const relayLeaseMs = () => Number(process.env.MAGI_RELAY_LEASE_MS) || 120000;
const RELAY_CLEANUP_RETRY_MS = 5000;

// The call that claimed an event still holds it: its lease is current, and
// its process is still running (the same pid, born at the same time, when
// its birth time was recorded and can be read now).
async function ownerAlive(rec) {
  if (rec?.leaseUntil != null && Date.now() > rec.leaseUntil) return false;
  if (!Number.isInteger(rec?.pid) || rec.pid <= 0) return false;
  try { process.kill(rec.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
  if (rec.startedAt == null) return true;
  if (rec.pid === process.pid) return rec.startedAt === ownProcessStartedAt();
  const now = await processStartedAtAsync(rec.pid);
  return now == null || now === rec.startedAt;
}

// What an engine's refusal of a relayed event means, by its code and what the
// event carries: done (the ledger has it, or it was already done), retry (it
// may land later), or refused (the event itself is wrong; dropped).
// - A reply or question whose orchestrator is away is in the ledger and the
//   mailbox here, so it is done; a note has no mailbox, so it is tried again
//   while its card could still use it (eight hours), then dropped.
// - A busy ledger, a failed delivery or a rate limit is tried again.
const RETRY_FOR_HOURS = 8;
function relayDisposition(ev, code) {
  if (code === 'ALREADY_REPLIED' || code === 'NOTE_DUPLICATE') return 'done';
  if (['LEDGER_BUSY', 'STATE_FAILED', 'DELIVERY_FAILED', 'NOTE_RATE_LIMIT'].includes(code)) return 'retry';
  if (['NO_REPLY_ROUTE', 'NO_LIVE_PEER', 'AMBIGUOUS_PEER'].includes(code)) {
    if (ev.action !== 'note') return 'done';
    return Date.now() - (ev.at ?? Date.now()) < RETRY_FOR_HOURS * 3600 * 1000 ? 'retry' : 'refused';
  }
  return 'refused';
}

// One tool on a server. Each adapter keeps its own engine and closures; what a
// combined server shares is only the process and the stdio transport.
function registerPeer(server, adapter) {
  const { self, engine } = makeServerEngine(adapter);

  server.registerTool(
    adapter.tool,
    {
      title: `Consult ${adapter.display} as an independent peer`,
      description: peerToolDescription(adapter.display),
      // Strict: an unknown field (verdict: on an outcome) was silently dropped
      // and recorded as zero findings. Rejecting it names the field instead.
      inputSchema: z.object(peerInputSchema(adapter.schema)).strict(),
    },
    async (a, extra) => {
      const progress = makeProgress(extra);
      try {
        // Only admission is gated. Completion and reconciliation stay reachable.
        if (['request', 'spawn'].includes(a.kind ?? 'request')) requireProvider(adapter.peer);
        // Codex names its calling thread in request metadata; any other
        // harness is identified by the registry entry for the parent process.
        const caller = self === 'codex' ? codexCaller(extra?._meta) : { threadId: null, keys: [], source: 'unknown' };
        traceCodexCaller(caller, a.kind);
        const ctx = { progress, meta: extra?._meta, signal: extra?.signal };
        switch (a.kind) {
          case 'peers': return await engine.handlePeers(a, ctx);
          case 'transcript': return await engine.handleTranscript(a, ctx);
          case 'outcome': return await engine.handleOutcome(a, ctx);
          case 'close': return await engine.handleClose(a, ctx);
          case 'note': return await engine.handleNote(a, ctx);
          case 'notify': return await engine.handleNotify(a, ctx);
          case 'spawn': return await engine.handleSpawn(a, ctx);
          case 'remember': return await engine.handleRemember(a, ctx);
          case 'recall': return await engine.handleRecall(a, ctx);
          case 'forget': return await engine.handleForget(a, ctx);
          case 'reply': return await engine.handleReply(a, ctx);
          case 'clarify': return await engine.handleClarify(a, ctx);
          case 'clarify_answer': return await engine.handleClarifyAnswer(a, ctx);
          default:
            if (!a.task) return toolError(new BridgeError('BAD_REQUEST', 'A request needs "task".'));
            return await engine.handleRequest(a, ctx);
        }
      } catch (e) {
        recordProviderFailure(adapter.peer, e);
        return toolError(e);
      }
    },
  );
  return self;
}

/**
 * How the workers of these open cards on `host` stand, as that machine sees
 * them (the relay's `state`: live, state, what it waits on; never words),
 * kept per card in the ledger for `magi status` (`remote-state`, by task id).
 * Each answer is dated when it was asked for, and one asked for earlier than
 * what is recorded is dropped, so a slow answer never overwrites a newer one,
 * whichever server here asked.
 */
export async function refreshRemoteState(host, taskIds) {
  // Every card, in batches the far end answers whole: none is left unseen
  // because it fell past one call's limit.
  for (let i = 0; i < (taskIds?.length ?? 0); i += STATE_BATCH) await refreshBatch(host, taskIds.slice(i, i + STATE_BATCH));
}

async function refreshBatch(host, taskIds) {
  const askedAt = Date.now();
  const rows = await relayCall(host, 'state', { tasks: taskIds });
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.taskId !== 'string' || !taskIds.includes(row.taskId)) continue;
    withStateLock('remote-state', () => {
      // Kept only while it describes the card's current round on this host:
      // a late answer about a round, or a machine, the card has left behind
      // never replaces what is known about the one it is on.
      const card = readTask(row.taskId);
      const current = card?.rounds.at(-1);
      const worker = current && Object.hasOwn(current, 'peerTarget') ? current.peerTarget : card?.peerTarget;
      if (!current || current.round !== row.round || worker?.host !== host) return;
      const had = getRecord(magiHome(), 'remote-state', row.taskId);
      if (had && had.round === row.round && had.host === host && had.observedAt >= askedAt) return;
      setRecord(magiHome(), 'remote-state', row.taskId, {
        host, observedAt: askedAt, round: Number.isInteger(row.round) ? row.round : null, live: row.live === true,
        state: typeof row.state === 'string' ? row.state : 'unknown', waitingFor: typeof row.waitingFor === 'string' ? row.waitingFor.slice(0, 80) : null,
      });
    });
  }
}

// One process, one stdio transport, one tool per adapter. A harness session
// used to start a server per peer (~60 MB of Node plus the MCP SDK each);
// `magi serve codex omp --as claude` serves both from one. Every adapter
// shares MAGI_AS, so a combined server has exactly one identity.
export async function serve(...adapters) {
  const peers = adapters.map((a) => a.peer);
  if (new Set(peers).size !== peers.length) throw new BridgeError('BAD_REQUEST', `serve was given the same peer twice (${peers.join(', ')}). Remove the repeat from the serve arguments and restart the server.`);
  // A launch wrapper that cannot run is refused before any worker could start
  // outside the containment its operator meant it to have.
  workerWrapper();
  const server = new McpServer({ name: adapters.length > 1 ? 'magi' : `magi-${peers[0]}`, version: '0.1.0' });
  const selves = new Set(adapters.map((a) => selfName(a.selfDefault, a.peer)));
  const providers = getProviders();
  const active = adapters.filter((adapter) => providers[adapter.peer].enabled);
  for (const adapter of active) registerPeer(server, adapter);
  if (!active.length) {
    // The SDK only installs tools/list when its first tool is registered.
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.server.setRequestHandler(CallToolRequestSchema, async () => toolError(new BridgeError('PROVIDER_DISABLED', `No configured provider is enabled. Run "magi provider enable ${peers[0]}" and restart the harness.`)));
  }
  // One process speaks for one harness; defaults that disagree mean --as was missing.
  if (selves.size > 1) throw new BridgeError('BAD_REQUEST', `A combined server needs one identity; got ${[...selves].join(' and ')}. Pass --as <the harness that loads it>.`);

  // Hygiene never blocks startup: an unreadable state dir is someone else's error.
  try { sweep(); } catch { /* next start tries again */ }
  // A live worker on another machine answers through a relay this process
  // holds. Cards still open from before a restart get theirs back, so what
  // waited in that machine's outbox arrives now.
  setRelayEventHandler(applyRelayEvent);
  // Kept open, and reopened when one ends, for every machine a card of this
  // server's may still hear from: a round unanswered in the last eight hours,
  // closed or not, since a late answer is still filed. Each round names its
  // own worker, so a card moved between machines is heard from on each.
  // Each pass also brings back how the workers of cards still open there
  // stand (not closed ones: a closed card's late answer still lands, but
  // nobody watches its worker), for `magi status` to read from the ledger;
  // status never asks over ssh itself.
  const keepRelays = () => {
    try {
      const since = Date.now() - 8 * 3600 * 1000;
      const hosts = new Map(); // host -> task ids whose open round's worker is there
      for (const t of listTasks()) {
        if (![...selves].includes(t.orchestrator)) continue;
        for (const r of t.rounds) {
          const worker = Object.hasOwn(r, 'peerTarget') ? r.peerTarget : t.peerTarget;
          if (worker?.host && !worker.headless && !r.replied && (r.openedAt ?? 0) > since) {
            if (!hosts.has(worker.host)) hosts.set(worker.host, new Set());
            if (!r.closedAt && r === t.rounds.at(-1)) hosts.get(worker.host).add(t.taskId);
          }
        }
      }
      for (const [host, taskIds] of hosts) {
        relayTo(host).ready
          .then(() => refreshRemoteState(host, [...taskIds]))
          .catch(() => { /* the next pass tries again */ });
      }
    } catch { /* the next pass tries again */ }
  };
  setTimeout(keepRelays, 3000).unref();
  setInterval(keepRelays, 30000).unref();
  // After the handshake, never in front of it: the pass reads every task.
  setTimeout(() => { try { autoReconcile(); } catch { /* next request tries again */ } }, 5000).unref();

  // Stdio closure is the owner's death, not permission to orphan delegates.
  // Ctrl+C and a closed console end the server the same way: a signal's
  // default action would skip the 'exit' hook that kills its workers.
  const shutdown = () => process.exit(0);
  process.once('exit', killTrackedChildren);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) process.once(signal, shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);

  await server.connect(new StdioServerTransport());
  console.error(`[magi] ${peers.join('+')} peer server ready (serving ${[...selves].join('+')})`);
}
