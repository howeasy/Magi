// The shapes below mirror src/protocol.mjs; test/magi-view.test.mjs composes
// every kind there and runs it through this file, so a protocol change that
// would leave text behind fails Magi's own suite.
const HEADER = /^PEER (REQUEST|TURN|REPLY|NOTE|QUESTION|CLARIFICATION|WATCH) magi\/1\b([^\n]*)\n?/
const MARKER = /\s*<!-- magi-delivery:[\w-]+ -->\s*$/
const REDACTED = /\n\n\[magi: \d+ secret-like value\(s\) redacted\]$/
// Claude Code's own framing of another session's message, which a row's text
// can still carry (seen on 2.1.29x desktop rows): "Another Claude session sent
// a message:", the message inside <cross-session-message …>, then the
// engine's advice to the model. The Magi message is what sits inside.
const WRAPPED = /^\s*(?:Another Claude session sent a message:\s*)?<cross-session-message\b[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/

/** The Magi message inside the engine's framing, or the text as given. */
function unwrap(text: string): string {
  return WRAPPED.exec(text)?.[1] ?? text
}

// The opening words of the closing paragraph protocol.mjs writes per kind.
const FOOTERS: Readonly<Record<string, string>> = {
  REPLY: 'Check each material finding against the source.',
  NOTE: 'This is conversation, not a request or a final reply.',
  QUESTION: 'Answer once with kind="clarify_answer"',
  CLARIFICATION: 'Use this to finish the requested checks.',
}

export type PeerKind = 'REQUEST' | 'TURN' | 'REPLY' | 'NOTE' | 'QUESTION' | 'CLARIFICATION' | 'WATCH'

/** What a Magi message's header says, in the words a person reads. */
export type PeerHead = {
  kind: PeerKind
  /** Who sent it, as the header names it (`omp`); absent on an answer to a question. */
  sender: string | undefined
  taskId: string | undefined
  /** The machine the sender is on, when the header names one (a request's `orchestrator_host`). */
  host: string | undefined
  /** `Reply from omp`, `Reply from omp on mac`, `Answer to your question`. */
  title: string
  /** What follows the title: the mode, the task and the round, those the header has. */
  details: string[]
}

function headOf(header: RegExpExecArray): PeerHead {
  const kind = header[1] as PeerKind
  const fields = header[2] ?? ''
  const isRequest = kind === 'REQUEST' || kind === 'TURN'
  const sender = (isRequest ? /\borchestrator=([\w-]+)/ : /\bfrom=([\w-]+)/).exec(fields)?.[1]
  const taskId = /\btask_id=(\S+)/.exec(fields)?.[1]
  const mode = isRequest ? /\bmode=([A-Z_]+)/.exec(fields)?.[1] : undefined
  const step = /\b(round|turn)=(\d+)(?:\/(\d+))?/.exec(fields)
  // A request from another machine names its orchestrator's host in the header.
  const host = isRequest ? /\borchestrator_host=([\w.-]+)/.exec(fields)?.[1] : undefined
  const from = `${sender ?? 'a peer'}${host ? ` on ${host}` : ''}`
  const titles: Readonly<Record<PeerKind, string>> = {
    REQUEST: `Request from ${from}`,
    TURN: `Follow-up request from ${from}`,
    REPLY: `Reply from ${from}`,
    NOTE: `Note from ${from}`,
    QUESTION: `Question from ${from}`,
    CLARIFICATION: 'Answer to your question',
    WATCH: `Check-in from ${from}`,
  }
  const round = step ? `${step[1]} ${step[2]}${step[3] ? `/${step[3]}` : ''}` : undefined
  return {
    kind,
    sender,
    taskId,
    host,
    title: titles[kind],
    details: [mode, taskId, round].filter((detail): detail is string => detail !== undefined),
  }
}

/**
 * The head with the sender's machine added, for a message whose header does
 * not name it (a reply, note or question from a worker on another machine:
 * the card's status knows where the worker is). A head that names one keeps it.
 */
export function onHost(head: PeerHead, host: string | null | undefined): PeerHead {
  if (!host || head.host || head.sender === undefined) return head
  return { ...head, host, title: head.title.replace(head.sender, `${head.sender} on ${host}`) }
}

/** The header of a Magi message, or null for any other text. */
export function peerHead(text: string): PeerHead | null {
  const header = HEADER.exec(unwrap(text))
  return header ? headOf(header) : null
}

/**
 * A Magi message as a person reads it: one header line (`Reply from omp ·
 * magi-1 · round 2`), then the body, without the PEER line, the protocol's
 * closing paragraph or the delivery marker. Any other text comes back as sent.
 */
export function cleanPeerText(given: string): string {
  const text = unwrap(given)
  const header = HEADER.exec(text)
  if (!header) return given
  const head = headOf(header)
  const rest = text.slice(header[0].length).replace(MARKER, '').replace(REDACTED, '')
  const label = [head.title, ...head.details].join(' · ')
  const body = bodyOf(head.kind, rest).trim()
  return body ? `${label}\n\n${body}` : label
}

function bodyOf(kind: PeerKind, rest: string): string {
  switch (kind) {
    case 'REQUEST': // TASK, its one-line brief, a blank line, the task, then MODE
      return /\nTASK\n[^\n]*\n\n([\s\S]*?)\n\nMODE\n/.exec(rest)?.[1] ?? rest
    case 'TURN': // ASK, the task, the mode's one-line ask, then the next section
      return /^\s*ASK\n([\s\S]*?)\n[^\n]*\n\n(?:CONTEXT|COUNTERPARTY CLAIMS|INDEPENDENCE)\n/.exec(rest)?.[1] ?? rest
    case 'WATCH':
      return /\n\nThey also said: ([\s\S]*)$/.exec(rest)?.[1] ?? 'asks to hear when you are free'
    default: {
      const footer = FOOTERS[kind]
      const at = footer === undefined ? -1 : rest.lastIndexOf(`\n\n${footer}`)
      return at === -1 ? rest : rest.slice(0, at)
    }
  }
}
