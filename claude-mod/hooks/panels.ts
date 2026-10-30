// The deck's panels as SVG documents for the surfaces that draw vectors
// (desktop, vscode, mobile): the Your move strip, a working card's two-line
// row, the exchange threaded by card, the ledger by direction, and the
// section and group headings with their hairline rules. Drawn in a Nerd Font
// (the `font` option, a monospace with the icon glyphs; `icons: false` swaps
// in plain Unicode) so columns align and the icons are glyphs of the same
// face. Every panel is a pure function of the facts and a minute-grained
// clock: a redraw with the same facts is the same markup, so an image is
// never replaced for a second ticking by. No script, no motion. The
// terminal draws the same facts as text (draw.tsx).
import type { MagiCard, MagiLedger, MagiOutcome } from '../types'

import type { DirectionRow, MoveRow, Thread } from './deck.ts'
import { agoText, clockOf, costText, receiptOf, roundText, standing, timeoutText } from './deck.ts'
import type { IconName, Icons } from './glyphs.ts'
import { glyphs } from './glyphs.ts'
import { AMBER, GREEN, PURPLE, RED, plural } from './nerv.ts'

/** The font family and whether the Nerd Font glyphs are drawn, from the plugin's options. */
export type PanelStyle = { font: string; icons: boolean }

export type Panel = { source: string; width: number; height: number; alt: string }

/** The body size; 0xProto's advance is 0.62 em, so a cell is CW pixels wide. */
export const FONT_SIZE = 13
export const CW = 8.06
/** A row's line height. */
export const LH = 20
/** The side margin inside every panel. */
export const PAD = 10
/** A small tag's text size and cell width. */
const TAG_SIZE = 10.5
const TAG_CW = 6.51

const INK = '#ECECF1'
const DIM = '#8B8B99'
const FAINT = '#5A5A6C'
const RULE = '#2A2A36'
const TAG_FILL = '#1B1B25'

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const chars = (text: string) => [...text].length
const px = (n: number) => Math.round(n * 10) / 10

/** The font list the markup names: the option first, then the Nerd Fonts and monospaces a machine is likely to have. */
export function fontList(font: string): string {
  const chosen = font.trim() || '0xProto Nerd Font Mono'
  return `'${chosen}', 'JetBrainsMono Nerd Font Mono', 'Cascadia Mono', Consolas, monospace`
}

/** `text` cut to `max` characters with an ellipsis. */
function fit(text: string, max: number): string {
  const list = [...text]
  if (list.length <= max) return text
  return max <= 1 ? '…' : `${list.slice(0, max - 1).join('')}…`
}

/** One piece of a line: its text, colour and weight; a tag is drawn on a small plate; `fit` marks the piece a narrow line cuts. */
type Seg = { text: string; fill?: string; bold?: boolean; tag?: boolean; opacity?: number; fit?: boolean }

const segWidth = (seg: Seg): number => (seg.tag ? chars(seg.text) * TAG_CW + 14 : chars(seg.text) * CW)

/** The pieces laid left to right from `x`, each its own text so the grid holds; the one marked `fit` is cut to the room left. */
function layLine(segs: Seg[], x: number, y: number, room: number): string {
  const fixed = segs.filter(seg => !seg.fit).reduce((n, seg) => n + segWidth(seg), 0)
  const out: string[] = []
  let at = x
  for (const seg of segs) {
    const text = seg.fit ? fit(seg.text, Math.max(0, Math.floor((room - fixed) / CW))) : seg.text
    if (text === '') continue
    // A spacer advances the cursor and draws nothing.
    if (text.trim() === '') {
      at += chars(text) * CW
      continue
    }
    if (seg.tag) {
      const w = chars(text) * TAG_CW + 10
      out.push(
        `<rect x="${px(at)}" y="${y - 11}" width="${px(w)}" height="15" rx="3" fill="${TAG_FILL}" stroke="${seg.fill ?? DIM}" stroke-opacity="0.55" stroke-width="1"/>`,
        `<text x="${px(at + 5)}" y="${y}" font-size="${TAG_SIZE}" letter-spacing="0.5" fill="${seg.fill ?? DIM}">${esc(text)}</text>`,
      )
      at += w + 4
      continue
    }
    const attrs = [
      `x="${px(at)}"`, `y="${y}"`,
      `fill="${seg.fill ?? INK}"`,
      seg.bold ? 'font-weight="700"' : '',
      seg.opacity !== undefined ? `opacity="${seg.opacity}"` : '',
      'xml:space="preserve"',
    ].filter(Boolean).join(' ')
    out.push(`<text ${attrs}>${esc(text)}</text>`)
    at += chars(text) * CW
  }
  return out.join('')
}

/** The width of a right-aligned run, a space between its pieces. */
const rightWidth = (right: Seg[]): number => right.reduce((n, seg) => n + segWidth(seg), 0) + (right.length > 1 ? (right.length - 1) * CW : 0)

/** The room a line leaves its left run beside a right run. */
const leftRoom = (right: Seg[], width: number): number => width - 2 * PAD - rightWidth(right) - (right.length > 0 ? 2 * CW : 0)

/** A line with a left run and a right-aligned run; the left's `fit` piece yields to the right. */
function line(left: Seg[], right: Seg[], y: number, width: number): string {
  const rightW = rightWidth(right)
  const spaced = right.flatMap((seg, i) => (i === 0 ? [seg] : [{ text: ' ' }, seg]))
  return layLine(left, PAD, y, leftRoom(right, width)) + (right.length > 0 ? layLine(spaced, width - PAD - rightW, y, rightW) : '')
}

const rule = (y: number, width: number, x = 0) => `<line x1="${x}" y1="${y}" x2="${width}" y2="${y}" stroke="${RULE}" stroke-width="1"/>`

function wrap(body: string, width: number, height: number, style: PanelStyle, alt: string): Panel {
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMinYMin meet" ` +
    `font-family="${esc(fontList(style.font))}" font-size="${FONT_SIZE}">${body}</svg>`
  return { source, width, height, alt }
}

const iconOf = (icons: Icons, name: IconName) => icons[name]

// ---- headings

export type HeadingArgs = { title: string; icon: IconName; count?: string; note?: string; width: number; style: PanelStyle }

/**
 * A section heading: its icon and title in the accent, a dim count and
 * note after it, and the hairline rule that runs from the words to the
 * right edge, which is the divider between sections.
 */
export function headingSvg(a: HeadingArgs): Panel {
  const icons = glyphs(a.style.icons)
  const H = 30
  const y = 19
  const segs: Seg[] = [
    { text: iconOf(icons, a.icon), fill: PURPLE },
    { text: ' ' },
    { text: a.title, fill: PURPLE, bold: true },
    ...(a.count ? [{ text: ` · ${a.count}`, fill: DIM }] : []),
    ...(a.note ? [{ text: `  ${a.note}`, fill: FAINT, fit: true }] : []),
  ]
  const used = segs.filter(seg => !seg.fit).reduce((n, seg) => n + segWidth(seg), 0)
  const noteW = a.note ? Math.min(chars(`  ${a.note}`) * CW, Math.max(0, a.width - 2 * PAD - used - 12 * CW)) : 0
  const body = layLine(segs, PAD, y, a.width - 2 * PAD) + rule(y - 4.5, a.width, PAD + used + noteW + 10)
  return wrap(body, a.width, H, a.style, [a.title, a.count, a.note].filter(Boolean).join(' · '))
}

/** A group heading inside Working: the session that asked, bold for this one, dim for another's. */
export function groupSvg(a: { heading: string; count: string; isHere: boolean; width: number; style: PanelStyle }): Panel {
  const H = 24
  const segs: Seg[] = a.isHere
    ? [{ text: a.heading, fill: INK, bold: true }, { text: ` · ${a.count}`, fill: DIM }]
    : [{ text: a.heading, fill: DIM, bold: true, fit: true }, { text: ` · ${a.count}`, fill: FAINT }]
  return wrap(layLine(segs, PAD, 17, a.width - 2 * PAD), a.width, H, a.style, `${a.heading} · ${a.count}`)
}

// ---- Your move

/** The strip at the top: a row per thing waiting on the orchestrator, or one dim line. */
export function yourMoveSvg(a: { rows: MoveRow[]; width: number; style: PanelStyle }): Panel {
  const icons = glyphs(a.style.icons)
  if (a.rows.length === 0) {
    const body = layLine([{ text: iconOf(icons, 'clear'), fill: FAINT }, { text: ' nothing waiting on you', fill: DIM }], PAD, 17, a.width - 2 * PAD)
    return wrap(body, a.width, 24, a.style, 'nothing waiting on you')
  }
  const RH = 22
  const H = a.rows.length * RH + 4
  const body = a.rows.map((row, i) => {
    const y = 2 + i * RH + 15
    const icon: IconName = row.kind === 'question' ? 'question' : row.kind === 'failed' ? 'alert' : 'reconcile'
    const left: Seg[] = [
      { text: iconOf(icons, icon), fill: row.color },
      { text: ' ' },
      ...(row.taskId ? [{ text: row.taskId, fill: DIM }, { text: ' ' }] : []),
      { text: row.text, fill: INK, fit: true },
    ]
    const right: Seg[] = row.since ? [{ text: row.since, fill: row.color }] : []
    return `<rect x="0" y="${y - 15}" width="2" height="${RH}" fill="${row.color}"/>` + line(left, right, y, a.width)
  }).join('')
  const alt = a.rows.map(row => `${row.text}${row.since ? ` (${row.since})` : ''}`).join('; ')
  return wrap(body, a.width, H, a.style, alt)
}

// ---- Working

export type CardRowArgs = { card: MagiCard; isHere: boolean; now: number; width: number; style: PanelStyle }

/** A card row's height: two lines and the hairline under them. */
export const CARD_ROW_H = 46
/** Below this many pixels a card row shortens its right-hand tags. */
const NARROW_PX = 900

/**
 * One working card, two lines over a hairline. Line one: the worker's state
 * mark, the harness, the worker's name, the task line, then at the right the
 * mode as a tag, the round and whether the worker is a live session or a
 * headless run. Line two, dim: where the worker stands (`stalled · idle 3h05`
 * in amber), its newest words and how long ago, then at the right the
 * receipt of the orchestrator's last message (sent, delivered, read) and a
 * headless run's time left. Another session's card is drawn faded.
 */
export function cardRowSvg(a: CardRowArgs): Panel {
  const icons = glyphs(a.style.icons)
  const { card, now } = a
  const worker = card.worker
  const stand = standing(worker, card, now)
  const harness = worker?.harness ?? card.to
  const name = worker?.name && worker.name !== harness ? worker.name : ''
  const via: IconName = worker?.via === 'headless' ? 'headless' : 'live'
  // A narrow row keeps the badge's glyph and shortens the round, so the task line keeps its room.
  const isRoomy = a.width >= NARROW_PX
  const viaWord = worker ? (worker.via === 'headless' ? 'headless' : 'live') : '—'
  const right1: Seg[] = [
    { text: card.mode, fill: PURPLE, tag: true },
    { text: isRoomy ? roundText(card) : roundText(card).replace('round ', 'r'), fill: DIM },
    { text: isRoomy ? `${iconOf(icons, via)} ${viaWord}` : iconOf(icons, via), fill: worker?.via === 'headless' ? DIM : FAINT },
  ]
  const who: Seg[] = [
    { text: iconOf(icons, stand.icon), fill: stand.color ?? FAINT },
    { text: ' ' },
    { text: harness, fill: INK, bold: true },
  ]
  // The task line yields first; when under ten cells would be left to it, it goes and the name yields instead.
  const named = name ? [{ text: ' · ', fill: FAINT }, { text: name, fill: INK }] : []
  const fixed = [...who, ...named].reduce((n, seg) => n + segWidth(seg), 0) + 3 * CW
  const hasBriefRoom = leftRoom(right1, a.width) - fixed >= 10 * CW
  const left1: Seg[] = card.brief && hasBriefRoom
    ? [...who, ...named, { text: ' · ', fill: FAINT }, { text: card.brief, fill: '#C9C9D4', fit: true }]
    : name
      ? [...who, { text: ' · ', fill: FAINT }, { text: name, fill: INK, fit: true }]
      : [...who, { text: '', fit: true }]
  // A stalled worker's word already says how long: no `ago` after it.
  const ago = stand.isStalled ? '' : agoText(worker?.lastActivityAt ?? null, now)
  const said = worker?.lastSaid ?? ''
  const left2: Seg[] = [
    { text: '  ' },
    { text: stand.word, fill: stand.color ?? DIM },
    ...(ago ? [{ text: ' · ', fill: FAINT }, { text: ago, fill: DIM }] : []),
    ...(said ? [{ text: ' · ', fill: FAINT }, { text: said, fill: DIM, fit: true }] : [{ text: ' · ', fill: FAINT }, { text: 'nothing said yet', fill: FAINT, fit: true }]),
  ]
  const receipt = receiptOf(card)
  const timeout = timeoutText(worker, now)
  const right2: Seg[] = [
    ...(receipt ? [{ text: `${iconOf(icons, receipt.icon)} ${receipt.label}${receipt.at !== null ? ` ${clockOf(receipt.at)}` : ''}`, fill: receipt.color ?? DIM }] : []),
    ...(timeout ? [{ text: `${iconOf(icons, 'timeout')} ${timeout}`, fill: timeout.startsWith('past') ? AMBER : DIM }] : []),
  ]
  const body =
    `<g opacity="${a.isHere ? 1 : 0.55}">` +
    line(left1, right1, 17, a.width) +
    line(left2, right2, 37, a.width) +
    `</g>` +
    rule(CARD_ROW_H - 0.5, a.width)
  const alt = [
    `${harness}${name ? ` ${name}` : ''}`, card.brief ?? card.taskId, card.mode, roundText(card), worker?.via ?? '',
    stand.word, ago ? `${ago}: ${said}` : said, receipt ? `last message ${receipt.label}` : '', timeout,
  ].filter(Boolean).join(' · ')
  return wrap(body, a.width, CARD_ROW_H, a.style, alt)
}

// ---- Exchange

const KIND_ICON: Readonly<Record<string, { icon: IconName; color: string | undefined }>> = {
  reply: { icon: 'kindReply', color: GREEN },
  request: { icon: 'kindRequest', color: AMBER },
  turn: { icon: 'kindRequest', color: AMBER },
  question: { icon: 'kindQuestion', color: AMBER },
  clarify: { icon: 'kindQuestion', color: AMBER },
  answer: { icon: 'kindAnswer', color: undefined },
  clarification: { icon: 'kindAnswer', color: undefined },
  outcome: { icon: 'kindOutcome', color: PURPLE },
  note: { icon: 'kindNote', color: undefined },
}

/** The messages threaded by card: a title line per card, its messages beneath, a hairline between cards. */
export function exchangeSvg(a: { threads: Thread[]; as: string; width: number; style: PanelStyle }): Panel {
  const icons = glyphs(a.style.icons)
  const TH = 24
  const MH = 20
  const parts: string[] = []
  let y = 4
  a.threads.forEach((thread, i) => {
    if (i > 0) parts.push(rule(y - 2, a.width))
    y += TH
    parts.push(layLine([{ text: iconOf(icons, 'cards'), fill: PURPLE }, { text: ' ' }, { text: thread.title, fill: INK, bold: true, fit: true }], PAD, y - 7, a.width - 2 * PAD))
    for (const m of thread.messages) {
      y += MH
      const kind = KIND_ICON[m.kind] ?? { icon: 'kindOther' as IconName, color: undefined }
      const isIn = m.route.endsWith(`→ ${a.as}`)
      const segs: Seg[] = [
        { text: '  ' },
        { text: m.time, fill: FAINT },
        { text: '  ' },
        { text: iconOf(icons, isIn ? 'in' : 'out'), fill: isIn ? GREEN : DIM },
        { text: ' ' },
        { text: m.route.padEnd(15), fill: DIM },
        { text: iconOf(icons, kind.icon), fill: kind.color ?? FAINT },
        { text: ' ' },
        { text: m.kind.padEnd(9), fill: kind.color ?? DIM },
        { text: m.words, fill: INK, fit: true },
      ]
      parts.push(layLine(segs, PAD, y - 6, a.width - 2 * PAD))
    }
    y += 6
  })
  const H = Math.max(24, y)
  const alt = a.threads.map(thread => `${thread.title}: ${thread.messages.map(m => `${m.time} ${m.route} ${m.kind} ${m.words}`).join('; ')}`).join(' | ')
  return wrap(parts.join(''), a.width, H, a.style, alt || 'no exchange yet')
}

// ---- Ledger

/** The held rate's colour: green from 90%, amber from 70%, red below; dim with no verdict. */
function heldColor(pct: number | null): string {
  if (pct === null) return FAINT
  return pct >= 90 ? GREEN : pct >= 70 ? AMBER : RED
}

/** A proportion bar `w` wide: accepted green, rejected red, open amber; a faint track with nothing counted. */
function bar(x: number, y: number, w: number, counts: { accepted: number; rejected: number; open: number }): string {
  const total = counts.accepted + counts.rejected + counts.open
  const out = [`<rect x="${px(x)}" y="${y}" width="${px(w)}" height="7" rx="1.5" fill="${RULE}"/>`]
  if (total === 0) return out.join('')
  let at = x
  for (const [n, fill] of [[counts.accepted, GREEN], [counts.rejected, RED], [counts.open, AMBER]] as const) {
    if (n === 0) continue
    const seg = Math.max(2, (n / total) * w)
    out.push(`<rect x="${px(at)}" y="${y}" width="${px(Math.min(seg, x + w - at))}" height="7" rx="1.5" fill="${fill}" opacity="0.85"/>`)
    at += seg
  }
  return out.join('')
}

export type LedgerArgs = { ledger: MagiLedger | null; outcomes: readonly MagiOutcome[]; rows: DirectionRow[]; width: number; style: PanelStyle }

/**
 * The ledger with its meaning: the week in one line, then a row per
 * direction (`claude → omp`) with a bar of its verdicts, the held rate in
 * the colour of its worth and the counts, and what priced headless runs cost.
 * The rows are how an orchestrator decides which peer to trust for what.
 */
export function ledgerSvg(a: LedgerArgs): Panel {
  const icons = glyphs(a.style.icons)
  const RH = 22
  const parts: string[] = []
  let y = 4
  const ledger = a.ledger
  if (ledger && ledger.total.cards > 0) {
    y += RH
    const t = ledger.total
    const head: Seg[] = [
      { text: `Last ${ledger.days} days`, fill: INK, bold: true },
      { text: ` · ${plural(t.cards, 'card')} · ${t.checked} checked`, fill: DIM },
      ...(t.heldPct !== null ? [{ text: ' · ', fill: FAINT }, { text: `${t.heldPct}% held`, fill: heldColor(t.heldPct), bold: true }] : []),
      { text: ` · ${[t.accepted > 0 ? `${t.accepted} accepted` : '', t.rejected > 0 ? `${t.rejected} rejected` : '', t.open > 0 ? `${t.open} open` : ''].filter(Boolean).join(' · ')}`, fill: DIM, fit: true },
    ]
    parts.push(layLine(head, PAD, y - 6, a.width - 2 * PAD))
    parts.push(rule(y + 2, a.width))
    y += 4
  }
  const labelW = Math.max(14, ...a.rows.map(row => chars(row.label))) * CW
  const barW = 14 * CW
  for (const row of a.rows) {
    y += RH
    const x0 = PAD
    parts.push(layLine([{ text: row.label, fill: INK }], x0, y - 6, labelW))
    parts.push(bar(x0 + labelW + CW, y - 13, barW, row))
    const held = row.heldPct !== null ? `${String(row.heldPct).padStart(3)}% held` : '   no verdict'
    const counts = [
      row.accepted > 0 ? `${row.accepted} accepted` : '',
      row.rejected > 0 ? `${row.rejected} rejected` : '',
      row.open > 0 ? `${row.open} open` : '',
    ].filter(Boolean).join(' · ')
    const tail: Seg[] = [
      { text: held, fill: heldColor(row.heldPct), bold: row.heldPct !== null },
      { text: `  ${counts}`, fill: DIM, fit: true },
    ]
    const tailX = x0 + labelW + CW + barW + 2 * CW
    parts.push(layLine(tail, tailX, y - 6, a.width - PAD - tailX - 10 * CW))
    parts.push(layLine([{ text: plural(row.cards, 'card'), fill: FAINT }], a.width - PAD - 10 * CW, y - 6, 10 * CW))
  }
  const cost = costText(ledger)
  if (cost) {
    y += RH
    parts.push(layLine([{ text: iconOf(icons, 'cost'), fill: DIM }, { text: ` headless runs cost ${cost}`, fill: DIM, fit: true }], PAD, y - 6, a.width - 2 * PAD))
  }
  if (parts.length === 0) {
    y += RH
    parts.push(layLine([{ text: `${plural(a.outcomes.length, 'recent verdict')}`, fill: DIM }], PAD, y - 6, a.width - 2 * PAD))
  }
  const H = y + 4
  const alt = [
    ledger && ledger.total.cards > 0 ? `last ${ledger.days} days: ${plural(ledger.total.cards, 'card')}, ${ledger.total.heldPct ?? '—'}% held` : '',
    ...a.rows.map(row => `${row.label}: ${row.heldPct ?? '—'}% held, ${row.accepted} accepted, ${row.rejected} rejected, ${row.open} open`),
    cost ? `headless runs cost ${cost}` : '',
  ].filter(Boolean).join('; ')
  return wrap(parts.join(''), a.width, H, a.style, alt)
}
