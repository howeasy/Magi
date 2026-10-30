// A unit's mark, beating on the surface's own frame clock while a card is in
// flight to it (bright, then dim), and still otherwise. It sits inside the
// unit's own box, so it lines up with the unit by construction; only this
// cell redraws, the deck does not. The frame-clock pattern is Flightdeck's
// (hooks/rail.tsx and hooks/elapsed.tsx, MIT, Stephen Casella); see NOTICE.
import type { ClientModule } from 'claude-code'

type Props = {
  /** True while a card is in flight to the unit: the mark beats. */
  active: boolean
  glyph: string
  /** The mark's colour; a theme key (`subtle`) or a hex value. */
  color: string
  /** Its colour on the off beat. */
  dim: string
}

type Ref = { phase: number; active: boolean }
type State = { ref: Ref }

const BEAT_MS = 700

const Pulse: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0, active: props.active }
  ref.active = props.active
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(BEAT_MS, () => {
      if (ref.active) {
        ref.phase = (ref.phase + 1) % 2
        surface.setState({ ref })
      }
    })
  }
  const isLit = !props.active || ref.phase === 0
  return <Text color={isLit ? props.color : props.dim} bold={isLit && props.active}>{props.glyph}</Text>
}

export default Pulse
