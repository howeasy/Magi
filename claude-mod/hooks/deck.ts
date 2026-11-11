// The deck's words, groups, alerts and layout rule, as pure functions of the
// status picture, so the tests read them directly. No `$` here; draw.tsx
// draws what these say.
import type { DeckLayout, MagiCard, MagiExchange, MagiLedger, MagiOutcome, MagiProvider, MagiRemote, MagiStatus, MagiTally, MagiUnit, MagiWorker } from '../types'

import type { IconName } from './glyphs.ts'
import { AMBER, GREEN, PURPLE, RED, age, deliveryState, plural } from './nerv.ts'

/** A worker with no word on its card this long is an alert. */
export const SILENT_MS = 30 * 60_000
/** A question waiting on its coordinator this long is an alert. */
export const QUESTION_MS = 5 * 60_000
/** Working cards with a hotkey (1-9) that opens them. */
export const HOTKEYS = 9

/** How the deck lays out: two columns, one, or the inline summary of at most 8 rows. */
export type Shape = 'wide' | 'compact' | 'mini'

/** The layout asked for, else mini inline above the prompt and wide from 110 columns docked. */
export function shapeOf(layout: DeckLayout, placement: string, columns: number): Shape {
  if (layout !== 'auto') return layout
  if (placement === 'inline') return 'mini'
  return columns >= 110 ? 'wide' : 'compact'
}

/** Whether a card was opened by the session the mod runs in. */
export function isHere(card: MagiCard, sessionId: string | null): boolean {
  return sessionId !== null && (card.coordinator?.ids.includes(sessionId) ?? false)
}

export type WorkingGroup = { heading: string; isHere: boolean; cards: MagiCard[] }

/** The cards a worker is on, by the session that opened them: this session first, then the others by name. */
export function workingGroups(status: MagiStatus | null, sessionId: string | null): WorkingGroup[] {
  if (!status) return []
  const groups = new Map<string, WorkingGroup>()
  for (const card of status.cards) {
    if (card.turn !== 'peer') continue
    const here = isHere(card, sessionId)
    const name = card.coordinator?.name ?? card.from
    // Another coordinator is grouped by the name a person knows it by; one
    // session can carry several ids, which once split it into two headings.
    const key = here ? '' : `${card.from}\n${name}`
    const group = groups.get(key) ?? { heading: here ? 'This session' : name, isHere: here, cards: [] }
    group.cards.push(card)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => Number(b.isHere) - Number(a.isHere) || a.heading.localeCompare(b.heading))
}

/** Open cards the status counts but did not list (it lists the oldest 20). */
export function unlistedCards(status: MagiStatus): number {
  return Math.max(status.cardsTotal - status.cards.length, 0)
}

/**
 * The status line: `Magi: claude ✓ · codex ✓ · omp ✓ · 1 working here · 4 in
 * Gen 2`, then questions and replies owed; ✓ a live session, – none, `off` a
 * turned-off provider.
 */
export function statusLine(status: MagiStatus | null, isStale = false, sessionId: string | null = null): string {
  if (!status) return isStale ? 'Magi: status unavailable (see /magi)' : 'Magi: checking…'
  const units = status.units.map(unit => `${unit.harness} ${unit.state === 'disabled' ? 'off' : unit.sessions > 0 ? '✓' : '–'}`)
  const groups = workingGroups(status, sessionId)
  const here = groups.find(group => group.isHere)
  const others = groups.filter(group => !group.isHere)
  const elsewhere = others.slice(2).reduce((n, group) => n + group.cards.length, 0)
  // Only this harness's own: a question on a card codex or omp opened is not "for claude".
  const questions = status.cards.filter(card => card.turn === 'orchestrator' && card.from === status.as).length
  const counts = [
    here ? `${here.cards.length} working here` : '',
    ...others.slice(0, 2).map(group => `${group.cards.length} in ${group.heading.slice(0, 24)}`),
    elsewhere > 0 ? `${elsewhere} more working` : '',
    unlistedCards(status) > 0 ? `${unlistedCards(status)} more open` : '',
    questions > 0 ? `${plural(questions, 'question')} for ${status.as}` : '',
    status.unreconciled > 0 ? `${plural(status.unreconciled, 'reply', 'replies')} for ${status.as} to check` : '',
  ].filter(Boolean)
  return `Magi: ${[...units, ...counts].join(' · ')}${isStale ? ' (stale)' : ''}`
}

/**
 * The desktop footer button's words: the footer holds about a dozen
 * characters, so the most pressing one fact after `Magi`, never the whole
 * status line: a failed delivery, then a question for this harness, then
 * replies to check, then this session's cards working, else nothing.
 */
export function footerLabel(status: MagiStatus | null, isStale = false, sessionId: string | null = null): string {
  if (!status) return isStale ? 'Magi · stale' : 'Magi'
  const failed = alerts(status, status.at, sessionId).length
  const questions = status.cards.filter(card => card.turn === 'orchestrator' && isHere(card, sessionId)).length
  const here = workingGroups(status, sessionId).find(group => group.isHere)?.cards.length ?? 0
  const fact = failed > 0 ? `${failed} failed`
    : questions > 0 ? plural(questions, 'question')
      : status.unreconciled > 0 ? `${status.unreconciled} to check`
        : here > 0 ? `${here} working`
          : ''
  return fact ? `Magi · ${fact}` : 'Magi'
}

/** Something that needs a person: the band shows these alone, each opening the deck at its card. */
export type Alert = { key: string; taskId: string; text: string; color: string }

/**
 * Failed deliveries on this session's own cards: the one thing a person must
 * act on. A worker's quiet or idle state is shown on its card line, not
 * alerted (the user called those alerts noise), and questions are the
 * coordinating agent's to answer. Another coordinator's cards are its own
 * session's business. With no session id yet, nothing is claimed.
 */
export function alerts(status: MagiStatus | null, _now: number, sessionId: string | null = null): Alert[] {
  if (!status) return []
  const mine = status.cards.filter(card => isHere(card, sessionId))
  const out: Alert[] = []
  for (const card of mine) {
    for (const receipt of card.delivery) {
      if (receipt.status === 'failed') out.push({ key: `failed-${card.taskId}-${receipt.to}`, taskId: card.taskId, text: `Delivery to ${receipt.to} failed on ${card.taskId}`, color: RED })
    }
  }
  for (const failure of status.failures) {
    const isMine = mine.some(card => card.taskId === failure.taskId) || (sessionId !== null && failure.coordinatorIds.includes(sessionId))
    if (!isMine) continue
    const key = `failed-${failure.taskId}-${failure.to}`
    if (!out.some(alert => alert.key === key)) out.push({ key, taskId: failure.taskId, text: `Delivery to ${failure.to} failed on ${failure.taskId}: ${failure.code}`, color: RED })
  }
  return out
}

/** One of this session's cards a peer still owes a reply on, for the waiting band. */
export type Waiting = { key: string; taskId: string; head: string; since: number | null; note: string }

/**
 * This session's cards whose turn is the peer's: the band shows them, calmly,
 * while the session is idle, so a person sees it is waiting on purpose. The
 * clock runs from the last thing sent to the peer. The note says what is
 * known of the worker: blocked on a person, a headless run that ended, or
 * else that the reply arrives by itself.
 */
export function waitingOn(status: MagiStatus | null, sessionId: string | null = null): Waiting[] {
  if (!status) return []
  return status.cards.filter(card => card.turn === 'peer' && isHere(card, sessionId)).map(card => {
    const sent = workerDelivery(card)?.at ?? null
    const worker = card.worker
    const note = !worker ? 'the reply comes back by itself'
      : worker.state === 'waiting' ? `${card.to} is ${waitingWords(worker)}`
        : worker.via === 'headless' && worker.state !== 'working' ? 'its run ended without a reply; open /magi'
          : worker.unseen ? `no word from ${worker.host ?? 'its machine'} lately; the reply comes back by itself`
            : 'the reply comes back by itself'
    return { key: `waiting-${card.taskId}`, taskId: card.taskId, head: `Waiting on ${card.to} · ${card.taskId} ${card.mode}`, since: sent ?? card.openedAt, note }
  })
}

/**
 * One labelled line of a working card: `Asked  <the task's first line>`.
 * `note` is drawn dim before the value (`3m ago`); a quiet value is drawn dim.
 */
export type CardField = { label: string; note: string; value: string; isQuiet: boolean }

/** One working card in lines; the live clock is drawn after `head`. */
export type CardLines = {
  /** `omp · Polished-2 · DELEGATE · round 1/2` */
  head: string
  /** Asked (when the status has the task line), Said, Delivery: one line each. */
  fields: CardField[]
  /** Dim: `magi-1 · live session, working · session 0f1e2d3c`. */
  id: string
  /** Opened: its last messages, `16:47 omp note: …`. */
  messages: string[]
}

/** The width of a card field's label column: `Delivery` and two spaces. */
export const FIELD_LABEL = 10

// Where the worker stands, in words.
/** One word for where a card's worker stands, for its one-line row. */
export function workerWord(worker: MagiWorker): string {
  if (worker.via === 'headless') return worker.state === 'working' ? 'running' : 'ended'
  if (worker.state === 'working') return 'working'
  if (worker.state === 'waiting') return 'waiting on a person'
  if (worker.state === 'idle') return worker.live ? 'idle' : 'idle, no longer live'
  return worker.live ? 'live' : 'not found'
}

/** The colour of where a worker stands: green while it works, amber while it waits on a person, none otherwise. */
export function workerColor(worker: MagiWorker): string | undefined {
  if (worker.state === 'working') return GREEN
  if (worker.state === 'waiting' && worker.via !== 'headless') return AMBER
  return undefined
}

/** "waiting on a person", and on what when its harness says: "waiting on a person: approval of bash". */
export function waitingWords(worker: MagiWorker): string {
  return worker.waitingFor ? `waiting on a person: ${worker.waitingFor}` : 'waiting on a person'
}

function presenceOf(worker: MagiWorker): string {
  const where = worker.host ? ` on ${worker.host}` : ''
  if (worker.via === 'headless') return worker.state === 'working' ? `headless worker running${where}` : `headless worker not running${where}`
  if (worker.unseen) return `live session${where}, not seen lately`
  if (!worker.live) return worker.state === 'idle' ? 'session idle, no longer live' : 'session not found right now'
  const state = { working: 'working', idle: 'idle', waiting: waitingWords(worker), unknown: 'state unknown' }[worker.state]
  return `live session, ${state}`
}

function workerDelivery(card: Pick<MagiCard, 'to' | 'delivery'>) {
  return card.delivery.find(one => one.toRole === 'peer')
    ?? card.delivery.find(one => !one.toRole && one.to === card.to)
}

function deliveryOf(card: MagiCard): CardField {
  const out = workerDelivery(card)
  if (!out) return { label: 'Delivery', note: '', value: 'not recorded', isQuiet: true }
  const back = card.delivery.filter(one => one !== out).map(one => `to ${one.toRole === 'orchestrator' ? 'coordinator' : one.to}: ${[deliveryState(one.status).label, one.statusText].filter(Boolean).join('; ')}`)
  return { label: 'Delivery', note: '', value: [[deliveryState(out.status).label, out.statusText].filter(Boolean).join('; '), ...back].join('; '), isQuiet: false }
}

/** `16:47`, local time; `--:--` when unknown. */
export function clockOf(at: number | null): string {
  return at === null ? '--:--' : new Date(at).toTimeString().slice(0, 5)
}

// The bridge's kinds in a person's words.
const KIND_WORD: Readonly<Record<string, string>> = { clarification: 'answer' }

/** The modes a live card runs under a time window, not a turn cap: the stored `maxRounds` is not a ceiling there. */
const WINDOW_MODES: ReadonlySet<string> = new Set(['DELEGATE', 'PARALLEL'])

/**
 * `round 1/6` where `maxRounds` is a real cap; `round 3` where it is not: a
 * live DELEGATE or PARALLEL card (an eight-hour window, whatever the record
 * says), no cap at all, or a round already past the number (so never `3/2`).
 */
export function roundText(card: Pick<MagiCard, 'round' | 'maxRounds' | 'mode' | 'worker'>): string {
  const isWindow = WINDOW_MODES.has(card.mode) && card.worker?.via !== 'headless'
  const cap = card.maxRounds !== null && card.round <= card.maxRounds && !isWindow ? card.maxRounds : null
  return `round ${card.round}${cap !== null ? `/${cap}` : ''}`
}

export function cardLines(card: MagiCard, now: number): CardLines {
  const worker = card.worker
  const harness = worker?.harness ?? card.to
  const name = worker?.name && worker.name !== harness ? [worker.name] : []
  const round = roundText(card)
  const since = worker?.lastActivityAt != null ? age(now - worker.lastActivityAt) : null
  const when = since === null ? '' : since === 'just now' ? since : `${since} ago`
  const said: CardField = worker?.lastSaid
    ? { label: 'Said', note: when, value: worker.lastSaid, isQuiet: false }
    : { label: 'Said', note: '', value: 'nothing yet', isQuiet: true }
  return {
    // Who and what; the mode and round are the row's tags, drawn beside it.
    head: [harness, ...name, ...(card.brief ? [card.brief] : [`${card.mode} · ${round}`])].join(' · '),
    fields: [...(card.brief ? [{ label: 'Asked', note: '', value: card.brief, isQuiet: false }] : []), said, deliveryOf(card)],
    id: [card.taskId, ...(worker ? [presenceOf(worker)] : []), ...(worker?.id ? [`session ${worker.id}`] : [])].join(' · '),
    messages: card.recent.map(m => `${clockOf(m.at)} ${m.from} ${KIND_WORD[m.kind] ?? m.kind}: ${m.text}${filesNote(m.files)}`),
  }
}

/** `text` cut to `max` characters with an ellipsis, for a label that cannot truncate itself (a Button's). */
export function fitText(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** A running clock's text where no surface module can tick it: `14:03`, `2h05`. */
export function timerText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** One exchange line in its columns: `16:47`, `omp → claude`, `reply`, the words. The card is the dim tail. */
export type ExchangeLine = { time: string; route: string; kind: string; words: string; taskId: string }

/** ` · 2 files: report.txt, shot.png`, the files a message carried; '' for none. */
export function filesNote(files: readonly string[]): string {
  if (!files.length) return ''
  const shown = files.slice(0, 3).join(', ')
  return ` · ${plural(files.length, 'file')}: ${shown}${files.length > 3 ? ', …' : ''}`
}

export function exchangeLine(x: MagiExchange): ExchangeLine {
  return { time: clockOf(x.at), route: `${x.from} → ${x.to ?? '?'}`, kind: KIND_WORD[x.kind] ?? x.kind, words: `${x.text}${filesNote(x.files)}`, taskId: x.taskId }
}

/**
 * The mark on an exchange line's timeline: a reply a green dot, a request or
 * a question an amber arrow or question mark, anything else a dim point.
 * The kind word beside it carries the meaning; the mark is the glance.
 */
export function exchangeMark(kind: string): { glyph: string; color: string | undefined } {
  switch (kind) {
    case 'reply':
      return { glyph: '●', color: GREEN }
    case 'request':
    case 'turn':
      return { glyph: '▸', color: AMBER }
    case 'question':
    case 'clarify':
      return { glyph: '?', color: AMBER }
    default:
      return { glyph: '·', color: undefined }
  }
}

/** One run of a proportion bar: this many cells in this colour. */
export type BarRun = { cells: number; color: string; label: string }

/**
 * The ledger's verdicts as a bar of `width` cells: accepted green, rejected
 * red, open amber, each at least one cell while its count is not zero;
 * empty when nothing was counted.
 */
export function ledgerBar(tally: Pick<MagiTally, 'accepted' | 'rejected' | 'open'>, width: number): BarRun[] {
  const parts = [
    { count: tally.accepted, color: GREEN, label: 'accepted' },
    { count: tally.rejected, color: RED, label: 'rejected' },
    { count: tally.open, color: AMBER, label: 'open' },
  ].filter(part => part.count > 0)
  const total = parts.reduce((n, part) => n + part.count, 0)
  if (total === 0 || width < parts.length) return []
  const runs = parts.map(part => ({ cells: Math.max(1, Math.floor((part.count / total) * width)), color: part.color, label: part.label }))
  // Rounding leaves cells over or short: the largest run takes the difference.
  const largest = runs.reduce((best, run) => (run.cells > best.cells ? run : best), runs[0] as BarRun)
  largest.cells += width - runs.reduce((n, run) => n + run.cells, 0)
  return runs
}

/**
 * `83% held · 5 accepted · 1 rejected`: the held rate first (a narrow line
 * cuts the counts, not the verdict), then the counts that are not zero; ''
 * when there is none.
 */
export function tallyWords(tally: Pick<MagiTally, 'accepted' | 'rejected' | 'open'> & { heldPct?: number | null }): string {
  return [
    tally.heldPct != null ? `${tally.heldPct}% held` : '',
    tally.accepted > 0 ? `${tally.accepted} accepted` : '',
    tally.rejected > 0 ? `${tally.rejected} rejected` : '',
    tally.open > 0 ? `${tally.open} open` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * The ledger's one line: `Last 7 days: 5 cards, 1 checked · 83% held · 5
 * accepted · 1 rejected`; '' when the week has no card and no verdict is listed,
 * so the panel takes no room.
 */
export function ledgerSummary(ledger: MagiLedger | null, outcomes: readonly MagiOutcome[]): string {
  if (ledger && ledger.total.cards > 0) {
    const counted = tallyWords(ledger.total)
    return `Last ${ledger.days} days: ${plural(ledger.total.cards, 'card')}, ${ledger.total.checked} checked${counted ? ` · ${counted}` : ''}`
  }
  return outcomes.length > 0 ? plural(outcomes.length, 'recent verdict') : ''
}

/**
 * What Details opens: by mode, by direction, the last verdicts, a row each,
 * the counts in words; a row with nothing counted and a section left empty are
 * left out, never drawn as zeros.
 */
export function ledgerDetails(ledger: MagiLedger | null, outcomes: readonly MagiOutcome[]): { title: string; rows: string[] }[] {
  const row = (label: string, tally: MagiTally) => (tally.cards > 0 ? [[label, plural(tally.cards, 'card'), tallyWords(tally)].filter(Boolean).join(' · ')] : [])
  const sections: { title: string; rows: string[] }[] = ledger && ledger.total.cards > 0
    ? [
      { title: 'By mode', rows: ledger.byMode.flatMap(b => row(b.mode, b)) },
      { title: 'By direction', rows: ledger.byDirection.flatMap(b => row(`${b.from} → ${b.to}`, b)) },
    ]
    : []
  sections.push({ title: 'Last verdicts', rows: outcomes.map(o => [o.taskId, o.mode, `${o.from} → ${o.to}`, tallyWords(o) || 'nothing counted'].join(' · ')) })
  return sections.filter(section => section.rows.length > 0)
}

/** `Headless runs cost $1.23 (5 priced)`; '' when none was priced. */
export function costLine(ledger: MagiLedger | null): string {
  return ledger && ledger.pricedRuns > 0 ? `Headless runs cost $${ledger.costUsd.toFixed(2)} (${plural(ledger.pricedRuns, 'priced run')})` : ''
}

/** A provider's state in words and colour, and the button that flips it. */
export function providerLine(p: MagiProvider): { state: string; color: string | undefined; action: 'enable' | 'disable' } {
  if (p.status === 'disabled') return { state: 'off', color: undefined, action: 'enable' }
  if (p.status === 'down') return { state: `down${p.reason ? `: ${p.reason}` : ''}`, color: RED, action: 'disable' }
  return { state: 'up', color: GREEN, action: 'disable' }
}

/**
 * A unit's state as its box says it: a glyph, the word, and the glyph's
 * colour (green while it is live, none otherwise). The word carries the
 * meaning; the glyph is the at-a-glance mark.
 */
export function unitState(unit: MagiUnit): { glyph: string; word: string; color: string | undefined } {
  switch (unit.state) {
    case 'active':
      return { glyph: '●', word: 'working', color: GREEN }
    case 'standby':
      return { glyph: '○', word: 'standby', color: GREEN }
    case 'disabled':
      return { glyph: '–', word: 'turned off', color: undefined }
    default:
      return { glyph: '○', word: 'no session', color: undefined }
  }
}

/** `1 live session`, `2 headless runs (1 remote)`, `3 open cards`: the counts that are not zero. */
export function unitCounts(unit: MagiUnit): string[] {
  return [
    unit.sessions > 0 ? plural(unit.sessions, 'live session') : '',
    unit.workers > 0 ? `${plural(unit.workers, 'headless run')}${unit.remoteWorkers > 0 ? ` (${unit.remoteWorkers} remote)` : ''}` : '',
    unit.openCards > 0 ? plural(unit.openCards, 'open card') : '',
  ].filter(Boolean)
}

/**
 * One machine of the fleet beyond this one, in words: `1 omp worker running ·
 * 1 live session on cards (devbox-omp) · 2 open cards`, `idle`, or, for a
 * host only a worker record names, `not in remotes.json`.
 */
export function remoteWords(remote: MagiRemote): string {
  const byHarness = new Map<string, number>()
  for (const w of remote.workers) byHarness.set(w.harness, (byHarness.get(w.harness) ?? 0) + 1)
  const parts = [
    ...[...byHarness].map(([harness, n]) => `${plural(n, `${harness} worker`)} running`),
    remote.live.length > 0 ? `${plural(remote.live.length, 'live session')} on cards (${remote.live.map(l => l.name).slice(0, 2).join(', ')}${remote.live.length > 2 ? ', …' : ''})` : '',
    remote.openCards > 0 ? plural(remote.openCards, 'open card') : '',
    remote.configured ? '' : 'not in remotes.json',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'idle'
}

/** The harnesses a card is in flight to: their units' marks pulse. */
export function inFlight(status: MagiStatus | null): Set<string> {
  return new Set((status?.cards ?? []).filter(card => card.turn === 'peer').map(card => card.to))
}

// ---- the deck's second reading of the same status: what waits on the
// orchestrator, where each worker stands in detail, the exchange by card and
// the ledger by direction. draw.tsx and panels.ts draw what these say.

/** A live worker idle, or no longer listed, this long after its last word is stalled. */
export const STALLED_MS = 30 * 60_000
/** Unreconciled replies past this many block new cards for the coordinator session. */
export const UNRECONCILED_LIMIT = 3

/** How long ago, as a row says it: `just now`, `3m ago`, `2h05 ago`; '' when unknown. */
export function agoText(at: number | null, now: number): string {
  if (at === null) return ''
  const m = Math.floor(Math.max(0, now - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')} ago` : `${Math.floor(h / 24)}d ago`
}

/** `2h05`, `14m`, `0m`: a duration without the `ago`. */
export function spanText(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d`
}

/** Where a worker stands, in detail: the icon's meaning, the word, its colour, and whether it has stalled. */
export type Standing = { icon: IconName; word: string; color: string | undefined; isStalled: boolean }

/**
 * A worker's standing for its row. Stalled: a live-session worker that is
 * idle or no longer listed, with no word on the card for STALLED_MS, while the
 * card is still open; its word says for how long (`stalled · idle 3h05`).
 */
export function standing(worker: MagiWorker | null, card: Pick<MagiCard, 'openedAt'>, now: number): Standing {
  if (!worker) return { icon: 'stateUnknown', word: 'no worker listed', color: undefined, isStalled: false }
  if (worker.via === 'headless') {
    return worker.state === 'working'
      ? { icon: 'stateRunning', word: 'running', color: GREEN, isStalled: false }
      : { icon: 'stateEnded', word: 'ended', color: undefined, isStalled: false }
  }
  // On another machine with no fresh word from there: not known, so neither gone nor stalled.
  if (worker.unseen) return { icon: 'stateUnknown', word: 'not seen lately', color: undefined, isStalled: false }
  const quiet = now - (worker.lastActivityAt ?? card.openedAt ?? now)
  const isIdle = worker.state === 'idle' || !worker.live
  if (isIdle && quiet >= STALLED_MS) {
    return { icon: 'stateStalled', word: `stalled · ${worker.live ? 'idle' : 'gone'} ${spanText(quiet)}`, color: AMBER, isStalled: true }
  }
  if (worker.state === 'working') return { icon: 'stateWorking', word: 'working', color: GREEN, isStalled: false }
  if (worker.state === 'waiting') return { icon: 'stateWaiting', word: waitingWords(worker), color: AMBER, isStalled: false }
  if (worker.state === 'idle') return { icon: 'stateIdle', word: worker.live ? 'idle' : 'idle, no longer live', color: undefined, isStalled: false }
  return { icon: worker.live ? 'stateIdle' : 'stateUnknown', word: worker.live ? 'live' : 'not found', color: undefined, isStalled: false }
}

/** The delivery receipt of the orchestrator's last message to the worker, as ticks. */
export type Receipt = { icon: IconName; label: string; color: string | undefined; at: number | null }

const RECEIPTS: Readonly<Record<string, { icon: IconName; label: string; color: string | undefined }>> = {
  received: { icon: 'read', label: 'read', color: GREEN },
  received_mid_turn: { icon: 'read', label: 'read mid-turn', color: GREEN },
  queued_unread: { icon: 'delivered', label: 'delivered, unread', color: undefined },
  accepted: { icon: 'delivered', label: 'delivered', color: undefined },
  unconfirmed: { icon: 'sent', label: 'sent', color: undefined },
  running: { icon: 'sent', label: 'running', color: undefined },
  failed: { icon: 'failed', label: 'failed', color: RED },
  not_applicable: { icon: 'sent', label: 'done', color: undefined },
}

/** The receipt of the last message to the card's worker; null when none is recorded. */
export function receiptOf(card: Pick<MagiCard, 'to' | 'delivery'>): Receipt | null {
  const out = workerDelivery(card)
  if (!out) return null
  const known = RECEIPTS[out.status]
  return known ? { ...known, at: out.at } : { icon: 'queued', label: out.status, color: undefined, at: out.at }
}

/** A headless run's time left: `12m left`, `past its timeout`; '' for a live session or no timeout. */
export function timeoutText(worker: MagiWorker | null, now: number): string {
  if (!worker || worker.via !== 'headless' || worker.timeoutAt === null) return ''
  return worker.timeoutAt > now ? `${spanText(worker.timeoutAt - now)} left` : 'past its timeout'
}

/** One row of the Your move strip: what waits on the orchestrator and since when. */
export type MoveRow = { kind: 'question' | 'reconcile' | 'failed'; taskId: string | null; text: string; since: string; color: string }

/**
 * What waits on the orchestrator of this session: questions on its cards (a
 * card whose turn is the orchestrator's), failed deliveries on them, and the
 * unreconciled replies against the limit past which new cards are refused.
 * With no session id, nothing is claimed. Empty: nothing waits.
 */
export function yourMove(status: MagiStatus | null, sessionId: string | null, now: number): MoveRow[] {
  if (!status) return []
  const out: MoveRow[] = []
  for (const card of status.cards) {
    if (card.turn !== 'orchestrator' || !isHere(card, sessionId)) continue
    const asked = [...card.recent].reverse().find(m => m.kind === 'question' || m.kind === 'clarify')
    const who = card.worker?.name && card.worker.name !== card.to ? `${card.to} (${card.worker.name})` : card.to
    out.push({
      kind: 'question',
      taskId: card.taskId,
      text: `${who} asks: ${asked?.text ?? card.brief ?? 'a question is waiting on the card'}`,
      since: agoText(card.questionAt ?? asked?.at ?? null, now),
      color: AMBER,
    })
  }
  for (const alert of alerts(status, now, sessionId)) {
    out.push({ kind: 'failed', taskId: alert.taskId, text: alert.text, since: '', color: RED })
  }
  if (status.unreconciled > 0) {
    const n = status.unreconciled
    const isBlocked = n > UNRECONCILED_LIMIT
    out.push({
      kind: 'reconcile',
      taskId: null,
      text: `${plural(n, 'reply', 'replies')} for ${status.as} to reconcile · ${n} of ${UNRECONCILED_LIMIT} ${isBlocked ? 'over the limit: new cards are refused until outcomes are recorded' : 'before new cards are refused'}`,
      since: '',
      color: isBlocked ? RED : AMBER,
    })
  }
  return out
}

/** The exchange on one card: its title line and its messages, newest first. */
export type Thread = { taskId: string; title: string; messages: ExchangeLine[] }

/**
 * The recent messages grouped by card, the card with the newest message
 * first, each card titled by its task line when the status lists the card,
 * else by its id and the peer it went to.
 */
export function threads(status: MagiStatus | null): Thread[] {
  if (!status) return []
  const byCard = new Map<string, Thread>()
  for (const x of status.exchanges) {
    const card = status.cards.find(c => c.taskId === x.taskId)
    const title = card?.brief ? `${x.taskId} · ${card.brief}` : `${x.taskId}${x.to ? ` · to ${x.to}` : ''}`
    const thread = byCard.get(x.taskId) ?? { taskId: x.taskId, title, messages: [] }
    thread.messages.push(exchangeLine(x))
    byCard.set(x.taskId, thread)
  }
  const newest = (t: Thread) => Math.max(...status.exchanges.filter(x => x.taskId === t.taskId).map(x => x.at ?? 0))
  return [...byCard.values()].sort((a, b) => newest(b) - newest(a))
}

/** The ledger one direction: `claude → omp`, the held rate and the counts. */
export type DirectionRow = { label: string; from: string; to: string; cards: number; heldPct: number | null; accepted: number; rejected: number; open: number }

/** The ledger's rows by direction, the most cards first; a direction with nothing counted is left out. */
export function directionRows(ledger: MagiLedger | null): DirectionRow[] {
  if (!ledger) return []
  return ledger.byDirection
    .filter(b => b.cards > 0)
    .map(b => ({ label: `${b.from} → ${b.to}`, from: b.from, to: b.to, cards: b.cards, heldPct: b.heldPct, accepted: b.accepted, rejected: b.rejected, open: b.open }))
    .sort((a, b) => b.cards - a.cards)
}

/** `$12.40 over 7 days (38 priced runs)`; '' when nothing was priced. */
export function costText(ledger: MagiLedger | null): string {
  return ledger && ledger.pricedRuns > 0 ? `$${ledger.costUsd.toFixed(2)} over ${ledger.days} days (${plural(ledger.pricedRuns, 'priced run')})` : ''
}
