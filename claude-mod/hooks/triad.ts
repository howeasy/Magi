// The MAGI triad as one SVG document, for the surfaces that draw vectors
// (desktop, vscode, mobile; the terminal draws boxes and a bus instead):
// three unit panels in a triangle, the links between them, and the cards in
// flight as packets moving along the links. Every moving part is a fact:
// a packet is a card on its way to the unit working it, a unit's mark
// breathes while a card is in flight to it, and the idle glint only says the
// units are wired. Motion is SMIL, which runs inside the surface's sandboxed
// frame and in an image alike; no script. Pure: no `$`, so the tests read it.
import type { MagiHarness, MagiStatus, MagiUnit } from '../types'

import { unitCounts, unitState } from './deck.ts'
import { AMBER, GREEN, KANJI, ORANGE, PURPLE, RED, plural } from './nerv.ts'

/** One card's way between two units: who asked, who works, whose it is, and whether a question is going back. */
export type Lane = { from: string; to: string; isHere: boolean; isQuestion: boolean; taskId: string }

/** Packets drawn per direction between two units: the rest are counted on the stamp, never drawn. */
export const PACKETS_PER_LANE = 4

/**
 * The lanes: a working card runs from its asker to its worker; a question
 * waiting on the asker runs back the other way. Cards between units the
 * status does not list are left out.
 */
export function lanes(status: MagiStatus, sessionId: string | null): Lane[] {
  const names = new Set(status.units.map(unit => unit.harness))
  return status.cards
    .filter(card => names.has(card.from as MagiHarness) && names.has(card.to as MagiHarness) && card.from !== card.to)
    .map(card => {
      const isQuestion = card.turn === 'orchestrator'
      return {
        from: isQuestion ? card.to : card.from,
        to: isQuestion ? card.from : card.to,
        isHere: sessionId !== null && (card.coordinator?.ids.includes(sessionId) ?? false),
        isQuestion,
        taskId: card.taskId,
      }
    })
}

export type TriadArgs = {
  status: MagiStatus
  sessionId: string | null
  /** The drawing's width in CSS pixels; the height follows from it. */
  width: number
  /** Units a delivery failed to on this session's cards: a red hazard strip on their panel. */
  failedTo: readonly string[]
  /** The font list for every text; absent, the surface's sans-serif with a monospace for the small labels. */
  font?: string
}

export type Triad = { source: string; width: number; height: number; alt: string }

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif'
const MONO = 'ui-monospace, Cascadia Mono, Consolas, Menlo, monospace'
const INK = '#ECECF1'
const DIM = '#8B8B99'
const PANEL = '#15161C'
const CUT = 12

type Rect = { x: number; y: number; w: number; h: number }
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** Where a line from this rect's centre towards `to` leaves the rect. */
function port(r: Rect, to: { x: number; y: number }): { x: number; y: number } {
  const c = center(r)
  const dx = to.x - c.x
  const dy = to.y - c.y
  const t = Math.min(dx === 0 ? Infinity : r.w / 2 / Math.abs(dx), dy === 0 ? Infinity : r.h / 2 / Math.abs(dy))
  // One decimal: the markup is read by nobody, but it is sent on every redraw.
  return { x: Math.round((c.x + dx * t) * 10) / 10, y: Math.round((c.y + dy * t) * 10) / 10 }
}

const cutBox = (r: Rect) =>
  `${r.x + CUT},${r.y} ${r.x + r.w},${r.y} ${r.x + r.w},${r.y + r.h - CUT} ${r.x + r.w - CUT},${r.y + r.h} ${r.x},${r.y + r.h} ${r.x},${r.y + CUT}`

/**
 * The triad: the first two units across the top, the third beneath between
 * them, the stamp (cards in flight) in the middle. Other counts of units
 * stand in a row.
 */
export function triadSvg(a: TriadArgs): Triad {
  const W = Math.max(600, Math.round(a.width))
  const pad = 8
  const PH = 96
  const PW = Math.round(Math.min(460, Math.max(240, W * 0.36)))
  const units = a.status.units
  const isTriangle = units.length === 3
  const rects: Rect[] = isTriangle
    ? [
      { x: pad, y: pad, w: PW, h: PH },
      { x: W - pad - PW, y: pad, w: PW, h: PH },
      { x: Math.round((W - PW) / 2), y: pad + PH + 70, w: PW, h: PH },
    ]
    : units.map((_, i) => ({ x: pad + i * ((W - 2 * pad) / Math.max(1, units.length)), y: pad, w: Math.floor((W - 2 * pad) / Math.max(1, units.length)) - pad, h: PH }))
  const H = (isTriangle ? pad + PH + 70 + PH : pad + PH) + pad
  const at = new Map(units.map((unit, i) => [unit.harness, rects[i] as Rect]))

  const all = lanes(a.status, a.sessionId)
  const moving = new Set(all.filter(lane => !lane.isQuestion).map(lane => lane.to))
  const asking = new Set(all.filter(lane => lane.isQuestion).map(lane => lane.to))
  const pairs = new Map<string, Lane[]>()
  for (const lane of all) {
    const key = [lane.from, lane.to].sort().join('|')
    pairs.set(key, [...(pairs.get(key) ?? []), lane])
  }

  const defs: string[] = [
    `<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `<pattern id="hz-down" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="5" height="10" fill="${ORANGE}"/><rect x="5" width="5" height="10" fill="#000"/></pattern>`,
    `<pattern id="hz-failed" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="5" height="10" fill="${RED}"/><rect x="5" width="5" height="10" fill="#000"/></pattern>`,
  ]
  const links: string[] = []
  const packets: string[] = []

  // ---- links: one per pair of units; active while a card runs between them
  const seen = new Set<string>()
  for (const from of units) {
    for (const to of units) {
      const key = [from.harness, to.harness].sort().join('|')
      if (from === to || seen.has(key)) continue
      seen.add(key)
      const ra = at.get(from.harness) as Rect
      const rb = at.get(to.harness) as Rect
      const pa = port(ra, center(rb))
      const pb = port(rb, center(ra))
      const here = pairs.get(key) ?? []
      if (here.length === 0) {
        links.push(`<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="${PURPLE}" stroke-opacity="0.32" stroke-width="1.5"/>`)
        // The idle glint: the wall is polling and the units are wired, nothing more.
        packets.push(
          `<circle class="pk" r="1.8" fill="${PURPLE}" opacity="0.55"><animateMotion dur="6s" repeatCount="indefinite" begin="${seen.size * 1.7}s" path="M${pa.x},${pa.y} L${pb.x},${pb.y}"/></circle>`,
        )
        continue
      }
      // The line runs from the first lane's asker (purple) to its worker (orange): the line itself says which way.
      const lead = here[0] as Lane
      const [p1, p2] = lead.from === from.harness ? [pa, pb] : [pb, pa]
      const id = `g-${key.replace('|', '-')}`
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"><stop offset="0" stop-color="${PURPLE}"/><stop offset="1" stop-color="${ORANGE}"/></linearGradient>`)
      links.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="url(#${id})" stroke-opacity="0.9" stroke-width="2"/>`)
      // Each direction its own packets: this session's bright orange, another's dim purple, a question amber.
      const byDirection = new Map<string, Lane[]>()
      for (const lane of here) byDirection.set(lane.from, [...(byDirection.get(lane.from) ?? []), lane])
      for (const [fromName, list] of byDirection) {
        const [q1, q2] = fromName === from.harness ? [pa, pb] : [pb, pa]
        list.slice(0, PACKETS_PER_LANE).forEach((lane, i) => {
          const fill = lane.isQuestion ? AMBER : lane.isHere ? ORANGE : PURPLE
          const r = lane.isHere || lane.isQuestion ? 4.2 : 3
          const opacity = lane.isHere || lane.isQuestion ? 1 : 0.7
          packets.push(
            `<circle class="pk" r="${r}" fill="${fill}" opacity="${opacity}" filter="url(#glow)"><title>${esc(`${lane.taskId}: ${lane.isQuestion ? 'question for' : 'card to'} ${lane.to}`)}</title>` +
            `<animateMotion dur="${(2.6 + i * 0.4).toFixed(1)}s" repeatCount="indefinite" begin="${(i * 0.7).toFixed(1)}s" path="M${q1.x},${q1.y} L${q2.x},${q2.y}"/></circle>`,
          )
        })
      }
    }
  }

  // ---- the panels
  const panels = units.map(unit => panel(unit, at.get(unit.harness) as Rect, a, moving.has(unit.harness), asking.has(unit.harness)))

  // ---- the stamp: cards in flight between the units, or standby since when
  const inFlight = all.filter(lane => !lane.isQuestion).length
  const questions = all.length - inFlight
  const last = a.status.exchanges[0]?.at ?? null
  // It sits in the band between the top panels and omp's, so it may be as wide as its words need.
  const stamp = isTriangle ? stampSvg(W, pad + PH + 4, Math.min(400, W - 4 * pad), inFlight, questions, last, esc(a.font ?? MONO)) : ''

  const alt = [
    ...units.map(unit => `${unit.harness} (${unit.unit}) ${unitState(unit).word}${unitCounts(unit).length ? `, ${unitCounts(unit).join(', ')}` : ''}`),
    inFlight > 0 ? `${plural(inFlight, 'card')} in flight` : 'no card in flight',
  ].join('; ')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet" font-family="${esc(a.font ?? FONT)}">` +
    `<style>@media (prefers-reduced-motion: reduce) { .pk, .ping { display: none } }</style>` +
    `<defs>${defs.join('')}</defs>` +
    links.join('') + panels.join('') + stamp + packets.join('') +
    `</svg>`
  return { source, width: W, height: H, alt }
}

/** A unit's panel: its name, its codename small and dim, its state beside a mark, its counts. */
function panel(unit: MagiUnit, r: Rect, a: TriadArgs, isMoving: boolean, isAsked: boolean): string {
  const mono = esc(a.font ?? MONO)
  const state = unitState(unit)
  const provider = a.status.providers.find(p => p.name === unit.harness)
  const isDown = provider?.status === 'down' && unit.state !== 'disabled'
  const isFailed = a.failedTo.includes(unit.harness)
  const isOff = unit.state === 'disabled'
  const counts = unitCounts(unit)
  const strip = isFailed ? 'url(#hz-failed)' : isDown ? 'url(#hz-down)' : null
  const dot = state.color ?? DIM
  const cx = r.x + 22
  const cy = r.y + 58
  const note = isFailed
    ? { text: 'a delivery to it failed', color: RED }
    : isDown
      ? { text: `provider down${provider?.reason ? `: ${provider.reason}` : ''}`, color: RED }
      : isOff
        ? { text: 'provider turned off', color: DIM }
        : counts.length > 0 ? { text: counts.join(' · '), color: DIM } : { text: 'nothing open', color: DIM }
  const trim = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)
  const maxChars = Math.floor((r.w - 36 - (isAsked ? 118 : 0)) / 6.6)
  return [
    `<g opacity="${isOff ? 0.55 : 1}">`,
    `<polygon points="${cutBox(r)}" fill="${PANEL}" stroke="${isFailed || isDown ? RED : PURPLE}" stroke-opacity="${isFailed || isDown ? 0.9 : 0.75}" stroke-width="1.25"/>`,
    strip ? `<polygon points="${r.x + CUT},${r.y} ${r.x + CUT + 6},${r.y} ${r.x + 6},${r.y + r.h} ${r.x},${r.y + r.h} ${r.x},${r.y + CUT}" fill="${strip}"/>` : '',
    `<text x="${r.x + 16}" y="${r.y + 31}" font-size="19" font-weight="700" fill="${INK}">${esc(unit.harness)}</text>`,
    `<text x="${r.x + r.w - 14}" y="${r.y + 29}" font-size="10.5" font-family="${mono}" letter-spacing="2" fill="${DIM}" text-anchor="end">${esc(unit.unit)}</text>`,
    isAsked ? `<text x="${r.x + r.w - 14}" y="${r.y + 82}" font-size="10" font-family="${mono}" letter-spacing="1" fill="${AMBER}" text-anchor="end">QUESTION WAITING</text>` : '',
    isMoving ? `<circle class="ping" cx="${cx}" cy="${cy}" r="5" fill="none" stroke="${dot}" stroke-width="1.5"><animate attributeName="r" values="5;13" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.7;0" dur="1.6s" repeatCount="indefinite"/></circle>` : '',
    `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${dot}">${isMoving ? `<animate attributeName="opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite"/>` : ''}</circle>`,
    `<text x="${cx + 12}" y="${cy + 5}" font-size="14" fill="${INK}">${esc(state.word)}</text>`,
    `<text x="${r.x + 16}" y="${r.y + 82}" font-size="12" fill="${note.color}">${esc(trim(note.text, maxChars))}</text>`,
    `</g>`,
  ].join('')
}

/**
 * The stamp between the top panels: the count of cards in flight, or standby.
 * No clock in it: markup that changes with time is a new drawing every
 * refresh, which the desktop draws again from scratch (a flash, the packets
 * restarting); the exchange timeline below carries the times.
 */
function stampSvg(W: number, y: number, maxW: number, inFlight: number, questions: number, lastAt: number | null, mono: string): string {
  const h = 54
  const isLive = inFlight > 0 || questions > 0
  const color = isLive ? ORANGE : PURPLE
  const figure = isLive ? String(inFlight + questions) : '—'
  // Longest first; the first that fits is drawn, so the words never cross the frame.
  const captions = isLive
    ? [
        [inFlight > 0 ? `${inFlight} in flight` : '', questions > 0 ? `${plural(questions, 'question')} waiting` : ''].filter(Boolean).join(' · '),
        [inFlight > 0 ? `${inFlight} in flight` : '', questions > 0 ? `${questions} waiting` : ''].filter(Boolean).join(' · '),
      ]
    : [lastAt === null ? 'standby · no exchange yet' : 'standby', 'standby']
  const title = isLive ? 'CARDS BETWEEN UNITS' : 'NOTHING IN FLIGHT'
  const kanji = isLive ? KANJI.working : KANJI.standby
  // Widths from the monospace advance (0xProto 0.62 em, wider than Cascadia's
  // 0.6, so a guess errs roomy); a CJK character is a full em.
  const across = (s: string, size: number, spacing = 0) => [...s].reduce((sum, ch) => sum + (/[　-鿿]/.test(ch) ? size : size * 0.62) + spacing, 0)
  const left = 18 + (figure.length > 1 ? 38 : 26)
  const right = 14
  const titleW = across(title, 10.5, 1.5)
  const kanjiW = across(kanji, 10) + 14
  const fits = (inner: number) => left + inner + right <= maxW
  const caption = captions.find(c => fits(across(c, 12))) ?? captions[captions.length - 1] ?? ''
  const isRoomy = fits(Math.max(titleW + kanjiW, across(caption, 12)))
  const inner = Math.max(isRoomy ? titleW + kanjiW : 0, across(caption, 12))
  const w = Math.round(Math.min(maxW, Math.max(150, left + inner + right)))
  const r: Rect = { x: Math.round((W - w) / 2), y, w, h }
  const x = r.x + left
  return [
    `<polygon points="${cutBox(r)}" fill="${PANEL}" stroke="${color}" stroke-opacity="${isLive ? 0.9 : 0.5}" stroke-width="1.25"/>`,
    `<text x="${r.x + 18}" y="${r.y + 37}" font-size="28" font-weight="700" font-family="${mono}" fill="${color}">${figure}</text>`,
    isRoomy ? `<text x="${x}" y="${r.y + 22}" font-size="10.5" font-family="${mono}" letter-spacing="1.5" fill="${DIM}">${title}</text>` : '',
    `<text x="${x}" y="${r.y + (isRoomy ? 40 : 36)}" font-size="12" font-family="${mono}" fill="${isLive ? INK : DIM}">${esc(caption)}</text>`,
    isRoomy ? `<text x="${r.x + r.w - right}" y="${r.y + 22}" font-size="10" fill="${DIM}" opacity="0.8" text-anchor="end">${kanji}</text>` : '',
  ].join('')
}
