// The bus under the unit boxes where no vector surface draws the triad (the
// terminal): one rail joining the units' ports, and a packet per card in
// flight moving from its asker's port to its worker's, on the surface's own
// frame clock so the deck need not redraw. Only this row redraws. The
// frame-clock pattern is Flightdeck's (hooks/rail.tsx, MIT, Stephen
// Casella); see NOTICE.
import type { ClientModule } from 'claude-code'

export type BusLane = {
  /** The column of the asker's port and of the worker's; the packet runs from one to the other. */
  from: number
  to: number
  /** The packet's colour: a hex value. */
  color: string
}

type Props = {
  width: number
  /** The columns the rail has a port at, one under each unit box. */
  ports: number[]
  lanes: BusLane[]
  /** The rail's colour; its ports and line are drawn dim. */
  rail: string
}

type Ref = { phase: number }
type State = { ref: Ref }

const STEP_MS = 120

const Bus: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0 }
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(STEP_MS, () => {
      ref.phase += 1
      surface.setState({ ref })
    })
  }
  const width = Math.max(1, surface.columns || props.width)
  const left = Math.min(...props.ports)
  const right = Math.max(...props.ports)
  const cells = Array.from({ length: width }, (_, i) => (i >= left && i <= right ? '─' : ' '))
  for (const p of props.ports) if (p >= 0 && p < width) cells[p] = '┴'
  // One packet per lane, each on its own offset so lanes between the same ports do not stack.
  const lit = new Map<number, string>()
  props.lanes.forEach((lane, i) => {
    const span = Math.abs(lane.to - lane.from)
    if (span === 0) return
    const step = (ref.phase + i * 5) % (span + 1)
    const at = lane.from + (lane.to > lane.from ? step : -step)
    if (at >= 0 && at < width) lit.set(at, lane.color)
  })
  // Runs, not cells: consecutive cells of one colour share a Text.
  const runs: { text: string; color: string | null }[] = []
  cells.forEach((glyph, i) => {
    const color = lit.get(i) ?? null
    const last = runs[runs.length - 1]
    const text = color ? '●' : glyph
    if (last && last.color === color) last.text += text
    else runs.push({ text, color })
  })
  return (
    <Box>
      {runs.map(run => (run.color ? <Text color={run.color} bold>{run.text}</Text> : <Text color={props.rail} dimColor>{run.text}</Text>))}
    </Box>
  )
}

export default Bus
