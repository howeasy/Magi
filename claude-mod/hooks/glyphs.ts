// The deck's icons, one table per meaning: Nerd Font glyphs for the vector
// panels (each codepoint checked against 0xProtoNerdFontMono-Regular.ttf's
// cmap, Nerd Fonts v3), and plain Unicode for a person without a Nerd Font
// (`icons: false`) and for the terminal, which never gets a private-use
// codepoint. Pure: no `$`, so the tests read it.

export type IconName =
  | 'yourMove' | 'working' | 'exchange' | 'ledger' | 'providers' | 'units' | 'remotes'
  | 'stateWorking' | 'stateIdle' | 'stateWaiting' | 'stateStalled' | 'stateRunning' | 'stateEnded' | 'stateUnknown'
  | 'live' | 'headless' | 'timeout'
  | 'sent' | 'delivered' | 'read' | 'failed' | 'queued'
  | 'question' | 'reconcile' | 'alert' | 'clear'
  | 'kindRequest' | 'kindReply' | 'kindNote' | 'kindQuestion' | 'kindAnswer' | 'kindOutcome' | 'kindOther'
  | 'in' | 'out' | 'arrow' | 'cost' | 'cards' | 'open' | 'shut'

export type Icons = Readonly<Record<IconName, string>>

/** Nerd Font v3 glyphs (nf-fa in U+F000-F2E0, nf-md in U+F0001-F1AF0). */
export const NERD: Icons = {
  yourMove: '\u{F0E47}', // nf-md-hand_back_left
  working: '', // nf-fa-cogs
  exchange: '', // nf-fa-exchange
  ledger: '', // nf-fa-bar_chart
  providers: '', // nf-fa-plug
  units: '\u{F06A9}', // nf-md-robot
  remotes: '\u{F233}', // nf-fa-server
  stateWorking: '', // nf-fa-circle
  stateIdle: '', // nf-fa-circle_o
  stateWaiting: '', // nf-fa-pause
  stateStalled: '', // nf-fa-exclamation_triangle
  stateRunning: '', // nf-fa-cog
  stateEnded: '', // nf-fa-stop
  stateUnknown: '', // nf-fa-question_circle
  live: '', // nf-fa-bolt
  headless: '', // nf-fa-terminal
  timeout: '\u{F051F}', // nf-md-timer_sand
  sent: '\u{F012C}', // nf-md-check
  delivered: '\u{F012D}', // nf-md-check_all
  read: '\u{F012D}', // nf-md-check_all, coloured
  failed: '', // nf-fa-times
  queued: '', // nf-fa-clock_o
  question: '', // nf-fa-question
  reconcile: '', // nf-fa-gavel
  alert: '', // nf-fa-exclamation_circle
  clear: '', // nf-fa-check
  kindRequest: '', // nf-fa-paper_plane
  kindReply: '', // nf-fa-reply
  kindNote: '', // nf-fa-comment
  kindQuestion: '', // nf-fa-question
  kindAnswer: '', // nf-fa-comment_o
  kindOutcome: '', // nf-fa-gavel
  kindOther: '', // nf-fa-circle
  in: '', // nf-fa-arrow_left
  out: '', // nf-fa-arrow_right
  arrow: '', // nf-fa-arrow_right
  cost: '', // nf-fa-usd
  cards: '\u{F0638}', // nf-md-cards
  open: '', // nf-fa-caret_down
  shut: '', // nf-fa-caret_right
}

/** The same meanings in Unicode any monospace font has. */
export const PLAIN: Icons = {
  yourMove: '☛',
  working: '⚙',
  exchange: '⇄',
  ledger: '▤',
  providers: '⌁',
  units: '△',
  remotes: '▣',
  stateWorking: '●',
  stateIdle: '○',
  stateWaiting: '‖',
  stateStalled: '!',
  stateRunning: '◐',
  stateEnded: '■',
  stateUnknown: '?',
  live: '⚡',
  headless: '>_',
  timeout: '⧗',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  failed: '✗',
  queued: '…',
  question: '?',
  reconcile: '⚖',
  alert: '!',
  clear: '✓',
  kindRequest: '▸',
  kindReply: '◂',
  kindNote: '·',
  kindQuestion: '?',
  kindAnswer: '↳',
  kindOutcome: '⚖',
  kindOther: '·',
  in: '←',
  out: '→',
  arrow: '→',
  cost: '$',
  cards: '▭',
  open: '▾',
  shut: '▸',
}

/** The table the `icons` option picks: Nerd Font glyphs, or plain Unicode. */
export function glyphs(icons: boolean): Icons {
  return icons ? NERD : PLAIN
}

/** True when the text holds a private-use codepoint (a glyph only a Nerd Font draws). */
export function hasPrivateUse(text: string): boolean {
  return /[-]|[\u{F0000}-\u{FFFFD}]/u.test(text)
}
