// Reads what `magi status --json` printed (src/status.mjs). Anything that is
// not that shape answers null, and the drawings keep their last good picture.
import type {
  MagiCard,
  MagiCoordinator,
  MagiDelivery,
  MagiExchange,
  MagiFailure,
  MagiLedger,
  MagiMessage,
  MagiOutcome,
  MagiProvider,
  MagiRemote,
  MagiStatus,
  MagiTally,
  MagiThread,
  MagiThreadMessage,
  MagiUnit,
  MagiUnitState,
  MagiWorker,
  MagiWorkerState,
} from '../types'

import { UNIT_OF, isObject } from './nerv.ts'

const STATES: readonly MagiUnitState[] = ['active', 'standby', 'none', 'disabled']
const WORKER_STATES: readonly MagiWorkerState[] = ['working', 'idle', 'waiting', 'unknown']

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isText = (value: unknown): value is string => typeof value === 'string'
const textOrNull = (value: unknown): string | null => (isText(value) && value !== '' ? value : null)
const timeOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const countOr0 = (value: unknown): number => (isCount(value) ? value : 0)

function unitOf(value: unknown): MagiUnit | null {
  if (!isObject(value)) return null
  const { harness, state, sessions, working, workers, remoteWorkers, openCards } = value
  if (harness !== 'claude' && harness !== 'codex' && harness !== 'omp') return null
  if (!STATES.includes(state as MagiUnitState)) return null
  if (!isCount(sessions) || !isCount(working) || !isCount(workers) || !isCount(openCards)) return null
  return { unit: UNIT_OF[harness], harness, state: state as MagiUnitState, sessions, working, workers, remoteWorkers: countOr0(remoteWorkers), openCards }
}

// The parts below are details: a Magi older than them prints none, and one
// that does not read is dropped alone, never the picture around it.
function workerOf(value: unknown): MagiWorker | null {
  if (!isObject(value)) return null
  const { harness, name, id, live, state, lastActivityAt, lastSaid, via, timeoutAt, host, waitingFor, unseen } = value
  if (!isText(harness) || typeof live !== 'boolean') return null
  return {
    harness,
    name: textOrNull(name),
    id: textOrNull(id),
    live,
    state: WORKER_STATES.includes(state as MagiWorkerState) ? state as MagiWorkerState : 'unknown',
    lastActivityAt: timeOrNull(lastActivityAt),
    lastSaid: textOrNull(lastSaid),
    via: via === 'headless' ? 'headless' : 'live',
    timeoutAt: timeOrNull(timeoutAt),
    host: textOrNull(host),
    waitingFor: textOrNull(waitingFor),
    unseen: unseen === true,
  }
}

function coordinatorOf(value: unknown): MagiCoordinator | null {
  if (!isObject(value) || !isText(value.harness) || !isText(value.name)) return null
  const ids = Array.isArray(value.ids) ? value.ids.filter(isText) : []
  return { harness: value.harness, name: value.name, ids }
}

// One entry per item that reads; the rest are left out.
function readable<T>(value: unknown, read: (one: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one: unknown) => {
    const item = read(one)
    return item === null ? [] : [item]
  })
}

const deliveryOf = (one: unknown): MagiDelivery | null =>
  isObject(one) && isText(one.to) && isText(one.status) ? { to: one.to, ...(one.toRole === 'peer' || one.toRole === 'orchestrator' ? { toRole: one.toRole } : {}), status: one.status, at: timeOrNull(one.at), ...(textOrNull(one.statusText) ? { statusText: String(one.statusText) } : {}) } : null

function messageOf(one: unknown): MagiMessage | null {
  if (!isObject(one) || !isText(one.from) || !isText(one.kind) || !isText(one.text)) return null
  return { at: timeOrNull(one.at), from: one.from, kind: one.kind, text: one.text, files: readable(one.files, f => (isText(f) && f !== '' ? f : null)) }
}

function exchangeOf(one: unknown): MagiExchange | null {
  const message = messageOf(one)
  if (!message || !isObject(one) || !isText(one.taskId)) return null
  return { ...message, taskId: one.taskId, to: textOrNull(one.to) }
}

function threadMessageOf(one: unknown): MagiThreadMessage | null {
  if (!isObject(one) || !isText(one.kind) || !isText(one.from) || !isText(one.text)) return null
  return { at: timeOrNull(one.at), kind: one.kind, round: isCount(one.round) ? one.round : null, from: one.from, to: isText(one.to) ? one.to : '', text: one.text, files: readable(one.files, f => (isText(f) && f !== '' ? f : null)) }
}

/** What `magi exchange <id> --json` printed (src/status.mjs cardThread), or null for anything else. */
export function parseThread(stdout: string): MagiThread | null {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(value) || !isText(value.taskId) || !Array.isArray(value.messages)) return null
  return { taskId: value.taskId, omitted: countOr0(value.omitted), messages: readable(value.messages, threadMessageOf), error: null }
}

function cardOf(value: unknown): MagiCard | null {
  if (!isObject(value)) return null
  const { taskId, mode, from, to, round, maxRounds, turn, openedAt, questionAt, coordinator, worker, brief, delivery, lastExchangeAt, recent } = value
  if (!isText(taskId) || !isText(mode) || !isText(from) || !isText(to) || !isCount(round)) return null
  if (turn !== 'peer' && turn !== 'orchestrator') return null
  return {
    taskId, mode, from, to, round, turn,
    maxRounds: isCount(maxRounds) ? maxRounds : null,
    openedAt: typeof openedAt === 'number' ? openedAt : null,
    questionAt: timeOrNull(questionAt),
    coordinator: coordinatorOf(coordinator),
    worker: workerOf(worker),
    brief: textOrNull(brief),
    delivery: readable(delivery, deliveryOf),
    lastExchangeAt: timeOrNull(lastExchangeAt),
    recent: readable(recent, messageOf),
  }
}

function outcomeOf(value: unknown): MagiOutcome | null {
  if (!isObject(value)) return null
  const { taskId, mode, from, to, accepted, rejected, open, at } = value
  if (!isText(taskId) || !isText(mode) || !isText(from) || !isText(to)) return null
  if (!isCount(accepted) || !isCount(rejected) || !isCount(open)) return null
  return { taskId, mode, from, to, accepted, rejected, open, at: typeof at === 'number' ? at : null }
}

function tallyOf(value: unknown): MagiTally {
  const v = isObject(value) ? value : {}
  return {
    cards: countOr0(v.cards),
    checked: countOr0(v.checked),
    accepted: countOr0(v.accepted),
    rejected: countOr0(v.rejected),
    open: countOr0(v.open),
    heldPct: isCount(v.heldPct) ? v.heldPct : null,
  }
}

function ledgerOf(value: unknown): MagiLedger | null {
  if (!isObject(value) || !isObject(value.total)) return null
  return {
    days: isCount(value.days) ? value.days : 7,
    total: tallyOf(value.total),
    byMode: readable(value.byMode, one => (isObject(one) && isText(one.mode) ? { ...tallyOf(one), mode: one.mode } : null)),
    byDirection: readable(value.byDirection, one => (isObject(one) && isText(one.from) && isText(one.to) ? { ...tallyOf(one), from: one.from, to: one.to } : null)),
    costUsd: typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) ? value.costUsd : 0,
    pricedRuns: countOr0(value.pricedRuns),
  }
}

function providerOf(one: unknown): MagiProvider | null {
  if (!isObject(one)) return null
  const { name, status, reason } = one
  if (name !== 'claude' && name !== 'codex' && name !== 'omp') return null
  if (status !== 'up' && status !== 'down' && status !== 'disabled') return null
  return { name, status, reason: textOrNull(reason) }
}

// A remote that does not read is dropped alone; the rest of the fleet still draws.
function remoteOf(one: unknown): MagiRemote | null {
  if (!isObject(one) || !isText(one.name) || one.name === '') return null
  const workers = readable(one.workers, w => (isObject(w) && isText(w.taskId) && isText(w.harness) ? { taskId: w.taskId, harness: w.harness } : null))
  const live = readable(one.live, l => (isObject(l) && isText(l.taskId) && isText(l.harness) ? { taskId: l.taskId, harness: l.harness, name: isText(l.name) ? l.name : l.harness } : null))
  return { name: one.name, configured: one.configured === true, workers, live, openCards: countOr0(one.openCards) }
}

function failureOf(one: unknown): MagiFailure | null {
  if (!isObject(one) || !isText(one.taskId) || !isText(one.from) || !isText(one.to) || typeof one.at !== 'number') return null
  const ids = Array.isArray(one.coordinatorIds) ? one.coordinatorIds.filter(isText) : []
  return { taskId: one.taskId, from: one.from, to: one.to, code: isText(one.code) ? one.code : 'DELIVERY_FAILED', at: one.at, coordinatorIds: ids }
}

// Every entry of a list must read, or the whole answer is refused: a half
// picture drawn as whole would say a unit is idle when it is not.
function listOf<T>(value: unknown, read: (one: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const one of value) {
    const item = read(one)
    if (item === null) return null
    out.push(item)
  }
  return out
}

/** The status `stdout` holds, or null when it is not `magi status --json` v1. */
export function parseStatus(stdout: string): MagiStatus | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.v !== 1 || typeof raw.at !== 'number' || !isText(raw.cwd)) return null
  const units = listOf(raw.units, unitOf)
  const cards = listOf(raw.cards, cardOf)
  const outcomes = listOf(raw.outcomes, outcomeOf)
  if (!units || !cards || !outcomes || !isCount(raw.unreconciled)) return null
  return {
    v: 1,
    at: raw.at,
    cwd: raw.cwd,
    as: isText(raw.as) ? raw.as : 'claude',
    units,
    remotes: readable(raw.remotes, remoteOf),
    // Off unless the server says on: an older server never sends it.
    files: raw.files === true,
    providers: readable(raw.providers, providerOf),
    cards,
    cardsTotal: isCount(raw.cardsTotal) ? Math.max(raw.cardsTotal, cards.length) : cards.length,
    unreconciled: raw.unreconciled,
    outcomes,
    exchanges: readable(raw.exchanges, exchangeOf),
    ledger: ledgerOf(raw.ledger),
    failures: readable(raw.failures, failureOf),
    liveError: isText(raw.liveError) ? raw.liveError : null,
  }
}
