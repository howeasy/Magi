import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderPropsOf, ToolCallArgs } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const WIDTHS = [40, 80, 120] as const
const MINUTE = 60_000
// An hour in, so a card can have been open longer than the silence threshold.
const NOW = 60 * MINUTE

const UNITS = [
  { unit: 'MELCHIOR-1', harness: 'claude', state: 'standby', sessions: 1, working: 0, workers: 0, openCards: 0 },
  { unit: 'BALTHASAR-2', harness: 'codex', state: 'active', sessions: 0, working: 0, workers: 1, openCards: 1 },
  { unit: 'CASPER-3', harness: 'omp', state: 'active', sessions: 1, working: 1, workers: 0, openCards: 3 },
]
const PROVIDERS = [
  { name: 'claude', status: 'up', reason: null },
  { name: 'codex', status: 'up', reason: null },
  { name: 'omp', status: 'disabled', reason: null },
]
const coordinator = (name: string, id: string) => ({ harness: 'claude', name, ids: [id] })

// This session's omp card whose delivery failed and its omp card that spoke
// 3 minutes ago; Gen 2 Boogaloo's headless codex run; a question from omp.
// Only a failed delivery on this session's own card alerts.
const DECK = {
  v: 1, at: NOW, cwd: '/work', as: 'claude', units: UNITS, providers: PROVIDERS,
  cards: [
    {
      taskId: 'magi-aaaa0004', mode: 'REVIEW', from: 'claude', to: 'omp', round: 1, maxRounds: 2, turn: 'peer', openedAt: 20 * MINUTE, questionAt: null,
      coordinator: coordinator('Magi Git repo', 'sess-here'),
      worker: { harness: 'omp', name: 'omp session 01a118ef', id: '01a118ef', live: true, state: 'working', lastActivityAt: null, lastSaid: null, via: 'live' },
      brief: 'Review the ledger', delivery: [{ to: 'omp', status: 'failed', at: 20 * MINUTE }], lastExchangeAt: 20 * MINUTE, recent: [],
    },
    {
      taskId: 'magi-aaaa0001', mode: 'DELEGATE', from: 'claude', to: 'omp', round: 1, maxRounds: 2, turn: 'peer', openedAt: 46 * MINUTE, questionAt: null,
      coordinator: coordinator('Magi Git repo', 'sess-here'),
      worker: { harness: 'omp', name: 'Polished-2', id: '0f1e2d3c', live: true, state: 'working', lastActivityAt: 57 * MINUTE, lastSaid: 'Reading src/status.mjs to add the worker fields.', via: 'live' },
      brief: 'Make the band working line open a pane', delivery: [{ to: 'omp', status: 'queued_unread', at: 46 * MINUTE }], lastExchangeAt: 57 * MINUTE,
      recent: [
        { at: 46 * MINUTE, from: 'claude', kind: 'request', text: 'Make the band working line open a pane' },
        { at: 57 * MINUTE, from: 'omp', kind: 'note', text: 'Reading src/status.mjs to add the worker fields.' },
      ],
    },
    { taskId: 'magi-aaaa0002', mode: 'REVIEW', from: 'claude', to: 'omp', round: 1, maxRounds: 2, turn: 'orchestrator', openedAt: 50 * MINUTE, questionAt: 53 * MINUTE, coordinator: coordinator('Magi Git repo', 'sess-here') },
    {
      taskId: 'magi-aaaa0003', mode: 'REVIEW', from: 'claude', to: 'codex', round: 1, maxRounds: 2, turn: 'peer', openedAt: 59 * MINUTE, questionAt: null,
      coordinator: coordinator('Gen 2 Boogaloo', 'sess-gen2'),
      worker: { harness: 'codex', name: 'headless codex', id: null, live: false, state: 'working', lastActivityAt: null, lastSaid: null, via: 'headless' },
      brief: 'Review the pane', delivery: [{ to: 'codex', status: 'running', at: 59 * MINUTE }], lastExchangeAt: 59 * MINUTE, recent: [],
    },
  ],
  cardsTotal: 4, unreconciled: 0,
  outcomes: [{ taskId: 'magi-bbbb0001', mode: 'REVIEW', from: 'claude', to: 'omp', accepted: 5, rejected: 1, open: 0, at: 30 * MINUTE }],
  exchanges: [
    { at: 57 * MINUTE, taskId: 'magi-aaaa0001', from: 'omp', to: 'claude', kind: 'note', text: 'Reading src/status.mjs to add the worker fields.' },
    { at: 30 * MINUTE, taskId: 'magi-bbbb0001', from: 'omp', to: 'claude', kind: 'reply', text: 'SUMMARY Five findings held.' },
  ],
  ledger: {
    days: 7,
    total: { cards: 5, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 },
    byMode: [{ mode: 'REVIEW', cards: 4, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 }],
    byDirection: [{ from: 'claude', to: 'omp', cards: 4, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 }],
    costUsd: 0.42, pricedRuns: 1,
  },
  failures: [],
  liveError: null,
}
// This session's card alone, nothing late: no alerts, so no band.
const CALM = { ...DECK, cards: [DECK.cards[1]], cardsTotal: 1 }
const QUIET = {
  ...DECK, cards: [], cardsTotal: 0, outcomes: [], exchanges: [], failures: [],
  ledger: { days: 7, total: { cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0, heldPct: null }, byMode: [], byDirection: [], costUsd: 0, pricedRuns: 0 },
}

type Found = { type: string; text: string; props: Record<string, unknown>; children: unknown[] }
type Findable = { findAll: (query: { text?: RegExp; type?: string }) => Promise<Found[]> }
// A found element's text includes its nested elements' text; judge the
// leaves, the elements that draw only strings, so each piece is seen once.
const isLeaf = (el: Found) => !el.children.some(child => typeof child === 'object' && child !== null)

// Kanji and the units' codenames only ever follow English: each its own dim
// Text that starts with spaces. MAGI in capitals never appears. Returns what breaks it.
async function accentsOnly(ui: Findable): Promise<string[]> {
  const bad = (await ui.findAll({ text: /[\u3040-\u30ff\u4e00-\u9fff]|MELCHIOR|BALTHASAR|CASPER/ }))
    .filter(isLeaf)
    .filter(el => el.type !== 'Text' || el.props.dimColor !== true || !/^\s+\S/.test(el.text))
    .map(el => el.text)
  return [...bad, ...(await ui.findAll({ text: /MAGI/ })).filter(isLeaf).map(el => el.text)]
}

const MARKER = '\n<!-- magi-delivery:0f1e2d3c-0000-4000-8000-000000000001 -->'
const REPLY =
  'PEER REPLY magi/1 task_id=magi-1 round=1 from=omp\n\nSUMMARY\nHolds.\n\n' +
  'Check each material finding against the source. Continue this card with kind="request" taskId="magi-1".' + MARKER

// One per kind; the senders cover all three harnesses. [text, title, details, body, accent]
const KINDS: readonly (readonly [string, string, string, string, string])[] = [
  [REPLY, 'Reply from omp', 'magi-1 · round 1', 'SUMMARY\nHolds.', '回答'],
  ['PEER REQUEST magi/1 task_id=magi-2 orchestrator=codex name="lead" peer=claude mode=REVIEW round=1/2 delegation_depth=1 write_policy=read-only\n\n' +
    'ROLE\nYou are the PEER.\n\nTASK\nIndependently verify the claims below.\n\nIs X true?\n\nMODE\nREVIEW. Check.',
    'Request from codex', 'REVIEW · magi-2 · round 1/2', 'Is X true?', '要請'],
  ['PEER NOTE magi/1 task_id=magi-3 from=claude\n\nLooking at it now.\n\nThis is conversation, not a request or a final reply. It opens no turn.',
    'Note from claude', 'magi-3', 'Looking at it now.', ''],
  ['PEER QUESTION magi/1 task_id=magi-4 round=1 question_id=q-1 from=codex\n\nWhich branch?\n\nAnswer once with kind="clarify_answer" taskId="magi-4" round=1.',
    'Question from codex', 'magi-4 · round 1', 'Which branch?', ''],
  ['PEER CLARIFICATION magi/1 task_id=magi-5 question_id=q-1\n\nUse main.\n\nUse this to finish the requested checks. When ready, send your reply.',
    'Answer to your question', 'magi-5', 'Use main.', ''],
  ['PEER TURN magi/1 task_id=magi-6 turn=3 mode=DELEGATE orchestrator=omp write_policy=workspace\n\nASK\nNext step.\nDo the ask.\n\nCONTEXT\nctx',
    'Follow-up request from omp', 'DELEGATE · magi-6 · turn 3', 'Next step.', '要請'],
  ['PEER WATCH magi/1 from=omp\n\nomp is waiting to hear when you are free.', 'Check-in from omp', '', 'asks to hear when you are free', ''],
]

type World = {
  clock: MockClock
  toasts: string[]
  statuses: (string | undefined)[]
  runs: (readonly string[])[]
  drawn: string[]
  calls: Record<string, unknown>[]
  /** The ToolUse props the engine was asked to draw. */
  toolRows: RenderPropsOf['ToolUse'][]
  /** The ids `ui.panes` lists: what the mod opened, until it or a test closed them. */
  openPanes: string[]
  /** Every `ui.open` the mod asked for. */
  opened: Record<string, unknown>[]
}

const ran = (stdout: string, exitCode = 0, stderr = ''): ProcessRunResult =>
  ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

/** Everything beneath the mod: the engine stand-ins and the nouns it calls. */
// What `magi exchange <id> --json` prints for a card: its whole conversation, words in full.
const LONG_REPLY = `SUMMARY\nFive findings held.\n\nFINDINGS\n${'- a finding with its evidence at src/status.mjs:120\n'.repeat(12)}`
const threadOf = (taskId: string) => ({
  taskId,
  mode: 'DELEGATE',
  from: 'claude',
  to: 'omp',
  omitted: 0,
  messages: [
    { at: NOW - 600_000, kind: 'request', round: 1, from: 'claude', to: 'omp', text: 'Make the band working line open a pane.\n\nKeep the deck as it is otherwise.' },
    { at: NOW - 60_000, kind: 'reply', round: 1, from: 'omp', to: 'claude', text: LONG_REPLY },
  ],
})

function world(on: On, run: ProcessRunResult = ran(JSON.stringify(DECK)), store: Record<string, unknown> = {}, now = NOW): World {
  const w: World = { clock: mock.clock(on, { now }), toasts: [], statuses: [], runs: [], drawn: [], calls: [], toolRows: [], openPanes: [], opened: [] }
  mock.store(on, store)
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    w.runs.push(e.argv)
    if (e.argv.includes('exchange')) return { value: ran(JSON.stringify(threadOf(e.argv[e.argv.indexOf('exchange') + 1] ?? ''))) }
    return { value: e.argv.includes('provider') ? ran('') : run }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-here' }))
  on('ui.open', (_$, e) => {
    w.opened.push({ ...e })
    if (!w.openPanes.includes(e.id)) w.openPanes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.openPanes = w.openPanes.filter(id => id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.openPanes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('tool.call', (_$, e) => {
    w.calls.push({ ...e })
    return { result: { ok: true }, text: 'sent' }
  })
  on('ui.render', { component: 'UserMessage' }, (_$, e) => {
    w.drawn.push(e.props.text)
    return { type: 'Text', children: [e.props.text] }
  })
  on('ui.render', { component: 'ToolUse' }, (_$, e) => {
    w.toolRows.push(e.props)
    return { type: 'Text', children: [`engine row ${e.props.tool}`] }
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'Pane' }, () => ({ type: 'Box', children: [] }))
  return w
}

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const row = (text: string, isExpanded: boolean, kind: 'peer' | 'composer' = 'peer') =>
  ({ component: 'UserMessage' as const, props: { text, origin: { kind }, isExpanded } })
// The band with the session idle (no turn running), and mid-turn.
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}
const BUSY = { ...BAND, props: { ...BAND.props, isWorking: true } }
const deck = (bodyColumns: number, placement: 'dock' | 'inline' = 'dock') => ({
  component: 'Pane' as const,
  requestId: 'magi',
  props: { title: 'Magi', isFocused: true, bodyColumns, placement, scroll: { offset: 0, bodyRows: 70 }, view: {} },
})
const texts = async (ui: Findable, pattern: RegExp) => (await ui.findAll({ type: 'Text', text: pattern })).filter(isLeaf).map(el => el.text)

describe('peer message rows', () => {
  test('expanded, each kind is a plain header line (who, which card, which round) over the cleaned body, kanji only as an accent after it', async ($, on) => {
    const w = world(on)
    for (const surface of SURFACES) {
      for (const [index, [text, title, details, body, kanji]] of KINDS.entries()) {
        w.drawn.length = 0
        const ui = await $.ui.mount({ plugin: 'magi-view', surface, requestId: `msg-${surface}-${index}`, ...row(text, true) })
        expect(await ui.find({ type: 'Text', text: title }), `${title} on ${surface}`).toBeDefined()
        if (details) expect(await ui.find({ type: 'Text', text: ` · ${details}` })).toBeDefined()
        expect(await ui.find({ text: /magi\/1|magi-delivery|kind="/ })).toBeUndefined()
        if (kanji) expect(await ui.find({ type: 'Text', text: `  ${kanji}` }), title).toBeDefined()
        expect(await accentsOnly(ui)).toEqual([])
        // The engine draws the body, the cleaned text less its header line.
        expect([...new Set(w.drawn)]).toEqual([body])
        await ui.unmount()
      }
    }
  })

  test('collapsed, a row is one line: the header, a colon, the first line of the body', async ($, on) => {
    const w = world(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, requestId: `msg-${surface}`, ...row(REPLY, false) })
      expect([...new Set(w.drawn)]).toEqual([])
      expect(await ui.findAll({ type: 'Box' })).toHaveLength(1)
      expect(await ui.find({ type: 'Text', text: 'Reply from omp' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · magi-1 · round 1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ': SUMMARY' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Holds.' })).toBeUndefined()
      expect(await accentsOnly(ui)).toEqual([])
      await ui.unmount()
    }
  })

  test("a row that still carries the engine's cross-session framing is drawn like a bare one", async ($, on) => {
    const w = world(on)
    const wrapped =
      'Another Claude session sent a message:\n<cross-session-message from-session="01a1" from-name="omp:Check" from-mode="bypass">\n' +
      REPLY +
      '\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.'
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, requestId: `wrapped-${surface}`, ...row(wrapped, false) })
      expect([...new Set(w.drawn)]).toEqual([])
      expect(await ui.find({ type: 'Text', text: 'Reply from omp' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · magi-1 · round 1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cross-session|Another Claude session|magi-delivery/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test("a peer message that is not Magi's is drawn by the engine as sent", async ($, on) => {
    const w = world(on)
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...row('hello from another session', true) })
    expect([...new Set(w.drawn)]).toEqual(['hello from another session'])
    expect(await ui.find({ type: 'Text', text: /from omp|from claude|from codex/ })).toBeUndefined()
  })

  test("the person's own prompt is drawn as typed, protocol words and all", async ($, on) => {
    const w = world(on)
    for (const surface of SURFACES) {
      await $.ui.mount({ plugin: 'magi-view', surface, ...row(REPLY, true, 'composer') })
    }
    expect([...new Set(w.drawn)]).toEqual([REPLY])
    expect(w.toasts).toEqual([])
  })

  test('a reply row toasts once when it first appears, on any surface, across sessions', async ($, on) => {
    const w = world(on, undefined, { repliesSeen: ['msg-old'] })
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', requestId: 'msg-new', ...row(REPLY, true) })
    await ui.redraw()
    await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', requestId: 'msg-new', ...row(REPLY, false) })
    await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', requestId: 'msg-old', ...row(REPLY, true) })
    await w.clock.settle()
    expect(w.toasts).toEqual(['Reply from omp (magi-1)'])
  })

  test('/magi-theme off leaves the row to the engine with the protocol text removed, no accent; a bare /magi-theme toggles back', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'magi-theme', args: 'off', ...COMMAND })
    w.drawn.length = 0
    const plain = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', requestId: 'm1', ...row(REPLY, true) })
    expect([...new Set(w.drawn)]).toEqual(['Reply from omp · magi-1 · round 1\n\nSUMMARY\nHolds.'])
    expect(await plain.findAll({ type: 'Box' })).toHaveLength(0)
    expect(await plain.find({ text: /回答/ })).toBeUndefined()
    expect(w.toasts).toContain('Magi styling off: Claude Code draws the rows (no protocol text), the deck plain')

    await $.command.run({ command: 'magi-theme', args: '', ...COMMAND })
    const styled = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', requestId: 'm2', ...row(REPLY, true) })
    expect(await styled.find({ type: 'Text', text: 'Reply from omp' })).toBeDefined()
    expect((await styled.findAll({ type: 'Box' })).length).toBeGreaterThan(0)
  })

  test('a stored off is read back when the session starts', async ($, on) => {
    const w = world(on, undefined, { theme: 'off' })
    await $.session.start(START)
    await w.clock.settle()
    await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', requestId: 'm1', ...row(REPLY, true) })
    expect([...new Set(w.drawn)]).toEqual(['Reply from omp · magi-1 · round 1\n\nSUMMARY\nHolds.'])
  })
})

// The desktop draws each section's body as an Svg panel; its alt says the same in English.
const alts = async (ui: Findable) => (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
const sources = async (ui: Findable) => (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source))
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]/u
const SECTIONS = ['Your move', 'Units', 'Working', 'Exchange', 'Ledger', 'Providers']

describe('the deck', () => {
  test('a possible Claude hold is visible without expanding a card, on terminal and desktop, and wraps', async ($, on) => {
    const statusText = 'may have been held for approval at that Claude session and dropped after 5 min; ask the user to check/approve there or resend'
    const picture = { ...CALM, cards: [{ ...DECK.cards[1], to: 'claude', delivery: [{ to: 'claude', status: 'unconfirmed', at: NOW - 10 * MINUTE, statusText }] }] }
    const w = world(on, ran(JSON.stringify(picture)))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(40) })
      const line = await ui.find({ type: 'Text', text: `to claude: ${statusText}` })
      expect(line).toBeDefined()
      expect(line?.props.wrap).toBe('wrap')
      await ui.unmount()
    }
  })

  test('every section draws on terminal and desktop at 40, 80 and 120 columns: text with rules, or Svg panels in the chosen font', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      for (const columns of WIDTHS) {
        const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(columns) })
        const at = `${surface} at ${columns}`
        expect(await ui.find({ type: 'Text', text: 'Magi deck' }), at).toBeDefined()
        if (surface === 'terminal') {
          for (const section of SECTIONS) {
            expect(await ui.find({ type: 'Text', text: new RegExp(`^${section}$`) }), `${section} on ${at}`).toBeDefined()
          }
          // A rule runs from each heading to the right edge; a hairline closes each card row.
          expect(await ui.find({ type: 'Text', text: /^ ─+$/ }), at).toBeDefined()
          expect((await ui.findAll({ type: 'Text', text: /^╌+$/ })).length, at).toBeGreaterThan(2)
          expect(await ui.find({ type: 'Text', text: '  MELCHIOR-1' }), at).toBeDefined()
          expect(await ui.find({ type: 'Svg' }), at).toBeUndefined()
          // A card's name is its button: who and the task line (the mode and round are its tags),
          // cut to the room the row leaves beside its tags and the clock.
          const head = await ui.find({ type: 'Button', key: 'card-magi-aaaa0001' })
          expect(head?.text, at).toBe(columns >= 120 ? 'omp · Polished-2 · Make the band working line open a pane' : columns >= 80 ? 'omp · Polished-2 · Make the band working line …' : 'omp · …')
          // The second line: where the worker stands, its words and how long ago, the receipt of the last message.
          expect(await ui.find({ type: 'Text', text: ' · 3m ago · Reading src/status.mjs to add the worker fields.' }), at).toBeDefined()
          expect(await ui.find({ type: 'Text', text: /^ ✓✓ delivered, unread \d\d:\d\d$/ }), at).toBeDefined()
          expect(await ui.find({ type: 'Text', text: 'SUMMARY Five findings held.' }), at).toBeDefined()
          expect(await ui.find({ type: 'Text', text: 'Last 7 days: 5 cards, 1 checked · 83% held · 5 accepted · 1 rejected' }), at).toBeDefined()
          // A kanji at most once per heading, and on no other line.
          expect((await texts(ui, /[\u4e00-\u9fff]/)).sort(), at).toEqual(['  交信', '  作動中', '  照合', '  警告'])
        } else {
          const list = await alts(ui)
          for (const section of SECTIONS) {
            expect(list.some(alt => alt.startsWith(section)), `${section} on ${at}`).toBe(true)
          }
          // Every panel names the font option first and carries its own size, no width prop: the slot scales it.
          for (const svg of await ui.findAll({ type: 'Svg' })) {
            expect(svg.props.isInteractive, at).toBeUndefined()
            expect(svg.props.width, at).toBeUndefined()
            expect(String(svg.props.source), at).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="\d+" height="\d+" /)
            expect(String(svg.props.source), at).toContain("&#39;0xProto Nerd Font Mono&#39;, &#39;JetBrainsMono Nerd Font Mono&#39;")
          }
          // The triad only from 66 columns; the card rows, the exchange and the ledger always.
          expect(list.some(alt => /^claude \(MELCHIOR-1\) standby, 1 live session; codex \(BALTHASAR-2\) working/.test(alt)), at).toBe(columns >= 66)
          expect(list, at).toContain('omp Polished-2 · Make the band working line open a pane · DELEGATE · round 1 · live · working · 3m ago: Reading src/status.mjs to add the worker fields. · last message delivered, unread')
          expect(list.some(alt => alt.includes('magi-bbbb0001 · to claude: ') && alt.includes('reply SUMMARY Five findings held.')), at).toBe(true)
          expect(list.some(alt => alt.startsWith('last 7 days: 5 cards, 83% held; claude → omp: 83% held, 5 accepted, 1 rejected, 0 open')), at).toBe(true)
          // The open mark is the card's button, with its hotkey; the clock stays native.
          expect((await ui.find({ type: 'Button', key: 'card-magi-aaaa0001' }))?.text, at).toBe('▸')
          expect((await ui.findAll({ type: 'Client' })).filter(c => String(c.props.module).endsWith('elapsed.tsx')).length, at).toBe(3)
          // Below 66 columns the units are a line each, the codename dim after the name, on this surface too.
          expect((await ui.find({ type: 'Text', text: '  MELCHIOR-1' })) === undefined, at).toBe(columns >= 66)
          expect(await texts(ui, /[\u4e00-\u9fff]/), at).toEqual([])
        }
        // Shut, a card is its rows (the exchange's thread title carries the task line, as a longer text); open, each field is a dim 'Label: ' before its value, natively on both surfaces.
        expect(await ui.find({ type: 'Text', text: /^Make the band working line open a pane$/ }), at).toBeUndefined()
        await ui.press({ key: 'card-magi-aaaa0001' })
        for (const [label, value] of [
          ['Asked: ', 'Make the band working line open a pane'],
          ['Said (3m ago): ', 'Reading src/status.mjs to add the worker fields.'],
          ['Delivery: ', 'queued, not read yet'],
        ] as const) {
          expect(await ui.find({ type: 'Text', text: label }), `${label} on ${at}`).toBeDefined()
          expect(await ui.find({ type: 'Text', text: value }), `${value} on ${at}`).toBeDefined()
        }
        expect(await ui.find({ type: 'Text', text: 'magi-aaaa0001 · live session, working · session 0f1e2d3c' }), at).toBeDefined()
        await ui.press({ key: 'card-magi-aaaa0001' })
        expect(await accentsOnly(ui), at).toEqual([])
        // Raw bridge words, empty fields and zero counts never reach the person.
        expect(await ui.find({ text: /queued_unread|undefined|null|NaN|\b0 (accepted|rejected|open)\b/ }), at).toBeUndefined()
        // One column at every width: no half-width split.
        expect((await ui.findAll({ type: 'Box' })).filter(box => box.props.width === Math.floor((columns - 2) / 2)).length, at).toBe(0)
        await ui.unmount()
      }
    }
  })

  test('colour is spent on headings and signals alone: the hazard mark, the edges of what waits, live marks, workers at work, receipts, held rates, a provider up', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(80) })
      const coloured = (await ui.findAll({ type: 'Text' }))
        .filter(isLeaf)
        .filter(el => typeof el.props.color === 'string')
        .map(el => `${el.props.color} ${el.text}`.replace(/\d\d:\d\d/, 'HH:MM'))
      expect(coloured.sort(), surface).toEqual(surface === 'terminal'
        ? [
          // Providers up, this session's workers at work (their marks and words), a message coming in, a reply's mark,
          // the direction bar, the live unit marks; the headings; a failed receipt and its alert's edge; what waits in amber.
          '#39FF14  up', '#39FF14  up', '#39FF14 working', '#39FF14 working', '#39FF14 ←', '#39FF14 ←', '#39FF14 █████████',
          '#39FF14 ○', '#39FF14 ●', '#39FF14 ● ', '#39FF14 ● ',
          '#8A5CF6 Exchange', '#8A5CF6 Ledger', '#8A5CF6 Providers', '#8A5CF6 Units', '#8A5CF6 Working', '#8A5CF6 Your move',
          '#FF2A2A  ✗ failed HH:MM', '#FF2A2A █', '#FF2A2A ▎ ', '#FF6A00 ◢◤◢◤',
          '#FFB000  7m ago', '#FFB000 83% held', '#FFB000 ▎ ',
        ]
        : [
          // The panels carry the rest inside their markup; natively only the providers and the hazard mark.
          '#39FF14  up', '#39FF14  up', '#FF6A00 ◢◤◢◤',
        ])
      const clients = (await ui.findAll({ type: 'Client' })).map(c => String(c.props.module).replace(/^.*\//, ''))
      if (surface === 'terminal') {
        // The units' frames are the accent; the marks of the units a card is in flight to beat, and the cards run along the bus.
        expect((await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'single').map(box => box.props.borderColor)).toEqual(['#8A5CF6', '#8A5CF6', '#8A5CF6'])
        expect(clients.filter(m => m === 'pulse.tsx')).toHaveLength(2)
        const bus = await ui.find({ type: 'Client', key: 'bus' })
        const props = bus?.props.props as { ports: number[]; lanes: { from: number; to: number; color: string }[] }
        expect(props.ports).toEqual([13, 40, 67])
        expect(props.lanes).toEqual([
          { from: 13, to: 67, color: '#FF6A00' }, { from: 13, to: 67, color: '#FF6A00' }, { from: 67, to: 13, color: '#FFB000' }, { from: 13, to: 40, color: '#8A5CF6' },
        ])
      } else {
        // The triad carries the units, their marks and the packets: no box, pulse or bus beside it.
        expect(clients.filter(m => m === 'pulse.tsx' || m === 'bus.tsx')).toEqual([])
        expect((await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'single')).toEqual([])
        const triad = (await ui.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith('claude (MELCHIOR-1)'))
        expect(String(triad?.props.source)).toContain('<animateMotion ')
        // The card panels: this session's full, another session's faded; the stalled and failed signals in their colours.
        const rows = (await ui.findAll({ type: 'Svg' })).filter(svg => /· (live|headless) ·/.test(String(svg.props.alt))).map(svg => String(svg.props.source))
        expect(rows.map(source => /<g opacity="([\d.]+)">/.exec(source)?.[1])).toEqual(['1', '1', '0.55'])
        expect(rows[0]).toContain(`fill="${'#FF2A2A'}"`)
      }
      // The providers are chips in the frame colour.
      expect((await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').map(box => box.props.borderColor)).toEqual(['#8A5CF6', '#8A5CF6', '#8A5CF6'])
      await ui.unmount()
    }
  })

  test('the ledger reads by direction; Details opens the rows by mode and the last verdicts; a row with nothing counted is never drawn', async ($, on) => {
    const ledger = {
      ...DECK.ledger,
      byMode: [...DECK.ledger.byMode, { mode: 'DEBATE', cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0, heldPct: null }],
      byDirection: [...DECK.ledger.byDirection, { from: 'claude', to: 'codex', cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0, heldPct: null }],
    }
    const outcomes = [...DECK.outcomes, { taskId: 'magi-bbbb0002', mode: 'DELEGATE', from: 'claude', to: 'codex', accepted: 0, rejected: 0, open: 0, at: 40 * MINUTE }]
    const w = world(on, ran(JSON.stringify({ ...DECK, ledger, outcomes, unreconciled: 2 })))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(80) })
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: 'Last 7 days: 5 cards, 1 checked · 83% held · 5 accepted · 1 rejected' }), surface).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'claude → omp' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '83% held' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '5 accepted · 1 rejected · 4 cards' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Headless runs cost $0.42 (1 priced run)' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'claude → codex' })).toBeUndefined()
      } else {
        const alt = (await alts(ui)).find(one => one.startsWith('last 7 days'))
        expect(alt, surface).toBe('last 7 days: 5 cards, 83% held; claude → omp: 83% held, 5 accepted, 1 rejected, 0 open; headless runs cost $0.42 over 7 days (1 priced run)')
      }
      // The unreconciled replies are the orchestrator's move, said against the limit.
      expect(surface === 'terminal'
        ? (await ui.find({ type: 'Text', text: '2 replies for claude to reconcile · 2 of 3 before new cards are refused' })) !== undefined
        : (await alts(ui)).some(one => one.includes('2 replies for claude to reconcile · 2 of 3 before new cards are refused'))).toBe(true)
      expect(await ui.find({ type: 'Text', text: /By mode|REVIEW · 4 cards/ })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'ledger-details', text: 'Details' })).toBeDefined()
      await ui.press({ key: 'ledger-details' })
      expect(await texts(ui, /^ {2}(REVIEW|claude|magi-)/)).toEqual([
        '  REVIEW · 4 cards · 83% held · 5 accepted · 1 rejected',
        '  magi-bbbb0001 · REVIEW · claude → omp · 5 accepted · 1 rejected',
        '  magi-bbbb0002 · DELEGATE · claude → codex · nothing counted',
      ])
      expect(await ui.find({ text: /DEBATE|\b0 (accepted|rejected|open|cards)\b/ })).toBeUndefined()
      await ui.press({ key: 'ledger-details' })
      expect(await ui.find({ type: 'Button', key: 'ledger-details', text: 'Details' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /By mode/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('narrow, the units are a line each and the providers lines; from 66 columns three equal boxes (the triad on a vector surface) and chips', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const narrow = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(64) })
      expect((await narrow.findAll({ type: 'Box' })).filter(box => box.props.borderStyle !== undefined), surface).toEqual([])
      expect((await alts(narrow)).some(alt => alt.startsWith('claude (MELCHIOR-1)')), surface).toBe(false)
      expect(await narrow.find({ type: 'Text', text: ' · 1 headless run · 1 open card' })).toBeDefined()
      await narrow.unmount()
      const roomy = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(66) })
      const boxes = (await roomy.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'single').map(box => box.props.width)
      expect(boxes, surface).toEqual(surface === 'terminal' ? [21, 21, 21] : [])
      expect((await alts(roomy)).filter(alt => alt.startsWith('claude (MELCHIOR-1)')).length, surface).toBe(surface === 'terminal' ? 0 : 1)
      expect((await roomy.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').length, surface).toBe(3)
      if (surface === 'terminal') expect(await roomy.find({ type: 'Text', text: '1 headless run' })).toBeDefined()
      await roomy.unmount()
    }
  })

  test('sections with nothing to show take no room; Your move says nothing waits, Units and Providers stay', async ($, on) => {
    const w = world(on, ran(JSON.stringify(QUIET)))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(80) })
      if (surface === 'terminal') {
        expect(await texts(ui, /^(Your move|Units|Working|Exchange|Ledger|Providers)$/), surface).toEqual(['Your move', 'Units', 'Providers'])
        expect(await ui.find({ type: 'Text', text: '✓ nothing waiting on you' })).toBeDefined()
      } else {
        const list = (await alts(ui)).map(alt => alt.split(' · ')[0])
        expect(list.filter(alt => SECTIONS.includes(alt as string)), surface).toEqual(['Your move', 'Units', 'Providers'])
        expect(await alts(ui)).toContain('nothing waiting on you')
      }
      await ui.unmount()
    }
  })

  test("working cards group by the session that asked, this session's first; a question is not work; a live DELEGATE card shows no cap", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    expect(await texts(ui, /^(This session|Gen 2 Boogaloo.*|Magi Git repo)$/)).toEqual(['This session', 'Gen 2 Boogaloo · 1 card'])
    const cards = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('card-'))
    expect(cards.map(button => [button.key, button.props.hotkey])).toEqual([['card-magi-aaaa0004', '1'], ['card-magi-aaaa0001', '2'], ['card-magi-aaaa0003', '3']])
    expect(await ui.find({ type: 'Button', key: 'card-magi-aaaa0004', text: 'omp · omp session 01a118ef · Review the ledger' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'card-magi-aaaa0003', text: 'codex · headless codex · Review the pane' })).toBeDefined()
    // The tags after the name, once each: the mode, the round, a bolt for a live session or a prompt for a headless run.
    expect(await ui.find({ type: 'Text', text: ' DELEGATE · round 1 · ⚡  ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' REVIEW · round 1/2 · >_  ' })).toBeDefined()
    // Another session's card is dim; a headless run's second line says it runs.
    expect((await ui.find({ type: 'Button', key: 'card-magi-aaaa0003' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'running' })).toBeDefined()
  })

  test('a card gone quiet for half an hour with its worker idle is marked stalled, in amber, on both surfaces', async ($, on) => {
    const stalled = {
      ...DECK.cards[1], taskId: 'magi-aaaa0009', openedAt: 0,
      worker: { ...DECK.cards[1]?.worker, state: 'idle', lastActivityAt: 10 * MINUTE, lastSaid: 'Done with the band.' },
    }
    const w = world(on, ran(JSON.stringify({ ...DECK, cards: [DECK.cards[1], stalled], cardsTotal: 2 })))
    await $.session.start(START)
    await w.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    const word = (await terminal.findAll({ type: 'Text', text: 'stalled · idle 50m' })).filter(isLeaf)[0]
    expect(word?.props.color).toBe('#FFB000')
    expect(await terminal.find({ type: 'Text', text: /50m ago/ }), 'no ago after a stalled word').toBeUndefined()
    await terminal.unmount()
    const desktop = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(80) })
    const row = (await desktop.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).includes('stalled · idle 50m'))
    expect(String(row?.props.source)).toContain('fill="#FFB000"')
    expect(String(row?.props.source)).toContain('>stalled · idle 50m</text>')
    await desktop.unmount()
  })

  test('a card hotkey opens its whole conversation, every message in full, and closes it again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(80) })
      expect(await ui.find({ type: 'Markdown' }), surface).toBeUndefined()
      await ui.press({ key: 'card-magi-aaaa0001' })
      expect(w.runs.some(argv => argv.join(' ').endsWith('exchange magi-aaaa0001 --json')), surface).toBe(true)
      const words = (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text))
      expect(words, surface).toEqual(['Make the band working line open a pane.\n\nKeep the deck as it is otherwise.', LONG_REPLY])
      expect(await ui.find({ type: 'Text', text: /omp → claude · reply · round 1$/ }), surface).toBeDefined()
      await ui.press({ key: 'card-magi-aaaa0001' })
      expect(await ui.find({ type: 'Markdown' }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test("a thread in Exchange opens the card's whole conversation under it, and Close messages closes it", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(120) })
      await ui.press({ key: 'thread-magi-bbbb0001' })
      expect((await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)), surface).toContain(LONG_REPLY)
      // Opened from Exchange, it shows there alone, not under a Working card too.
      expect(await ui.findAll({ type: 'Markdown' }), surface).toHaveLength(2)
      await ui.press({ key: 'close-exchange-magi-bbbb0001' })
      expect(await ui.find({ type: 'Markdown' }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test("Your move lists this session's waiting question, its failed delivery (a button to the card) and the replies to reconcile; nothing of another session's", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    expect(await ui.find({ type: 'Text', text: /^Your move$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 2 waiting' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'omp asks: a question is waiting on the card' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 7m ago' })).toBeDefined()
    const needs = (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('need-')).map(button => [button.key, button.text])
    expect(needs).toEqual([['need-failed-magi-aaaa0004', 'Delivery to omp failed on magi-aaaa0004']])
    await ui.unmount()
    // The desktop strip says the same.
    const desktop = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(80) })
    expect(await alts(desktop)).toContain('omp asks: a question is waiting on the card (7m ago); Delivery to omp failed on magi-aaaa0004')
    expect((await desktop.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('need-'))).toEqual([])
  })

  test('the exchange is threaded by card, the card with the newest message first, each message its time, direction, kind and words', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    // Each thread's title is the button that opens its full messages.
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('thread-')).map(b => b.text)).toEqual(['magi-aaaa0001 · Make the band working line open a pane', 'magi-bbbb0001 · to claude'])
    expect(await ui.find({ type: 'Text', text: 'omp → claude' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'reply' })).toBeDefined()
    await ui.unmount()
    const desktop = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(120) })
    // One drawing per thread, each with its open button beside it.
    const threadAlts = (await alts(desktop)).filter(one => /^magi-(aaaa|bbbb)0001 · /.test(one))
    expect(threadAlts[0]).toMatch(/^magi-aaaa0001 · Make the band working line open a pane: \d\d:\d\d omp → claude note Reading src\/status\.mjs to add the worker fields\.$/)
    expect(threadAlts[1]).toMatch(/^magi-bbbb0001 · to claude: \d\d:\d\d omp → claude reply SUMMARY Five findings held\.$/)
    expect((await desktop.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('thread-')).map(b => b.key)).toEqual(['thread-magi-aaaa0001', 'thread-magi-bbbb0001'])
  })

  test('a panel holds no clock: ten seconds later the same facts are the same markup, and the card clocks tick natively', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(120) })
    const before = await sources(ui)
    expect(before.length).toBeGreaterThan(8)
    await w.clock.advance(10_000)
    await ui.redraw()
    expect(await sources(ui)).toEqual(before)
    const clocks = (await ui.findAll({ type: 'Client' })).filter(c => String(c.props.module).endsWith('elapsed.tsx'))
    expect(clocks.map(c => (c.props.props as { now: number }).now)).toEqual([NOW + 10_000, NOW + 10_000, NOW + 10_000])
  })

  test('icons off draws the panels with plain Unicode and no private-use codepoint; on, the Nerd Font glyphs', { options: { icons: false } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(120) })
    const list = await sources(ui)
    expect(list.length).toBeGreaterThan(8)
    for (const source of list) expect(PRIVATE_USE.test(source), source.slice(0, 80)).toBe(false)
    expect(list.some(source => source.includes('>●</text>'))).toBe(true)
  })

  test('a font option names the face every panel is drawn in', { options: { font: '3270 Nerd Font' } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...deck(120) })
    const list = await sources(ui)
    expect(list.length).toBeGreaterThan(8)
    for (const source of list) expect(source).toContain('font-family="&#39;3270 Nerd Font&#39;, &#39;JetBrainsMono Nerd Font Mono&#39;')
    expect(list.some(source => PRIVATE_USE.test(source))).toBe(true)
  })

  test('mid-turn the band shows alerts alone, each a button that opens the deck at its card with Working first', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      w.opened.length = 0
      const band = await $.ui.mount({ plugin: 'magi-view', surface, ...BUSY })
      expect((await band.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['failed-magi-aaaa0004-omp'])
      expect(await band.find({ text: /working|Working/ }), 'no working line any more').toBeUndefined()
      expect(await accentsOnly(band)).toEqual([])
      // Each line is its edge and its words: no accent trails it.
      expect(await band.find({ text: /[一-鿿]/ })).toBeUndefined()
      await band.press({ key: 'failed-magi-aaaa0004-omp' })
      await w.clock.settle()
      expect(w.opened, surface).toHaveLength(1)
      expect(w.opened[0]).toMatchObject({ id: 'magi', focus: true, closeOnEscape: true })
      const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
      expect(await texts(ui, /^(Units|Working)$/)).toEqual(['Working', 'Units'])
      await ui.unmount()
      const survey = await $.ui.mount({ plugin: 'magi-view', surface, ...BAND, props: { ...BAND.props, hasSurvey: true } })
      expect(await survey.findAll({ type: 'Button' })).toHaveLength(0)
      await band.unmount()
    }
  })

  test('the band shows three alerts and says how many more the deck lists', async ($, on) => {
    const failures = ['magi-cccc0001', 'magi-cccc0002', 'magi-cccc0003'].map(taskId => ({ taskId, from: 'claude', to: 'codex', code: 'NO_LIVE_PEER', at: 59 * MINUTE }))
    // Failed deliveries alert only for this session's cards.
    const failing = failures.map(f => ({ taskId: f.taskId, mode: 'DELEGATE', from: 'claude', to: 'codex', round: 1, maxRounds: 2, turn: 'orchestrator', openedAt: 58 * MINUTE, questionAt: null, coordinator: coordinator('Magi Git repo', 'sess-here') }))
    const w = world(on, ran(JSON.stringify({ ...DECK, cards: [...DECK.cards, ...failing], cardsTotal: DECK.cards.length + failing.length, failures })))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'magi-view', surface, ...BUSY })
      expect((await band.findAll({ type: 'Button' })).map(button => button.key), surface).toEqual(['failed-magi-aaaa0004-omp', 'failed-magi-cccc0001-codex', 'failed-magi-cccc0002-codex'])
      expect(await band.find({ type: 'Text', text: '▎ 1 more alert in /magi' })).toBeDefined()
      await band.unmount()
    }
  })

  // What `magi status --json` really prints for a failed delivery: the round
  // is closed, so the card is in `failures` and not among the open `cards`.
  test('an alert for a delivery that closed its card opens the deck with that card\'s messages under Your move', async ($, on) => {
    const failures = [{ taskId: 'magi-cccc0001', from: 'claude', to: 'codex', code: 'NO_LIVE_PEER', at: 59 * MINUTE, coordinatorIds: ['sess-here'] }]
    const w = world(on, ran(JSON.stringify({ ...CALM, failures })))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      w.opened.length = 0
      const band = await $.ui.mount({ plugin: 'magi-view', surface, ...BUSY })
      await band.press({ key: 'failed-magi-cccc0001-codex' })
      await w.clock.settle()
      expect(w.opened, surface).toHaveLength(1)
      expect(w.runs.some(argv => argv.join(' ').endsWith('exchange magi-cccc0001 --json')), surface).toBe(true)
      await band.unmount()
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(120) })
      // The card is in no Working block, so its conversation is drawn once, under Your move.
      expect((await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)), surface).toContain(LONG_REPLY)
      expect(await ui.findAll({ type: 'Markdown' }), surface).toHaveLength(2)
      await ui.press({ key: 'close-working-magi-cccc0001' })
      expect(await ui.find({ type: 'Markdown' }), surface).toBeUndefined()
      await ui.unmount()
    }
  })

  test('mid-turn, a card simply working is in the deck, not above the prompt', async ($, on) => {
    const w = world(on, ran(JSON.stringify(CALM)))
    for (const surface of SURFACES) {
      const before = await $.ui.mount({ plugin: 'magi-view', surface, ...BAND })
      expect(await before.findAll({ type: 'Button' }), 'nothing before the first status').toHaveLength(0)
    }
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'magi-view', surface, ...BUSY })
      expect(await band.findAll({ type: 'Button' }), surface).toHaveLength(0)
      expect(await band.find({ text: /working|reply|question|Waiting/ })).toBeUndefined()
    }
  })

  test('idle, the band says calmly which peer owes this session a reply, with its clock, and opens the deck at the card', async ($, on) => {
    const w = world(on, ran(JSON.stringify(CALM)))
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      w.opened.length = 0
      const band = await $.ui.mount({ plugin: 'magi-view', surface, ...BAND })
      const buttons = await band.findAll({ type: 'Button' })
      expect(buttons.map(button => button.key), surface).toEqual(['waiting-magi-aaaa0001'])
      expect(buttons[0]?.text).toBe('Waiting on omp · magi-aaaa0001 DELEGATE')
      expect(buttons[0]?.props.dimColor, 'calm: dim, not coloured').toBe(true)
      expect(await band.find({ type: 'Text', text: ' · the reply comes back by itself' })).toBeDefined()
      // Its clock runs from the request's delivery (46 minutes in), not the last note.
      expect(JSON.stringify(await band.findAll({ type: 'Client' }))).toContain(String(46 * MINUTE))
      expect(await band.find({ text: /[一-鿿]/ }), 'no accent on a waiting line').toBeUndefined()
      await band.press({ key: 'waiting-magi-aaaa0001' })
      await w.clock.settle()
      expect(w.opened, surface).toHaveLength(1)
      await band.unmount()
    }
  })

  test("idle, another session's card and a question for this one are not waiting lines", async ($, on) => {
    const others = { ...DECK, cards: DECK.cards.filter(card => card.taskId === 'magi-aaaa0002' || card.taskId === 'magi-aaaa0003'), cardsTotal: 2 }
    const w = world(on, ran(JSON.stringify(others)))
    await $.session.start(START)
    await w.clock.settle()
    const band = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...BAND })
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test('a waiting line says when the worker is blocked on a person, or its headless run ended', async ($, on) => {
    const base = CALM.cards[0] as (typeof DECK.cards)[1]
    const blocked = { ...base, worker: { ...base.worker, state: 'waiting', waitingFor: 'approval of bash' } }
    const ended = { ...base, taskId: 'magi-aaaa0009', worker: { ...base.worker, via: 'headless', state: 'idle', live: false } }
    const w = world(on, ran(JSON.stringify({ ...CALM, cards: [blocked, ended], cardsTotal: 2 })))
    await $.session.start(START)
    await w.clock.settle()
    const band = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...BAND })
    expect(await texts(band, /^ · \S/)).toEqual([' · omp is waiting on a person: approval of bash', ' · its run ended without a reply; open /magi'])
  })

  test('the band keeps re-reading while a waiting line shows, and the line leaves once the card is answered', async ($, on) => {
    const answer = ran(JSON.stringify(CALM)) as { stdout: string }
    const w = world(on, answer as ProcessRunResult)
    await $.session.start(START)
    await w.clock.settle()
    const band = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...BAND })
    expect(await band.findAll({ type: 'Button' })).toHaveLength(1)
    const before = w.runs.length
    await w.clock.advance(15_000)
    expect(w.runs.length, 'a re-read while a peer owes a reply').toBe(before + 1)
    answer.stdout = JSON.stringify(QUIET)
    await w.clock.advance(15_000)
    await w.clock.settle()
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    const after = w.runs.length
    await w.clock.advance(60_000)
    expect(w.runs.length, 'no re-reads once nothing is owed').toBe(after)
  })

  test('a main-loop turn that ends re-reads the status when a peer owes a reply; a subagent turn does not', async ($, on) => {
    const w = world(on, ran(JSON.stringify(CALM)))
    await $.session.start(START)
    await w.clock.settle()
    const turn = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' as const, turnId: 't-1' }
    const before = w.runs.length
    await $.turn.complete({ ...turn, agentId: 'sub-1' })
    await w.clock.settle()
    expect(w.runs.length, 'a subagent finishing is not the session going idle').toBe(before)
    await $.turn.complete(turn)
    await w.clock.settle()
    expect(w.runs.length).toBe(before + 1)
  })

  test('the band re-reads while it shows an alert and stops once none is left', async ($, on) => {
    const answer = ran(JSON.stringify(DECK)) as { stdout: string }
    const w = world(on, answer as ProcessRunResult)
    await $.session.start(START)
    await w.clock.settle()
    const band = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...BUSY })
    expect(await band.findAll({ type: 'Button' })).toHaveLength(1)
    const before = w.runs.length
    await w.clock.advance(15_000)
    expect(w.runs.length, 'a re-read while the band shows an alert').toBe(before + 1)
    answer.stdout = JSON.stringify(CALM)
    await w.clock.advance(15_000)
    await w.clock.settle()
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    const after = w.runs.length
    await w.clock.advance(60_000)
    expect(w.runs.length, 'no re-reads once nothing needs a person').toBe(after)
  })

  test("a provider's button runs magi provider enable or disable for it, then re-reads", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('provider-')).map(b => [b.key, b.text])).toEqual([
      ['provider-claude', 'Disable'], ['provider-codex', 'Disable'], ['provider-omp', 'Enable'],
    ])
    w.runs.length = 0
    await ui.press({ key: 'provider-omp' })
    await w.clock.settle()
    expect(w.runs[0]?.slice(1)).toEqual([expect.stringMatching(/[\\/]bin[\\/]magi\.mjs$/), 'provider', 'enable', 'omp'])
    expect(w.runs[1]?.slice(2, 4)).toEqual(['status', '--json'])
    await ui.press({ key: 'provider-codex' })
    await w.clock.settle()
    expect(w.runs[2]?.slice(2)).toEqual(['provider', 'disable', 'codex'])
    expect(w.toasts).toContain('omp enabled; restart the harnesses to refresh their tools')
  })

  test('/magi opens it, /magi layout sets the layout, /magi close closes it', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.command.run({ command: 'magi', args: '', ...COMMAND })
    expect(w.openPanes).toEqual(['magi'])
    expect(w.opened[0]).toMatchObject({ id: 'magi', title: 'Magi' })
    expect(w.opened[0]?.focus, 'a plain /magi leaves the keys with the prompt').toBeUndefined()
    await $.command.run({ command: 'magi', args: 'layout wide', ...COMMAND })
    const wide = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    // Wide no longer splits the deck into two half-width columns.
    expect((await wide.findAll({ type: 'Box' })).filter(box => box.props.width === 39).length).toBe(0)
    await wide.unmount()
    await $.command.run({ command: 'magi', args: 'layout mini', ...COMMAND })
    const mini = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(120) })
    expect(await mini.find({ type: 'Text', text: /^Magi deck$/ })).toBeUndefined()
    await mini.unmount()
    expect(await $.command.run({ command: 'magi', args: 'layout diagonal', ...COMMAND })).toMatchObject({ text: 'Usage: /magi layout auto|compact|wide|mini' })
    await $.command.run({ command: 'magi', args: 'close', ...COMMAND })
    expect(w.openPanes).toEqual([])
  })

  test('/magi-working opens the deck with the keys and Working first', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    await $.command.run({ command: 'magi-working', args: '', ...COMMAND })
    expect(w.opened[0]).toMatchObject({ id: 'magi', focus: true, closeOnEscape: true })
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    expect(await texts(ui, /^(Units|Working)$/)).toEqual(['Working', 'Units'])
  })

  test('inline above the prompt the deck is a summary of at most 8 rows', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    for (const surface of SURFACES) {
      for (const columns of WIDTHS) {
        const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(columns, 'inline') })
        const root = (await ui.drawn()) as { children?: unknown[] }
        expect((root.children ?? []).filter(Boolean).length <= 8, `${surface} at ${columns}`).toBe(true)
        expect(await ui.find({ type: 'Text', text: ' · 3 cards working · 2 things waiting on you' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Delivery to omp failed on magi-aaaa0004' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'omp · Polished-2 · Make the band working line open a pane' })).toBeDefined()
        expect(await accentsOnly(ui)).toEqual([])
        await ui.unmount()
      }
    }
  })

  test('/magi-theme off draws the deck without the hazard mark, colours, beats, kanji or panels: plain text with its rules on every surface', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    const themed = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    // The hazard mark is a few cells before the title, never a row of its own.
    expect((await themed.findAll({ type: 'Text', text: '◢◤◢◤' })).filter(isLeaf)[0]).toMatchObject({ props: { color: '#FF6A00', backgroundColor: '#000000' } })
    expect(await themed.find({ type: 'Text', text: '  作動中' })).toBeDefined()
    await themed.unmount()
    await $.command.run({ command: 'magi-theme', args: 'off', ...COMMAND })
    for (const surface of SURFACES) {
      const plain = await $.ui.mount({ plugin: 'magi-view', surface, ...deck(80) })
      expect(await plain.find({ text: /[◢◤]|[\u4e00-\u9fff]/ }), surface).toBeUndefined()
      expect((await plain.findAll({ type: 'Text' })).filter(text => typeof text.props.color === 'string' && text.props.color.startsWith('#'))).toEqual([])
      expect((await plain.findAll({ type: 'Box' })).filter(box => box.props.borderColor !== undefined)).toEqual([])
      expect((await plain.findAll({ type: 'Client' })).filter(c => String(c.props.module).endsWith('pulse.tsx'))).toEqual([])
      expect(await plain.findAll({ type: 'Svg' }), surface).toEqual([])
      expect(await plain.find({ type: 'Text', text: /^Working$/ })).toBeDefined()
      expect(await plain.find({ type: 'Text', text: /^╌+$/ })).toBeDefined()
      // The opened card is kept across surfaces: press only while it is shut.
      if (!(await plain.find({ type: 'Text', text: 'queued, not read yet' }))) await plain.press({ key: 'card-magi-aaaa0001' })
      expect(await plain.find({ type: 'Text', text: 'queued, not read yet' }), surface).toBeDefined()
      await plain.unmount()
    }
  })

  test('the status line says what works here and what for which other session', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.runs[0]?.slice(1)).toEqual([expect.stringMatching(/[\\/]bin[\\/]magi\.mjs$/), 'status', '--json', '--cwd', '/work'])
    expect(w.statuses.at(-1)).toBe('Magi: claude ✓ · codex – · omp ✓ · 2 working here · 1 in Gen 2 Boogaloo · 1 question for claude')
  })

  test("the desktop footer draws the engine's modes and the summary as a button that opens the deck; the status line then stays clear", async ($, on) => {
    const w = world(on)
    on('ui.render', { component: 'SessionMode' }, (_$, e) => ({ type: 'Text', children: [e.props.modes.join(' & ') || 'no modes'] }))
    await $.session.start(START)
    await w.clock.settle()
    const summary = 'Magi: claude ✓ · codex – · omp ✓ · 2 working here · 1 in Gen 2 Boogaloo · 1 question for claude'
    expect(w.statuses.at(-1)).toBe(summary)
    const footer = { component: 'SessionMode' as const, props: { modes: ['focus'] } }
    // The terminal keeps the engine's labels and the pinned status line.
    const terminal = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...footer })
    expect(await terminal.find({ type: 'Button', key: 'magi-footer' })).toBeUndefined()
    expect(await terminal.find({ type: 'Text', text: 'focus' })).toBeDefined()
    await terminal.unmount()
    // The desktop: the engine's labels, then a short summary as a button (the footer holds
    // about a dozen characters: the most pressing fact, here this session's failed delivery);
    // pressing it opens the deck as /magi does.
    const desktop = await $.ui.mount({ plugin: 'magi-view', surface: 'desktop', ...footer })
    expect(await desktop.find({ type: 'Text', text: 'focus' })).toBeDefined()
    const button = await desktop.find({ type: 'Button', key: 'magi-footer' })
    expect(button?.text).toBe('Magi · 1 failed')
    expect([...String(button?.text)].length).toBeLessThanOrEqual(18)
    expect(button?.props).toMatchObject({ plain: true, dimColor: true })
    expect(w.statuses.at(-1), 'the pinned line is cleared once the footer carries it').toBeUndefined()
    await desktop.press({ key: 'magi-footer' })
    await w.clock.settle()
    expect(w.opened.map(open => open.id)).toEqual(['magi'])
    expect(w.opened[0]?.focus).toBeUndefined()
    // A later refresh draws the button anew and pins no status line.
    const pinned = w.statuses.length
    await desktop.press({ key: 'magi-footer' })
    await w.clock.settle()
    expect(w.statuses.length).toBe(pinned)
  })

  test('a failing magi status is shown in the deck and on the status line', async ($, on) => {
    const w = world(on, ran('', 1, 'magi: BAD_CONFIG: Cannot read provider settings'))
    await $.session.start(START)
    await w.clock.settle()
    expect(w.statuses.at(-1)).toBe('Magi: status unavailable (see /magi)')
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(80) })
    expect(await ui.find({ type: 'Text', text: 'BAD_CONFIG' })).toBeDefined()
  })

  test('the deck refreshes on a timer only while open, and on its button', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.runs).toHaveLength(1)
    await $.command.run({ command: 'magi', args: '', ...COMMAND })
    await w.clock.settle()
    expect(w.runs).toHaveLength(2)
    await w.clock.advance(10_000)
    expect(w.runs).toHaveLength(3)
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...deck(120) })
    await ui.press({ key: 'refresh' })
    expect(w.runs).toHaveLength(4)
    w.openPanes.length = 0
    await w.clock.advance(10_000)
    await w.clock.advance(10_000)
    expect(w.runs).toHaveLength(4)
  })

  test('the deck stays shut at start by default', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.opened).toEqual([])
  })

  test('openOnStart opens it when the session starts', { options: { openOnStart: true } }, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect(w.opened.map(open => open.id)).toEqual(['magi'])
  })
})

// Typed loosely on purpose: which MCP tools .claude-plugin/types lists depends
// on the servers connected when the mod last loaded, not on this test.
const callTool = ($: Engine, input: Readonly<Record<string, unknown>>) => $.tool.call(input as unknown as ToolCallArgs)

describe('Magi tool calls', () => {
  test('the call passes through unchanged; a toast and a refresh follow its answer', async ($, on) => {
    const w = world(on)
    const args = { kind: 'request', task: 'Review the band', mode: 'REVIEW', delivery: 'auto' }
    const answer = await callTool($, { tool: 'mcp__magi__omp_peer', ...args })
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]).toMatchObject({ tool: 'mcp__magi__omp_peer', ...args })
    expect(answer).toMatchObject({ result: { ok: true }, text: 'sent' })
    expect(w.toasts).toEqual(['Request sent to omp'])
    expect(w.runs).toHaveLength(1)
    const reserved = ['tool', 'tool_use_id', 'consent', 'agentId']
    const passed = Object.entries(w.calls[0] ?? {}).filter(([key, value]) => value !== undefined && !reserved.includes(key))
    expect(passed.map(([key]) => key).sort()).toEqual(Object.keys(args).sort())
  })

  test('an outcome toasts its counts; the magi-omp server and the codex tool name their peer', async ($, on) => {
    const w = world(on)
    await callTool($, { tool: 'mcp__magi__codex_peer', kind: 'outcome', taskId: 'magi-1', accepted: 5, rejected: 0, open: 1 })
    await callTool($, { tool: 'mcp__magi-omp__omp_peer', kind: 'note', taskId: 'magi-1', body: 'hi' })
    await w.clock.settle()
    expect(w.toasts).toEqual(['Outcome recorded: 5 accepted, 0 rejected, 1 open', 'Note sent to omp (magi-1)'])
  })

  test('another server with a look-alike tool is left alone', async ($, on) => {
    const w = world(on)
    await callTool($, { tool: 'mcp__other__omp_peer', kind: 'request', task: 'x' })
    await w.clock.settle()
    expect(w.calls).toHaveLength(1)
    expect(w.toasts).toEqual([])
    expect(w.runs).toEqual([])
  })
})

const toolUse = (tool: string, input: Readonly<Record<string, unknown>>, state: Partial<RenderPropsOf['ToolUse']> = {}) => ({
  component: 'ToolUse' as const,
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false, ...state },
})
const LONG = 'Review the band drawing against the reference and report every refusal you can find in it'

// [tool, input, what the line says]: one per kind the line names.
const TOOL_KINDS: readonly (readonly [string, Readonly<Record<string, unknown>>, readonly string[]])[] = [
  ['mcp__magi__omp_peer', { task: `${LONG}\nsecond line`, mode: 'REVIEW' }, ['Sent request to omp', ' · REVIEW', '"Review the band drawing against the reference', '  要請']],
  ['mcp__magi__omp_peer', { kind: 'request', taskId: 'magi-1', task: 'Next round' }, ['Continued magi-1 with omp', '"Next round"']],
  ['mcp__magi__codex_peer', { kind: 'note', taskId: 'magi-1', body: 'Looking at it now' }, ['Sent note to codex', ' · magi-1', '"Looking at it now"']],
  ['mcp__magi__claude_peer', { kind: 'reply', taskId: 'magi-1', round: 1, body: 'SUMMARY holds' }, ['Replied to claude', ' · magi-1', '"SUMMARY holds"', '  回答']],
  ['mcp__magi__codex_peer', { kind: 'clarify', taskId: 'magi-1', body: 'Which branch?' }, ['Asked a question on magi-1', '"Which branch?"']],
  ['mcp__magi__codex_peer', { kind: 'clarify_answer', taskId: 'magi-1', questionId: 'q-1', body: 'Use main.' }, ['Answered question on magi-1', '"Use main."']],
  ['mcp__magi__omp_peer', { kind: 'outcome', taskId: 'magi-1', accepted: 2, rejected: 0, open: 0, body: 'Both held' }, ['Recorded outcome for magi-1: 2 accepted, 0 rejected, 0 open', '"Both held"', '  照合']],
  ['mcp__magi__omp_peer', { kind: 'peers' }, ['Listed peers']],
  ['mcp__magi__omp_peer', { kind: 'transcript' }, ["Read omp's transcript"]],
  ['mcp__magi__omp_peer', { kind: 'remember', body: 'The band yields to a survey' }, ['Saved to memory', '"The band yields to a survey"']],
  ['mcp__magi__omp_peer', { kind: 'recall', body: 'band' }, ['Searched memory', '"band"']],
  ['mcp__magi__omp_peer', { kind: 'forget', memoryId: 'm-1' }, ['Removed from memory']],
  ['mcp__magi__omp_peer', { kind: 'close', taskId: 'magi-1', body: 'Stopped waiting' }, ['Closed magi-1', '"Stopped waiting"']],
  ['mcp__magi-omp__omp_peer', { kind: 'notify', body: 'Pick a branch' }, ['Flagged for your attention', '"Pick a branch"']],
  ['mcp__magi__codex_peer', { kind: 'spawn', name: 'second' }, ['Started a new codex session']],
]

describe('Magi tool rows', () => {
  test('each kind is one plain line: what was done, to whom, on which card, the first of its text, then any accent', async ($, on) => {
    const w = world(on)
    for (const surface of SURFACES) {
      for (const [index, [tool, input, says]] of TOOL_KINDS.entries()) {
        const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...toolUse(tool, input), requestId: `toolu-${surface}-${index}` })
        expect(await ui.findAll({ type: 'Box' }), `${says[0]} on ${surface}`).toHaveLength(1)
        for (const part of says) expect(await ui.find({ type: 'Text', text: part }), part).toBeDefined()
        expect(await accentsOnly(ui)).toEqual([])
        await ui.unmount()
      }
    }
    expect(w.toolRows).toEqual([])
  })

  test('a call to a peer on another machine names the machine; on this machine the row is unchanged', async ($, on) => {
    // The card's worker is on mac in the status; the reply row and the outcome row learn it there.
    const remote = { ...CALM, cards: [{ ...CALM.cards[0], worker: { ...(CALM.cards[0] as (typeof DECK.cards)[1]).worker, host: 'mac' } }] }
    const w = world(on, ran(JSON.stringify(remote)))
    await $.session.start(START)
    await w.clock.settle()
    const rows: [Readonly<Record<string, unknown>>, Partial<RenderPropsOf['ToolUse']>, string][] = [
      [{ task: 'Go', mode: 'DELEGATE', host: 'mac' }, {}, 'Sent request to omp on mac'],
      [{ kind: 'note', taskId: 'magi-x', body: 'hi' }, { output: { structuredContent: { taskId: 'magi-x', via: 'relay:devbox:live:9316', deliveryStatus: 'queued_unread' } } }, 'Sent note to omp on devbox'],
      [{ kind: 'outcome', taskId: 'magi-aaaa0001', accepted: 1, rejected: 0, open: 0 }, {}, 'Recorded outcome for magi-aaaa0001: 1 accepted, 0 rejected, 0 open'],
      [{ kind: 'note', taskId: 'magi-local', body: 'hi' }, {}, 'Sent note to omp'],
    ]
    for (const [index, [input, state, says]] of rows.entries()) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', input, state), requestId: `toolu-host-${index}` })
      expect(await ui.find({ type: 'Text', text: says }), says).toBeDefined()
      await ui.unmount()
    }
    const outcome = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', rows[2]?.[0] ?? {}), requestId: 'toolu-host-outcome' })
    expect(await outcome.find({ type: 'Text', text: ' · with omp on mac' })).toBeDefined()
    const reply = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...row(REPLY.replace('task_id=magi-1', 'task_id=magi-aaaa0001'), false) })
    expect(await reply.find({ type: 'Text', text: /^Reply from omp on mac/ })).toBeDefined()
    expect(w.toasts).toContain('Reply from omp on mac (magi-aaaa0001)')
  })

  test('the text is its first line, quoted and cut at 60 characters', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', { task: `${LONG}\nsecond line`, mode: 'REVIEW' }) })
    expect(await ui.find({ type: 'Text', text: `"${[...LONG].slice(0, 59).join('')}…"` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: LONG })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'second line' })).toBeUndefined()
  })

  test('a details button opens the engine row with every argument under the line, and closes it again', async ($, on) => {
    const w = world(on)
    for (const surface of SURFACES) {
      const { props } = toolUse('mcp__magi__omp_peer', { task: LONG, mode: 'DELEGATE' }, { tool_use_id: `toolu_d_${surface}` })
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, component: 'ToolUse', requestId: props.tool_use_id, props })
      w.toolRows.length = 0
      expect(await ui.find({ type: 'Text', text: /engine row/ }), surface).toBeUndefined()
      await ui.press({ key: 'details' })
      expect(await ui.find({ type: 'Text', text: 'engine row mcp__magi__omp_peer' }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Sent request to omp' })).toBeDefined()
      expect(w.toolRows.at(-1)?.input, 'the engine gets the call as sent').toEqual({ task: LONG, mode: 'DELEGATE' })
      await ui.press({ key: 'details' })
      expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the state follows the call: running, then its delivery and card, failed with its code, interrupted', async ($, on) => {
    world(on)
    for (const surface of SURFACES) {
      const { props } = toolUse('mcp__magi__omp_peer', { task: 'Review the band', mode: 'DELEGATE' }, { isRunning: true })
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, component: 'ToolUse', props })
      expect(await ui.find({ type: 'Text', text: ' · running' }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /magi-/ })).toBeUndefined()

      await ui.redraw({ ...props, isRunning: false, output: JSON.stringify({ taskId: 'magi-77', mode: 'DELEGATE', round: 1, deliveryStatus: 'queued_unread' }) })
      expect(await ui.find({ type: 'Text', text: ' · queued, not read yet' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · DELEGATE · magi-77' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'running' })).toBeUndefined()

      await ui.redraw({ ...props, isRunning: false, isErrored: true, output: 'magi error - NO_LIVE_PEER: No omp session here.\nNext: Use kind:"peers".' })
      expect(await ui.find({ type: 'Text', text: ' · failed: NO_LIVE_PEER' })).toBeDefined()

      await ui.redraw({ ...props, isRunning: false, isInterrupted: true, output: 'Interrupted by user' })
      expect(await ui.find({ type: 'Text', text: ' · interrupted' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('each delivery status reads as a plain phrase', async ($, on) => {
    world(on)
    const phrases = {
      received: 'delivered', received_mid_turn: 'delivered mid-turn', queued_unread: 'queued, not read yet',
      unconfirmed: 'sent, not confirmed', running: 'running', failed: 'failed', not_applicable: 'done',
    }
    for (const [index, [deliveryStatus, phrase]] of Object.entries(phrases).entries()) {
      const output = JSON.stringify({ taskId: 'magi-9', deliveryStatus })
      const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', { task: 'Review' }, { output }), requestId: `toolu-${index}` })
      expect(await ui.find({ type: 'Text', text: ` · ${phrase}` }), deliveryStatus).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /received|queued_unread|unconfirmed|not_applicable/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the result is read however the host stored it: JSON text, an MCP result, content blocks, plain text', async ($, on) => {
    world(on)
    const fields = { taskId: 'magi-9', mode: 'REVIEW', deliveryStatus: 'received' }
    const outputs = [
      JSON.stringify(fields),
      { content: [{ type: 'text', text: 'Sent to omp.' }], structuredContent: fields },
      [{ type: 'text', text: JSON.stringify(fields) }],
    ]
    for (const [index, output] of outputs.entries()) {
      const ui = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', { task: 'Review' }, { output }), requestId: `toolu-${index}` })
      expect(await ui.find({ type: 'Text', text: ' · delivered' }), JSON.stringify(output)).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'magi-9' })).toBeDefined()
      await ui.unmount()
    }
    const plain = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...toolUse('mcp__magi__omp_peer', { task: 'Review' }, { output: 'Sent to omp (live:x), task_id=magi-10, mode=REVIEW, round=1/2.' }) })
    expect(await plain.find({ type: 'Text', text: 'magi-10' })).toBeDefined()
    expect(await plain.find({ type: 'Text', text: ' · done' })).toBeDefined()
  })

  test('a recorded outcome reads its counts as the bridge recorded them', async ($, on) => {
    world(on)
    for (const surface of SURFACES) {
      const output = JSON.stringify({ taskId: 'magi-1', outcome: { accepted: 5, rejected: 0, open: 1 }, deliveryStatus: 'not_applicable' })
      const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...toolUse('mcp__magi__codex_peer', { kind: 'outcome', taskId: 'magi-1', accepted: 4 }, { output }) })
      expect(await ui.find({ type: 'Text', text: 'Recorded outcome for magi-1: 5 accepted, 0 rejected, 1 open' }), surface).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · done' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('other tools, a look-alike server and an unknown kind are drawn by the engine, onScreen as received', async ($, on) => {
    const w = world(on)
    const onScreen = { first: 0, last: 1, of: 2 }
    const rows = [
      toolUse('Bash', { command: 'ls -la' }, { onScreen }),
      toolUse('mcp__other__omp_peer', { kind: 'request', task: 'x' }, { onScreen }),
      toolUse('mcp__magi__omp_peer', { kind: 'dance' }, { onScreen }),
    ]
    for (const surface of SURFACES) {
      for (const [index, one] of rows.entries()) {
        const ui = await $.ui.mount({ plugin: 'magi-view', surface, ...one, requestId: `toolu-${surface}-${index}` })
        expect(await ui.find({ type: 'Text', text: `engine row ${one.props.tool}` })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /Sent|Listed/ })).toBeUndefined()
        await ui.unmount()
      }
    }
    expect(w.toolRows).toEqual([...rows, ...rows].map(one => one.props))
  })

  test('/magi-theme off leaves the row to the engine, props and onScreen as received', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'magi-theme', args: 'off', ...COMMAND })
    const one = toolUse('mcp__magi__omp_peer', { task: 'Review' }, { onScreen: { first: 0, last: 0, of: 1 } })
    const plain = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...one })
    expect(await plain.find({ type: 'Text', text: 'engine row mcp__magi__omp_peer' })).toBeDefined()
    expect(w.toolRows).toEqual([one.props])

    await $.command.run({ command: 'magi-theme', args: 'on', ...COMMAND })
    const styled = await $.ui.mount({ plugin: 'magi-view', surface: 'terminal', ...one, requestId: 'toolu_2' })
    expect(await styled.find({ type: 'Text', text: 'Sent request to omp' })).toBeDefined()
    expect(w.toolRows).toHaveLength(1)
  })
})
