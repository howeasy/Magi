// The magi-view mod's own contract: the shape `magi status --json` prints
// (src/status.mjs) and the values the mod keeps in $.state. Drawings read
// these while they draw, so a write redraws exactly the readers.

export type MagiHarness = 'claude' | 'codex' | 'omp'
/** The units' codenames, shown only as the deck's dim subtitles. */
export type MagiUnitName = 'MELCHIOR-1' | 'BALTHASAR-2' | 'CASPER-3'

/** active: a live session working, a headless worker or an open card; standby: live sessions, idle; none: no live session; disabled: provider off. */
export type MagiUnitState = 'active' | 'standby' | 'none' | 'disabled'

export type MagiUnit = {
  unit: MagiUnitName
  harness: MagiHarness
  state: MagiUnitState
  sessions: number
  working: number
  workers: number
  /** Of `workers`, how many run on another machine; 0 from a Magi older than remotes. */
  remoteWorkers: number
  openCards: number
}

/** A machine from remotes.json, or one a running worker names: its running headless workers and the open cards routed there. */
export type MagiRemote = { name: string; configured: boolean; workers: { taskId: string; harness: string }[]; live: { taskId: string; harness: string; name: string }[]; openCards: number }

/** working: its session is busy (or its headless run still going); waiting: blocked on a person; unknown: not listed now. */
export type MagiWorkerState = 'working' | 'idle' | 'waiting' | 'unknown'

/** Who is on an open card, as `magi status --json` reads it from the ledger and the live sessions. */
export type MagiWorker = {
  harness: string
  /** Its name, else its title, else `omp session 01a118ef`; `headless omp` for an unnamed headless run. */
  name: string | null
  /** The first eight characters of its session id; null when none is recorded. */
  id: string | null
  /** True while its session is listed live right now. */
  live: boolean
  state: MagiWorkerState
  /** When `lastSaid` was said; null when unknown. */
  lastActivityAt: number | null
  /** Its newest words on the card, one line, redacted, at most 140 characters; null when none. */
  lastSaid: string | null
  via: 'live' | 'headless'
  /** When a headless run is stopped, from its worker record; null for a live session. */
  timeoutAt: number | null
  /** The remote a headless worker runs on (`name` then ends "on <host>"); null on this machine. */
  host: string | null
  /** What a waiting session waits on, in its harness's words ("permission prompt: choose: allow or deny …", "approval of bash"); null otherwise. */
  waitingFor: string | null
  /** A live worker on another machine with no fresh word from there: not known, which is neither gone nor idle. */
  unseen: boolean
}

/** The session that opened a card: its name as the worker's is shown, and every id it goes by. */
export type MagiCoordinator = { harness: string; name: string; ids: string[] }

/** The latest delivery receipt one way: to whom, the bridge's deliveryStatus word, when. */
export type MagiDelivery = { to: string; toRole?: 'peer' | 'orchestrator'; status: string; at: number | null; statusText?: string }

/** One message on a card, one line, redacted, at most 100 characters. */
/** `files`: the names (in the sender's tree) of the files it carried; empty for none or from an older Magi. */
export type MagiMessage = { at: number | null; from: string; kind: string; text: string; files: string[] }

export type MagiCard = {
  taskId: string
  mode: string
  from: string
  to: string
  round: number
  maxRounds: number | null
  /** peer: the worker is on it; orchestrator: a question waits on the asker. */
  turn: 'peer' | 'orchestrator'
  openedAt: number | null
  /** When the unanswered question was asked; null with none. */
  questionAt: number | null
  /** Null from a Magi older than the deck. */
  coordinator: MagiCoordinator | null
  /** Null from a Magi older than the Working pane, or when it could not be read. */
  worker: MagiWorker | null
  /** The task's first line, redacted, at most 140 characters. */
  brief: string | null
  /** Newest first, one per direction. */
  delivery: MagiDelivery[]
  lastExchangeAt: number | null
  /** Its last three messages, oldest first. */
  recent: MagiMessage[]
}

export type MagiOutcome = {
  taskId: string
  mode: string
  from: string
  to: string
  accepted: number
  rejected: number
  open: number
  at: number | null
}

/** A message on any card, for the deck's exchange panel. */
export type MagiExchange = MagiMessage & { taskId: string; to: string | null }

/** Verdict counts and the held rate (accepted of accepted plus rejected). */
export type MagiTally = { cards: number; checked: number; accepted: number; rejected: number; open: number; heldPct: number | null }

export type MagiLedger = {
  days: number
  total: MagiTally
  byMode: (MagiTally & { mode: string })[]
  byDirection: (MagiTally & { from: string; to: string })[]
  /** What headless runs cost where the provider priced them. */
  costUsd: number
  pricedRuns: number
}

export type MagiProviderStatus = 'up' | 'down' | 'disabled'
export type MagiProvider = { name: MagiHarness; status: MagiProviderStatus; reason: string | null }

/** A round closed in the last hour because its request could not be delivered. */
/** A delivery that failed and closed its card; `coordinatorIds` say whose card it was. */
export type MagiFailure = { taskId: string; from: string; to: string; code: string; at: number; coordinatorIds: string[] }

export type MagiStatus = {
  v: 1
  at: number
  cwd: string
  as: string
  units: MagiUnit[]
  /** The fleet beyond this machine; empty with no remotes.json. */
  remotes: MagiRemote[]
  /** Whether files cross to and from other machines here (`magi files`); off by default. */
  files: boolean
  providers: MagiProvider[]
  cards: MagiCard[]
  cardsTotal: number
  unreconciled: number
  outcomes: MagiOutcome[]
  exchanges: MagiExchange[]
  ledger: MagiLedger | null
  failures: MagiFailure[]
  liveError: string | null
}

/** auto: mini inline above the prompt, wide from 110 columns docked, compact below. */
export type DeckLayout = 'auto' | 'compact' | 'wide' | 'mini'

/** One message of a card's whole conversation, as `magi exchange <id> --json` prints it (src/status.mjs cardThread). */
export type MagiThreadMessage = { at: number | null; kind: string; round: number | null; from: string; to: string; text: string; files: string[] }

/** A card's whole conversation, fetched when the person opens the card; `error` when it could not be read. */
export type MagiThread = {
  taskId: string
  /** Older messages left out to keep the drawing bounded; `magi exchange <id>` prints them all. */
  omitted: number
  messages: MagiThreadMessage[]
  error: string | null
}

export type DeckView = {
  /** Set by /magi layout; null follows the pane's place and width. */
  layout: DeckLayout | null
  /** The card opened with its hotkey, its Exchange button or from an alert. */
  expanded: string | null
  /** Where it was opened: its full messages show under it there. */
  openIn?: 'working' | 'exchange'
  /** 'working' after /magi-working or an alert: the Working panel comes first. */
  focus: 'working' | null
  /** True after the Ledger's Details button: its rows by mode, by direction and the last verdicts show. */
  isLedgerOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'magi-view': {
      /** The last `magi status --json` that parsed; null until one has. */
      status: MagiStatus | null
      /** Why the last refresh failed, null after one that worked. */
      statusError: string | null
      /** False after /magi-theme off: plain rows, no accents in the deck. */
      isThemed: boolean
      /** Magi tool calls the person opened with their details button: tool_use_ids. */
      openCalls: string[]
      /** This session's id ($.session.id()), to find its own cards; null until read. */
      sessionId: string | null
      /** The deck's layout, expanded card and focus. */
      view: DeckView
      /** The opened card's whole conversation; null while none is open or before it is read. */
      thread: MagiThread | null
    }
  }
}
