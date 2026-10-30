import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DeckLayout, DeckView, MagiHarness, MagiThread } from '../types'

import { cleanPeerText, onHost, peerHead } from './clean-peer-text.ts'
import type { PeerHead } from './clean-peer-text.ts'
import { alerts, footerLabel, shapeOf, statusLine, waitingOn } from './deck.ts'
import { alertBand, deckTree, footerTree, hasElements, rowCard, rowLine, stacked, toolDetails, toolLine, waitingBand } from './draw.tsx'
import { bodyOf, firstLine, isObject, toolRow, toolToast } from './nerv.ts'
import { parseStatus, parseThread } from './status.ts'

const DEFAULT_VIEW: DeckView = { layout: null, expanded: null, focus: null, isLedgerOpen: false }

const status = atom({ plugin: 'magi-view', key: 'status' } as const, null)
const statusError = atom({ plugin: 'magi-view', key: 'statusError' } as const, null)
const isThemed = atom({ plugin: 'magi-view', key: 'isThemed' } as const, true)
const openCalls = atom({ plugin: 'magi-view', key: 'openCalls' } as const, [])
const sessionId = atom({ plugin: 'magi-view', key: 'sessionId' } as const, null)
const view = atom({ plugin: 'magi-view', key: 'view' } as const, DEFAULT_VIEW)
const thread = atom({ plugin: 'magi-view', key: 'thread' } as const, null)

const PANE = 'magi'
const THEME_KEY = 'theme'
const SEEN_KEY = 'repliesSeen'
// The dock width the deck asks for beside the transcript, and its rows inline.
const DECK_COLUMNS = 70
const DECK_ROWS = 8
// One `magi status` run reads the ledger and lists every live session (Codex
// from its own databases), so the open deck polls no faster than this.
const PANE_REFRESH_MS = 10_000
// While the band shows an alert it re-reads this often, so an answered
// question or a worker that spoke leaves it without waiting for a Magi call.
const BAND_REFRESH_MS = 15_000
const MAGI_TOOL = /^mcp__magi(?:-omp|-codex)?__(?:claude|codex|omp)_peer$/
const LAYOUTS: readonly DeckLayout[] = ['auto', 'compact', 'wide', 'mini']

// Module values are this load's: a hot reload starts them again, which at
// worst re-polls once or repeats a toast the store has not caught.
let inflight: Promise<void> | null = null
let paneTimer: Timer | null = null
let bandTimer: Timer | null = null
// Whether the band last drew with no turn running: waiting lines show only
// then, so the band's timer keeps re-reading for them only then.
let isBandIdle = false
const toasted = new Set<string>()

// The `checkout` option, kept from register for magiBin.
let checkoutOption: unknown
// The `font` and `icons` options: the monospace the deck's vector panels are
// drawn in, and whether they use its Nerd Font glyphs.
let fontOption = ''
let iconsOption = true
// The session's directory, kept from session.start: `magi status` scopes the
// reconciliation debt it reports to it, and the engine's own process cwd is
// not promised to be the session's.
let sessionCwd: string | null = null

/** The file `magi install` writes beside the mod's hooks, naming the checkout. */
const CHECKOUT_FILE = 'checkout.json'

// Where bin/magi.mjs is. Claude Code loads the mod from a copy in its plugin
// cache in every project but the checkout itself, so the folder above the mod
// is the checkout only there: the `checkout` option wins, then the file
// `magi install` writes into claude-mod/ (copied into the cache with the
// rest), then the folder above, for a session in the checkout before any install.
async function magiBin($: EngineInterface): Promise<string> {
  const sep = $.plugin.root.includes('\\') ? '\\' : '/'
  const set = typeof checkoutOption === 'string' ? checkoutOption.trim() : ''
  const checkout = set || (await installedCheckout($, sep)) || $.plugin.root.replace(/[\\/]+[^\\/]+[\\/]*$/, '')
  return [checkout.replace(/[\\/]+$/, ''), 'bin', 'magi.mjs'].join(sep)
}

async function installedCheckout($: EngineInterface, sep: string): Promise<string> {
  try {
    const doc: unknown = JSON.parse(await $.fs.read([$.plugin.root.replace(/[\\/]+$/, ''), CHECKOUT_FILE].join(sep)))
    return isObject(doc) && typeof doc.checkout === 'string' ? doc.checkout.trim() : ''
  } catch {
    return ''
  }
}

// What the peer-row hook decided for its last rows, in render-trace.json
// beside the mod: a row the person sees drawn plain says why here, and a
// row missing from it never reached the hook. Best effort, never awaited.
// ponytail: a diagnostic while received rows are being checked on the
// desktop; drop it, or move it behind an option, once they are.
const trace: Record<string, unknown>[] = []
function traceRow($: EngineInterface, row: Record<string, unknown>): void {
  trace.push({ at: new Date().toISOString(), ...row })
  trace.splice(0, Math.max(0, trace.length - 30))
  const sep = $.plugin.root.includes('\\') ? '\\' : '/'
  void $.fs.write([$.plugin.root.replace(/[\\/]+$/, ''), 'render-trace.json'].join(sep), `${JSON.stringify(trace, null, 1)}\n`).catch(() => undefined)
}

// The machine a card's worker is on, from the last status; null on this
// machine or for a card the status does not list.
async function hostLookup($: EngineInterface): Promise<(taskId: string | undefined) => string | null> {
  const cards = (await read($, status))?.cards ?? []
  return taskId => (taskId ? cards.find(card => card.taskId === taskId)?.worker?.host ?? null : null)
}

// A stored view of an older shape reads as the default, field by field.
async function getView($: EngineInterface): Promise<DeckView> {
  const v: unknown = await read($, view)
  if (!isObject(v)) return DEFAULT_VIEW
  return {
    layout: LAYOUTS.includes(v.layout as DeckLayout) ? v.layout as DeckLayout : null,
    expanded: typeof v.expanded === 'string' ? v.expanded : null,
    openIn: v.openIn === 'exchange' ? 'exchange' : 'working',
    focus: v.focus === 'working' ? 'working' : null,
    isLedgerOpen: v.isLedgerOpen === true,
  }
}

// True once a surface's prompt footer has drawn the summary as a button
// (SessionMode on the desktop): pinned too, the status line would show it
// twice, so from then on it is not pinned. The terminal keeps the pin.
let isFooterDrawn = false

function pinStatus($: EngineInterface, text: string): void {
  if (!isFooterDrawn) $.ui.status(text)
}

// One run at a time; never rejects, so every caller may leave it unawaited.
function refresh($: EngineInterface): Promise<void> {
  inflight ??= (async () => {
    let why: string
    try {
      const argv = ['node', await magiBin($), 'status', '--json', ...(sessionCwd ? ['--cwd', sessionCwd] : [])]
      const ran = await $.process.run(argv, { timeoutMs: 45_000 })
      const parsed = ran.exitCode === 0 ? parseStatus(ran.stdout) : null
      if (parsed) {
        await update($, status, () => parsed)
        await update($, statusError, () => null)
        pinStatus($, statusLine(parsed, false, await read($, sessionId)))
        return
      }
      why = ran.exitCode === 0
        ? 'magi status --json printed something this mod cannot read; update the Magi checkout and the mod together.'
        : `magi status failed (exit ${ran.exitCode}): ${firstLine(ran.stderr) || 'no message'}`
    } catch (error) {
      why = `magi status could not run (${error instanceof Error ? error.message : String(error)}); check node is on PATH and the mod's checkout option names the Magi folder.`
    }
    try {
      await update($, statusError, () => why)
      pinStatus($, statusLine(await read($, status), true, await read($, sessionId)))
    } catch {
      // Nothing left to tell it with; the next refresh tries again.
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

// The deck polls only while it is open: each tick asks the engine, so a deck
// the person closed stops the timer within one period.
function watchPane($: EngineInterface): void {
  paneTimer ??= $.clock.every(PANE_REFRESH_MS, () => {
    void (async () => {
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) return refresh($)
      paneTimer?.cancel()
      paneTimer = null
    })().catch(() => undefined) // a failed look at the panes: the next tick asks again
  })
}

// Runs only while the band has something to show, an alert or a card a peer
// owes this session; stops itself once neither is left.
function watchBand($: EngineInterface): void {
  bandTimer ??= $.clock.every(BAND_REFRESH_MS, () => {
    void (async () => {
      await refresh($)
      const current = await read($, status)
      const id = await read($, sessionId)
      if (alerts(current, await $.clock.now(), id).length > 0 || (isBandIdle && waitingOn(current, id).length > 0)) return
      bandTimer?.cancel()
      bandTimer = null
    })().catch(() => undefined) // the next tick tries again
  })
}

// Opens the deck; `atCard` (an alert or /magi-working) puts Working first,
// opens that card and asks for the keys so 1-9, r and Esc work at once.
// Never rejects, so a Button may leave it unawaited.
async function openDeck($: EngineInterface, atCard?: { taskId: string | null }): Promise<string> {
  try {
    if (atCard) {
      await update($, view, v => ({ ...DEFAULT_VIEW, ...v, focus: 'working', expanded: atCard.taskId ?? v.expanded, openIn: 'working' }))
      if (atCard.taskId) void loadThread($, atCard.taskId).catch(() => undefined)
    }
    const opened = await $.ui.open(atCard
      ? { id: PANE, title: 'Magi', columns: DECK_COLUMNS, rows: DECK_ROWS, focus: true, closeOnEscape: true }
      : { id: PANE, title: 'Magi', columns: DECK_COLUMNS, rows: DECK_ROWS })
    watchPane($)
    void refresh($)
    return opened.isPlaced ? '' : `The Magi deck is not shown yet: ${opened.reason}`
  } catch (error) {
    const why = `magi-view: the deck did not open: ${error instanceof Error ? error.message : String(error)}`
    $.ui.log(why, { to: 'debug' })
    return why
  }
}

// A card's hotkey, its Exchange button or its alert: opens it where it was
// pressed, or closes it when open there. Opening reads the card's whole
// conversation (`magi exchange <id> --json`), drawn under it.
// Never rejects, so a Button may leave it unawaited.
async function toggleCard($: EngineInterface, taskId: string, openIn: 'working' | 'exchange' = 'working'): Promise<void> {
  try {
    const before = await getView($)
    const isClosing = before.expanded === taskId && (before.openIn ?? 'working') === openIn
    await update($, view, v => ({ ...DEFAULT_VIEW, ...v, expanded: isClosing ? null : taskId, openIn }))
    if (isClosing) return update($, thread, () => null)
    if ((await read($, thread))?.taskId !== taskId) await update($, thread, () => null)
    await loadThread($, taskId)
  } catch (error) {
    $.ui.log(`magi-view: the card did not open: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

async function loadThread($: EngineInterface, taskId: string): Promise<void> {
  let loaded: MagiThread
  try {
    const ran = await $.process.run(['node', await magiBin($), 'exchange', taskId, '--json'], { timeoutMs: 30_000 })
    const parsed = ran.exitCode === 0 ? parseThread(ran.stdout) : null
    loaded = parsed ?? { taskId, omitted: 0, messages: [], error: ran.exitCode === 0 ? 'magi exchange --json printed something this mod cannot read; update the Magi checkout and the mod together.' : `magi exchange failed (exit ${ran.exitCode}): ${firstLine(ran.stderr) || 'no message'}` }
  } catch (error) {
    loaded = { taskId, omitted: 0, messages: [], error: `magi exchange could not run (${error instanceof Error ? error.message : String(error)})` }
  }
  // Only if the card is still the one open: a slow read must not land on another.
  if ((await getView($)).expanded === taskId) await update($, thread, () => loaded)
}

// The Ledger's Details button: opens its rows, or closes them when open.
async function toggleLedger($: EngineInterface): Promise<void> {
  await update($, view, v => ({ ...DEFAULT_VIEW, ...v, isLedgerOpen: !v.isLedgerOpen }))
}

// A provider's Enable or Disable: the same command a person would run.
async function switchProvider($: EngineInterface, name: MagiHarness, action: 'enable' | 'disable'): Promise<void> {
  try {
    const ran = await $.process.run(['node', await magiBin($), 'provider', action, name], { timeoutMs: 30_000 })
    $.ui.toast(ran.exitCode === 0
      ? `${name} ${action === 'enable' ? 'enabled' : 'disabled'}; restart the harnesses to refresh their tools`
      : `magi provider ${action} ${name} failed: ${firstLine(ran.stderr) || `exit ${ran.exitCode}`}`)
  } catch (error) {
    $.ui.toast(`magi provider ${action} ${name} could not run: ${error instanceof Error ? error.message : String(error)}`)
  }
  void refresh($)
}

// A call row's details button: ToolUse has no expanded state of its own, so
// the person opens one row at a time; the newest 50 are remembered.
async function toggleCall($: EngineInterface, id: string): Promise<void> {
  await update($, openCalls, ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-50))
}

// A toast the first time a reply row is drawn, once per message across
// sessions; the status picture changed with it.
async function announceReply($: EngineInterface, requestId: string, head: PeerHead): Promise<void> {
  if (toasted.has(requestId)) return
  toasted.add(requestId)
  const stored = await $.store.get(SEEN_KEY)
  const seen = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  if (seen.includes(requestId)) return
  $.ui.toast(`Reply from ${head.sender ?? 'a peer'}${head.host ? ` on ${head.host}` : ''}${head.taskId ? ` (${head.taskId})` : ''}`)
  await $.store.set(SEEN_KEY, [...seen, requestId].slice(-200))
  void refresh($)
}

/**
 * Shows Magi in Claude Code in plain words: peer messages as a header line
 * over their body, the coordinator's own Magi calls as one line each, the
 * /magi deck (units, working cards by coordinator, alerts, the exchange, the
 * ledger, providers), a band above the prompt with failed deliveries and,
 * while the session is idle, the replies peers still owe it, peers on other
 * machines named with them, and peer presence on the status line. Every rewrite is the
 * drawing's alone: the stored message and what the model reads stay as
 * delivered, and any doubt draws the plain cleaned row or the engine's own.
 */
export const register: Register = (on, options) => {
  checkoutOption = options.checkout
  fontOption = typeof options.font === 'string' ? options.font : ''
  iconsOption = options.icons !== false
  on('session.start', async ($, e, next) => {
    sessionCwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : null
    try {
      await $.command.register({ name: 'magi', description: 'Magi deck: units, working agents, alerts, the exchange, the ledger and providers', argumentHint: '[close|layout auto|compact|wide|mini]', immediate: true })
      await $.command.register({ name: 'magi-working', description: 'Magi deck, opened at the agents working on cards', immediate: true })
      await $.command.register({ name: 'magi-theme', description: 'Magi styling and accents for peer messages, Magi tool calls and the deck: on, off, or toggle', argumentHint: '[on|off]', immediate: true })
      const theme = await $.store.get(THEME_KEY)
      await update($, isThemed, () => theme !== 'off')
      const id = await $.session.id()
      await update($, sessionId, () => id)
    } catch (error) {
      $.ui.log(`magi-view: setup failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    void refresh($)
    if (options.openOnStart === true) void openDeck($)
    return next(e)
  })

  on('command.run', { command: 'magi' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Magi deck closed.' }
    }
    if (verb === 'layout') {
      if (!LAYOUTS.includes(arg as DeckLayout)) return { text: 'Usage: /magi layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...DEFAULT_VIEW, ...v, layout: arg === 'auto' ? null : arg as DeckLayout }))
    }
    const why = await openDeck($)
    if (why) $.ui.toast(why)
    return {}
  })

  on('command.run', { command: 'magi-working' }, async $ => {
    const why = await openDeck($, { taskId: null })
    if (why) $.ui.toast(why)
    return {}
  })

  on('command.run', { command: 'magi-theme' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const isOn = asked === 'on' ? true : asked === 'off' ? false : !(await read($, isThemed))
    await $.store.set(THEME_KEY, isOn ? 'on' : 'off')
    await update($, isThemed, () => isOn)
    $.ui.toast(isOn
      ? 'Magi styling on: peer messages, Magi tool calls and the deck drawn with Magi accents'
      : 'Magi styling off: Claude Code draws the rows (no protocol text), the deck plain')
    return {}
  })

  // A main-loop turn that ends leaves the session idle: re-read once if a peer
  // owed it a reply, so the waiting band starts from the current picture. A
  // subagent's turn (agentId set) is not the session going idle.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if (e.agentId === undefined && waitingOn(await read($, status), await read($, sessionId)).length > 0) void refresh($)
    } catch {
      // The band's own timer re-reads anyway.
    }
    return done
  })

  // Never alters the call: the hook sees the answer, then decorates.
  on('tool.call', { tool: MAGI_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const text = toolToast(String(e.tool), e as unknown as Readonly<Record<string, unknown>>, ran)
      if (text) $.ui.toast(text)
      void refresh($)
    } catch (error) {
      $.ui.log(`magi-view: tool toast failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'peer' } } }, async ($, e, next) => {
    const seen = (outcome: string) => traceRow($, { surface: e.surface, isExpanded: e.props.isExpanded, start: e.props.text.slice(0, 80), outcome })
    const cleaned = cleanPeerText(e.props.text)
    if (cleaned === e.props.text) {
      seen('not a Magi message: the engine draws it')
      return next(e)
    }
    // The degraded drawing: the cleaned text in the engine's own row. onScreen rides along.
    const plain = (why: string) => {
      seen(`plain: ${why}`)
      return next({ ...e, props: { ...e.props, text: cleaned } })
    }
    try {
      const parsed = peerHead(e.props.text)
      if (!parsed) return plain('no header')
      const head = onHost(parsed, (await hostLookup($))(parsed.taskId))
      // A store that fails costs the toast, never the drawing.
      if (head.kind === 'REPLY') await announceReply($, e.requestId, head).catch(() => undefined)
      const t = $.ui.resolve(e)
      if (!(await read($, isThemed))) return plain('theme off')
      if (!hasElements(t)) return plain('no Box/Text/Button on this surface')
      const body = bodyOf(cleaned)
      // Collapsed is one line of its own; expanded (ctrl+o, --verbose) shows all.
      seen(e.props.isExpanded ? 'themed card' : 'themed line')
      if (!e.props.isExpanded) return rowLine(t, head, body)
      return rowCard(t, head, await next({ ...e, props: { ...e.props, text: body || cleaned } }))
    } catch (error) {
      return plain(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // The coordinator's own Magi calls: one line in place of the engine's call
  // line, in every view. ToolUse carries no isExpanded (UserMessage and
  // ToolGroup do), and the result is the engine's own ToolResult row beneath,
  // which keeps its ctrl+o. A details button on the line opens the engine's
  // own row, all arguments, beneath it.
  on('ui.render', { component: 'ToolUse', props: { tool: MAGI_TOOL } }, async ($, e, next) => {
    try {
      const row = toolRow(e.props, await hostLookup($))
      if (!row || !(await read($, isThemed))) return next(e)
      const t = $.ui.resolve(e)
      if (!hasElements(t)) return next(e)
      const id = e.props.tool_use_id
      const isOpen = (await read($, openCalls)).includes(id)
      const line = toolLine(t, row, { isOpen, onToggle: () => void toggleCall($, id) })
      // Open: the engine's own row, every argument, under the line.
      return isOpen ? toolDetails(t, line, await next(e)) : line
    } catch {
      return next(e)
    }
  })

  // The prompt footer's mode labels on the desktop: the engine's own modes,
  // then a short Magi summary (footerLabel: the footer holds about a dozen
  // characters) as a button that opens the deck as /magi does. `$.ui.status` cannot be pressed, so on this
  // surface the summary lives here and the status line is cleared; the
  // terminal keeps the status line. Reads the status from $.state, so it
  // redraws with every refresh.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    try {
      if (e.surface !== 'desktop') return next(e)
      const t = $.ui.resolve(e)
      if (!hasElements(t)) return next(e)
      const label = footerLabel(await read($, status), (await read($, statusError)) !== null, await read($, sessionId))
      const tree = footerTree(t, await next(e), label, () => void openDeck($))
      if (!isFooterDrawn) {
        isFooterDrawn = true
        $.ui.status(undefined)
      }
      return tree
    } catch {
      return next(e)
    }
  })

  // The band: this session's failed deliveries (alerts()), and, while no turn
  // runs, a calm line per card a peer still owes this session a reply on, so
  // an idle session reads as waiting on purpose. Each opens the deck at its card.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const now = await $.clock.now()
      const id = await read($, sessionId)
      const current = await read($, status)
      const list = alerts(current, now, id)
      isBandIdle = !e.props.isWorking
      const owed = isBandIdle ? waitingOn(current, id) : []
      if (list.length > 0 || owed.length > 0) watchBand($)
      const t = $.ui.resolve(e)
      if ((list.length === 0 && owed.length === 0) || !hasElements(t)) return next(e)
      const onCard = (taskId: string) => void openDeck($, { taskId })
      return stacked(t, [
        list.length > 0 ? alertBand(t, list, await read($, isThemed), onCard) : null,
        owed.length > 0 ? waitingBand(t, owed, now, onCard) : null,
      ])
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    try {
      // After a hot reload the deck stays up and its timer is gone.
      watchPane($)
      const t = $.ui.resolve(e)
      if (!hasElements(t)) return next(e)
      const v = await getView($)
      return deckTree(t, {
        surface: e.surface,
        status: await read($, status),
        error: await read($, statusError),
        sessionId: await read($, sessionId),
        view: v,
        thread: await read($, thread),
        shape: shapeOf(v.layout ?? 'auto', e.props.placement, e.props.bodyColumns),
        columns: e.props.bodyColumns,
        now: await $.clock.now(),
        themed: await read($, isThemed),
        font: fontOption,
        icons: iconsOption,
        onRefresh: () => void refresh($),
        onExpand: (taskId, openIn) => void toggleCard($, taskId, openIn),
        onLedger: () => void toggleLedger($),
        onProvider: (name, action) => void switchProvider($, name, action),
      })
    } catch {
      return next(e)
    }
  })
}
