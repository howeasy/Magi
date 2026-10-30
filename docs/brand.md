# Magi identity

The web dashboard this describes (`magi dashboard`, `src/pane/`) was removed
in 2026-10 and no longer exists; the Claude Code mod's `/magi` deck is the view
now. This page stays as the design record of that dashboard's identity: the
MAGI structure, the codenames, and the colours. What the mod kept is small: the
codenames as subtitles (MELCHIOR-1 for Claude, BALTHASAR-2 for Codex, CASPER-3
for omp), Unit-01 purple as its one accent with green, amber and red as
signals, the orange hazard mark in the deck's header, and a few dim kanji
accents after the English. It draws in terminal colours of its own
(`claude-mod/hooks/nerv.ts`), not the hex values below. The rest of this page
describes the removed dashboard as it was designed: its pages, fonts, motion
and copy are not in the codebase.

Magi is a referee between three AI harnesses that must reach a verdict on
evidence. The identity says that: the structure is the MAGI deliberation
display from *Evangelion* (three units locked in a triangle, readouts, a
verdict between them, a unit lighting up when one dissents), and the
surface keeps the Yamashita sleeve's discipline (paper, line work, one
signal colour, geometric 80s type with air in it) in Evangelion's own
colours: Unit-01 purple for the line work, NERV orange for the one signal,
the green of a live readout for a unit at work. Black-and-red, a Persona
cut and a sea-and-coral sleeve were each tried and pulled back: the first
was an alarm, the second fought the schematic, the third was not the MAGI.

The web pane has day and night: night is the MAGI screen itself, a blue-black with
the purple lifted so it still reads, orange unchanged, the band kept. It
follows the system and a click on "day / night" pins one in that browser.
Beside it, the livery: the same wall in another unit's colours. Unit-01
(purple, the default), Unit-00 (the blue prototype with orange trim),
Unit-02 (the red production model with amber) and Unit-03 (black, with a
red signal). A livery swaps only the line colour, the signal, the ember and
the go green; paper, ink and every rule follow. Pinned per browser.

The wall is the home page: the three units, the deliberation between
them, what is in flight, the last rounds. The exchange, one page over, is
the collaboration itself: what one agent asked another, in its words, what
came back, and what was settled, as it happens.

## Colour

| Token | Hex | Role |
|---|---|---|
| Paper | `#f4f0e8` day, `#0a0d1a` night | the ground |
| Ink | `#1b1631` day, `#f0e9d6` night | text |
| NERV (`--nerv`) | `#5a3e9e` day, `#a58ff0` night | Unit-01 purple: unit outlines, connectors, section titles, links, the name, the nav's current page, a request's rule in a thread |
| Signal | `#f26b1d` | NERV orange, the one signal in both: the stamp, a unit with a session waiting on a human, an open thread, the primary action, the cursor bar, the inbox count |
| Ember | `#c9500f` day, `#ff9a4d` night | pressed signal, and signal as text (it reads on the ground where orange does not) |
| Go (`--go`) | `#4f8f2a` day, `#a5e05a` night | a unit at work: the working state, the breathing marker, a passing check |
| Haze | `#7b7890` day, `#8a86a0` night | secondary text, readout labels |
| Band | orange hazard stripes, 45°, 14 px | the band across the top of the page, and nothing else; it slides while a unit is blocked on its human |
| Rules | nerv at 28 % and 10 % | dividers and hover; the schematic grid is nerv at 9 % on a 28 px cell |

Orange is spent in one place at a time. A whole unit goes orange only when
one of its sessions is blocked on its human; the connectors to it go with
it; an open thread waits in orange. The subscription windows go ember past
90 %. Nothing else is orange.

## Type

Two families, clearly distinct.

- **Shippori Mincho B1** 800 (Google Fonts; fallback Yu Mincho, Hiragino
  Mincho, Times) for the display: the few words that name things (the
  name, the units, the stamp, section titles, a thread's route), uppercase,
  tracked `0.14em`. It is the heavy Mincho of the Evangelion title cards,
  and it carries the decoration glyphs too.
- **Jost** (Google Fonts; fallback Futura, Avenir Next) for everything
  read: upright 400, 600 and 700 in ink, sentence case, tabular figures;
  bold small caps for a mode name.
- **Space Mono** (Google Fonts; fallback Consolas, Cascadia Mono) for the
  unit readouts, the header telemetry and the figures beside the stamp: the
  MAGI's own voice. Not for body text.

Line length under 80 characters in the transcript pane (`72ch`).

## Pages

Six, one per question, on one stylesheet (`src/pane/brand.css`) and one
script (`src/pane/app.js`); the header carries the name, the pages, the two
accounts' windows and the day/night switch on every one.

| Page | Question | What is on it |
|---|---|---|
| MAGI (`/`) | what is happening right now | the wall: the three units (live sessions, each with its running subagents under it, and headless workers; saved Codex threads with no turn in the last hour count as saved), the connectors (flowing from asker to asked while a round is in flight), the stamp, what is in flight with the question, the figures; below it the strip, then the feed (the whole room, newest first, the wide column, read as talk: a harness badge, the session's name and its model lead a run of what it said, consecutive lines from one speaker join into one bubble, "you, to name" for what its human typed, a typing bubble for every session mid-turn, and the exchange's lines with their verbs, asked, replied, checked, on a rule in their colour, linking to the thread) and the last rounds. One control, "notify me"; 4 s refresh. Also on the wall, since the pages were cut from six to three: **Needs you** (unread notices and replies that never reached their asker, each row carrying the command that clears it; shown only when something waits, the count sits on the nav), the **Exchange** threads (see below) and the accounts' windows and doctor rows in the strip. `/exchange`, `/inbox` and `/system` still serve the wall for old bookmarks. Exchange threads: every task as a thread, open ones first: the request as the peer saw it, the reply, a clarifying question and its answer, the verdict, a close; open threads wait in orange with a breathing marker; each thread reads as a conversation, the asker's turns on the left in nerv, the peer's on the right in green, chamfered bubbles under a plain lead-in ("<session> asked codex", "codex replied", "<session> checked codex's reply against the source"), the verdict and a close as short centred lines; a request shows the question as the orchestrator wrote it, with the framed request one click away; a reply is rendered as prose (headings, bullets, bold, code) from elements, never markup. One `<article>` per task, updated in place, so scroll, focus and an opened "show all" survive the 3 s refresh |
| Sessions | who is here | every live session with its state, its subagents indented under it; click one for its transcript tail |
| Ledger | is asking worth it | confirmed-rate by week, by mode and by direction, then every task with the question, status, findings checked and cost, the rest in the row's detail, with filters |

## Structure

- The header carries the 8 px sky band and a 3 px sea rule. The name is
  `MAG` in nerv and `I` in orange; the current page carries an orange rule.
- The MAGI is a 3 × 2 grid: MELCHIOR·1 (Claude) top-left, BALTHASAR·2
  (Codex) top-right, CASPER·3 (omp) bottom-centre, the stamp top-centre,
  what is in flight bottom-left, the ledger's figures bottom-right. Units
  are nerv outlines 4 px thick with 18 px chamfers (`clip-path`), paper
  inside; every live session and every headless worker of the harness is a
  row (a worker's marker is ◇, a session's ●): the name (a link into its
  desktop app when it lives in one), the model it runs as a small chip
  (Claude from its transcript or statusline, Codex from the CLI's
  configured default, omp from its session's `model_change`), then its
  state and what it is working on on one line, and a thin context gauge
  when the harness reports a window. A nameless omp session is labelled by
  the title its first prompt starts with. Nothing else goes in a unit: windows and a timeline
  were tried there and crowded the picture.
  Three 3 px connectors join the unit centres. Directly under the wall,
  the last 24 hours as a line with one tick per round opened: orange while
  open, green when its findings were confirmed, ember when something was
  rejected, haze when it was never checked, half-height when it closed
  unanswered. Then a one-line strip: the accounts' subscription windows
  (Claude's 5 h and 7 d, Codex's 7 d, a bar each, ember past 90 %; the
  header carries no telemetry), the installation checks, the state
  directory, the clock and the one control on the page, "notify me": a
  browser notification when a unit goes blocked or a notice arrives, off
  until pressed because the browser asks on a gesture.
- The stamp is the deliberation, chamfered like a unit: DELIBERATING with
  the number of rounds between the units right now, on orange; STANDBY as
  an outline saying when the MAGI last spoke. The figures beside it are the
  ledger in the project's words: exchanges, live units, findings confirmed or rejected
  once the asking agent checked the reply against the source, and how many
  replies were never checked at all. "Reconcile" is the protocol's word;
  the page says "checked", which is what it means.
- Decoration: the MAGI labels its readouts in its own script, and the
  English beside it carries the meaning, always. 作動中 ACTIVE, 待機
  STANDBY, 警告 BLOCKED, 審議中 DELIBERATING, 承認 CONFIRMED, 否決 REJECTED,
  未決 reply never checked, 終了 closed. The glyphs are `aria-hidden`, smaller,
  at 70 % opacity; nothing is said only in them.
- On the other pages, the operations sheet: sessions, notices, ledger,
  replies as tables with hairline rows; the transcript pane for the selected peer
  as a chamfered sea outline, sticky on the right.
- Controls are sharp (2 px radius), 40 px tall, 32 px inside tables. One
  primary action per form, in coral.

## Motion

Each piece of motion is a fact, and reduced motion stops all of it:

- a connector flows from asker to asked while a round is in flight between
  its two units: the line is a purple-to-orange gradient in that direction,
  and one packet per open round travels it (purple for a review, green for
  a fact-check, orange otherwise; a debate's second round sends one back);
- the orchestrating unit wears an orange 指令 ORCHESTRATING tag and a slow
  orange glow, the answering one a green 応答 ANSWERING tag and glow; a
  unit doing both is purple and says BOTH WAYS;
- while deliberating, the stamp's frame is a conic gradient with one dark
  gap that runs round it, the MAGI's own progress ring;
- a reply that closes a round sends a green packet back along its
  connector once, and the answering unit flashes green and pings (an
  outline that expands and fades);
- a working session's marker breathes; a headless worker's marker spins;
  a session mid-turn is a typing bubble at the top of the feed;
- a blocked unit pulses, its name flickers out of sync, hazard stripes slide
  across the whole wall behind the units, and the band slides;
- idle, a faint glint crosses each connector every few seconds: the wall is
  polling and the units are wired, no more; the grid drifts a cell every
  90 s;
- the wall boots: each unit's inside is wiped in by a scan on first render;
- the stamp pops when the number of rounds changes;
- the scan line crosses the wall every 7 s, the MAGI's own heartbeat;
- a new feed line and a new thread slide in once.

Nothing fades in for effect. Transitions on controls are 120 ms.

## Copy

The page shows; the CLI acts, and the page names the command (`magi
notices --read <id>`, `magi close --task <id>`). Outcome words are *held*,
*overturned*, *unsettled*. Empty states say what to do next; errors say what
happened and how to fix it, never sorry.

## What is deliberately not here

Cards with soft shadows, gradients anywhere but the sky band, a
third accent, uppercase eyebrow labels above headings, middle-dot meta
strings, a `→` on buttons, entrance animation on anything that renders more
than once.
