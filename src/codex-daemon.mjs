// A client of a machine's shared Codex app-server daemon, over
// src/ws-stream.mjs (docs/evidence/codex-app-server-r2-2026-10-17.md): find a
// thread by id or exact name, list what the daemon has loaded, read a
// thread's active turn, add to its queue, and steer a running turn. Its one
// hard rule: the daemon is shared, and a thread created after this client
// connects attaches it, so requests the daemon sends (an approval, a user
// input, an elicitation) belong to whichever client owns that thread. They
// are counted and never answered, not even with an error, which the daemon
// would take as a denial. Written by an omp peer and
// checked here.
import { randomUUID } from 'node:crypto';
import { openWebSocket } from './ws-stream.mjs';

const DELTA_OPT_OUTS = [
  'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
  'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta',
];
const MUTATIONS = new Set(['thread/queue/add', 'turn/steer']);

class DaemonError extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`);
    this.name = 'DaemonError';
    this.code = code;
    this.dispatchUncertain = false;
    Object.assign(this, detail);
  }
}

const failure = (code, message, detail) => new DaemonError(code, message, detail);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireString = (value, label) => {
  if (typeof value !== 'string' || !value) throw failure('BAD_REQUEST', `Provide a nonempty ${label}; nothing was sent.`);
};

function rpcFailure(method, value) {
  let code = 'DAEMON_RPC';
  let next = 'Check the daemon version and request before trying again.';
  if (value.code === -32600) {
    if (value.message === 'no active turn to steer') {
      code = 'NO_ACTIVE_TURN';
      next = 'Read the thread status; explicitly choose whether to wait or queue a new turn. Nothing was queued automatically.';
    } else if (/^expected active turn id `.*` but found `.*`$/.test(value.message)) {
      code = 'TURN_MISMATCH';
      next = 'Read the current turn and explicitly decide whether to steer it; the client will not refresh or resend.';
    } else if (/^thread (?:not found|not loaded): /.test(value.message)) {
      code = 'THREAD_NOT_LOADED';
      next = 'Check loadedIds() and use the daemon that owns the thread; do not resume it merely to observe it.';
    } else if (method === 'turn/steer' && /^cannot steer a (?:review|compact) turn$/.test(value.message)) {
      code = 'TURN_NOT_STEERABLE';
      next = 'Send a queued note instead; this turn cannot be steered and nothing was submitted.';
    } else if (value.message === 'expectedTurnId must not be empty') {
      code = 'BAD_REQUEST';
      next = 'Read the active turn id and provide it explicitly; nothing was queued automatically.';
    }
  }
  // An internal error can follow persistence; only known refusals prove no dispatch.
  const dispatchUncertain = MUTATIONS.has(method) && code === 'DAEMON_RPC';
  if (dispatchUncertain) next = 'Inspect the queue or thread history before retrying; the error may follow persistence.';
  return failure(code, `${method}: ${value.message}. ${next}`, {
    method, rpcCode: value.code, dispatchUncertain, ...(Object.hasOwn(value, 'data') ? { data: value.data } : {}),
  });
}

// This is an observer of other clients' threads, never their approval/tool/auth handler.
// Closing owns the byte streams. A successful mutation response is acceptance, not consumption.
export async function openCodexDaemon({ readable, writable, clientVersion, timeoutMs = 30_000 } = {}) {
  requireString(clientVersion, 'clientVersion');
  if (!writable || typeof writable !== 'object') throw failure('BAD_REQUEST', 'Provide the proxy readable and writable streams.');
  const outgoing = [];
  // send() resolves after the write callback. Observe the actual write attempt so an
  // EOF before that callback is uncertain, but a still-queued mutation is not.
  const observedWritable = new Proxy(writable, {
    get(target, property) {
      if (property === 'write') return (bytes, ...args) => {
        if (Buffer.isBuffer(bytes) && (bytes[0] & 15) === 1) {
          const entry = outgoing.shift();
          if (entry) entry.written = true;
        }
        return target.write(bytes, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const ws = await openWebSocket({ readable: readable === writable ? observedWritable : readable, writable: observedWritable, timeoutMs });
  const pending = new Map();
  const outstanding = new Set();
  const notificationListeners = new Set();
  const closeListeners = new Set();
  const notifications = [];
  const requestMethods = new Map();
  let notificationBytes = 0;
  let unansweredCount = 0;
  let nextId = 0;
  let closed = null;
  let detachMessage = () => {};
  let detachClose = () => {};

  function settle(entry, cause, value) {
    if (!outstanding.delete(entry)) return;
    clearTimeout(entry.timer);
    if (entry.id !== undefined) pending.delete(entry.id);
    if (cause) entry.reject(cause);
    else entry.resolve(value);
  }

  function stop(cause) {
    if (closed) return;
    closed = failure('DAEMON_CLOSED', `The daemon connection ended: ${cause.message}. Reconnect and inspect written mutations before retrying.`, { cause });
    for (const entry of outstanding) {
      settle(entry, failure('DAEMON_CLOSED', `${entry.method} lost its connection. Reconnect; inspect any uncertain mutation before retrying.`, {
        cause, method: entry.method, dispatchUncertain: entry.mutating && entry.written,
      }));
    }
    outgoing.length = 0;
    detachMessage();
    detachClose();
    for (const listener of closeListeners) queueMicrotask(() => listener(closed));
    closeListeners.clear();
    notificationListeners.clear();
    ws.close();
  }

  function badResult(method, mutating = false) {
    return failure('DAEMON_PROTOCOL', `${method} returned an invalid result. Check the pinned daemon schema; inspect mutations before retrying.`, { method, dispatchUncertain: mutating });
  }

  function receive(text) {
    let message;
    try { message = JSON.parse(text); }
    catch { stop(failure('DAEMON_PROTOCOL', 'The daemon sent invalid JSON. Check the proxy and daemon version.')); return; }
    if (!isObject(message)) { stop(failure('DAEMON_PROTOCOL', 'The daemon sent a non-object message. Check the proxy endpoint.')); return; }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        // An error reply would consume the shared approval callback too. Abstention
        // means sending no frame at all; retain no tool/auth/approval payload.
        unansweredCount++;
        requestMethods.set(message.method, (requestMethods.get(message.method) ?? 0) + 1);
      } else if (notificationListeners.size) {
        for (const listener of notificationListeners) listener(message);
      } else {
        const bytes = Buffer.byteLength(text);
        if (notifications.length >= 1024 || notificationBytes + bytes > 64 * 1024 * 1024) {
          stop(failure('DAEMON_NOTIFICATION_BACKLOG', 'Notifications arrived without a reader. Register onNotification immediately after opening.'));
          return;
        }
        notifications.push(message);
        notificationBytes += bytes;
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && (!isObject(message.error) || typeof message.error.code !== 'number' || typeof message.error.message !== 'string'))) {
      stop(failure('DAEMON_PROTOCOL', 'The daemon sent an invalid RPC response. Check its schema; do not blindly resend mutations.'));
    } else {
      settle(entry, hasError ? rpcFailure(entry.method, message.error) : null, message.result);
    }
  }

  function transmit(method, params, notification = false) {
    if (closed) return Promise.reject(failure('DAEMON_CLOSED', 'The daemon connection is closed. Open a new connection before making a call.', { cause: closed }));
    const message = notification ? { method } : { id: ++nextId, method, params };
    return new Promise((resolve, reject) => {
      const entry = { id: message.id, method, mutating: MUTATIONS.has(method), written: false, resolve, reject, timer: null };
      outstanding.add(entry);
      if (!notification) pending.set(message.id, entry);
      entry.timer = setTimeout(() => {
        const cause = failure('DAEMON_TIMEOUT', `${method} got no completion within ${timeoutMs} ms. Reconnect; inspect any uncertain mutation before retrying.`, {
          method, dispatchUncertain: entry.mutating && entry.written,
        });
        settle(entry, cause);
        // A timed-out frame must not leave a hidden send waiting behind backpressure.
        stop(cause);
      }, timeoutMs);
      outgoing.push(entry);
      ws.send(JSON.stringify(message)).then(() => {
        if (notification) settle(entry, null);
      }, stop);
    });
  }

  async function rows(method, params) {
    const data = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await transmit(method, { ...params, ...(cursor ? { cursor } : {}) });
      if (!isObject(result) || !Array.isArray(result.data)) throw badResult(method);
      data.push(...result.data);
      if (result.nextCursor === null) return data;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw failure('PAGINATION_FAILED', `${method} did not finish pagination. Use an exact thread id or inspect the daemon; no partial selection is safe.`);
  }

  async function read(threadId, includeTurns) {
    requireString(threadId, 'thread id');
    const result = await transmit('thread/read', { threadId, includeTurns });
    if (!isObject(result?.thread) || result.thread.id !== threadId) throw badResult('thread/read');
    return result.thread;
  }

  const client = {
    async findThread({ id, name } = {}) {
      if (id !== undefined && name !== undefined) throw failure('BAD_REQUEST', 'Select a thread by either id or exact name, not both.');
      if (id !== undefined) return read(id, false);
      requireString(name, 'thread name');
      const found = await rows('thread/list', { limit: 100, archived: false, modelProviders: [], useStateDbOnly: true, searchTerm: name });
      if (found.some((thread) => !isObject(thread) || typeof thread.id !== 'string')) throw badResult('thread/list');
      const all = [...new Map(found.map((thread) => [thread.id, thread])).values()];
      const matches = all.filter((thread) => thread.name === name);
      if (matches.length === 1) return matches[0];
      const candidates = (matches.length ? matches : all).map((thread) => ({ id: thread.id, name: thread.name ?? null }));
      const labels = candidates.map((thread) => `${JSON.stringify(thread.name ?? '<unnamed>')} (${thread.id})`).join(', ') || '(none)';
      throw failure(matches.length ? 'AMBIGUOUS_THREAD' : 'THREAD_NOT_FOUND', `Exact name ${JSON.stringify(name)} matched ${matches.length} threads. Candidates: ${labels}. Use an exact thread id or choose a unique name.`, { candidates });
    },
    async loadedIds() {
      const ids = await rows('thread/loaded/list', { limit: 100 });
      if (ids.some((id) => typeof id !== 'string')) throw badResult('thread/loaded/list');
      return [...new Set(ids)];
    },
    async activeTurnId(threadId) {
      const thread = await read(threadId, true);
      if (!Array.isArray(thread.turns)) throw badResult('thread/read');
      const active = thread.turns.filter((turn) => turn?.status === 'inProgress');
      if (active.length > 1 || (active.length && typeof active[0].id !== 'string')) throw badResult('thread/read');
      return active[0]?.id ?? null;
    },
    async queueAdd(threadId, text, clientUserMessageId) {
      requireString(threadId, 'thread id');
      requireString(clientUserMessageId, 'clientUserMessageId');
      if (typeof text !== 'string') throw failure('BAD_REQUEST', 'Provide message text as a string; nothing was queued.');
      const result = await transmit('thread/queue/add', { threadId, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }] });
      const queued = result?.queuedSubmission;
      if (!isObject(queued) || typeof queued.id !== 'string' || queued.clientUserMessageId !== clientUserMessageId || !Array.isArray(queued.input)) throw badResult('thread/queue/add', true);
      return queued;
    },
    async steer(threadId, expectedTurnId, text, clientUserMessageId) {
      requireString(threadId, 'thread id');
      requireString(clientUserMessageId, 'clientUserMessageId');
      if (typeof expectedTurnId !== 'string' || typeof text !== 'string') throw failure('BAD_REQUEST', 'Provide the explicit expectedTurnId and message text as strings; nothing was steered.');
      const result = await transmit('turn/steer', { threadId, expectedTurnId, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }] });
      if (!isObject(result) || result.turnId !== expectedTurnId) throw badResult('turn/steer', true);
      return result;
    },
    onNotification(listener) {
      if (typeof listener !== 'function') throw failure('BAD_REQUEST', 'Provide an onNotification function.');
      if (!closed) notificationListeners.add(listener);
      const waiting = notifications.splice(0);
      notificationBytes = 0;
      for (const message of waiting) listener(message);
      return () => notificationListeners.delete(listener);
    },
    onClose(listener) {
      if (typeof listener !== 'function') throw failure('BAD_REQUEST', 'Provide an onClose function.');
      if (closed) queueMicrotask(() => listener(closed));
      else closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    unansweredRequests() { return { count: unansweredCount, methods: Object.fromEntries(requestMethods) }; },
    close() { stop(failure('DAEMON_CLOSED', 'The client closed this connection.')); },
  };
  detachClose = ws.onClose(stop);
  detachMessage = ws.onMessage(receive);
  try {
    const initialized = await transmit('initialize', {
      clientInfo: { name: 'magi', title: 'Magi', version: clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: DELTA_OPT_OUTS },
    });
    if (!isObject(initialized) || ['userAgent', 'codexHome', 'platformFamily', 'platformOs'].some((key) => typeof initialized[key] !== 'string')) throw badResult('initialize');
    await transmit('initialized', undefined, true);
    return client;
  } catch (cause) {
    stop(cause);
    throw cause;
  }
}

// Steer the running turn of a thread this daemon has loaded, named by id. The
// fresh clientUserMessageId is what the thread history records on the steered
// userMessage, so the caller can confirm receipt by it. Throws
// THREAD_NOT_LOADED when the daemon does not hold the thread and
// NO_ACTIVE_TURN when it is idle; neither sent anything.
export async function steerLoadedThread(daemon, threadId, text, beforeSend = () => {}) {
  if (typeof threadId !== 'string' || !threadId) throw failure('THREAD_NOT_LOADED', 'the card has no recorded Codex thread id.');
  const thread = await daemon.findThread({ id: threadId });
  if (thread.status?.type === 'notLoaded') throw failure('THREAD_NOT_LOADED', `thread ${threadId} is not loaded in this daemon.`);
  const turnId = await daemon.activeTurnId(threadId);
  if (!turnId) throw failure('NO_ACTIVE_TURN', `thread ${threadId} has no active turn to steer.`);
  await beforeSend();
  const clientId = randomUUID();
  const steered = await daemon.steer(threadId, turnId, text, clientId);
  return { threadId, turnId: steered.turnId, clientId };
}

// What a failed daemon steer tells the agent to do next.
export function adviseSteerFailure(e) {
  e.dispatchUncertain ??= false;
  e.message += e.dispatchUncertain
    ? ' Dispatch may have occurred; inspect the thread history and do not resend blindly.'
    : ' Send this as a note instead with delivery:"live"; nothing was queued automatically.';
  return e;
}
