// The trees: a peer message's row (header over its body) and its collapsed
// line, a Magi tool call's line, the alert band above the prompt, and the
// deck. Each takes the surface's own element table; props stay inside what
// Elements allows on every surface (a tree that fails validation is not
// drawn, and the engine then draws its own). Plain English carries every
// meaning; kanji are dim accents after it, at most one per heading, and only
// while themed.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { DeckView, MagiCard, MagiProvider, MagiStatus, MagiThread, MagiUnit } from '../types'

import type { PeerHead } from './clean-peer-text.ts'
import type { BusLane } from './bus.tsx'
import {
  HOTKEYS,
  agoText,
  alerts,
  cardLines,
  clockOf,
  costLine,
  directionRows,
  exchangeMark,
  fitText,
  inFlight,
  ledgerBar,
  ledgerDetails,
  ledgerSummary,
  providerLine,
  receiptOf,
  remoteWords,
  roundText,
  standing,
  tallyWords,
  threads,
  timeoutText,
  timerText,
  unitCounts,
  unitState,
  unlistedCards,
  workingGroups,
  yourMove,
} from './deck.ts'
import type { Alert, DirectionRow, MoveRow, Shape, Thread, Waiting, WorkingGroup } from './deck.ts'
import { glyphs } from './glyphs.ts'
import type { IconName } from './glyphs.ts'
import { AMBER, EDGE, GREEN, HAZARD, KANJI, KIND_COLOR, KIND_KANJI, ORANGE, PURPLE, RED, firstLine, plural } from './nerv.ts'
import type { ToolRow } from './nerv.ts'
import { cardRowSvg, exchangeSvg, fontList, groupSvg, headingSvg, ledgerSvg, yourMoveSvg } from './panels.ts'
import type { Panel, PanelStyle } from './panels.ts'
import { lanes, triadSvg } from './triad.ts'

/**
 * The elements every drawing here uses; terminal and desktop both have them.
 * `Client` and `Svg` are optional: without `Client` nothing moves, without
 * `Svg` (the terminal) the units are boxes over a bus instead of the triad.
 */
export type Table = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & Partial<Pick<Elements['terminal'], 'Client' | 'Markdown'>> & Partial<Pick<Elements['desktop'], 'Svg'>>

/**
 * CSS pixels one column of the pane comes to on a vector surface, to size
 * the panels from `bodyColumns`. An estimate (the desktop reports cells over
 * its code font's advance, not pixels): each panel carries a viewBox and no
 * width prop, so a slot narrower than the estimate scales the drawing down
 * and one wider leaves a margin, never a cut.
 */
const PX_PER_COLUMN = 8

/** False when a `ui.resolve` hook left an element out: the caller then passes. */
export function hasElements(t: Partial<Table>): t is Table {
  return typeof t.Box === 'function' && typeof t.Text === 'function' && typeof t.Button === 'function'
}

/** A dim kanji accent after the English, two spaces before it; nothing when unthemed. */
function accent(t: Table, themed: boolean, word: string | undefined): RenderElement | null {
  const { Text } = t
  return themed && word ? <Text dimColor>{`  ${word}`}</Text> : null
}

/** `▎ Reply from omp · magi-1 · round 2  回答`, the title in the kind's colour. */
function headText(t: Table, head: PeerHead, tail: RenderElement | null): RenderElement {
  const { Text } = t
  const color = KIND_COLOR[head.kind]
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{EDGE}</Text>
      <Text bold color={color}>{head.title}</Text>
      {head.details.length > 0 ? <Text dimColor>{` · ${head.details.join(' · ')}`}</Text> : null}
      {tail}
      {accent(t, true, KIND_KANJI[head.kind])}
    </Text>
  )
}

/** Expanded: the header line over the body the engine drew. */
export function rowCard(t: Table, head: PeerHead, body: RenderElement): RenderElement {
  const { Box } = t
  return (
    <Box flexDirection="column">
      {headText(t, head, null)}
      <Box flexDirection="column" paddingLeft={2}>{body}</Box>
    </Box>
  )
}

/** Collapsed: one line, `Reply from omp · magi-1 · round 2: first line of the body`. */
export function rowLine(t: Table, head: PeerHead, body: string): RenderElement {
  const { Box, Text } = t
  const line = firstLine(body)
  return <Box flexDirection="row">{headText(t, head, line ? <Text>{`: ${line}`}</Text> : null)}</Box>
}

/**
 * A Magi tool call, one line: `▎ Sent request to omp · DELEGATE · magi-1 ·
 * queued, not read yet · "task"  要請`. The state sits before the quoted text
 * so a narrow row cuts the text, never the state.
 */
export function toolLine(t: Table, row: ToolRow, toggle?: { isOpen: boolean; onToggle: () => void }): RenderElement {
  const { Box, Button, Text } = t
  return (
    <Box flexDirection="row">
      {toggle ? <Button key="details" plain label={toggle.isOpen ? '▾ hide' : '▸ details'} onPress={toggle.onToggle} /> : null}
      {toggle ? <Text> </Text> : null}
      <Text wrap="truncate-end">
        <Text color={row.color}>{EDGE}</Text>
        <Text>{row.action}</Text>
        {row.details.length > 0 ? <Text dimColor>{` · ${row.details.join(' · ')}`}</Text> : null}
        {row.state ? (
          <Text {...(row.state.color === undefined ? { dimColor: true } : { color: row.state.color })}>{` · ${row.state.label}`}</Text>
        ) : null}
        {row.text ? <Text dimColor>{` · ${row.text}`}</Text> : null}
        {accent(t, true, row.accent)}
      </Text>
    </Box>
  )
}

/** An opened call: its line, then the engine's own row with every argument. */
export function toolDetails(t: Table, line: RenderElement, engine: RenderElement): RenderElement {
  const { Box } = t
  return (
    <Box flexDirection="column">
      {line}
      <Box paddingLeft={2}>{engine}</Box>
    </Box>
  )
}

/** Alerts the band shows; past them one dim line says how many more the deck lists. */
const BAND_ALERTS = 3

/**
 * The band above the prompt: one line per alert, a coloured edge and the
 * alert's words as a button that opens the deck at its card. No accent: the
 * words are the whole line.
 */
export function alertBand(t: Table, list: readonly Alert[], themed: boolean, onAlert: (taskId: string) => void): RenderElement {
  const { Box, Button, Text } = t
  const more = list.length - BAND_ALERTS
  return (
    <Box flexDirection="column">
      {list.slice(0, BAND_ALERTS).map(alert => (
        <Box flexDirection="row">
          <Text {...(themed ? { color: alert.color } : { dimColor: true })}>{EDGE}</Text>
          <Button key={alert.key} plain label={alert.text} onPress={() => onAlert(alert.taskId)} />
        </Box>
      ))}
      {more > 0 ? <Text dimColor wrap="truncate-end">{`${EDGE}${plural(more, 'more alert')} in /magi`}</Text> : null}
    </Box>
  )
}

/** Bands drawn one under another; a lone one as itself. */
export function stacked(t: Table, parts: readonly (RenderElement | null)[]): RenderElement {
  const shown = parts.filter((part): part is RenderElement => part !== null)
  const { Box } = t
  return shown.length === 1 ? shown[0] as RenderElement : <Box flexDirection="column">{shown}</Box>
}

/**
 * The waiting band: while the session is idle, one calm line per card a peer
 * still owes it a reply on, `▎ Waiting on omp · magi-1 DELEGATE · 4:12 · the
 * reply comes back by itself`. Dim, never red: it explains the quiet, it asks
 * nothing. The head is a button that opens the deck at its card.
 */
export function waitingBand(t: Table, list: readonly Waiting[], now: number, onCard: (taskId: string) => void): RenderElement {
  const { Box, Button, Text, Client } = t
  const more = list.length - BAND_ALERTS
  const clock = (key: string, since: number | null) =>
    since === null ? null
      : Client ? <Client key={`${key}-clock`} module="./elapsed.tsx" props={{ since, now, color: 'subtle' }} />
        : <Text dimColor>{timerText(now - since)}</Text>
  return (
    <Box flexDirection="column">
      {list.slice(0, BAND_ALERTS).map(one => (
        <Box flexDirection="row">
          <Text dimColor>{EDGE}</Text>
          <Button key={one.key} plain dimColor label={one.head} onPress={() => onCard(one.taskId)} />
          {one.since === null ? null : <Text dimColor>{' · '}</Text>}
          {clock(one.key, one.since)}
          <Text dimColor wrap="truncate-end">{` · ${one.note}`}</Text>
        </Box>
      ))}
      {more > 0 ? <Text dimColor wrap="truncate-end">{`${EDGE}${plural(more, 'more card')} waiting, in /magi`}</Text> : null}
    </Box>
  )
}

/**
 * The prompt footer's mode labels on a surface whose footer takes a tree:
 * the engine's own modes, then the Magi summary (the status line's words)
 * as a plain dim button that opens the deck. `$.ui.status` cannot be
 * pressed; this can.
 */
export function footerTree(t: Table, engine: RenderElement, label: string, onOpen: () => void): RenderElement {
  const { Box, Button } = t
  return (
    <Box flexDirection="row" columnGap={1}>
      {engine}
      <Button key="magi-footer" plain dimColor label={label} onPress={onOpen} />
    </Box>
  )
}

export type DeckArgs = {
  /** The surface drawn on: the terminal has no vectors, so the panels are text there. */
  surface: RenderSurface
  status: MagiStatus | null
  error: string | null
  sessionId: string | null
  view: DeckView
  /** The opened card's whole conversation; null before it is read. */
  thread?: MagiThread | null
  shape: Shape
  columns: number
  now: number
  themed: boolean
  /** The `font` option: the monospace the vector panels are drawn in. */
  font: string
  /** The `icons` option: Nerd Font glyphs in the vector panels, else plain Unicode. */
  icons: boolean
  onRefresh: () => void
  /** Opens or closes a card where it was pressed: its full messages show under it there. */
  onExpand: (taskId: string, openIn?: 'working' | 'exchange') => void
  onLedger: () => void
  onProvider: (name: MagiProvider['name'], action: 'enable' | 'disable') => void
}

/** From this many columns the units stand side by side as three equal boxes; below, a line each. */
const UNIT_BOXES_FROM = 66
/** Columns a card row's Svg leaves for the open mark with its hotkey and the clock at the right. */
const CARD_ROW_SIDE = 14
/** Columns the ledger's heading leaves for its Details button. */
const LEDGER_BUTTON = 12

/**
 * The deck: a header, then the sections in reading order, each a heading
 * with a rule under it and its rows separated by hairlines. On a surface
 * that draws vectors, and while themed, each section's body is an Svg panel
 * in the chosen monospace (panels.ts); the controls (Refresh, a card's open
 * mark with its hotkey, Details, Enable and Disable) and a card's clock stay
 * native. On the terminal, and unthemed everywhere, the same sections are
 * text: a heading line with a rule, two lines per card over a dim rule,
 * the exchange threaded by card, the ledger by direction. Colour marks only
 * what needs reading first.
 */
export function deckTree(t: Table, a: DeckArgs): RenderElement {
  const { Box, Button, Text, Client, Svg } = t
  const W = Math.max(40, a.columns)
  const status = a.status
  const tint = (color: string | undefined) => (a.themed && color ? { color } : {})
  const isVector = a.themed && typeof Svg === 'function' && a.surface !== 'terminal'
  const style: PanelStyle = { font: a.font, icons: a.icons }
  const icons = glyphs(false)
  const moving = inFlight(status)
  const needs = alerts(status, a.now, a.sessionId)
  const moves = yourMove(status, a.sessionId, a.now)
  const groups = workingGroups(status, a.sessionId)
  const threadList = threads(status)
  const directions = directionRows(status?.ledger ?? null)

  // An Svg panel as an image: the frame `isInteractive` asks for paints its
  // own white page under a transparent drawing and reloads when the markup
  // changes; an image keeps the pane behind it. No width or height prop: the
  // surface fits the markup's own size to the slot, scaling it down when the
  // slot is narrower than the columns-to-pixels estimate.
  const image = (p: Panel) => (Svg ? <Svg source={p.source} alt={p.alt} /> : null)
  const pxOf = (cols: number) => Math.max(240, cols * PX_PER_COLUMN)

  // A working card's clock: ticks on the surface where a module can, else the time at this draw.
  const clock = (key: string, since: number | null) =>
    since === null ? (
      <Text dimColor>—</Text>
    ) : Client ? (
      <Client key={key} module="./elapsed.tsx" props={{ since, now: a.now, color: 'subtle' }} />
    ) : (
      <Text dimColor>{timerText(a.now - since)}</Text>
    )

  // ---- headings and rules
  // Vector: the icon, the title and a count over a hairline, in the panel font. Text: `Working · 6 cards ───`.
  const heading = (title: string, icon: IconName, opts: { count?: string; note?: string; kanji?: string; right?: RenderElement } = {}) => {
    if (isVector) {
      const width = pxOf(opts.right ? W - LEDGER_BUTTON : W)
      const drawn = image(headingSvg({ title, icon, ...(opts.count ? { count: opts.count } : {}), ...(opts.note ? { note: opts.note } : {}), width, style }))
      return opts.right ? <Box flexDirection="row" justifyContent="space-between" alignItems="center">{drawn}{opts.right}</Box> : drawn
    }
    const words = [title, opts.count ? ` · ${opts.count}` : '', opts.note ? `  ${opts.note}` : '', a.themed && opts.kanji ? `  ${opts.kanji}` : ''].join('')
    const fill = Math.max(0, W - [...words].length - 2 - (opts.right ? LEDGER_BUTTON : 0))
    const line = (
      <Text wrap="truncate-end">
        <Text bold {...tint(PURPLE)}>{title}</Text>
        {opts.count ? <Text dimColor>{` · ${opts.count}`}</Text> : null}
        {opts.note ? <Text dimColor>{`  ${opts.note}`}</Text> : null}
        {accent(t, a.themed, opts.kanji)}
        <Text dimColor>{` ${'─'.repeat(fill)}`}</Text>
      </Text>
    )
    return opts.right ? <Box flexDirection="row" justifyContent="space-between">{line}{opts.right}</Box> : line
  }
  const rule = () => <Text dimColor wrap="truncate-end">{'╌'.repeat(W)}</Text>

  // ---- full messages: an opened card's whole conversation, under the card
  // where it was opened (Working or Exchange). Each message is a dim line
  // (time, who to whom, kind, round) over its words, as markdown where the
  // surface draws it, since replies are written in markdown.
  const { Markdown } = t
  const fullMessages = (taskId: string, openIn: 'working' | 'exchange') => {
    if (a.view.expanded !== taskId || (a.view.openIn ?? 'working') !== openIn) return null
    const thread = a.thread?.taskId === taskId ? a.thread : null
    const body: RenderElement[] = !thread
      ? [<Text dimColor>Reading the messages…</Text>]
      : thread.error
        ? [<Text {...tint(RED)} wrap="wrap">{thread.error}</Text>]
        : thread.messages.length === 0
          ? [<Text dimColor>No messages kept for this card.</Text>]
          : [
              ...(thread.omitted > 0 ? [<Text dimColor wrap="wrap">{`${plural(thread.omitted, 'older message')} left out; magi exchange ${taskId} prints them all`}</Text>] : []),
              ...thread.messages.flatMap((m, i) => {
                const mark = exchangeMark(m.kind)
                return [
                  <Box flexDirection="row" {...(i > 0 ? { marginTop: 1 } : {})}>
                    <Text {...(mark.color && a.themed ? { color: mark.color } : { dimColor: true })}>{`${mark.glyph} `}</Text>
                    <Text dimColor wrap="truncate-end">{[m.at !== null ? clockOf(m.at) : '', `${m.from} → ${m.to}`, m.kind, m.round !== null ? `round ${m.round}` : ''].filter(Boolean).join(' · ')}</Text>
                  </Box>,
                  Markdown ? <Markdown text={m.text || '(no words)'} /> : <Text wrap="wrap">{m.text || '(no words)'}</Text>,
                  // The files it carried, by their names in the sender's tree.
                  ...(m.files.length ? [<Text dimColor wrap="wrap">{`${plural(m.files.length, 'file')}: ${m.files.join(', ')}`}</Text>] : []),
                ]
              }),
            ]
    return (
      <Box flexDirection="column" paddingLeft={4} marginTop={1} marginBottom={1}>
        {body}
        <Box flexDirection="row" marginTop={1}>
          <Button key={`close-${openIn}-${taskId}`} plain dimColor label="Close messages" onPress={() => a.onExpand(taskId, openIn)} />
        </Box>
      </Box>
    )
  }
  // A section: its heading and lines, a blank row above it.
  const section = (...body: (RenderElement | RenderElement[] | null)[]) => (
    <Box flexDirection="column" width={W} marginTop={1}>{body.flat()}</Box>
  )

  // ---- header: a few cells of hazard tape, the title, when it was read, Refresh
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          {a.themed ? <Text color={ORANGE} backgroundColor="#000000">{HAZARD}</Text> : null}
          {a.themed ? <Text> </Text> : null}
          <Text bold>Magi deck</Text>
          {status ? <Text dimColor>{` · ${W >= 56 ? 'updated ' : ''}${new Date(status.at).toTimeString().slice(0, 8)}`}</Text> : null}
        </Text>
        <Button key="refresh" plain dimColor label="Refresh" hotkey="r" onPress={a.onRefresh} />
      </Box>
      {status === null && !a.error ? <Text dimColor>Reading magi status…</Text> : null}
      {a.error ? <Text {...tint(RED)}>{a.error}</Text> : null}
      {status?.liveError ? <Text dimColor wrap="truncate-end">{`live sessions partly unreadable: ${status.liveError}`}</Text> : null}
    </Box>
  )

  // ---- your move: what waits on the orchestrator, first. A failed delivery
  // is a button that opens its card; the rest are lines. Empty: one dim line.
  const moveRow = (row: MoveRow) => {
    const edge = <Text {...(a.themed ? { color: row.color } : { dimColor: true })}>{EDGE}</Text>
    if (row.kind === 'failed' && row.taskId) {
      return (
        <Box flexDirection="row">
          {edge}
          <Button key={`need-failed-${row.taskId}`} plain label={row.text} onPress={() => a.onExpand(row.taskId as string)} />
        </Box>
      )
    }
    return (
      <Box flexDirection="row">
        {edge}
        <Text wrap="truncate-end">
          {row.taskId ? <Text dimColor>{`${row.taskId} `}</Text> : null}
          <Text>{row.text}</Text>
        </Text>
        {row.since ? <Box flexGrow={1} /> : null}
        {row.since ? <Text {...tint(row.color)}>{` ${row.since}`}</Text> : null}
      </Box>
    )
  }
  const movePanel = () =>
    section(
      heading('Your move', 'yourMove', { count: moves.length > 0 ? `${moves.length} waiting` : 'nothing waiting', kanji: KANJI.alert }),
      isVector
        ? image(yourMoveSvg({ rows: moves, width: pxOf(W), style }))
        : moves.length === 0
          ? <Text dimColor>{`${icons.clear} nothing waiting on you`}</Text>
          : moves.map(moveRow))

  // ---- units: the triad on a vector surface; three boxes over a bus, or a
  // line each when narrow, on the terminal. The mark beats while a card is
  // in flight to the unit; it is inside the unit's own box or line.
  const mark = (unit: MagiUnit) => {
    const state = unitState(unit)
    const isMoving = moving.has(unit.harness)
    return Client && a.themed && isMoving ? (
      <Client key={`pulse-${unit.harness}`} module="./pulse.tsx" width={1} height={1} props={{ active: true, glyph: state.glyph, color: state.color ?? 'subtle', dim: 'subtle' }} />
    ) : (
      <Text {...(state.color && a.themed ? { color: state.color } : { dimColor: true })}>{state.glyph}</Text>
    )
  }
  const providerNote = (unit: MagiUnit) => {
    const provider = status?.providers.find(p => p.name === unit.harness)
    if (!provider || provider.status === 'up' || unit.state === 'disabled') return null
    return provider.status === 'down'
      ? <Text wrap="truncate-end" {...(a.themed ? { color: RED } : {})}>provider down</Text>
      : <Text wrap="truncate-end" dimColor>provider off</Text>
  }
  const unitBox = (unit: MagiUnit, width: number) => (
    <Box flexDirection="column" borderStyle="single" {...(a.themed ? { borderColor: PURPLE } : { borderDimColor: true })} paddingX={1} width={width}>
      <Text wrap="truncate-end">
        <Text bold>{unit.harness}</Text>
        <Text dimColor>{`  ${unit.unit}`}</Text>
      </Text>
      <Box flexDirection="row">
        {mark(unit)}
        <Text wrap="truncate-end">{` ${unitState(unit).word}`}</Text>
      </Box>
      {unitCounts(unit).map(line => <Text dimColor wrap="truncate-end">{line}</Text>)}
      {providerNote(unit)}
    </Box>
  )
  const unitLine = (unit: MagiUnit) => {
    const counts = unitCounts(unit)
    const provider = status?.providers.find(p => p.name === unit.harness)
    const off = provider && provider.status !== 'up' && unit.state !== 'disabled' ? `provider ${provider.status === 'down' ? 'down' : 'off'}` : ''
    return (
      <Box flexDirection="row">
        {mark(unit)}
        <Text wrap="truncate-end">
          <Text bold>{` ${unit.harness.padEnd(8)}`}</Text>
          <Text>{unitState(unit).word}</Text>
          {counts.length > 0 ? <Text dimColor>{` · ${counts.join(' · ')}`}</Text> : null}
          {off ? <Text {...(provider?.status === 'down' ? tint(RED) : { dimColor: true })}>{` · ${off}`}</Text> : null}
          <Text dimColor>{`  ${unit.unit}`}</Text>
        </Text>
      </Box>
    )
  }
  const laneList = status ? lanes(status, a.sessionId) : []
  const failedTo = [...new Set(needs.map(alert => status?.cards.find(card => card.taskId === alert.taskId)?.to ?? ''))].filter(Boolean)
  const triad = () => (status ? image(triadSvg({ status, sessionId: a.sessionId, width: pxOf(W), failedTo, font: fontList(a.font) })) : null)
  const bus = (bw: number) => {
    if (!Client || laneList.length === 0 || !status) return null
    const portOf = new Map(status.units.map((unit, i) => [unit.harness, i * (bw + 1) + Math.floor(bw / 2)]))
    const busLanes: BusLane[] = laneList
      .filter(lane => portOf.has(lane.from) && portOf.has(lane.to))
      .map(lane => ({ from: portOf.get(lane.from) as number, to: portOf.get(lane.to) as number, color: lane.isQuestion ? AMBER : lane.isHere ? ORANGE : PURPLE }))
    if (busLanes.length === 0) return null
    return <Client key="bus" module="./bus.tsx" width={W} height={1} props={{ width: W, ports: [...portOf.values()], lanes: busLanes, rail: PURPLE }} />
  }
  const unitsPanel = () => {
    if (!status) return null
    const bw = Math.floor((W - 2) / 3)
    const body: (RenderElement | null)[] = isVector && W >= UNIT_BOXES_FROM
      ? [triad()]
      : W >= UNIT_BOXES_FROM
        ? [<Box flexDirection="row" columnGap={1}>{status.units.map(unit => unitBox(unit, bw))}</Box>, a.themed ? bus(bw) : null]
        : status.units.map(unitLine)
    return section(
      heading('Units', 'units', laneList.length > 0 ? { count: `${plural(laneList.length, 'card')} between them` } : {}),
      ...body)
  }

  // ---- working: cards by the session that asked; 1-9 open one. A card is
  // two lines (who and what; where its worker stands, its words, the receipt)
  // over a hairline, its clock at the right; open, its last messages follow.
  let hotkey = 0
  const cardBlock = (card: MagiCard, isHere: boolean) => {
    const lines = cardLines(card, a.now)
    const isOpen = a.view.expanded === card.taskId && (a.view.openIn ?? 'working') === 'working'
    hotkey += 1
    const key = hotkey <= HOTKEYS ? { hotkey: String(hotkey) } : {}
    const stand = standing(card.worker, card, a.now)
    const standColor = a.themed && (isHere || stand.isStalled) ? stand.color : undefined
    const receipt = receiptOf(card)
    const timeout = timeoutText(card.worker, a.now)
    const ago = stand.isStalled ? '' : agoText(card.worker?.lastActivityAt ?? null, a.now)
    const receiptHints = !isOpen ? card.delivery.filter(d => d.statusText).map(d => (
      <Text dimColor wrap="wrap">{`to ${d.to}: ${d.statusText}`}</Text>
    )) : null
    const opened = isOpen ? (
      <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
        {lines.fields.map(field => (
          <Text wrap="wrap">
            <Text dimColor>{`${field.label}${field.note ? ` (${field.note})` : ''}: `}</Text>
            <Text {...(field.isQuiet ? { dimColor: true } : {})}>{field.value}</Text>
          </Text>
        ))}
        <Text dimColor wrap="truncate-end">{lines.id}</Text>
        {fullMessages(card.taskId, 'working')}
      </Box>
    ) : null
    if (isVector) {
      const row = cardRowSvg({ card, isHere, now: a.now, width: pxOf(W - CARD_ROW_SIDE), style })
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="flex-start">
            <Button key={`card-${card.taskId}`} plain dimColor {...key} label={isOpen ? '▾' : '▸'} onPress={() => a.onExpand(card.taskId)} />
            <Text> </Text>
            {image(row)}
            <Box flexGrow={1} />
            <Box flexShrink={0}>{clock(`clock-${card.taskId}`, card.openedAt)}</Box>
          </Box>
          {receiptHints}
          {opened}
        </Box>
      )
    }
    // A Button's label does not truncate: cut it to the room the row leaves (the mark, the hotkey, the tags, the clock).
    const tags = `${card.mode} · ${roundText(card)} · ${card.worker?.via === 'headless' ? icons.headless : icons.live}`
    const label = fitText(lines.head, W - 11 - tags.length)
    const second = [stand.word, ago, card.worker?.lastSaid ?? 'nothing said yet'].filter(Boolean).join(' · ')
    const receiptText = receipt ? `${icons[receipt.icon]} ${receipt.label}${receipt.at !== null ? ` ${clockOf(receipt.at)}` : ''}` : ''
    const tail = [receiptText, timeout ? `${icons.timeout} ${timeout}` : ''].filter(Boolean).join('  ')
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text {...(standColor ? { color: standColor } : { dimColor: true })}>{`${icons[stand.icon]} `}</Text>
          <Button key={`card-${card.taskId}`} plain {...(isHere ? {} : { dimColor: true })} {...key} label={label} onPress={() => a.onExpand(card.taskId)} />
          <Box flexGrow={1} />
          <Text dimColor>{` ${tags}  `}</Text>
          <Box flexShrink={0}>{clock(`clock-${card.taskId}`, card.openedAt)}</Box>
        </Box>
        <Box flexDirection="row" paddingLeft={2}>
          <Text wrap="truncate-end">
            <Text {...(standColor ? { color: standColor } : { dimColor: true })}>{stand.word}</Text>
            <Text dimColor>{second.slice(stand.word.length)}</Text>
          </Text>
          {tail ? <Box flexGrow={1} /> : null}
          {tail ? <Text wrap="truncate-end" {...(receipt?.color && a.themed ? { color: receipt.color } : { dimColor: true })}>{` ${tail}`}</Text> : null}
        </Box>
        {receiptHints}
        {opened}
        {rule()}
      </Box>
    )
  }
  const workingCount = groups.reduce((n, group) => n + group.cards.length, 0)
  const groupHead = (group: WorkingGroup) => {
    const count = plural(group.cards.length, 'card')
    if (isVector) return image(groupSvg({ heading: group.heading, count, isHere: group.isHere, width: pxOf(W), style }))
    return <Text bold={group.isHere} dimColor={!group.isHere} wrap="truncate-end">{group.isHere ? group.heading : `${group.heading} · ${count}`}</Text>
  }
  const workingPanel = () =>
    section(
      heading('Working', 'working', { count: plural(workingCount, 'card'), note: workingCount > 0 ? '1-9 open a card' : '', kanji: KANJI.working }),
      workingCount === 0 ? <Text dimColor>Nothing is working right now</Text> : null,
      groups.map((group, i) => (
        <Box flexDirection="column" {...(i === 0 || isVector ? {} : { marginTop: 1 })}>
          {groupHead(group)}
          {group.cards.map(card => cardBlock(card, group.isHere))}
        </Box>
      )),
      status && unlistedCards(status) > 0 ? <Text dimColor wrap="truncate-end">{`${plural(unlistedCards(status), 'more open card')} not listed (magi channels lists them all)`}</Text> : null)

  // ---- exchange: the last messages threaded by card, the newest card first;
  // under its title, one line per message: the time, its direction, the kind, the words
  const isThreadOpen = (thread: Thread) => a.view.expanded === thread.taskId && a.view.openIn === 'exchange'
  const threadButton = (thread: Thread, label: string, dim: boolean) => (
    <Button key={`thread-${thread.taskId}`} plain {...(dim ? { dimColor: true } : {})} label={label} onPress={() => a.onExpand(thread.taskId, 'exchange')} />
  )
  const threadRows = (thread: Thread) => [
    <Box flexDirection="row">
      <Text dimColor>{isThreadOpen(thread) ? '▾ ' : '▸ '}</Text>
      {threadButton(thread, fitText(thread.title, W - 4), false)}
    </Box>,
    ...thread.messages.map(line => {
      const mark = exchangeMark(line.kind)
      const isIn = status ? line.route.endsWith(`→ ${status.as}`) : false
      return (
        <Box flexDirection="row" paddingLeft={2}>
          <Box width={6} flexShrink={0}><Text dimColor>{line.time}</Text></Box>
          <Box width={2} flexShrink={0}><Text {...(isIn && a.themed ? { color: GREEN } : { dimColor: true })}>{isIn ? icons.in : icons.out}</Text></Box>
          <Box width={15} flexShrink={0}><Text dimColor wrap="truncate-end">{line.route}</Text></Box>
          <Box width={2} flexShrink={0}><Text {...(mark.color && a.themed ? { color: mark.color } : { dimColor: true })}>{mark.glyph}</Text></Box>
          <Box width={9} flexShrink={0}><Text dimColor wrap="truncate-end">{line.kind}</Text></Box>
          <Text wrap="truncate-end">{line.words}</Text>
        </Box>
      )
    }),
  ]
  const exchangePanel = () =>
    section(
      heading('Exchange', 'exchange', { count: plural(status?.exchanges.length ?? 0, 'message'), note: 'this project', kanji: KANJI.exchange }),
      // Each card's thread opens its full messages under it: the ▸ beside the
      // drawing on a vector surface, the title itself in text.
      isVector
        ? threadList.map(thread => (
            <Box flexDirection="column">
              <Box flexDirection="row" alignItems="flex-start">
                {threadButton(thread, isThreadOpen(thread) ? '▾' : '▸', true)}
                <Text> </Text>
                {image(exchangeSvg({ threads: [thread], as: status?.as ?? 'claude', width: pxOf(W - 3), style }))}
              </Box>
              {fullMessages(thread.taskId, 'exchange')}
            </Box>
          ))
        : threadList.flatMap((thread, i) => [...(i > 0 ? [rule()] : []), ...threadRows(thread), fullMessages(thread.taskId, 'exchange')].filter((x): x is RenderElement => x !== null)))

  // ---- ledger: the week, then each direction with its held rate and counts;
  // Details opens the rows by mode and the last verdicts
  const summary = ledgerSummary(status?.ledger ?? null, status?.outcomes ?? [])
  const details = ledgerDetails(status?.ledger ?? null, status?.outcomes ?? []).filter(section => section.title !== 'By direction')
  const cost = costLine(status?.ledger ?? null)
  const hasDetails = details.length > 0
  const bar = (row: { accepted: number; rejected: number; open: number }, cells: number) =>
    ledgerBar(row, cells).map(run => <Text {...(a.themed ? { color: run.color } : { dimColor: true })}>{'█'.repeat(run.cells)}</Text>)
  const directionLine = (row: DirectionRow) => {
    const counts = tallyWords({ accepted: row.accepted, rejected: row.rejected, open: row.open })
    return (
      <Box flexDirection="row">
        <Box width={16} flexShrink={0}><Text wrap="truncate-end">{row.label}</Text></Box>
        {W >= 72 ? <Box width={12} flexShrink={0} flexDirection="row">{bar(row, 10)}</Box> : null}
        <Box width={10} flexShrink={0}><Text {...(row.heldPct !== null ? tint(row.heldPct >= 90 ? GREEN : row.heldPct >= 70 ? AMBER : RED) : { dimColor: true })}>{row.heldPct !== null ? `${row.heldPct}% held` : 'no verdict'}</Text></Box>
        <Text dimColor wrap="truncate-end">{`${counts}${counts ? ' · ' : ''}${plural(row.cards, 'card')}`}</Text>
      </Box>
    )
  }
  const ledgerPanel = () =>
    section(
      heading('Ledger', 'ledger', {
        count: status?.ledger ? `last ${status.ledger.days} days` : '',
        kanji: KANJI.outcome,
        ...(hasDetails ? { right: <Button key="ledger-details" plain dimColor hotkey="d" label={a.view.isLedgerOpen ? 'Hide details' : 'Details'} onPress={a.onLedger} /> } : {}),
      }),
      isVector
        ? image(ledgerSvg({ ledger: status?.ledger ?? null, outcomes: status?.outcomes ?? [], rows: directions, width: pxOf(W), style }))
        : [
          summary ? <Text wrap="truncate-end">{summary}</Text> : null,
          ...directions.map(directionLine),
          cost ? <Text dimColor wrap="truncate-end">{cost}</Text> : null,
        ],
      a.view.isLedgerOpen ? (
        <Box flexDirection="column" marginTop={1}>
          {details.map(section => (
            <Box flexDirection="column">
              <Text dimColor wrap="truncate-end">{section.title}</Text>
              {section.rows.map(row => <Text wrap="truncate-end">{`  ${row}`}</Text>)}
            </Box>
          ))}
        </Box>
      ) : null)

  // ---- providers: one compact row of chips, each its state and the button that flips it
  const providerChip = (p: MagiProvider, isChip: boolean) => {
    const line = providerLine(p)
    const words = (
      <Text wrap="truncate-end">
        <Text bold>{isChip ? p.name : p.name.padEnd(8)}</Text>
        <Text {...(line.color && a.themed ? { color: line.color } : { dimColor: true })}>{isChip ? ` ${line.state}` : line.state}</Text>
      </Text>
    )
    const button = <Button key={`provider-${p.name}`} plain dimColor label={line.action === 'enable' ? 'Enable' : 'Disable'} onPress={() => a.onProvider(p.name, line.action)} />
    return isChip ? (
      <Box flexDirection="row" borderStyle="round" {...(a.themed ? { borderColor: PURPLE } : { borderDimColor: true })} paddingX={1} columnGap={2}>
        {words}
        {button}
      </Box>
    ) : (
      <Box flexDirection="row" justifyContent="space-between">
        {words}
        {button}
      </Box>
    )
  }
  const providersPanel = () => {
    const list = status?.providers ?? []
    const isChips = W >= UNIT_BOXES_FROM
    return section(
      heading('Providers', 'providers'),
      isChips
        ? <Box flexDirection="row" columnGap={1} flexWrap="wrap">{list.map(p => providerChip(p, true))}</Box>
        : list.map(p => providerChip(p, false)))
  }

  // ---- remotes: the machines headless workers run on, one row each
  const remotesPanel = () => {
    const list = status?.remotes ?? []
    const busy = list.filter(r => r.workers.length > 0).length
    return section(
      heading('Remotes', 'remotes', { count: busy > 0 ? `${busy} busy` : `${list.length}` }),
      [
        ...list.map(r => (
          <Text wrap="truncate-end">
            <Text bold>{r.name.padEnd(12)}</Text>
            <Text {...(r.workers.length > 0 && a.themed ? { color: GREEN } : { dimColor: true })}>{remoteWords(r)}</Text>
          </Text>
        )),
        // The operator's switch for files between machines, as this machine has it.
        <Text dimColor wrap="truncate-end">{status?.files ? 'files between machines: on' : 'files between machines: off'}</Text>,
      ])
  }

  const showWorking = workingCount > 0 || a.view.focus === 'working'
  const showExchange = (status?.exchanges.length ?? 0) > 0
  const showLedger = summary !== '' || directions.length > 0
  const showProviders = (status?.providers.length ?? 0) > 0
  const showRemotes = (status?.remotes?.length ?? 0) > 0

  // ---- mini: inline above the prompt, at most 8 rows
  if (a.shape === 'mini') {
    const cards = groups.flatMap(group => group.cards)
    const shown = cards.slice(0, 3)
    return (
      <Box flexDirection="column" width={W}>
        <Text wrap="truncate-end">
          {a.themed ? <Text color={ORANGE} backgroundColor="#000000">{HAZARD}</Text> : null}
          {a.themed ? <Text> </Text> : null}
          <Text bold>Magi</Text>
          <Text dimColor>{` · ${plural(workingCount, 'card')} working · ${plural(moves.length, 'thing')} waiting on you`}</Text>
          {accent(t, a.themed, workingCount > 0 ? KANJI.working : KANJI.standby)}
        </Text>
        {moves.slice(0, 2).map(row => (
          <Text wrap="truncate-end">
            <Text {...(a.themed ? { color: row.color } : { dimColor: true })}>{EDGE}</Text>
            <Text>{row.text}</Text>
          </Text>
        ))}
        {shown.map(card => (
          <Box flexDirection="row">
            <Text dimColor>▸ </Text>
            <Text wrap="truncate-end">{cardLines(card, a.now).head}</Text>
            <Box flexGrow={1} />
            <Text> </Text>
            <Box flexShrink={0}>{clock(`mini-clock-${card.taskId}`, card.openedAt)}</Box>
          </Box>
        ))}
        {cards.length > shown.length ? <Text dimColor wrap="truncate-end">{`+${cards.length - shown.length} more · /magi layout compact for all`}</Text> : null}
        {status ? (
          <Text dimColor wrap="truncate-end">{status.units.map(unit => `${unit.harness} ${unit.state === 'disabled' ? 'off' : unit.sessions > 0 ? '✓' : '–'}`).join(' · ')}</Text>
        ) : (
          <Text dimColor>{a.error ?? 'Reading magi status…'}</Text>
        )}
      </Box>
    )
  }

  // One column at every width: a side-by-side split squeezed Working into
  // half the pane and wrapped every card.
  return (
    <Box flexDirection="column" width={W}>
      {header}
      {status ? movePanel() : null}
      {a.view.focus === 'working' && showWorking ? workingPanel() : null}
      {unitsPanel()}
      {a.view.focus !== 'working' && showWorking ? workingPanel() : null}
      {showExchange ? exchangePanel() : null}
      {showLedger ? ledgerPanel() : null}
      {showProviders ? providersPanel() : null}
      {showRemotes ? remotesPanel() : null}
    </Box>
  )
}
