// The fleet as the CLI reads it: every live session of every harness with
// its state (`magi peers`, `magi status`), and the ledger grouped into
// coordinator/worker channels (`magi channels`). Everything here is read from
// the ledger and the three harnesses' own records; nothing is polled from a
// model and nothing here writes. The human acts through the CLI.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STALE_OPEN_MS, expiredCovers, outcomeCovers, reconciliationOwed, listPersonas, magiHome, readExchange, sameSession, roundDeliveries } from './state.mjs';
import { peerState, describeState, isLive } from './serve.mjs';
import { claudeAppLink } from './transport.mjs';
import { adapter as codexAdapter } from './codex-adapter.mjs';
import { adapter as claudeAdapter } from './claude-adapter.mjs';
import { adapter as ompAdapter } from './omp-adapter.mjs';
import { getProviders, recordProviderFailure } from './providers.mjs';
import { redact } from './protocol.mjs';
import { confirmClaude, confirmCodex, confirmHeadlessNote, confirmOmp } from './delivery-confirm.mjs';
import { claudeDialogTimeout, claudeReceiptHint } from './claude-dialog.mjs';

export const HARNESSES = { claude: claudeAdapter, codex: codexAdapter, omp: ompAdapter };
const CODEX_CACHE_MS = 10_000;
export const CODEX_CACHE_MAX_ENTRIES = 24; // directories, keyed by home/cwd

// A Codex listing is cached briefly per scope and a failure becomes a field.
// Scoped to a directory, it is `thread/list` with that cwd, through an
// app-server spawned once per process: what `magi peers` and routing use.
// Scope 'all' is every interactive thread on the machine, read from Codex's
// databases with no app-server, which is what `magi status` counts; it asks
// thread/list for everything only when those cannot be read.
const codexCache = new Map();
async function codexSessions(cwd, scope) {
  const key = magiHome() + '|' + (scope === 'all' ? '*' : String(cwd ?? '').toLowerCase());
  const hit = codexCache.get(key);
  if (hit && Date.now() - hit.at < CODEX_CACHE_MS) {
    codexCache.delete(key);
    codexCache.set(key, hit);
    return hit.value;
  }
  let value;
  const observedAt = Date.now();
  try {
    const rows = scope === 'all'
      ? (await codexAdapter.presence()) ?? await codexAdapter.sessions({ strict: true })
      : await codexAdapter.sessions({ cwd, strict: true });
    value = { rows, error: null };
  } catch (e) {
    recordProviderFailure('codex', e, observedAt);
    value = { rows: [], error: e.code ?? e.message };
  }
  codexCache.delete(key);
  codexCache.set(key, { at: Date.now(), value });
  while (codexCache.size > CODEX_CACHE_MAX_ENTRIES) codexCache.delete(codexCache.keys().next().value);
  return value;
}

// "claude-opus-5" -> "opus-5", "openrouter/stealth/union-alpha" -> "union-alpha",
// "claude-haiku-4-5-20251001" -> "haiku-4-5": the part a human says, for a readout.
export function shortModel(m) {
  if (!m) return null;
  return String(m).split('/').pop().replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Codex's thread list carries no model; the CLI's configured default is
// what every thread runs unless the desktop picked another, which nothing
// on disk records. Read once per process.
let codexDefaultModel;
function codexModel() {
  if (codexDefaultModel !== undefined) return codexDefaultModel;
  try {
    codexDefaultModel = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf-8'))?.[1] ?? null;
  } catch {
    codexDefaultModel = null;
  }
  return codexDefaultModel;
}

const purposeOf = (harness, s) => s.purpose ?? HARNESSES[harness].purpose?.(s) ?? null;

// Stored targets and live sessions must use the same human-facing identity.
export function sessionLabel(session, fallback = '?') {
  if (typeof session === 'string') return session.trim() || fallback;
  const title = String(session?.purpose ?? '').split(/[:\n]/)[0].trim().slice(0, 48);
  return session?.name?.trim() || title || String(session?.id ?? session?.sessionId ?? session?.pid ?? '').slice(0, 8) || fallback;
}
function peerRow(harness, s) {
  const st = peerState(s);
  const purpose = purposeOf(harness, s);
  return {
    live: isLive(harness, st),
    harness,
    name: s.name ?? s.id ?? s.sessionId ?? String(s.pid ?? ''),
    id: s.id ?? s.sessionId ?? null,
    pid: s.pid ?? null,
    cwd: s.cwd ?? null,
    kind: s.kind ?? null,
    jobId: s.jobId ?? null,
    sessionFile: s.sessionFile ?? null, // omp: where its subagents' files sit
    transcript: s.transcript ?? null, // claude remote: its transcript, found by scan
    remote: s.remote ?? false,
    parent: s.parentThreadId ?? null, // codex: the thread that spawned this one
    recencyAt: s.recencyAt ?? null,
    nickname: s.agentNickname ?? null,
    role: s.agentRole ?? null,
    label: sessionLabel({ ...s, purpose }, harness),
    model: s.model ?? (harness === 'codex' ? codexModel() : null),
    modelShort: shortModel(s.model ?? (harness === 'codex' ? codexModel() : null)),
    // Where the session can be opened by hand: a Claude desktop session by
    // the app id its own records give it (Claude desktop 2.110), any Codex
    // thread in the Codex app (26.908). docs/transport-recon.md.
    appLink: harness === 'claude' ? claudeAppLink(s) : harness === 'codex' && s.id ? `codex://threads/${s.id}` : null,
    purpose,
    branch: s.branch ?? null,
    lastActive: s.lastActive ?? null,
    // When the harness last saw its state change; `magi status` reports it as
    // the activity time of a worker that has said nothing on its card.
    statusAt: typeof s.statusAt === 'number' && Number.isFinite(s.statusAt) ? s.statusAt : null,
    costUsd: s.costUsd ?? null,
    ...st,
    stateText: describeState(st),
  };
}

// Every live session of every harness, with its state, plus persistent peers.
// Claude and omp are listed machine-wide; Codex is listed for `cwd` unless
// `codexScope` is 'all'.
export async function listFleet({ cwd, codexScope = 'cwd' } = {}) {
  const enabled = Object.fromEntries(Object.entries(getProviders()).filter(([, p]) => p.enabled));
  const results = await Promise.all(Object.keys(enabled).map(async (name) => {
    const observedAt = Date.now();
    try {
      const value = name === 'codex' ? await codexSessions(cwd, codexScope) : { rows: await HARNESSES[name].sessions({}), error: null };
      return { name, rows: value.rows.map((s) => peerRow(name, s)), error: value.error };
    } catch (e) {
      recordProviderFailure(name, e, observedAt);
      return { name, rows: [], error: e.code ?? e.message };
    }
  }));
  const providers = Object.fromEntries(Object.entries(getProviders()).filter(([, p]) => p.enabled));
  return {
    providers,
    peers: results.flatMap((r) => r.rows).filter((p) => providers[p.harness]),
    codexError: providers.codex ? results.find((r) => r.name === 'codex')?.error ?? null : null,
    personas: listPersonas(null, cwd).filter((p) => (!p.peer || providers[p.peer]) && (!p.agent || !HARNESSES[p.agent] || providers[p.agent])),
  };
}

// A round no one answered for this long is not in flight: a live session can
// take hours to get to a request, but past eight the asker or peer is gone. It is
// shown as stale, with the command that closes it, never as live.
export const STALE_MS = STALE_OPEN_MS;

// Open rounds: who asked whom what, and how long they have waited. The
// one thing no single terminal shows.
export function inflightOf(tasks, now = Date.now()) {
  const out = [];
  for (const t of tasks) {
    const last = t.rounds?.at(-1);
    if (!last || last.replied || last.closedAt || now - last.openedAt > STALE_MS) continue;
    out.push({ taskId: t.taskId, mode: t.mode, from: t.orchestrator, fromName: sessionLabel(t.orchestratorTarget, t.orchestrator), to: t.peer, toName: sessionLabel(t.peerTarget, t.peer), round: last.round, maxRounds: t.maxRounds, openedAt: last.openedAt, waitedMs: now - last.openedAt, brief: last.brief ?? null, cwd: t.cwd ?? null });
  }
  return out.sort((a, b) => a.openedAt - b.openedAt);
}

// Each task as a card head: who asked whom, the round, its status. Event text
// is clipped here; `magi exchange` prints one whole.
const THREAD_CLIP = 600;
function threadHead(t, now) {
  const last = t.rounds?.at(-1) ?? {};
  const status = last.replied ? (outcomeCovers(t) ? 'settled' : expiredCovers(t) ? 'expired' : 'replied') : last.closedAt ? 'closed' : now - last.openedAt > STALE_MS ? 'stale' : 'open';
  return {
    taskId: t.taskId, mode: t.mode, cwd: t.cwd ?? null,
    from: t.orchestrator, fromName: sessionLabel(t.orchestratorTarget, t.orchestrator), to: t.peer, toName: sessionLabel(t.peerTarget, t.peer),
    round: last.round ?? 0, maxRounds: t.maxRounds, status, closeReason: last.closeReason ?? null, closeCode: last.closeCode ?? null,
    peerStatus: last.status?.state ?? null,
    openedAt: t.rounds?.[0]?.openedAt ?? null, lastAt: Math.max(last.openedAt ?? 0, last.repliedAt ?? 0, last.closedAt ?? 0, t.outcome?.at ?? 0) || null,
    roundOpenedAt: last.openedAt ?? null, repliedAt: last.repliedAt ?? null,
    waitedMs: status === 'open' || status === 'stale' ? now - last.openedAt : null,
    via: last.via ?? null, costUsd: t.rounds?.reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0) || null,
    outcome: t.outcome ?? null, brief: last.brief ?? null,
  };
}
// A request recorded before the task text was kept beside it (2026-09-15)
// still has it inside the framed request: the TASK section.
const taskOf = (e) => e.task ?? /\nTASK\n(?:[^\n]*\n\n)?([\s\S]*?)(?:\n\nMODE\n|$)/.exec(e.text ?? '')?.[1]?.trim();
const clipEvent = (e) => {
  const text = typeof e.text === 'string' ? redact(e.text).text : e.text;
  return {
    ...e, task: e.kind === 'request' ? taskOf(e) : undefined,
    text: typeof text === 'string' && text.length > THREAD_CLIP ? `${text.slice(0, THREAD_CLIP)}…` : text,
    clipped: typeof text === 'string' && text.length > THREAD_CLIP,
  };
};
const elapsed = (ms) => ms < 90000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 5400000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 3600000)}h`;
const targetId = (target) => typeof target === 'object' && target ? target.id ?? target.sessionId ?? null : null;
function endpoint(harness, target, taskId) {
  const id = targetId(target);
  if (id) return [harness, 'id', id];
  const name = sessionLabel(target, '');
  // Harness labels and sessionless headless personas identify no worker.
  return name && name !== harness && !target?.headless ? [harness, 'name', name] : [harness, 'task', taskId];
}
export function openQuestion(t, events) {
  const last = t.rounds?.at(-1);
  if (!last || last.replied || last.closedAt) return null;
  // Questions pair with answers by id: answering one leaves an earlier one open.
  const open = new Map();
  for (const e of events) {
    if (e.round !== last.round) continue;
    const id = e.questionId ?? 'unidentified';
    if (e.kind === 'question') open.set(id, { text: e.text, at: e.at, round: e.round });
    else if (e.kind === 'clarification') { if (e.questionId) open.delete(id); else open.clear(); }
  }
  return open.values().next().value ?? null;
}

function channelStatusText(channel, now) {
  const card = channel.currentCard;
  const text = card.openQuestion ? 'worker waits on the coordinator\'s answer to a question; coordinator owes an answer'
    : channel.turn === 'worker' ? `worker working on card ${card.taskId} since ${new Date(channel.since).toISOString()}`
    : channel.turn === 'coordinator' ? `coordinator's turn; reply landed ${elapsed(now - channel.since)} ago`
    : `${channel.turn}: ${card.taskId}`;
  return card.statusText ? `${text}; ${card.statusText}` : text;
}

function describeReceipts(card, now, timeout) {
  for (const receipt of card.deliveries ?? []) {
    if (receipt.to !== 'claude') continue;
    const text = claudeReceiptHint(receipt, now, timeout);
    if (text) receipt.statusText = text;
    else delete receipt.statusText;
  }
  const hint = card.deliveries?.find((d) => d.to === 'claude' && d.statusText)?.statusText;
  if (hint) card.statusText = hint;
  else delete card.statusText;
}

// Channels are a projection, not another ledger. IDs disambiguate renamed
// sessions; named legacy targets group by name, identity-free ones by task.
export function channelsOf(tasks, now = Date.now()) {
  const pairs = new Map();
  const timeout = claudeDialogTimeout();
  for (const t of tasks) {
    const id = JSON.stringify([endpoint(t.orchestrator, t.orchestratorTarget, t.taskId), endpoint(t.peer, t.peerTarget, t.taskId)]);
    let channel = pairs.get(id);
    if (!channel) {
      channel = { id, from: t.orchestrator, fromId: targetId(t.orchestratorTarget), fromName: sessionLabel(t.orchestratorTarget, t.orchestrator), to: t.peer, toId: targetId(t.peerTarget), toName: sessionLabel(t.peerTarget, t.peer), turns: [], turnCount: 0, unreconciledCount: 0, repeatedAnswers: [], requests: [], replies: [] };
      pairs.set(id, channel);
    }
    const events = readExchange(t.taskId);
    const last = t.rounds?.at(-1) ?? {};
    // Every direction's receipt is refreshed; the card shows the latest one.
    const deliveries = Object.values(roundDeliveries(last)).map((d) => ({ ...d }));
    const delivery = deliveries.reduce((latest, d) => (latest && (latest.at ?? 0) >= (d.at ?? 0) ? latest : d), null);
    channel.turns.push({ ...threadHead(t, now), delivery, deliveries, deliveryStatus: delivery?.deliveryStatus ?? 'unconfirmed', roundOpenedAt: last.openedAt ?? null, repliedAt: last.repliedAt ?? null, openQuestion: openQuestion(t, events), events });
    describeReceipts(channel.turns.at(-1), now, timeout);
    channel.turnCount += t.rounds?.length ?? 0;
    if (reconciliationOwed(t)) channel.unreconciledCount++;
    for (const r of t.rounds ?? []) {
      if (typeof r.openedAt === 'number') channel.requests.push(r.openedAt);
      if (r.replied && typeof r.repliedAt === 'number') channel.replies.push(r.repliedAt);
      if (r.framing && sameSession(r.framing.target, t.peerTarget) === true && r.framing.sentAt > (channel.protocolSentAt ?? 0)) {
        channel.protocol = r.framing.protocol;
        channel.protocolSentAt = r.framing.sentAt;
      }
    }
  }
  for (const c of pairs.values()) {
    c.turns.sort((a, b) => (b.roundOpenedAt ?? 0) - (a.roundOpenedAt ?? 0) || b.taskId.localeCompare(a.taskId));
    c.currentCard = c.turns.find((t) => t.status === 'open') ?? c.turns[0];
    c.fromName = c.turns[0].fromName;
    c.toName = c.turns[0].toName;
    const card = c.currentCard;
    c.deliveryStatus = card.deliveryStatus;
    c.openQuestion = card.openQuestion;
    c.turn = card.openQuestion ? 'coordinator' : card.status === 'open' ? 'worker' : card.repliedAt != null ? 'coordinator' : card.status === 'stale' ? 'stale' : 'closed';
    c.since = card.openQuestion?.at ?? (c.turn === 'worker' ? card.roundOpenedAt : card.repliedAt ?? card.lastAt);
    c.statusText = channelStatusText(c, now);
    c.requests.sort((a, b) => a - b);
    c.replies.sort((a, b) => a - b);
    const latencies = [];
    let replyIndex = 0;
    // Match each reply to its next request; concurrent requests are not
    // coordinator response latency, and a reply with no successor is omitted.
    for (const request of c.requests) {
      while (replyIndex < c.replies.length && c.replies[replyIndex] <= request) latencies.push(request - c.replies[replyIndex++]);
    }
    latencies.sort((a, b) => a - b);
    const middle = Math.floor(latencies.length / 2);
    c.medianLatencyMs = latencies.length ? (latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2) : null;
    const seen = new Map();
    const answers = c.turns.flatMap((t) => t.events.filter((e) => e.kind === 'reply').map((e) => ({ t, e }))).sort((a, b) => (a.e.at ?? 0) - (b.e.at ?? 0));
    for (const { t, e } of answers) {
      const text = e.text?.trim();
      if (!text) continue;
      const previous = seen.get(text);
      const ref = { taskId: t.taskId, round: e.round, at: e.at };
      if (previous) {
        e.repeatedAnswer = true;
        e.repeatedFrom = previous;
        c.repeatedAnswers.push({ ...ref, repeatedFrom: previous });
      } else seen.set(text, ref);
    }
    for (const t of c.turns) t.events = t.events.map((e) => {
      const asker = (e.kind === 'note' && (e.fromRole ? e.fromRole === 'orchestrator' : e.from === t.from && t.from !== t.to)) || e.kind === 'request' || e.kind === 'clarification' || e.kind === 'outcome' || e.kind === 'closed';
      return clipEvent({ ...e, fromName: e.kind === 'note' && e.fromName ? e.fromName : asker ? t.fromName : t.toName, toName: e.kind === 'note' && e.toName ? e.toName : asker ? t.toName : t.fromName });
    });
    delete c.requests;
    delete c.replies;
  }
  return [...pairs.values()].sort((a, b) => Number(b.currentCard.status === 'open') - Number(a.currentCard.status === 'open') || (b.turns[0].roundOpenedAt ?? 0) - (a.turns[0].roundOpenedAt ?? 0));
}

// A later read refines a card's receipt from the original write's evidence
// without another send; the view changes, never the ledger. `magi status`
// calls it for each open card's current round, so the deck's receipts move
// from queued to read as the worker reads.
export async function refreshChannelDeliveries(channels, { now = Date.now() } = {}) {
  const timeout = claudeDialogTimeout();
  for (const channel of channels) {
    for (const card of channel.turns) {
      for (const receipt of card.deliveries ?? []) {
        // Remote ids refer to that machine's history, never this one's databases or transcripts.
        if (String(receipt.via ?? '').startsWith('relay:')) continue;
        const current = receipt.deliveryStatus ?? 'unconfirmed';
        if (!['queued_unread', 'unconfirmed', 'accepted'].includes(current)) continue;
        let status;
        if (String(receipt.via ?? '').startsWith('headless:') && receipt.workerPid && receipt.messageId) {
          status = await confirmHeadlessNote({ pid: receipt.workerPid, frameId: receipt.messageId, timeoutMs: 0 });
        } else if (receipt.to === 'codex' && (receipt.clientId || receipt.marker)) {
          status = await confirmCodex({ threadId: receipt.threadId, clientId: receipt.clientId, marker: receipt.marker, cursor: receipt.cursor, timeoutMs: 0 });
        } else if (receipt.to === 'claude' && receipt.marker && Number.isFinite(receipt.cursor)) {
          status = await confirmClaude({ session: receipt.target, transcriptPath: receipt.transcriptPath, cursor: receipt.cursor, marker: receipt.marker, timeoutMs: 0 });
        } else if (receipt.to === 'omp' && receipt.marker && Number.isFinite(receipt.cursor)) {
          status = await confirmOmp({ session: receipt.target, sessionFile: receipt.sessionFile, cursor: receipt.cursor, marker: receipt.marker, frameId: receipt.messageId, timeoutMs: 0 });
        }
        // queued_unread is progress over a bare write or a desktop acceptance:
        // a steer found in history but not yet read by the model.
        if (status === 'received' || status === 'received_mid_turn' || status === 'failed' ||
          (status === 'queued_unread' && (current === 'unconfirmed' || current === 'accepted'))) {
          receipt.deliveryStatus = status;
        }
      }
      describeReceipts(card, now, timeout);
      if (card.delivery) card.deliveryStatus = card.delivery.deliveryStatus ?? 'unconfirmed';
    }
    channel.deliveryStatus = channel.currentCard.deliveryStatus;
    if (channel.statusText !== undefined) channel.statusText = channelStatusText(channel, now);
  }
  return channels;
}

// Inspection surfaces share the refreshed receipt, including real evidence that
// supersedes a possible hold; neither the hint nor the refresh writes the ledger.
export async function claudeDeliveryHints(tasks, now = Date.now()) {
  const timeout = claudeDialogTimeout();
  const overdue = tasks.filter((t) => Object.values(roundDeliveries(t.rounds?.at(-1))).some((d) => claudeReceiptHint(d, now, timeout)));
  if (!overdue.length) return [];
  const channels = channelsOf(overdue, now);
  await refreshChannelDeliveries(channels, { now });
  return channels.flatMap((channel) => channel.turns.flatMap((card) =>
    (card.deliveries ?? []).filter((d) => d.to === 'claude' && d.statusText)
      .map((d) => ({ taskId: card.taskId, round: card.round, statusText: d.statusText }))));
}
