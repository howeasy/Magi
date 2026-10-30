// `magi status --json`: the small picture the Claude Code mod (claude-mod/)
// draws its deck, alert band and status line from. Read-only like fleet.mjs.
// The only message text that leaves here is each open card's first task line,
// its worker's latest words and its last three messages, and the last eight
// messages of the session's project, every one redacted and cut (SAID_CHARS,
// LINE_CHARS). Sessions, cards, messages and ledger are that project's alone.
// The whole answer stays under STATUS_MAX_BYTES however big the ledger.
import { STALE_OPEN_MS, listTasks, listWorkers, magiHome, readExchange, readTask, recentExchanges, roundDeliveries, sameSession, unreconciledFor } from './state.mjs';
import { getRecord } from './store.mjs';
// refreshChannelDeliveries stays in fleet.mjs, which the CLI and the servers
// share; nothing here depends on the web dashboard.
import { listFleet, openQuestion, refreshChannelDeliveries } from './fleet.mjs';
import { transcriptTail } from './transcript.mjs';
import { redact } from './protocol.mjs';
import { getProviders } from './providers.mjs';
import { BridgeError } from './exec.mjs';
import { readRemotes } from './remote.mjs';
import { filesEnabled } from './artifacts.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';

// The three MAGI units, in the order the mod draws them. The mod keeps the
// same table in claude-mod/hooks/nerv.ts.
export const UNITS = [
  { unit: 'MELCHIOR-1', harness: 'claude' },
  { unit: 'BALTHASAR-2', harness: 'codex' },
  { unit: 'CASPER-3', harness: 'omp' },
];
export const STATUS_MAX_BYTES = 40_000;
const MAX_CARDS = 20;
const MAX_OUTCOMES = 5;
const SAID_CHARS = 140;
const LINE_CHARS = 100;
const CARD_MESSAGES = 3;
const EXCHANGE_LINES = 8;
const LEDGER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// A delivery failure stays an alert this long after its round was closed.
const FAILURE_MS = 60 * 60 * 1000;
const MESSAGE_KINDS = new Set(['request', 'reply', 'question', 'clarification', 'note']);
const clip = (value, n) => String(value ?? '').slice(0, n);

const projects = new Map();
// The project a directory belongs to, so the deck shows only the peers and
// cards of the session's own: the main checkout of its git repository (a
// linked worktree's `.git` file names it, a sibling `../repo-x` worktree
// included), found by reading files rather than running git on every refresh;
// outside git, the directory with any `.claude/worktrees/<name>` cut off.
export function projectOf(dir) {
  if (!dir) return null;
  const path = String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  const key = path.toLowerCase();
  if (projects.has(key)) return projects.get(key);
  let root = path.replace(/\/\.claude\/worktrees\/[^/]+(\/.*)?$/, '');
  for (let at = path; at; at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '') {
    const dotGit = `${at}/.git`;
    if (!existsSync(dotGit)) continue;
    let main = at;
    try {
      if (statSync(dotGit).isFile()) {
        const linked = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.replace(/\\/g, '/');
        const owner = linked && /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(linked)?.[1];
        if (owner) main = owner;
      }
    } catch { /* unreadable: the folder holding it stands for the project */ }
    root = main;
    break;
  }
  const project = root.toLowerCase();
  projects.set(key, project);
  return project;
}

// One line of words, redacted before it is cut so a secret the cut would
// split is still caught, and cut by code point so no emoji is split in half;
// null when nothing is left.
function said(text, chars = SAID_CHARS) {
  const flat = redact(String(text ?? '')).text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const all = [...flat];
  return all.length > chars ? `${all.slice(0, chars - 1).join('')}…` : flat;
}

// What a message said: a request its task's first line (the framed text
// repeats protocol), anything else its text.
const wordsOf = (e) => (e.kind === 'request' && typeof e.task === 'string' ? redact(e.task).text.split('\n').find((line) => line.trim()) : e.text);

// The task's first line, from the request as recorded; the ledger's brief
// (already one redacted line) for a card from before tasks were kept.
function briefOf(request, last) {
  if (typeof request?.task === 'string') return said(redact(request.task).text.split('\n').find((line) => line.trim()));
  return said(last.brief);
}

const targetId = (target) => (target && typeof target === 'object' ? target.id ?? target.sessionId ?? null : null);

// Every id a recorded session goes by, so the mod can find its own cards.
function idsOf(target) {
  if (!target || typeof target !== 'object') return [];
  const ids = [target.sessionId, target.id, ...(Array.isArray(target.sessionAliases) ? target.sessionAliases : [])];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, 4).map((id) => clip(id, 80));
}

// The listed session a recorded target is, live or not: by verified id, or by
// the name it was sent to when the target has no id. A headless run has none.
// A session idle past LIVE_IDLE_MS is still listed, only not live; matching
// it keeps its real state and when it changed, where matching live rows only
// read as "not found". Live rows come first, so a name both carry finds the
// live one.
// ponytail: a Claude desktop session listed under its app alias is not
// matched (fleet.cardsOf does that with claudeAppSessionIndex); it reads as
// `live: false, state: unknown` until that index is shared here.
function sessionOf(harness, target, peers) {
  const rows = peers.filter((p) => p.harness === harness).sort((a, b) => Number(b.live) - Number(a.live));
  if (typeof target === 'string') return rows.find((p) => p.name === target || p.label === target || p.id === target) ?? null;
  if (!target || typeof target !== 'object' || target.headless) return null;
  const byId = rows.find((p) => sameSession({ agent: harness, ...target }, { agent: p.harness, ...p }) === true);
  if (byId || targetId(target)) return byId ?? null;
  return target.name ? rows.find((p) => p.name === target.name || p.label === target.name) ?? null : null;
}

// How a live worker on another machine last stood, as the server holding a
// relay there brought it back for this card (refreshRemoteState in
// src/serve.mjs): read from the ledger, never over ssh. Only for the card's
// current round on the host its worker is on now, and for two minutes after
// it was asked for; otherwise nothing is known, which is not the same as gone.
const REMOTE_STATE_FRESH_MS = 2 * 60 * 1000;
function remoteStateOf(t, now) {
  let rec = null;
  try { rec = getRecord(magiHome(), 'remote-state', t.taskId); } catch { /* the ledger is the request's to report */ }
  // The same binding the writer checks: the card's current round, on the host its worker is on now.
  const current = t.rounds.at(-1);
  const host = (current && Object.hasOwn(current, 'peerTarget') ? current.peerTarget : t.peerTarget)?.host;
  if (!rec || now - rec.observedAt > REMOTE_STATE_FRESH_MS || rec.round !== current?.round || rec.host !== host) return null;
  return rec;
}

// What a person calls a session: its name, else its title (the purpose's
// first line), else `omp session 01a118ef`; an unnamed headless run is
// `headless omp`. Never a bare id: a name that is the id's start is none.
function sessionName(harness, target, session) {
  const bare = typeof target === 'string' && /^[0-9a-f-]{8,}$/i.test(target.trim()) ? target.trim() : null;
  const id = targetId(target) ?? session?.id ?? bare;
  const named = (typeof target === 'string' ? target : target?.name ?? '').trim();
  if (named && !(id && /^[0-9a-f-]{6,}$/i.test(named) && String(id).startsWith(named))) return clip(named, 48);
  if (target?.headless) return `headless ${harness}`;
  // A title the harness made from Magi's own request carries the protocol
  // line ("…: PEER REQUEST magi/1 …"); keep only what comes before it.
  const title = redact(String(session?.purpose ?? target?.purpose ?? '')).text.split('\n').map((line) => line.trim()).find(Boolean)
    ?.replace(/[:\s-]*PEER [A-Z]+ magi\/1\b.*$/, '').trim();
  if (title) return clip(title, 48);
  return id ? `${harness} session ${String(id).slice(0, 8)}` : harness;
}

const SESSION_STATE = { working: 'working', blocked: 'waiting', idle: 'idle' };

// The newest thing the worker said on this round: a question or note it sent
// on the card, or its own transcript's newest assistant text since the round
// opened. Same-harness notes carry the verified sender's card role; legacy
// rows without a role cannot be attributed from their harness alone.
async function latestWords(t, last, events, session, tails) {
  let best = null;
  for (const e of events) {
    if (e.round !== last.round || typeof e.text !== 'string') continue;
    if (e.kind === 'question' || (e.kind === 'note' && (e.fromRole === 'peer' || (!e.fromRole && e.from === t.peer && t.orchestrator !== t.peer)))) best = { text: e.text, at: e.at ?? null };
  }
  if (session) {
    const key = `${session.harness}:${session.id ?? session.name}`;
    if (!tails.has(key)) tails.set(key, await transcriptTail(session, { limit: 8 }).catch(() => []));
    const own = tails.get(key).filter((m) => m.role === 'assistant' && (m.at == null || m.at >= (last.openedAt ?? 0))).at(-1);
    if (own && (best === null || (own.at ?? 0) >= (best.at ?? 0))) best = { text: own.text, at: own.at ?? null };
  }
  return best;
}

// The latest receipt per direction, newest first. Uncertain ones are looked
// at again the way fleet.mjs refreshes channels (read-only, one look per
// receipt, no age limit: only open cards come here), so a request the worker
// has read stops saying `queued_unread`.
async function deliveriesOf(last, now) {
  const deliveries = Object.values(roundDeliveries(last)).map((d) => ({ ...d }));
  const delivery = deliveries.reduce((latest, d) => (latest && (latest.at ?? 0) >= (d.at ?? 0) ? latest : d), null);
  const card = { status: 'open', deliveries, delivery, roundOpenedAt: last.openedAt ?? null };
  try {
    await refreshChannelDeliveries([{ turns: [card], currentCard: card }], { now });
  } catch {
    // The receipt as recorded still answers.
  }
  return deliveries
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .map((d) => ({ to: clip(d.to ?? 'unknown', 24), ...(d.toRole ? { toRole: d.toRole } : {}), status: clip(d.deliveryStatus ?? 'unconfirmed', 32), at: typeof d.at === 'number' ? d.at : null, ...(d.statusText ? { statusText: d.statusText } : {}) }));
}

// Who is on the card and what they last said. `live` means the worker's
// session is listed live right now; `state` is that session's state whether
// or not it is live. `lastActivityAt` is when `lastSaid` was said, else when
// the session's state last changed. `timeoutAt` is when a running headless
// worker is stopped.
async function workerOf(t, last, events, { peers, workers, tails }) {
  const request = events.filter((e) => e.kind === 'request' && e.round === last.round).at(-1);
  const target = t.peerTarget;
  // The recorded target wins: a live send that fell back to a headless run
  // marks its target headless after the request was recorded as live.
  const via = target?.headless || request?.via === 'headless' ? 'headless' : 'live';
  // A live worker on another machine is known only by what its relay brought
  // back for this card; it is never looked up here, and never read from a
  // transcript here (a session id there can name another thread here).
  const remoteLive = via === 'live' && Boolean(target?.host);
  const remote = remoteLive ? remoteStateOf(t, Date.now()) : null;
  const session = via !== 'live' || remoteLive ? null : sessionOf(t.peer, target, peers);
  const running = workers.find((w) => w.taskId === t.taskId);
  const words = await latestWords(t, last, events, session, tails);
  const id = targetId(target);
  const timeoutAt = running && typeof running.startedAt === 'number' && typeof running.timeoutMs === 'number' ? running.startedAt + running.timeoutMs : null;
  // A headless worker on another machine (remotes.json): its card and channel are here.
  // A worker on another machine (remotes.json), headless or a live session
  // there: its card and channel are here; status never asks that machine.
  const host = clip(target?.host ?? running?.host ?? '', 64) || null;
  return {
    request,
    worker: {
      harness: clip(t.peer, 24),
      name: via === 'headless' && !target?.name ? `headless ${clip(t.peer, 24)}${host ? ` on ${host}` : ''}` : `${sessionName(clip(t.peer, 24), target, session)}${host && via === 'live' ? ` on ${host}` : ''}`,
      id: id ? clip(id, 8) : null,
      live: remoteLive ? Boolean(remote?.live) : Boolean(session?.live),
      state: via === 'headless' ? (running ? 'working' : 'unknown')
        : remote ? SESSION_STATE[remote.state] ?? 'unknown'
          : session ? SESSION_STATE[session.state] ?? 'unknown' : 'unknown',
      // What a waiting session waits on, in its harness's words: Claude's
      // waitingFor and needs, omp's approval of a named tool. From another
      // machine only the short `waitingFor` crosses, never `needs`.
      waitingFor: remote ? (remote.state === 'blocked' ? clip(remote.waitingFor ?? '', 120) || null : null)
        : session?.state === 'blocked' ? clip([session.waitingFor, session.needs].filter(Boolean).join(': '), 120) || null : null,
      // A live worker on another machine with no fresh word from there: not
      // seen, which is neither gone nor idle.
      ...(remoteLive ? { unseen: !remote } : {}),
      lastActivityAt: typeof words?.at === 'number' ? words.at : typeof session?.statusAt === 'number' ? session.statusAt : null,
      lastSaid: words ? said(words.text) : null,
      via,
      timeoutAt: via === 'headless' ? timeoutAt : null,
      host,
    },
  };
}

// The session that opened the card, for grouping the deck by coordinator and
// marking the mod's own session's cards.
function coordinatorOf(t, peers) {
  const target = t.orchestratorTarget;
  const harness = clip(t.orchestrator, 24);
  return { harness, name: sessionName(harness, target, sessionOf(t.orchestrator, target, peers)), ids: idsOf(target) };
}

// A card's last few messages, one line each.
// A message that carried files names them: their names in the sender's tree, never a path.
const filesOf = (e) => (Array.isArray(e.files) && e.files.length ? { files: e.files.slice(0, 20).map((f) => clip(String(f.path ?? f.name ?? ''), 80)) } : {});

const messagesOf = (events) => events
  .filter((e) => MESSAGE_KINDS.has(e.kind))
  .slice(-CARD_MESSAGES)
  .map((e) => ({ at: typeof e.at === 'number' ? e.at : null, from: clip(e.from, 24), kind: e.kind, text: said(wordsOf(e), LINE_CHARS) ?? '', ...filesOf(e) }));

// An open card: the last round unanswered, not closed, not past the stale
// window (the same test fleet.inflightOf applies).
function openCards(tasks, now) {
  const cards = [];
  for (const t of tasks) {
    const last = t.rounds?.at(-1);
    if (!last || last.replied || last.closedAt || now - last.openedAt > STALE_OPEN_MS) continue;
    const events = readExchange(t.taskId);
    // A question the worker asked and nobody answered hands the turn back.
    const question = openQuestion(t, events);
    cards.push({
      t, last, events,
      card: {
        taskId: clip(t.taskId, 64),
        mode: clip(t.mode, 24),
        from: clip(t.orchestrator, 24),
        to: clip(t.peer, 24),
        round: last.round ?? 1,
        maxRounds: Number.isInteger(t.maxRounds) ? t.maxRounds : null,
        turn: question ? 'orchestrator' : 'peer',
        openedAt: last.openedAt ?? null,
        questionAt: typeof question?.at === 'number' ? question.at : null,
      },
    });
  }
  return cards.sort((a, b) => (a.card.openedAt ?? 0) - (b.card.openedAt ?? 0));
}

// The listed cards' details: coordinator, worker, brief, receipts, messages.
async function detailed(open, context, now) {
  const out = [];
  for (const { t, last, events, card } of open) {
    const { request, worker } = await workerOf(t, last, events, context);
    const lastEvent = events.at(-1);
    out.push({
      ...card,
      coordinator: coordinatorOf(t, context.peers),
      worker,
      brief: briefOf(request, last),
      delivery: await deliveriesOf(last, now),
      lastExchangeAt: typeof lastEvent?.at === 'number' ? lastEvent.at : null,
      recent: messagesOf(events),
    });
  }
  return out;
}

// The last few messages on any card, one line each; `to` filled in from the
// card where the row does not say it.
function exchangesOf(tasks) {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  // Read deep enough that a project which is not the busiest still fills its lines.
  return recentExchanges(EXCHANGE_LINES * 50)
    .filter((e) => MESSAGE_KINDS.has(e.kind) && byId.has(e.taskId))
    .slice(0, EXCHANGE_LINES)
    .map((e) => {
      const t = byId.get(e.taskId);
      const to = e.to ?? (t ? (e.from === t.orchestrator ? t.peer : t.orchestrator) : null);
      return { at: typeof e.at === 'number' ? e.at : null, taskId: clip(e.taskId, 64), from: clip(e.from, 24), to: to ? clip(to, 24) : null, kind: e.kind, text: said(wordsOf(e), LINE_CHARS) ?? '', ...filesOf(e) };
    });
}

// One card's whole conversation for the deck's "full messages" view
// (`magi exchange <id> --json`): every message's words, redacted, the
// request's task rather than its framing, each cut at THREAD_MESSAGE_CHARS
// and the whole at THREAD_CHARS (the newest kept) so one drawing holds it.
const THREAD_MESSAGE_CHARS = 12_000;
const THREAD_CHARS = 90_000;
const THREAD_KINDS = new Set([...MESSAGE_KINDS, 'outcome', 'closed']);
export function cardThread(taskId) {
  const t = readTask(taskId);
  if (!t) throw new BridgeError('UNKNOWN_TASK', `No task ${taskId}. Use "magi log" to list tasks, then "magi exchange <task_id> --json".`);
  const messages = readExchange(taskId)
    .filter((e) => THREAD_KINDS.has(e.kind))
    .map((e) => {
      const full = e.kind === 'request' && typeof e.task === 'string' ? e.task
        : e.kind === 'outcome' ? [`accepted ${e.accepted ?? 0} · rejected ${e.rejected ?? 0} · open ${e.open ?? 0}`, e.text].filter(Boolean).join('\n\n')
          : e.kind === 'closed' ? (e.reason ?? e.text ?? '')
            : (e.text ?? '');
      const words = [...redact(String(full)).text];
      const text = words.length > THREAD_MESSAGE_CHARS
        ? `${words.slice(0, THREAD_MESSAGE_CHARS).join('')}\n\n… ${words.length - THREAD_MESSAGE_CHARS} more characters (magi exchange ${taskId})`
        : words.join('');
      const to = e.to ?? (e.from === t.orchestrator ? t.peer : t.orchestrator);
      // A request that let the worker run shell commands says so.
      return { at: typeof e.at === 'number' ? e.at : null, kind: e.kind, round: e.round ?? null, from: clip(e.from ?? t.orchestrator, 24), to: clip(to, 24), text, ...(e.allowCommands ? { allowCommands: true } : {}), ...filesOf(e) };
    });
  let total = 0;
  let first = messages.length;
  while (first > 0 && total + messages[first - 1].text.length <= THREAD_CHARS) total += messages[--first].text.length;
  // The card's grant, and each round that ran with commands.
  const commandRounds = (t.rounds ?? []).filter((r) => r.allowCommands).map((r) => r.round);
  return { taskId, mode: t.mode, from: t.orchestrator, to: t.peer, allowCommands: Boolean(t.allowCommands), commandRounds, omitted: first, messages: messages.slice(first) };
}

function lastOutcomes(tasks) {
  return tasks
    .filter((t) => t.outcome)
    .sort((a, b) => (b.outcome.at ?? 0) - (a.outcome.at ?? 0))
    .slice(0, MAX_OUTCOMES)
    .map((t) => ({
      taskId: clip(t.taskId, 64),
      mode: clip(t.mode, 24),
      from: clip(t.orchestrator, 24),
      to: clip(t.peer, 24),
      accepted: t.outcome.accepted ?? 0,
      rejected: t.outcome.rejected ?? 0,
      open: t.outcome.open ?? 0,
      at: t.outcome.at ?? null,
    }));
}

// Cards opened in the last LEDGER_DAYS: the verdict counts and the held rate
// (accepted of accepted plus rejected) in all, per mode and per direction, and
// what the headless runs among them cost where the provider priced them.
function ledgerOf(tasks, now) {
  const since = now - LEDGER_DAYS * DAY_MS;
  const bucket = (extra) => ({ ...extra, cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0 });
  const total = bucket({});
  const byMode = new Map();
  const byDirection = new Map();
  let costUsd = 0;
  let pricedRuns = 0;
  for (const t of tasks) {
    if ((t.rounds?.[0]?.openedAt ?? 0) < since) continue;
    const mode = clip(t.mode, 24);
    const from = clip(t.orchestrator, 24);
    const to = clip(t.peer, 24);
    if (!byMode.has(mode)) byMode.set(mode, bucket({ mode }));
    if (!byDirection.has(`${from}>${to}`)) byDirection.set(`${from}>${to}`, bucket({ from, to }));
    for (const b of [total, byMode.get(mode), byDirection.get(`${from}>${to}`)]) {
      b.cards++;
      if (!t.outcome) continue;
      b.checked++;
      b.accepted += t.outcome.accepted ?? 0;
      b.rejected += t.outcome.rejected ?? 0;
      b.open += t.outcome.open ?? 0;
    }
    for (const r of t.rounds ?? []) {
      if (typeof r.usage?.costUsd !== 'number') continue;
      costUsd += r.usage.costUsd;
      pricedRuns++;
    }
  }
  const rated = (b) => ({ ...b, heldPct: b.accepted + b.rejected ? Math.round((100 * b.accepted) / (b.accepted + b.rejected)) : null });
  const busiest = (map) => [...map.values()].sort((a, b) => b.cards - a.cards).slice(0, 9).map(rated);
  return { days: LEDGER_DAYS, total: rated(total), byMode: busiest(byMode), byDirection: busiest(byDirection), costUsd: Math.round(costUsd * 100) / 100, pricedRuns };
}

// Rounds closed because the request could not be delivered, in the last hour.
function failuresOf(tasks, now) {
  return tasks
    .flatMap((t) => {
      const last = t.rounds?.at(-1);
      if (last?.closeReason !== 'delivery_failed' || now - (last.closedAt ?? 0) > FAILURE_MS) return [];
      // The coordinator's ids: a failed card is closed, so only these say whose it is.
      return [{ taskId: clip(t.taskId, 64), from: clip(t.orchestrator, 24), to: clip(t.peer, 24), code: clip(last.closeCode ?? 'DELIVERY_FAILED', 40), at: last.closedAt, coordinatorIds: idsOf(t.orchestratorTarget) }];
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 5);
}

// active: a live session working or blocked, a headless worker running, or an
// open card waiting on this unit; standby: live sessions, none of them busy.
function unitsOf({ providers, peers, workers, cards }) {
  return UNITS.map(({ unit, harness }) => {
    const enabled = Boolean(providers[harness]?.enabled);
    const live = peers.filter((p) => p.harness === harness && p.live);
    const working = live.filter((p) => p.state === 'working' || p.state === 'blocked').length;
    const running = workers.filter((w) => w.harness === harness).length;
    const remote = workers.filter((w) => w.harness === harness && w.host).length;
    const asked = cards.filter((c) => c.to === harness).length;
    const state = !enabled ? 'disabled' : working || running || asked ? 'active' : live.length ? 'standby' : 'none';
    return { unit, harness, state, sessions: live.length, working, workers: running, remoteWorkers: remote, openCards: asked };
  });
}

const tooBig = (status) => Buffer.byteLength(JSON.stringify(status)) > STATUS_MAX_BYTES;

// Over budget, the newest cards lose their message lines first, then their
// worker's words, then their brief; then the exchange lines go, then the
// cards themselves. cardsTotal still counts every one.
function fit(status) {
  const drops = [(card) => { card.recent = []; }, (card) => { card.worker.lastSaid = null; }, (card) => { card.brief = null; }];
  for (const drop of drops) {
    for (let i = status.cards.length - 1; i >= 0 && tooBig(status); i--) drop(status.cards[i]);
  }
  while (status.exchanges.length && tooBig(status)) status.exchanges.pop();
  while (status.cards.length && tooBig(status)) status.cards.pop();
  return status;
}

export async function magiStatus({ cwd = process.cwd(), as = 'claude', now = Date.now() } = {}) {
  if (!UNITS.some((u) => u.harness === as)) {
    throw new BridgeError('BAD_REQUEST', `Unknown --as "${as}". Use "magi status --json --as <claude|codex|omp>" (claude by default).`);
  }
  const providers = getProviders();
  // Everything below is the session's own project: its sessions, cards,
  // messages and ledger. Peers busy in another project are not this one's
  // business. Providers stay machine-wide, since they are switched per machine.
  const project = projectOf(cwd);
  const here = (dir) => projectOf(dir) === project;
  let peers = [];
  let liveError = null;
  try {
    const fleet = await listFleet({ cwd, codexScope: 'all' });
    peers = fleet.peers.filter((p) => here(p.cwd));
    liveError = fleet.codexError ? `codex: ${fleet.codexError}` : null;
  } catch (e) {
    // The ledger still answers: units fall back to workers and open cards.
    liveError = `${e.code ? `${e.code}: ` : ''}${e.message}`;
  }
  const tasks = listTasks().filter((t) => here(t.cwd));
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const workers = listWorkers().filter((w) => taskIds.has(w.taskId));
  const open = openCards(tasks, now);
  const all = open.map((o) => o.card);
  const status = {
    v: 1,
    at: now,
    cwd,
    as,
    units: unitsOf({ providers, peers, workers, cards: all }),
    remotes: remotesOf(workers, open),
    // Whether files cross to and from peers on other machines here (`magi files`).
    files: filesEnabled(),
    providers: UNITS.map(({ harness }) => ({ name: harness, status: providers[harness]?.status ?? 'disabled', reason: providers[harness]?.reason ? clip(providers[harness].reason, 160) : null })),
    // ponytail: only the oldest MAX_CARDS are detailed and listed; a paged
    // `--cards` would be the upgrade if 20 ever stops being enough.
    cards: await detailed(open.slice(0, MAX_CARDS), { peers, workers, tails: new Map() }, now),
    cardsTotal: all.length,
    // The debt RECONCILE_FIRST counts for this orchestrator in this directory.
    unreconciled: unreconciledFor(as, { cwd }).length,
    outcomes: lastOutcomes(tasks),
    exchanges: exchangesOf(tasks),
    ledger: ledgerOf(tasks, now),
    failures: failuresOf(tasks, now),
    liveError: liveError ? clip(liveError, 300) : null,
  };
  return fit(status);
}

function remotesOf(workers, open) {
  let configured = {};
  try { configured = readRemotes(); } catch { /* a bad remotes.json is the request's error to report */ }
  const names = new Set([...Object.keys(configured), ...workers.map((w) => w.host).filter(Boolean)]);
  return [...names].sort().map((name) => ({
    name: clip(name, 64),
    configured: Boolean(configured[name]),
    workers: workers.filter((w) => w.host === name).map((w) => ({ taskId: w.taskId, harness: w.harness })),
    live: open.filter((o) => o.t.peerTarget?.host === name && !o.t.peerTarget.headless).map((o) => ({ taskId: o.t.taskId, harness: o.t.peer, name: clip(String(o.t.peerTarget.name ?? o.t.peerTarget.sessionId ?? o.t.peerTarget.id ?? o.t.peer), 48) })),
    openCards: open.filter((o) => o.t.peerTarget?.host === name).length,
  }));
}

// Exposed for the naming regression only.
export { sessionName as sessionNameForTest };
