import { describe, expect, test } from 'claude-code/testing'

import { FIELD_LABEL, STALLED_MS, alerts, cardLines, costLine, costText, directionRows, exchangeLine, exchangeMark, filesNote, fitText, ledgerBar, ledgerDetails, ledgerSummary, providerLine, receiptOf, remoteWords, roundText, shapeOf, standing, statusLine, tallyWords, threads, timeoutText, unitCounts, unitState, workerColor, workingGroups, yourMove } from '../hooks/deck.ts'
import { NERD, PLAIN, glyphs, hasPrivateUse } from '../hooks/glyphs.ts'
import { AMBER, GREEN, ORANGE, PURPLE, RED, toolRow, toolToast } from '../hooks/nerv.ts'
import { cardRowSvg, exchangeSvg, fontList, headingSvg, ledgerSvg, yourMoveSvg } from '../hooks/panels.ts'
import { parseStatus } from '../hooks/status.ts'
import { lanes, triadSvg } from '../hooks/triad.ts'
import type { MagiCard } from '../types'

const NOW = 1760000000000
// Alerts are for the session that opened a card; these tests claim every card for it.
const HERE = 'sess-here'
const mineAll = <T extends { cards: MagiCard[] }>(status: T): T => ({ ...status, cards: status.cards.map(card => ({ ...card, coordinator: { harness: 'claude', name: 'Magi Git repo', ids: [HERE] } })) })
const MINUTE = 60_000

// What `magi status --json` prints, trimmed: a card of this session's, one of
// another session's gone quiet, and a question left waiting.
const PRINTED = JSON.stringify({
  v: 1, at: NOW, cwd: 'E:\\work', as: 'claude',
  units: [
    { unit: 'MELCHIOR-1', harness: 'claude', state: 'none', sessions: 0, working: 0, workers: 0, openCards: 0 },
    { unit: 'BALTHASAR-2', harness: 'codex', state: 'disabled', sessions: 0, working: 0, workers: 0, openCards: 1 },
    { unit: 'CASPER-3', harness: 'omp', state: 'active', sessions: 0, working: 0, workers: 1, openCards: 2 },
  ],
  providers: [
    { name: 'claude', status: 'up', reason: null },
    { name: 'codex', status: 'disabled', reason: null },
    { name: 'omp', status: 'down', reason: 'CLI_NOT_FOUND: omp is not on PATH' },
  ],
  cards: [
    {
      taskId: 'magi-open0001', mode: 'DELEGATE', from: 'claude', to: 'omp', round: 1, maxRounds: 2, turn: 'peer', openedAt: NOW - 14 * MINUTE, questionAt: null,
      coordinator: { harness: 'claude', name: 'Magi Git repo', ids: ['sess-here'] },
      worker: { harness: 'omp', name: 'Polished-2', id: null, live: false, state: 'working', lastActivityAt: NOW - 3 * MINUTE, lastSaid: 'Reading src/status.mjs now.', via: 'headless' },
      brief: 'Check the band line [REDACTED]',
      delivery: [{ to: 'omp', status: 'running', at: NOW - 14 * MINUTE }],
      lastExchangeAt: NOW - 3 * MINUTE,
      recent: [
        { at: NOW - 14 * MINUTE, from: 'claude', kind: 'request', text: 'Check the band line [REDACTED]' },
        { at: NOW - 3 * MINUTE, from: 'omp', kind: 'note', text: 'Reading src/status.mjs now.' },
      ],
    },
    {
      taskId: 'magi-open0002', mode: 'REVIEW', from: 'claude', to: 'codex', round: 2, maxRounds: null, turn: 'peer', openedAt: NOW - 40 * MINUTE, questionAt: null,
      coordinator: { harness: 'claude', name: 'Gen 2 Boogaloo', ids: ['sess-gen2'] },
      worker: { harness: 'codex', name: 'codex session 0f1e2d3c', id: '0f1e2d3c', live: true, state: 'waiting', lastActivityAt: null, lastSaid: null, via: 'live' },
      brief: null,
      delivery: [{ to: 'claude', status: 'received', at: NOW - MINUTE }, { to: 'codex', status: 'failed', at: NOW - 40 * MINUTE }],
      lastExchangeAt: null,
      recent: [],
    },
    // As a Magi older than the deck printed it, but for when its question was asked.
    { taskId: 'magi-asks0001', mode: 'REVIEW', from: 'claude', to: 'omp', round: 1, maxRounds: null, turn: 'orchestrator', openedAt: NOW - 20 * MINUTE, questionAt: NOW - 6 * MINUTE },
  ],
  cardsTotal: 3,
  unreconciled: 1,
  outcomes: [{ taskId: 'magi-done0005', mode: 'REVIEW', from: 'claude', to: 'codex', accepted: 5, rejected: 1, open: 0, at: NOW - 10 * MINUTE }],
  exchanges: [
    { at: NOW - 3 * MINUTE, taskId: 'magi-open0001', from: 'omp', to: 'claude', kind: 'note', text: 'Reading src/status.mjs now.' },
    { at: NOW - 5 * MINUTE, taskId: 'magi-done0005', from: 'codex', to: 'claude', kind: 'reply', text: `SUMMARY ${'x'.repeat(90)}` },
  ],
  ledger: {
    days: 7,
    total: { cards: 4, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 },
    byMode: [{ mode: 'REVIEW', cards: 3, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 }],
    byDirection: [{ from: 'claude', to: 'codex', cards: 2, checked: 1, accepted: 5, rejected: 1, open: 0, heldPct: 83 }],
    costUsd: 1.234,
    pricedRuns: 2,
  },
  failures: [{ taskId: 'magi-gone0001', from: 'claude', to: 'omp', code: 'NO_LIVE_PEER', at: NOW - MINUTE, coordinatorIds: ['sess-here'] }],
  liveError: null,
  later: 'a field a newer magi adds is ignored',
})

const printed = () => {
  const status = parseStatus(PRINTED)
  if (!status) throw new Error('PRINTED did not parse')
  return status
}

describe('magi status --json', () => {
  test('a printed status reads whole', () => {
    const status = printed()
    expect(status.units.map(unit => [unit.unit, unit.state])).toEqual([['MELCHIOR-1', 'none'], ['BALTHASAR-2', 'disabled'], ['CASPER-3', 'active']])
    expect(status.providers.map(p => [p.name, p.status])).toEqual([['claude', 'up'], ['codex', 'disabled'], ['omp', 'down']])
    expect(status.cards.map(card => [card.taskId, card.turn, card.coordinator?.name ?? null])).toEqual([
      ['magi-open0001', 'peer', 'Magi Git repo'], ['magi-open0002', 'peer', 'Gen 2 Boogaloo'], ['magi-asks0001', 'orchestrator', null],
    ])
    expect(status.exchanges).toHaveLength(2)
    expect(status.ledger?.byMode[0]).toMatchObject({ mode: 'REVIEW', accepted: 5, heldPct: 83 })
    expect(status.failures).toEqual([{ taskId: 'magi-gone0001', from: 'claude', to: 'omp', code: 'NO_LIVE_PEER', at: NOW - MINUTE, coordinatorIds: ['sess-here'] }])
    expect(status).not.toHaveProperty('later')
  })

  test('details from an older Magi, or that do not read, are empty; the card stays', () => {
    const asking = printed().cards[2]
    expect(asking).toMatchObject({ worker: null, coordinator: null, brief: null, delivery: [], recent: [], questionAt: NOW - 6 * MINUTE })
    const raw = JSON.parse(PRINTED) as { cards: Record<string, unknown>[] }
    const odd = parseStatus(JSON.stringify({ ...raw, cards: [{ ...raw.cards[0], worker: { harness: 7 }, delivery: 'no', coordinator: { name: 3 } }], exchanges: 'no', ledger: 1 }))
    expect(odd?.cards[0]).toMatchObject({ taskId: 'magi-open0001', worker: null, delivery: [], coordinator: null })
    expect([odd?.exchanges, odd?.ledger]).toEqual([[], null])
  })

  test('anything else reads as nothing, never as a half picture', () => {
    const raw = JSON.parse(PRINTED) as Record<string, unknown>
    expect(parseStatus('')).toBeNull()
    expect(parseStatus('magi: BAD_CONFIG: no')).toBeNull()
    expect(parseStatus(JSON.stringify({ ...raw, v: 2 }))).toBeNull()
    expect(parseStatus(JSON.stringify({ ...raw, units: [{ harness: 'gemini', state: 'active' }] }))).toBeNull()
    expect(parseStatus(JSON.stringify({ ...raw, cards: [{ taskId: 'x', turn: 'peer' }] }))).toBeNull()
    expect(parseStatus(JSON.stringify({ ...raw, unreconciled: -1 }))).toBeNull()
  })
})

describe('the deck in words', () => {
  test('the status line splits the work by whose session asked for it', () => {
    const line = 'Magi: claude – · codex off · omp – · 1 working here · 1 in Gen 2 Boogaloo · 1 question for claude · 1 reply for claude to check'
    expect(statusLine(printed(), false, 'sess-here')).toBe(line)
    expect(statusLine(printed(), true, 'sess-here')).toBe(`${line} (stale)`)
    // Another session's mod sees both cards as someone else's.
    expect(statusLine(printed(), false, 'sess-other')).toBe('Magi: claude – · codex off · omp – · 1 in Gen 2 Boogaloo · 1 in Magi Git repo · 1 question for claude · 1 reply for claude to check')
    expect(statusLine({ ...printed(), cardsTotal: 7 }, false, 'sess-here')).toContain('4 more open')
    expect(statusLine(null)).toBe('Magi: checking…')
    expect(statusLine(null, true)).toBe('Magi: status unavailable (see /magi)')
    const quiet = { ...printed(), units: printed().units.map(unit => ({ ...unit, sessions: 1, state: 'standby' as const })), cards: [], cardsTotal: 0, unreconciled: 0 }
    expect(statusLine(quiet)).toBe('Magi: claude ✓ · codex ✓ · omp ✓')
  })

  test('working cards group by coordinator session, this session first; questions are not work', () => {
    expect(workingGroups(printed(), 'sess-here').map(g => [g.heading, g.isHere, g.cards.map(c => c.taskId)])).toEqual([
      ['This session', true, ['magi-open0001']],
      ['Gen 2 Boogaloo', false, ['magi-open0002']],
    ])
    expect(workingGroups(printed(), null).map(g => g.heading)).toEqual(['Gen 2 Boogaloo', 'Magi Git repo'])
    expect(workingGroups(null, 'sess-here')).toEqual([])
  })

  test('alerts: failed deliveries only; a quiet worker or a waiting question is not an alert', () => {
    expect(alerts(mineAll(printed()), NOW, HERE)).toEqual([
      { key: 'failed-magi-open0002-codex', taskId: 'magi-open0002', text: 'Delivery to codex failed on magi-open0002', color: RED },
      { key: 'failed-magi-gone0001-omp', taskId: 'magi-gone0001', text: 'Delivery to omp failed on magi-gone0001: NO_LIVE_PEER', color: RED },
    ])
    expect(alerts(null, NOW)).toEqual([])
  })

  test('a working card in lines: who and what, what it was asked, what it last said, the delivery, its id and messages', () => {
    const [mine, theirs] = printed().cards
    const lines = cardLines(mine!, NOW)
    // The head is who and what: the task line, else the mode and round (a row's tags carry those).
    expect({ ...lines, messages: [] }).toEqual({
      head: 'omp · Polished-2 · Check the band line [REDACTED]',
      fields: [
        { label: 'Asked', note: '', value: 'Check the band line [REDACTED]', isQuiet: false },
        { label: 'Said', note: '3m ago', value: 'Reading src/status.mjs now.', isQuiet: false },
        { label: 'Delivery', note: '', value: 'running', isQuiet: false },
      ],
      id: 'magi-open0001 · headless worker running',
      messages: [],
    })
    expect(lines.messages).toHaveLength(2)
    expect(lines.messages[1]).toMatch(/^\d\d:\d\d omp note: Reading src\/status\.mjs now\.$/)
    // No task line: no Asked; no words yet: a quiet Said.
    expect(cardLines(theirs!, NOW)).toMatchObject({
      head: 'codex · codex session 0f1e2d3c · REVIEW · round 2',
      fields: [
        { label: 'Said', note: '', value: 'nothing yet', isQuiet: true },
        { label: 'Delivery', note: '', value: 'failed; to claude: delivered', isQuiet: false },
      ],
      id: 'magi-open0002 · live session, waiting on a person · session 0f1e2d3c',
    })
    // Every label fits the label column with room to spare.
    expect(Math.max(...lines.fields.map(field => field.label.length))).toBeLessThan(FIELD_LABEL)
    expect(fitText('omp · Polished-2 · DELEGATE', 10)).toBe('omp · Pol…')
    expect(fitText('omp', 10)).toBe('omp')
  })

  test('an exchange line is its columns: time, who to whom, the kind, the words; no accent', () => {
    const [note, reply] = printed().exchanges
    expect(exchangeLine(note!)).toMatchObject({ route: 'omp → claude', kind: 'note', words: 'Reading src/status.mjs now.', taskId: 'magi-open0001' })
    expect(exchangeLine(note!).time).toMatch(/^\d\d:\d\d$/)
    expect(exchangeLine(reply!)).toMatchObject({ route: 'codex → claude', kind: 'reply' })
    expect(exchangeLine(reply!)).not.toHaveProperty('accent')
  })

  test('the ledger: one line for the week, the rows behind Details, no zero ever drawn', () => {
    const status = printed()
    expect(ledgerSummary(status.ledger, status.outcomes)).toBe('Last 7 days: 4 cards, 1 checked · 83% held · 5 accepted · 1 rejected')
    expect(ledgerDetails(status.ledger, status.outcomes)).toEqual([
      { title: 'By mode', rows: ['REVIEW · 3 cards · 83% held · 5 accepted · 1 rejected'] },
      { title: 'By direction', rows: ['claude → codex · 2 cards · 83% held · 5 accepted · 1 rejected'] },
      { title: 'Last verdicts', rows: ['magi-done0005 · REVIEW · claude → codex · 5 accepted · 1 rejected'] },
    ])
    expect(tallyWords({ accepted: 0, rejected: 0, open: 2, heldPct: null })).toBe('2 open')
    expect(tallyWords({ accepted: 0, rejected: 0, open: 0 })).toBe('')
    // A week with no card: no summary unless a verdict is listed, and no section left empty.
    const empty = { ...status.ledger!, total: { cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0, heldPct: null }, byMode: [], byDirection: [] }
    expect(ledgerSummary(empty, [])).toBe('')
    expect(ledgerDetails(empty, [])).toEqual([])
    expect(ledgerSummary(empty, status.outcomes)).toBe('1 recent verdict')
    expect(costLine(status.ledger)).toBe('Headless runs cost $1.23 (2 priced runs)')
    expect(ledgerSummary(null, [])).toBe('')
    expect(costLine(null)).toBe('')
  })

  test('a unit says its state in a word beside its mark, and its counts that are not zero', () => {
    expect(printed().units.map(unit => [unitState(unit).glyph, unitState(unit).word, unitCounts(unit)])).toEqual([
      ['○', 'no session', []],
      ['–', 'turned off', ['1 open card']],
      ['●', 'working', ['1 headless run', '2 open cards']],
    ])
    expect(unitState({ ...printed().units[0]!, state: 'standby', sessions: 2 })).toEqual({ glyph: '○', word: 'standby', color: '#39FF14' })
  })

  test('a provider reads up, down with its reason, or off, with the button that flips it', () => {
    expect(printed().providers.map(providerLine)).toEqual([
      { state: 'up', color: '#39FF14', action: 'disable' },
      { state: 'off', color: undefined, action: 'enable' },
      { state: 'down: CLI_NOT_FOUND: omp is not on PATH', color: RED, action: 'disable' },
    ])
  })

  test('the layout: mini inline, wide docked from 110 columns, compact below; a set layout wins', () => {
    expect(shapeOf('auto', 'inline', 200)).toBe('mini')
    expect(shapeOf('auto', 'dock', 109)).toBe('compact')
    expect(shapeOf('auto', 'dock', 110)).toBe('wide')
    expect(shapeOf('wide', 'inline', 40)).toBe('wide')
    expect(shapeOf('mini', 'dock', 200)).toBe('mini')
  })

  test("where a worker stands is green while it works, amber while it waits on a person, uncoloured otherwise", () => {
    const [here, gen2] = printed().cards
    expect(workerColor(here!.worker!)).toBe(GREEN)
    expect(workerColor(gen2!.worker!)).toBe(AMBER)
    expect(workerColor({ ...gen2!.worker!, state: 'idle' })).toBeUndefined()
    expect(workerColor({ ...here!.worker!, state: 'unknown' })).toBeUndefined()
  })

  test('the exchange timeline marks a reply green, a request or a question amber, the rest a dim point', () => {
    expect(['reply', 'request', 'turn', 'question', 'note', 'answer'].map(kind => exchangeMark(kind))).toEqual([
      { glyph: '●', color: GREEN }, { glyph: '▸', color: AMBER }, { glyph: '▸', color: AMBER }, { glyph: '?', color: AMBER },
      { glyph: '·', color: undefined }, { glyph: '·', color: undefined },
    ])
  })

  test('the ledger bar shares its cells by the verdict counts, at least one cell per count, none when nothing was counted', () => {
    expect(ledgerBar({ accepted: 5, rejected: 1, open: 0 }, 30)).toEqual([{ cells: 25, color: GREEN, label: 'accepted' }, { cells: 5, color: RED, label: 'rejected' }])
    expect(ledgerBar({ accepted: 98, rejected: 1, open: 1 }, 20).map(run => run.cells)).toEqual([18, 1, 1])
    expect(ledgerBar({ accepted: 1, rejected: 1, open: 1 }, 30).reduce((n, run) => n + run.cells, 0)).toBe(30)
    expect(ledgerBar({ accepted: 0, rejected: 0, open: 0 }, 30)).toEqual([])
    expect(ledgerBar({ accepted: 1, rejected: 1, open: 1 }, 2)).toEqual([])
  })
})

describe('the triad', () => {
  test('a working card is a lane from its asker to its worker; a waiting question runs back; a card between unlisted units is left out', () => {
    expect(lanes(printed(), HERE)).toEqual([
      { from: 'claude', to: 'omp', isHere: true, isQuestion: false, taskId: 'magi-open0001' },
      { from: 'claude', to: 'codex', isHere: false, isQuestion: false, taskId: 'magi-open0002' },
      { from: 'omp', to: 'claude', isHere: false, isQuestion: true, taskId: 'magi-asks0001' },
    ])
    expect(lanes({ ...printed(), units: printed().units.slice(0, 2) }, HERE).map(lane => lane.taskId)).toEqual(['magi-open0002'])
    expect(lanes(printed(), null).every(lane => !lane.isHere)).toBe(true)
  })

  test('the triad draws three panels named in English with the codename small after, a stamp counting the cards, and a packet per lane', () => {
    const drawn = triadSvg({ status: mineAll(printed()), sessionId: HERE, width: 1200, failedTo: ['codex'] })
    expect(drawn.source.length).toBeLessThan(131072)
    expect(drawn.height).toBeGreaterThan(200)
    expect(drawn.source.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 ')).toBe(true)
    // Plain English carries the meaning; the codename is a small dim label after the name.
    for (const [name, codename] of [['claude', 'MELCHIOR-1'], ['codex', 'BALTHASAR-2'], ['omp', 'CASPER-3']]) {
      expect(drawn.source.indexOf(`>${name}</text>`)).toBeLessThan(drawn.source.indexOf(`>${codename}</text>`))
      expect(drawn.source).toContain(`letter-spacing="2" fill="#8B8B99" text-anchor="end">${codename}</text>`)
    }
    expect(drawn.alt).toBe('claude (MELCHIOR-1) no session; codex (BALTHASAR-2) turned off, 1 open card; omp (CASPER-3) working, 1 headless run, 2 open cards; 2 cards in flight')
    // The stamp: two in flight, one question waiting; its kanji dim after the words.
    expect(drawn.source).toContain('>2 in flight · 1 question waiting</text>')
    expect(drawn.source).toContain('>作動中</text>')
    // Packets: this session's orange, the question amber; each moves along its lane.
    const packets = drawn.source.match(/<circle class="pk" r="[\d.]+" fill="(#[0-9A-F]{6})"[^>]*filter="url\(#glow\)"/g) ?? []
    expect(packets.map(p => /fill="(#[0-9A-F]{6})"/.exec(p)?.[1])).toEqual([ORANGE, ORANGE, AMBER])
    // Three packets, and the glint on the one idle link (codex and omp).
    expect((drawn.source.match(/<animateMotion /g) ?? []).length).toBe(4)
    // A unit a delivery failed to wears the red hazard strip and says so; a provider down the orange one.
    expect(drawn.source).toContain('fill="url(#hz-failed)"')
    expect(drawn.source).toContain('>a delivery to it failed</text>')
    expect(drawn.source).toContain('fill="url(#hz-down)"')
    expect(drawn.source).toContain('>provider down: CLI_NOT_FOUND: omp is not on PATH</text>')
    // Nothing moves without a reason: a ring only on a unit a card is in flight to.
    expect((drawn.source.match(/class="ping"/g) ?? []).length).toBe(2)
  })

  test("the stamp's words stay inside its frame at every width, the long caption shortened before it would cross", () => {
    const busy = mineAll(printed())
    const many = { ...busy, cards: [...busy.cards, ...busy.cards.map(card => ({ ...card, taskId: `${card.taskId}-b` }))] }
    for (const width of [700, 800, 1000, 1290]) {
      const { source } = triadSvg({ status: many, sessionId: HERE, width, failedTo: [] })
      // The stamp is the frame drawn just before the 28 px figure.
      const stamp = /<polygon points="([^"]+)"[^>]*\/><text x="[\d.]+" y="[\d.]+" font-size="28"[\s\S]*?(?=<polygon|<\/g>|<\/svg>|$)/.exec(source)
      expect(stamp, `stamp at ${width}`).not.toBeNull()
      const xs = (stamp?.[1] ?? '').split(' ').map(point => Number(point.split(',')[0]))
      const right = Math.max(...xs)
      // Every left-anchored line of words ends inside the frame (the kanji is right-anchored to it).
      for (const m of (stamp?.[0] ?? '').matchAll(/<text x="([\d.]+)"[^>]*font-size="([\d.]+)"(?:[^>]*letter-spacing="([\d.]+)")?(?![^>]*text-anchor)[^>]*>([^<]*)<\/text>/g)) {
        const [, x, size, spacing, words] = m
        const end = Number(x) + [...(words ?? '')].length * (Number(size) * 0.62 + Number(spacing ?? 0))
        expect(end, `"${words}" at ${width}`).toBeLessThanOrEqual(right - 8)
      }
    }
  })

  test('standby: idle links carry only the glint, the stamp carries no clock, and text is escaped', () => {
    const status = { ...printed(), cards: [], providers: printed().providers.map(p => (p.name === 'omp' ? { ...p, reason: 'a <b>"tag"</b> & more' } : p)) }
    const drawn = triadSvg({ status, sessionId: HERE, width: 1200, failedTo: [] })
    expect(drawn.source).toContain('>standby</text>')
    expect(drawn.source).not.toMatch(/ago|just now/)
    expect(drawn.source).toContain('>待機</text>')
    // A narrow stamp keeps the words; coordinates are short.
    const narrow = triadSvg({ status, sessionId: HERE, width: 700, failedTo: [] })
    expect(narrow.source).toContain('>standby</text>')
    expect(narrow.source).not.toMatch(/[ML]-?\d+\.\d{2,}/)
    expect(drawn.source).not.toContain('filter="url(#glow)"')
    expect((drawn.source.match(/<animateMotion /g) ?? []).length).toBe(3)
    expect(drawn.source).toContain('provider down: a &lt;b&gt;&quot;tag&quot;&lt;/b&gt; &amp; more')
    expect(drawn.source).not.toContain('<b>')
    expect(drawn.alt).toContain('no card in flight')
  })
})

describe('Magi tool calls', () => {
  test('a toast names the peer and the card; a refused or failed call says so; the read-only kinds stay quiet', () => {
    expect(toolToast('mcp__magi__codex_peer', { kind: 'request' }, { deny: 'no' })).toBe('Magi request to codex was refused')
    expect(toolToast('mcp__magi__omp_peer', { kind: 'reply' }, { isError: true })).toBe('Magi reply to omp failed')
    expect(toolToast('mcp__magi__omp_peer', {}, { isError: true, text: 'magi error - NO_LIVE_PEER: none here' })).toBe('Magi request to omp failed: NO_LIVE_PEER')
    expect(toolToast('mcp__magi__claude_peer', {}, {})).toBe('Request sent to claude')
    expect(toolToast('mcp__magi__omp_peer', { task: 'x' }, { result: { content: [], structuredContent: { taskId: 'magi-9' } } })).toBe('Request sent to omp (magi-9)')
    expect(toolToast('mcp__magi__omp_peer', { taskId: 'magi-9', task: 'x' }, {})).toBe('Follow-up sent to omp (magi-9)')
    expect(toolToast('mcp__magi__omp_peer', { kind: 'outcome', taskId: 'magi-9', accepted: 5, rejected: 1 }, {})).toBe('Outcome recorded: 5 accepted, 1 rejected, 0 open')
    expect(toolToast('mcp__magi__omp_peer', { kind: 'peers' }, {})).toBeUndefined()
  })

  test('a request, a reply and an outcome carry their kanji accent; the other kinds none', () => {
    const view = (input: Record<string, unknown>) => ({ tool: 'mcp__magi__omp_peer', input, isRunning: false, isErrored: false, isInterrupted: false })
    expect(toolRow(view({ task: 'x' }))?.accent).toBe('要請')
    expect(toolRow(view({ kind: 'reply', taskId: 'magi-1', body: 'x' }))?.accent).toBe('回答')
    expect(toolRow(view({ kind: 'outcome', taskId: 'magi-1' }))?.accent).toBe('照合')
    expect(toolRow(view({ kind: 'peers' }))?.accent).toBe('')
  })
})

describe('late cards', () => {
  const base = (worker: Partial<NonNullable<MagiCard['worker']>>): MagiCard => ({
    ...printed().cards[1]!, openedAt: NOW - 70 * MINUTE, delivery: [],
    worker: { ...printed().cards[1]!.worker!, lastSaid: null, lastActivityAt: null, timeoutAt: null, ...worker },
  })
  test('an idle, silent or long headless worker is shown on its card, never alerted', () => {
    for (const worker of [{ state: 'idle' as const, live: false }, { state: 'working' as const, live: true }, { state: 'working' as const, live: false, via: 'headless' as const, timeoutAt: NOW - MINUTE }]) {
      expect(alerts(mineAll({ ...printed(), cards: [base(worker)], failures: [] }), NOW, HERE)).toEqual([])
    }
  })
})

describe('whose alerts', () => {
  test("another session's late card raises no alert here", () => {
    const status = printed()
    expect(alerts(status, NOW, 'sess-somebody-else')).toEqual([])
    expect(alerts(status, NOW, null)).toEqual([])
    expect(alerts(mineAll(status), NOW, HERE).length).toBeGreaterThan(0)
  })
})

describe('the deck in detail', () => {
  const live = (over: Partial<NonNullable<MagiCard['worker']>>): NonNullable<MagiCard['worker']> =>
    ({ harness: 'omp', name: 'Polished-2', id: '0f1e2d3c', live: true, state: 'working', lastActivityAt: NOW - 3 * MINUTE, lastSaid: 'Reading.', via: 'live', timeoutAt: null, host: null, waitingFor: null, unseen: false, ...over })

  test('the round shows its cap only where the cap is real: never past it, never on a live DELEGATE or PARALLEL card', () => {
    expect(roundText({ round: 1, maxRounds: 6, mode: 'ADVERSARIAL_REVIEW', worker: live({}) })).toBe('round 1/6')
    expect(roundText({ round: 3, maxRounds: 2, mode: 'REVIEW', worker: live({}) })).toBe('round 3')
    expect(roundText({ round: 1, maxRounds: 2, mode: 'DELEGATE', worker: live({}) })).toBe('round 1')
    expect(roundText({ round: 1, maxRounds: 2, mode: 'PARALLEL', worker: live({}) })).toBe('round 1')
    expect(roundText({ round: 1, maxRounds: 2, mode: 'DELEGATE', worker: live({ via: 'headless' }) })).toBe('round 1/2')
    expect(roundText({ round: 2, maxRounds: null, mode: 'REVIEW', worker: null })).toBe('round 2')
  })

  test('a live worker idle or gone for half an hour is stalled, in amber, with how long; working, waiting, headless and unknown read as themselves', () => {
    const card = { openedAt: NOW - 4 * 60 * MINUTE }
    expect(standing(live({ state: 'idle', lastActivityAt: NOW - 185 * MINUTE }), card, NOW)).toEqual({ icon: 'stateStalled', word: 'stalled · idle 3h05', color: AMBER, isStalled: true })
    expect(standing(live({ state: 'unknown', live: false, lastActivityAt: null }), card, NOW)).toEqual({ icon: 'stateStalled', word: 'stalled · gone 4h00', color: AMBER, isStalled: true })
    expect(standing(live({ state: 'idle', lastActivityAt: NOW - STALLED_MS + MINUTE }), card, NOW)).toEqual({ icon: 'stateIdle', word: 'idle', color: undefined, isStalled: false })
    expect(standing(live({}), card, NOW)).toMatchObject({ icon: 'stateWorking', word: 'working', color: GREEN })
    expect(standing(live({ state: 'waiting' }), card, NOW)).toMatchObject({ icon: 'stateWaiting', word: 'waiting on a person', color: AMBER })
    expect(standing(live({ state: 'waiting', waitingFor: 'approval of bash' }), card, NOW)).toMatchObject({ word: 'waiting on a person: approval of bash' })
    // On another machine with no fresh word: not seen, never gone or stalled however quiet.
    expect(standing(live({ state: 'unknown', live: false, unseen: true, host: 'mac', lastActivityAt: NOW - 185 * MINUTE }), card, NOW)).toEqual({ icon: 'stateUnknown', word: 'not seen lately', color: undefined, isStalled: false })
    expect(standing(live({ via: 'headless' }), card, NOW)).toMatchObject({ icon: 'stateRunning', word: 'running', color: GREEN })
    expect(standing(live({ via: 'headless', state: 'idle', lastActivityAt: NOW - 185 * MINUTE }), card, NOW)).toMatchObject({ icon: 'stateEnded', word: 'ended', isStalled: false })
    expect(standing(null, card, NOW)).toMatchObject({ icon: 'stateUnknown', word: 'no worker listed' })
  })

  test('the receipt of the last message to the worker reads as ticks; a headless run says its time left', () => {
    expect(receiptOf({ to: 'omp', delivery: [{ to: 'claude', status: 'received', at: 1 }, { to: 'omp', status: 'queued_unread', at: 2 }] })).toEqual({ icon: 'delivered', label: 'delivered, unread', color: undefined, at: 2 })
    expect(receiptOf({ to: 'omp', delivery: [{ to: 'omp', status: 'received', at: 3 }] })).toMatchObject({ icon: 'read', label: 'read', color: GREEN })
    expect(receiptOf({ to: 'omp', delivery: [{ to: 'omp', status: 'failed', at: 3 }] })).toMatchObject({ icon: 'failed', label: 'failed', color: RED })
    expect(receiptOf({ to: 'omp', delivery: [{ to: 'omp', status: 'odd_word', at: null }] })).toEqual({ icon: 'queued', label: 'odd_word', color: undefined, at: null })
    expect(receiptOf({ to: 'omp', delivery: [] })).toBeNull()
    expect(timeoutText(live({ via: 'headless', timeoutAt: NOW + 23 * MINUTE }), NOW)).toBe('23m left')
    expect(timeoutText(live({ via: 'headless', timeoutAt: NOW - MINUTE }), NOW)).toBe('past its timeout')
    expect(timeoutText(live({ timeoutAt: NOW + MINUTE }), NOW)).toBe('')
  })

  test('a possible Claude hold is receipt detail, not a failed state or an alert', () => {
    const statusText = 'may have been held for approval at that Claude session and dropped after 5 min; ask the user to check/approve there or resend'
    const raw = JSON.parse(PRINTED)
    raw.cards = [{ ...raw.cards[0], from: 'omp', to: 'claude', delivery: [{ to: 'claude', status: 'unconfirmed', at: NOW - 10 * MINUTE, statusText }] }]
    raw.failures = []
    const status = parseStatus(JSON.stringify(raw))!
    const card = status.cards[0]!
    expect(card.delivery[0]?.status).toBe('unconfirmed')
    expect(cardLines(card, NOW).fields.find(f => f.label === 'Delivery')?.value).toContain(statusText)
    expect(receiptOf(card)?.icon).toBe('sent')
    expect(alerts(status, NOW, HERE)).toEqual([])
  })

  test("Your move: this session's waiting questions and failed deliveries, then the replies to reconcile against the limit; empty with nothing waiting", () => {
    const status = mineAll(printed())
    expect(yourMove(status, HERE, NOW)).toEqual([
      { kind: 'question', taskId: 'magi-asks0001', text: 'omp asks: a question is waiting on the card', since: '6m ago', color: AMBER },
      { kind: 'failed', taskId: 'magi-open0002', text: 'Delivery to codex failed on magi-open0002', since: '', color: RED },
      { kind: 'failed', taskId: 'magi-gone0001', text: 'Delivery to omp failed on magi-gone0001: NO_LIVE_PEER', since: '', color: RED },
      { kind: 'reconcile', taskId: null, text: '1 reply for claude to reconcile · 1 of 3 before new cards are refused', since: '', color: AMBER },
    ])
    // The question's own words when the card carries them; past the limit the reconcile row turns red.
    const asked = { ...status, unreconciled: 4, cards: status.cards.map(card => (card.turn === 'orchestrator' ? { ...card, recent: [{ at: NOW - 2 * MINUTE, from: 'omp', kind: 'question', text: 'Which branch?' }] } : card)) }
    const rows = yourMove(asked, HERE, NOW)
    expect(rows[0]).toMatchObject({ kind: 'question', text: 'omp asks: Which branch?', since: '6m ago' })
    expect(rows.at(-1)).toMatchObject({ kind: 'reconcile', text: '4 replies for claude to reconcile · 4 of 3 over the limit: new cards are refused until outcomes are recorded', color: RED })
    expect(yourMove(printed(), 'sess-other', NOW).map(row => row.kind)).toEqual(['reconcile'])
    expect(yourMove({ ...printed(), unreconciled: 0 }, null, NOW)).toEqual([])
    expect(yourMove(null, HERE, NOW)).toEqual([])
  })

  test('the exchange threads by card, the card with the newest message first, titled by its task line when listed', () => {
    const list = threads(printed())
    expect(list.map(thread => [thread.taskId, thread.title, thread.messages.map(m => m.kind)])).toEqual([
      ['magi-open0001', 'magi-open0001 · Check the band line [REDACTED]', ['note']],
      ['magi-done0005', 'magi-done0005 · to claude', ['reply']],
    ])
    expect(threads(null)).toEqual([])
  })

  test('the ledger by direction, the most cards first, nothing counted left out; the cost in one line', () => {
    const ledger = printed().ledger!
    const more = { ...ledger, byDirection: [...ledger.byDirection, { from: 'codex', to: 'omp', cards: 9, checked: 9, accepted: 20, rejected: 0, open: 1, heldPct: 100 }, { from: 'omp', to: 'codex', cards: 0, checked: 0, accepted: 0, rejected: 0, open: 0, heldPct: null }] }
    expect(directionRows(more).map(row => [row.label, row.cards, row.heldPct])).toEqual([['codex → omp', 9, 100], ['claude → codex', 2, 83]])
    expect(directionRows(null)).toEqual([])
    expect(costText(ledger)).toBe('$1.23 over 7 days (2 priced runs)')
    expect(costText({ ...ledger, pricedRuns: 0 })).toBe('')
  })

  test('the icon tables name the same meanings; the Nerd Font ones are private-use glyphs, the plain ones never', () => {
    expect(Object.keys(NERD).sort()).toEqual(Object.keys(PLAIN).sort())
    expect(Object.values(NERD).every(hasPrivateUse)).toBe(true)
    expect(Object.values(PLAIN).some(hasPrivateUse)).toBe(false)
    expect(glyphs(true)).toBe(NERD)
    expect(glyphs(false)).toBe(PLAIN)
  })

  test('the panels: the font option first in every font list, no clock finer than a minute, plain Unicode with icons off, text escaped', () => {
    const status = mineAll(printed())
    const card = status.cards[0]!
    const nerd = { font: '0xProto Nerd Font Mono', icons: true }
    const plain = { font: 'Cascadia Mono', icons: false }
    expect(fontList('')).toBe("'0xProto Nerd Font Mono', 'JetBrainsMono Nerd Font Mono', 'Cascadia Mono', Consolas, monospace")
    const row = cardRowSvg({ card, isHere: true, now: NOW, width: 1000, style: nerd })
    expect(row.source).toContain('font-family="&#39;0xProto Nerd Font Mono&#39;, ')
    expect(row.height).toBe(46)
    expect(row.alt).toBe('omp Polished-2 · Check the band line [REDACTED] · DELEGATE · round 1/2 · headless · running · 3m ago: Reading src/status.mjs now. · last message running')
    // Ten seconds later, within the minute: the same markup. A minute later: only the `ago` moved.
    expect(cardRowSvg({ card, isHere: true, now: NOW + 10_000, width: 1000, style: nerd }).source).toBe(row.source)
    expect(cardRowSvg({ card, isHere: true, now: NOW + MINUTE, width: 1000, style: nerd }).source).not.toBe(row.source)
    expect(row.source).not.toMatch(/\d\d:\d\d:\d\d/)
    // Icons off: no private-use codepoint anywhere; the same facts in plain marks.
    const panels = [
      cardRowSvg({ card, isHere: false, now: NOW, width: 700, style: plain }),
      yourMoveSvg({ rows: yourMove(status, HERE, NOW), width: 700, style: plain }),
      exchangeSvg({ threads: threads(status), as: 'claude', width: 700, style: plain }),
      ledgerSvg({ ledger: status.ledger, outcomes: status.outcomes, rows: directionRows(status.ledger), width: 700, style: plain }),
      headingSvg({ title: 'Working', icon: 'working', count: '2 cards', note: '1-9 open a card', width: 700, style: plain }),
    ]
    for (const panel of panels) {
      expect(hasPrivateUse(panel.source), panel.alt).toBe(false)
      expect(panel.source).toContain('font-family="&#39;Cascadia Mono&#39;, ')
      expect(panel.source.length).toBeLessThan(131072)
    }
    expect(panels[0]!.source).toContain('<g opacity="0.55">')
    expect(yourMoveSvg({ rows: [], width: 700, style: nerd }).alt).toBe('nothing waiting on you')
    // A narrow row keeps the task line by shortening its tags; markup never carries raw text.
    const narrow = cardRowSvg({ card: { ...card, brief: 'a <b>"task"</b> & more' }, isHere: true, now: NOW, width: 600, style: nerd })
    expect(narrow.source).toContain('a &lt;b&gt;&quot;task&quot;&lt;/b&gt; &amp; more')
    expect(narrow.source).toContain('>r1/2</text>')
    expect(narrow.source).not.toContain('<b>')
  })
})

describe('the fleet beyond this machine', () => {
  // As `magi status --json` prints a remote worker (src/status.mjs): the card's
  // worker names its host, the unit counts it, and the remotes list it.
  const remote = () => {
    const raw = JSON.parse(PRINTED)
    raw.units = raw.units.map((unit: { harness: string }) => (unit.harness === 'omp' ? { ...unit, remoteWorkers: 1 } : unit))
    raw.cards[0].worker = { ...raw.cards[0].worker, name: 'headless omp on devbox', host: 'devbox' }
    raw.remotes = [
      { name: 'devbox', configured: true, workers: [{ taskId: 'magi-open0001', harness: 'omp' }], live: [{ taskId: 'magi-open0002', harness: 'omp', name: 'devbox-omp' }], openCards: 2 },
      { name: 'macbook', configured: true, workers: [], openCards: 0 },
      { name: 'gone', configured: false, workers: [{ taskId: 'magi-x', harness: 'claude' }, { taskId: 'magi-y', harness: 'claude' }], openCards: 0 },
      { name: '', configured: true, workers: [], openCards: 0 },
    ]
    return parseStatus(JSON.stringify(raw))!
  }

  test('files between machines read as on only when the server says so', () => {
    const raw = JSON.parse(PRINTED)
    expect(parseStatus(JSON.stringify({ ...raw, files: true }))!.files).toBe(true)
    expect(parseStatus(JSON.stringify({ ...raw, files: 'yes' }))!.files).toBe(false)
    expect(parseStatus(PRINTED)!.files).toBe(false)
  })

  test('reads each remote, the worker host and the remote count; an older Magi prints none', () => {
    const status = remote()
    expect(status.remotes.map(r => r.name)).toEqual(['devbox', 'macbook', 'gone'])
    expect(status.cards[0]!.worker!.host).toBe('devbox')
    expect(status.units.find(u => u.harness === 'omp')!.remoteWorkers).toBe(1)
    const old = parseStatus(PRINTED)!
    expect(old.remotes).toEqual([])
    expect(old.cards[0]!.worker!.host).toBeNull()
    expect(old.units.every(u => u.remoteWorkers === 0)).toBe(true)
  })

  test('says what each machine is doing, and where a headless run is', () => {
    const [devbox, macbook, gone] = remote().remotes
    expect(remoteWords(devbox!)).toBe('1 omp worker running · 1 live session on cards (devbox-omp) · 2 open cards')
    expect(devbox!.live).toEqual([{ taskId: 'magi-open0002', harness: 'omp', name: 'devbox-omp' }])
    expect(remoteWords(macbook!)).toBe('idle')
    expect(remoteWords(gone!)).toBe('2 claude workers running · not in remotes.json')
    expect(unitCounts(remote().units.find(u => u.harness === 'omp')!)).toEqual(['1 headless run (1 remote)', '2 open cards'])
    expect(cardLines(remote().cards[0]!, NOW).id).toContain('headless worker running on devbox')
    // A message that carried files says so, by name, after its words; an older Magi's carries none.
    const raw = JSON.parse(PRINTED)
    raw.exchanges[0].files = ['report.txt', 'shot.png']
    const withFiles = parseStatus(JSON.stringify(raw))!
    expect(withFiles.exchanges[0]!.files).toEqual(['report.txt', 'shot.png'])
    expect(exchangeLine(withFiles.exchanges[0]!).words).toBe('Reading src/status.mjs now. · 2 files: report.txt, shot.png')
    expect(parseStatus(PRINTED)!.exchanges[0]!.files).toEqual([])
    expect(filesNote(['a', 'b', 'c', 'd'])).toBe(' · 4 files: a, b, c, …')
    expect(NERD.remotes).toBe('\u{F233}')
    expect(hasPrivateUse(PLAIN.remotes)).toBe(false)
  })
})
