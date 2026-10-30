// The words and colours the drawings share: the palette and its kanji
// accents, how a Magi tool call reads in plain English, and the toasts.
// Pure: no `$`, so the tests read it directly. The deck's own words are in
// deck.ts.
import type { MagiHarness, MagiUnitName } from '../types'

import type { PeerKind } from './clean-peer-text.ts'

// The deck spends colour in two ways only. PURPLE is its one accent: panel
// headings and the unit frames (Unit-01's line work). The rest are signals,
// each on the one word or mark that needs it: GREEN live or up, AMBER waiting
// or open, RED failed or down. Body text is the theme's own, secondary text
// dim. ORANGE is the hazard mark in the deck's header and nothing else.
export const PURPLE = '#8A5CF6'
export const GREEN = '#39FF14'
export const RED = '#FF2A2A'
export const AMBER = '#FFB000'
export const ORANGE = '#FF6A00'
/** The hazard mark before the deck's title: NERV tape, orange on black, a few cells, never a row. */
export const HAZARD = '◢◤◢◤'
/** The thin coloured left edge of a row or a band line. */
export const EDGE = '▎ '

/**
 * Kanji, drawn only as a dim accent after the English that carries the
 * meaning, at most once per heading, and only while /magi-theme is on.
 */
export const KANJI = {
  working: '作動中',
  standby: '待機',
  request: '要請',
  reply: '回答',
  outcome: '照合',
  alert: '警告',
  exchange: '交信',
} as const

// The same table as src/status.mjs UNITS; the codename is the pane's subtitle alone.
export const UNIT_OF: Readonly<Record<MagiHarness, MagiUnitName>> = {
  claude: 'MELCHIOR-1',
  codex: 'BALTHASAR-2',
  omp: 'CASPER-3',
}

/** The accent of a peer message's row, by its kind. */
export const KIND_COLOR: Readonly<Record<PeerKind, string>> = {
  REQUEST: AMBER,
  TURN: AMBER,
  REPLY: GREEN,
  NOTE: PURPLE,
  QUESTION: AMBER,
  CLARIFICATION: PURPLE,
  WATCH: PURPLE,
}

/** The kanji accent after a peer message's header, for the kinds that have one. */
export const KIND_KANJI: Readonly<Partial<Record<PeerKind, string>>> = {
  REQUEST: KANJI.request,
  TURN: KANJI.request,
  REPLY: KANJI.reply,
}

/** The kanji accent after a Magi tool call's line, for the kinds that have one. */
const TOOL_KANJI: Readonly<Record<string, string>> = { request: KANJI.request, reply: KANJI.reply, outcome: KANJI.outcome }

/** cleanPeerText's answer less its header line: the body alone. */
export function bodyOf(cleaned: string): string {
  const at = cleaned.indexOf('\n\n')
  return at === -1 ? '' : cleaned.slice(at + 2)
}

export function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
}

/** `1 card`, `2 replies`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** How long ago, as a card's age reads: `just now`, `4m`, `3h`, `2d`. */
export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const word = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const ERROR_CODE = /magi error - ([A-Z][A-Z0-9_]*)/
const TASK_ID = /\btask_id=([\w-]+)/

/** The mod's one object guard: a plain object, its fields still unknown. */
export const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The harness a Magi tool talks to, by the name its tool ends in. */
function peerOfTool(tool: string): string {
  return /__(claude|codex|omp)_peer$/.exec(tool)?.[1] ?? 'a peer'
}

/** A result's text: a string as stored, or an MCP content list's text blocks. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks: unknown[] = Array.isArray(output) ? output : isObject(output) && Array.isArray(output.content) ? output.content : []
  return blocks.map(block => (isObject(block) && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n')
}

// The bridge's structuredContent, in whichever shape the host stored the MCP
// result: the result object, the content itself, or its text as JSON.
function resultFields(output: unknown): Readonly<Record<string, unknown>> {
  if (isObject(output)) {
    if (isObject(output.structuredContent)) return output.structuredContent
    if (!Array.isArray(output.content)) return output
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText(output))
  } catch {
    return {}
  }
  if (!isObject(parsed)) return {}
  return isObject(parsed.structuredContent) ? parsed.structuredContent : parsed
}

export type Votes = { accepted: number; rejected: number; open: number }

// What the bridge recorded, else what the call asked to record.
function votesOf(fields: Readonly<Record<string, unknown>>, args: Readonly<Record<string, unknown>>): Votes {
  const outcome = isObject(fields.outcome) ? fields.outcome : args
  return { accepted: count(outcome.accepted), rejected: count(outcome.rejected), open: count(outcome.open) }
}

type ToolAnswer = { deny?: string | undefined; isError?: boolean | undefined; result?: unknown; text?: string | undefined }

/**
 * The toast after a Magi tool call resolved, or undefined for the kinds that
 * only read (peers, transcript, recall). Built from the call's own arguments
 * and its answer; the call itself is never touched.
 */
export function toolToast(tool: string, args: Readonly<Record<string, unknown>>, ran: ToolAnswer): string | undefined {
  const peer = peerOfTool(tool)
  const kind = typeof args.kind === 'string' ? args.kind : 'request'
  if (ran.deny !== undefined) return `Magi ${kind} to ${peer} was refused`
  const said = ran.text ?? resultText(ran.result)
  if (ran.isError) {
    const code = ERROR_CODE.exec(said)?.[1]
    return `Magi ${kind} to ${peer} failed${code ? `: ${code}` : ''}`
  }
  const fields = resultFields(ran.result)
  const taskId = word(fields.taskId) ?? word(args.taskId) ?? TASK_ID.exec(said)?.[1]
  const on = taskId ? ` (${taskId})` : ''
  const host = hostOfCall(args, fields)
  const to = host ? `${peer} on ${host}` : peer
  switch (kind) {
    case 'request':
      return `${word(args.taskId) ? 'Follow-up' : 'Request'} sent to ${to}${on}`
    case 'reply':
      return `Reply sent to ${to}${on}`
    case 'note':
      return `Note sent to ${to}${on}`
    case 'clarify':
      return `Question sent${on}`
    case 'clarify_answer':
      return `Answer sent${on}`
    case 'outcome': {
      const votes = votesOf(fields, args)
      return `Outcome recorded: ${votes.accepted} accepted, ${votes.rejected} rejected, ${votes.open} open`
    }
    case 'close':
      return `Closed ${taskId ?? 'the card'}`
    case 'spawn':
      return `Starting a new ${peer} session`
    default:
      return undefined
  }
}

// The kinds src/peer-schema.mjs KINDS lists; a kind added there draws the engine's row until named here.
const KNOWN_KINDS: Readonly<Record<string, true>> = {
  request: true, reply: true, note: true, clarify: true, clarify_answer: true, outcome: true, peers: true,
  transcript: true, remember: true, recall: true, forget: true, close: true, notify: true, spawn: true,
}

/** Where a call stands, in words; the colour is the row's accent, absent drawn dim. */
export type ToolState = { label: string; color: string | undefined }

// A finished call's state, by the deliveryStatus the bridge reported; any
// other word is drawn dim as it came.
const DELIVERY: Readonly<Record<string, ToolState>> = {
  received: { label: 'delivered', color: GREEN },
  received_mid_turn: { label: 'delivered mid-turn', color: GREEN },
  queued_unread: { label: 'queued, not read yet', color: AMBER },
  unconfirmed: { label: 'sent, not confirmed', color: AMBER },
  accepted: { label: 'accepted, not confirmed', color: AMBER },
  running: { label: 'running', color: AMBER },
  failed: { label: 'failed', color: RED },
  not_applicable: { label: 'done', color: undefined },
}

/** A deliveryStatus word as the tool rows say it; an unknown word as it came, dim. */
export function deliveryState(status: string): ToolState {
  return Object.prototype.hasOwnProperty.call(DELIVERY, status) ? DELIVERY[status] as ToolState : { label: status, color: undefined }
}

/** The ToolUse props a Magi row is drawn from. */
export type ToolCallView = {
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
}

/** One Magi tool call as its row says it. */
export type ToolRow = {
  /** `Sent request to omp`, `Recorded outcome for magi-1: 5 accepted, 1 rejected, 0 open`. */
  action: string
  /** The mode and task where the action does not name them. */
  details: string[]
  /** Absent on a recorded outcome, whose counts say it. */
  state: ToolState | undefined
  /** The first line of the task or body, quoted, at most TEXT_MAX characters; '' when none. */
  text: string
  /** The row's left edge. */
  color: string
  /** The kanji accent after the line; '' for a kind without one. */
  accent: string
}

const TEXT_MAX = 60

/**
 * Reads a Magi tool call's row: what was done, to whom, on which card, and
 * where it stands. Null for a kind this mod does not know, so the engine
 * draws that row itself.
 */
/**
 * The machine a call's peer is on, from the call itself: its `host`
 * argument, a remote run's result, or a relayed delivery's `via`
 * (`relay:<host>:…`). Undefined on this machine, or when the call does not say.
 */
export function hostOfCall(input: Readonly<Record<string, unknown>>, fields: Readonly<Record<string, unknown>>): string | undefined {
  return word(input.host) ?? word(fields.host) ?? /^relay:([^:]+)/.exec(word(fields.via) ?? '')?.[1]
}

/**
 * A Magi call as one row. `hostOf` finds the machine a card's worker is on
 * (from the status), for a call that does not say so itself, so a row to a
 * peer on another machine always reads `omp on mac`.
 */
export function toolRow(view: ToolCallView, hostOf?: (taskId: string) => string | null | undefined): ToolRow | null {
  const input = view.input
  if (!isObject(input)) return null
  const kind = input.kind === undefined ? 'request' : input.kind
  if (typeof kind !== 'string' || KNOWN_KINDS[kind] !== true) return null
  const peer = peerOfTool(view.tool)
  const isDone = !view.isRunning && !view.isErrored && !view.isInterrupted
  const fields: Readonly<Record<string, unknown>> = isDone ? resultFields(view.output) : {}
  const continued = word(input.taskId)
  const taskId = word(fields.taskId) ?? continued ?? (isDone ? TASK_ID.exec(resultText(view.output))?.[1] : undefined)
  const card = taskId ?? 'a card'
  const mode = word(fields.mode) ?? word(input.mode)
  const votes = votesOf(fields, input)
  const host = hostOfCall(input, fields) ?? (taskId ? hostOf?.(taskId) ?? undefined : undefined)
  const to = host ? `${peer} on ${host}` : peer
  // A card-only row (a question, an outcome, a close) names the far end only when it is remote.
  const remote = host ? `with ${to}` : undefined
  const [action, details] = ((): [string, (string | undefined)[]] => {
    switch (kind) {
      case 'request':
        return continued ? [`Continued ${continued} with ${to}`, [mode]] : [`Sent request to ${to}`, [mode, taskId]]
      case 'note':
        return [`Sent note to ${to}`, [taskId]]
      case 'reply':
        return [`Replied to ${to}`, [taskId]]
      case 'clarify':
        return [`Asked a question on ${card}`, [remote]]
      case 'clarify_answer':
        return [`Answered question on ${card}`, [remote]]
      case 'outcome':
        return [`Recorded outcome for ${card}: ${votes.accepted} accepted, ${votes.rejected} rejected, ${votes.open} open`, [remote]]
      case 'peers':
        return [host ? `Listed peers on ${host}` : 'Listed peers', []]
      case 'transcript':
        return [`Read ${to}'s transcript`, []]
      case 'remember':
        return ['Saved to memory', []]
      case 'recall':
        return ['Searched memory', []]
      case 'forget':
        return ['Removed from memory', []]
      case 'close':
        return [`Closed ${card}`, [remote]]
      case 'notify':
        return ['Flagged for your attention', []]
      default: // spawn
        return [`Started a new ${peer} session`, []]
    }
  })()
  let state: ToolState | undefined
  if (view.isInterrupted) state = { label: 'interrupted', color: RED }
  else if (view.isErrored) {
    const code = ERROR_CODE.exec(resultText(view.output))?.[1]
    state = { label: code ? `failed: ${code}` : 'failed', color: RED }
  } else if (view.isRunning) state = { label: 'running', color: AMBER }
  else if (kind !== 'outcome') {
    state = deliveryState(word(fields.deliveryStatus) ?? 'not_applicable')
  }
  const line = firstLine(word(input.task) ?? word(input.body) ?? '')
  const chars = [...line]
  return {
    action,
    details: details.filter((detail): detail is string => detail !== undefined),
    state,
    text: line ? `"${chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : line}"` : '',
    color: state?.color ?? GREEN,
    accent: TOOL_KANJI[kind] ?? '',
  }
}
