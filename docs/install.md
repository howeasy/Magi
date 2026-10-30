# Installation

## Requirements

- Node.js 22.13 or newer (the store uses built-in `node:sqlite`)
- Claude Code, installed and signed in
- Codex CLI, installed and signed in
- Oh My Pi (omp), optional: a plain install wires it in when it is found
- git (optional, but `diffRef` needs it)

## Install

1. Get the checkout: `git clone https://github.com/howeasy/Magi.git`, then
   in the new `Magi` folder run `npm install`.
2. Close the harnesses, so their own config writes do not race the installer,
   then run `node bin/magi.mjs install`. It registers the `magi` MCP server
   with Claude Code and Codex (and omp when found), copies the skills into
   place, installs the Claude Code mod (below), and deletes the removed web
   dashboard's Windows login entry (`magi-dashboard.cmd` in the Startup folder)
   with one line saying so.
   Done when it prints `Done. Restart Claude Code, Codex and omp so they pick
   up the servers.` A refused configuration exits nonzero with `BAD_CONFIG` or
   `REGISTRATION_FAILED` and leaves the working registration untouched: see
   [Safe configuration updates](#safe-configuration-updates).
3. Set `"crossSessionInbound": "accept"` in Claude's `settings.json`
   (`~/.claude/settings.json`, or beneath `$CLAUDE_CONFIG_DIR`). The installer
   does not write it; [mcp-config.md](mcp-config.md) says why it is needed.
4. Restart every Claude Code, Codex and omp session. Each harness reads its MCP
   servers at startup, and a server that predates a ledger change keeps
   writing the old record shape until it restarts, so restart them all.
   After installing a changed magi-view plugin, reload it in Claude Code with
   `/reload-plugins` if it has not been loaded by a fresh restart; reloading
   the plugin alone does not restart the MCP servers.
5. Run `node bin/magi.mjs doctor`. Done when it exits 0 with no `FAIL` row;
   `warn` rows (a desktop app not seen, a CLI newer than the verified version)
   do not fail it. Then `node bin/magi.mjs peers` lists the sessions the
   restarted harnesses registered.
6. Optional: `npm link` in the checkout puts `magi` on the PATH. It is done
   once and points at this checkout, so a pull is live on the next start.

### Moving or renaming the checkout

The checkout folder is `Magi`; no particular absolute path is required. On
Windows, close harnesses and terminals using the checkout before moving it:
their working-directory handles can prevent the folder rename.

After moving the checkout, run `node bin/magi.mjs install` from its new
location to refresh MCP registrations and record the mod's checkout pointer.
A same-version cached mod can retain its old `checkout.json`; update its
`checkout` path under `~/.claude/plugins/cache/magi/magi-view/<version>/`
if the installer leaves it unchanged. If the Magi statusline is enabled,
also run `node bin/magi.mjs install --usage`. If `npm link` was used, run it
again to refresh the global command. Repair linked worktrees with
`git worktree repair <worktree-path>...` after moving their main checkout,
and update any project trust or local permission paths.
Restart the harnesses and run `node bin/magi.mjs doctor` from the new folder.

### What doctor checks

Doctor first runs SQLite `PRAGMA quick_check` on `magi.db`, then checks the
executables (including omp when present) and their provider status, live
sessions, the Codex app-server, the Codex desktop app's steer channel (a
reachable app-server does not imply it), the desktop apps' URL handlers, both
user MCP registrations independently, the active `magi` table's
`tool_timeout_sec` (not an old `magi-omp` table or a child table; a
commented-out header does not count as registration), Claude's
`crossSessionInbound`, the installed skills, and with omp its `mcp.json`
entries, inbox extension and the combined servers. It reports dead-PID
waiters, dead-PID or overdue workers, and questions older than a day on open
rounds, with what to do about each, and it shows whether files between
machines are on, any relay events held for reconciliation, and the shared
memory's size. A busy database is not a reason to restore
or delete it. Fixes for each row: [troubleshooting.md](troubleshooting.md).

`VERIFIED_VERSIONS` in `src/install.mjs` pins the versions each private
delivery format was last checked against: Claude 2.1.310, Codex 0.160.1,
omp 18.4.4, the Claude desktop app 2.110.0.0 and the Codex desktop app
26.915.4065.0. Doctor warns when an installed CLI is newer. Older dated
observations in the transport guide remain evidence for those versions, not
fresh checks of the current binaries.

## Partial installs

```bash
node bin/magi.mjs install --claude
node bin/magi.mjs install --codex
node bin/magi.mjs install --omp
node bin/magi.mjs install --skills-only
```

Single-harness installs keep omp support when its binary is present or an
existing Magi registration or extension already enables
it; they keep the `peer-omp` and `omp-advisor` skills when only Claude or Codex
is being updated. `--omp` alone still (re)registers Claude and Codex.

## Upgrading a loose-file ledger

State from before the SQLite store (loose task, mail, exchange, outcome and
memory files) is imported only by an explicit migration, never by database
reads or server startup. That is by decision: an implicit migration once moved
the live ledger from a test.

1. Stop all harnesses and Magi servers.
2. Back up the state directory.
3. Run the migration against it. `--home` is required; use the actual
   `MAGI_HOME` directory (`~/.magi` by default):

   ```bash
   node bin/magi.mjs migrate --home <state-directory>
   ```

   Done when it reports verified table and namespace counts; it then removes
   only the imported legacy files, after hash-checking them.
4. Restart all harnesses on the new version. omp needs the restart after
   `magi install` has copied the new inbox extension (it uses `bun:sqlite` on
   omp and `node:sqlite` under Node): its database inbox is not compatible with
   an old poller.

Run it before any new memory is written to the database: migration refuses a
populated memory table. It also refuses a populated receiving namespace or
mail/exchanges table and decoded-key collisions rather than overwriting newer
records; preserve both trees and reconcile the conflict, or import into a fresh
home, before retrying. Unrelated database namespaces do not block import, and
previously migrated core state does not prevent the one-time memory import. The
upgrade also imports Claude usage and statusline-chain, the omp registry and
inbox files. Usage reads keep a one-time, read-only fallback for pre-migration
files; writes use SQLite.

Retention afterwards: task metadata and verdicts stay indefinitely. Closed
cards older than 30 days get exchange-body markers only after a persistent
summary and embedding. CLI-readable transport bodies live in `MAGI_HOME/spill/`
and are swept after seven days.

## Safe configuration updates

Configuration replacements are atomic. Before replacing an existing file,
Magi saves its exact original bytes to `<filename>.bak` (the most recent
pre-write version). Unrelated JSON properties and TOML sections are retained.

Only configurations being rewritten require validation. `--skills-only` leaves
MCP configuration untouched; a single-harness install uses other configurations
only for best-effort omp discovery. If omp support is retained, its MCP file is
also a rewrite target and must be valid.

`BAD_CONFIG` means no rewrite of that file occurred. Existing JSON must be a
valid object: a BOM, trailing comma, empty file, or invalid JSON is not treated
as missing. Fix it first, preserving permissions and `crossSessionInbound`.
The conservative Codex TOML editor refuses inline tables, dotted assignment
keys, spaced table headers, escaped header keys, owned arrays of tables,
multiline strings, empty assignment values and unbalanced brackets/quotes rather
than guessing which lines belong to Magi. Convert these to ordinary table
sections with canonical headers such as `[mcp_servers.magi]`, or edit the
registration manually using [mcp-config.md](mcp-config.md). Plain quoted key
components, including `["mcp_servers"."magi"]`, use the same ownership rules
for replacement, removal and inspection. Child tables, comments, LF/CRLF, and
flat multiline arrays are supported. Nested array elements that start a line
with `[` must be moved onto the assignment line or edited manually.

Claude user registrations live in `~/.claude.json`, or
`$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set. Settings and skills
live beneath `$CLAUDE_CONFIG_DIR` (default `~/.claude`). Verified with Claude
Code 2.1.290: `mcp add -s user` writes that file and refuses an existing name.
So Magi runs every CLI add in an isolated temporary config, checks its exit
status, then re-reads the user config and atomically merges the result into
that latest document, preserving unrelated edits made while the CLI ran.
Existing `magi` entries are replaced atomically in place. Stale
registrations are removed only with the successful replacement, never before a
CLI add succeeds. A failed registration exits nonzero with
`REGISTRATION_FAILED`; it does not print `Done` and keeps the working user
registration untouched.

Windows npm `.cmd` CLIs use the shared CLI launcher. Arguments containing `%`,
`!`, newlines, or NUL cannot safely round-trip through `cmd.exe` and are refused
as `CMD_UNSAFE_ARGUMENT`. Quotes and metacharacters are escaped through both the
launch and shim-forwarding parses. Use a native executable or move the
checkout/CLI to a path without refused characters; spaces are supported.

## If the executables are not on PATH

Common on Windows, where the Codex desktop app bundles its own binary. Point at
them explicitly before installing:

```bash
export CODEX_BIN="/path/to/codex"
export CLAUDE_BIN="/path/to/claude"
export OMP_BIN="/path/to/omp"
```

The installer pins each path it resolves into the registrations' environment
(the Codex `[mcp_servers.magi.env]` table, the Claude entry's `env`, omp's
`mcp.json` entries), so the server finds the CLIs without PATH. It touches
only those three `*_BIN` keys: any other key already in those `env` tables
(`MAGI_WORKER_WRAPPER`, say) is kept when install runs again. It also writes
the same paths to `<MAGI_HOME>/bins.json`, which a Magi process no harness
started reads when PATH lacks a CLI: an ssh command on this machine as a
remote (`magi worker`, `magi relay`), or `magi doctor` run over ssh. A path
through a per-shell folder is recorded as the file behind it: fnm puts each
shell's node on PATH as a link under `fnm_multishells` (on Linux in
`$XDG_RUNTIME_DIR`, `/run/user/<uid>`) and deletes it when that shell exits,
so `CODEX_BIN` becomes `.../fnm/node-versions/<version>/installation/lib/node_modules/@openai/codex/bin/codex.js`,
which the server runs under its own node. Any other link is kept as found:
Claude's `~/.local/bin/claude` is repointed by its updater at each version,
and the file behind it is deleted later. A CLI that exists only inside a
per-shell folder is refused (`EPHEMERAL_BIN`) before any config is written.
`magi doctor` fails any recorded path that is missing or per-shell. Codex's
`env_vars` list is a different thing: it forwards `PEER_DEPTH` and the other
peer variables across the hop ([mcp-config.md](mcp-config.md)).

## A third harness: Oh My Pi (omp)

Any harness that can load an MCP server can consult Claude or Codex through the
bridge; being answered out of band needs a small shim inside its session.
For omp both halves ship here, and `install --omp` (also run by a plain
`install` when omp is found) sets them up:

- `~/.omp/agent/mcp.json` gains `magi` (serving `claude_peer`),
  `magi-codex` (serving `codex_peer`) and `magi-omp` (serving `omp_peer`).
  All run with `--as omp` so the ledger and every prompt say omp asked,
  with the resolved CLI paths pinned in `env`, including `OMP_BIN`,
  and with `timeout: 0`. omp
  aborts an MCP request after 30 seconds unless the server's own entry says
  otherwise, which no imported config can, and a blocking review waits up to
  an hour.
- `~/.omp/agent/extensions/magi/index.js`, the inbox extension. It registers
  each omp session in `~/.magi/magi.db` (`records`, namespace `agents`) and
  polls queued rows in its `frames` table, handing each frame to the model as a
  user turn: a new turn when idle, an aside at the next step boundary when
  busy, a steer when the sender asked for one. Without it omp can ask, but a
  `wait: false` reply, a note or a clarifying question has nowhere to land.
- `peer-claude`, `peer-codex` and `peer-omp`, under `~/.omp/agent/skills/`.

And the other direction, so Claude and Codex can consult omp:

- Claude Code's `magi` server becomes `serve codex omp --as claude` and
  Codex's `[mcp_servers.magi]` table `serve claude omp --as codex`, so each
  session still runs one server process and gains `omp_peer`. A `magi-omp`
  entry from an earlier install is removed.
- the `peer-omp` and `omp-advisor` skills, under `~/.claude/skills/` and
  `~/.agents/skills/`. The second is for switching omp's advisor on for a
  delegated worker (`docs/usage.md`); omp's own skills folder does not get it.

`OMP_AGENT_DIR` (or `PI_CODING_AGENT_DIR`) moves `~/.omp/agent`. Set `OMP_BIN`
if the binary is not on PATH or in its default install location. Restart all
three afterwards. Done when `doctor` has no `FAIL` row among its omp checks and
`peers` lists the registered omp sessions.

An omp session can then consult another omp session through `omp_peer`;
the receiver replies through `omp_peer` too. The bridge requires verified
session identities to distinguish the roles and refuses a session targeting
itself. Installation alone does not verify a live round trip.

For this OMP-to-OMP update, run `node bin/magi.mjs install --omp` from the
updated checkout before restarting every participating harness: the new MCP
registration, copied skills and inbox extension are not picked up by an
already-running session. The magi-view update also needs the plugin reload
or fresh restart described above to distinguish same-harness delivery
directions. Existing mislabeled cards remain historical records; installation
does not relabel them without trustworthy session evidence.

Nothing here reaches into omp's own internals: the extension uses only the
documented extension API, and the bridge side is a registry and an inbox in
`magi.db` that any other harness could implement the same way.

## Subscription usage (optional)

```bash
node bin/magi.mjs install --usage
```

Puts `magi statusline` in front of your Claude statusline (kept and chained,
restored by `uninstall`) so `magi usage` can show the account's 5-hour and
7-day windows and `magi peers` each session's cache warmth. Alone, `--usage`
does only this; beside `--claude`, `--codex` or `--omp` it runs after that
install, so `install --omp --usage` does both. Codex needs nothing: its app-server reports the windows on request. Done
when `magi usage` prints a `claude:` line, which needs one Claude session to
have rendered its statusline since. See [usage.md](usage.md), "Subscription
usage, not dollars".

## Provider settings

`magi provider disable|enable <claude|codex|omp>` turns a provider off or back
on without touching the registrations; `magi provider list` shows which are
off and which are down. What each state does, and the settings' storage, is
[usage.md](usage.md), "Providers".

## Readable peer traffic in Claude Code: the magi-view mod

`magi install` adds this checkout as a Claude Code plugin marketplace (`magi`)
and installs its `magi-view` mod (`claude-mod/`), which shows Magi traffic in
plain words and, in the `/magi` deck, the whole fleet. Everything it does is
drawing: the stored message and what the model reads are unchanged (Claude
Code's `ui.render` contract for `UserMessage` and `ToolUse` rows), so replies,
outcomes and delivery confirmation work exactly as without it.

### Installing and updating it

It needs Claude Code 2.1.287 or newer with mods (the mod was written and typed
against 2.1.293), and is refused where managed settings set
`allowManagedModsOnly`. A failure is reported with the `claude plugin …`
command to retry and never fails the install. Done when install prints
`Installed the magi-view mod in Claude Code` and, after `/reload-plugins` or a
restart, `/magi` opens the deck.

Claude Code copies the plugin into a versioned cache
(`~/.claude/plugins/cache/magi/magi-view/<version>`) and a session in any other
project loads that copy, so `magi install` also runs
`claude plugin marketplace update magi` and
`claude plugin update magi-view@magi`. Bump `version` in
`claude-mod/.claude-plugin/plugin.json` with every change to the mod, since the
cache is kept per version. The copy has no checkout above it, so install first
writes `claude-mod/checkout.json` (ignored by git) naming the checkout, and the
mod runs `bin/magi.mjs` from there; the plugin's `checkout` option (`/config`),
when set, wins, and a copy of the mod kept elsewhere names the checkout there.
A session started in this checkout reads `claude-mod/` itself and picks an edit
up on `/reload-plugins`. `node` must be on the PATH Claude Code runs with.
`magi uninstall` removes the plugin and the marketplace.

omp and Codex have no equivalent: omp can only restyle custom messages, which
reach its model with developer authority, and Codex has no interface extension
point.

### What it draws

Peers are named by harness (`claude`, `codex`, `omp`) everywhere. Plain English
carries every meaning; the Eva styling is accent only and spends colour
sparingly: purple for the deck's headings and unit frames; green, amber and red
only on the word or mark that signals live, waiting or failed; a few cells of
orange-and-black hazard tape before the deck's title; the MAGI codenames
(MELCHIOR-1, BALTHASAR-2, CASPER-3) as dim subtitles of the units; and kanji as
dim accents after the English they repeat, at most one per heading or row
(警告 alert, 作動中 working, 交信 exchange, 照合 outcome in the deck's headings;
待機 standby in the inline summary; 要請 request and 回答 reply on message
rows).

- **Peer messages you receive.** The `PEER … magi/1` line, the closing
  instructions and the delivery marker are left off. Expanded, a row is one
  header line over the body, such as `Reply from omp · magi-1a2b3c4d · round 2
  回答` (every kind's title, from `Request from claude` to `Check-in from omp`,
  is in `hooks/clean-peer-text.ts`). Collapsed, it is that header, a colon and
  the body's first line.
- **Your own Magi tool calls.** The call line of each `claude_peer`,
  `codex_peer` and `omp_peer` call is one line saying what was done, such as
  `Sent request to omp · DELEGATE · magi-… · queued, not read yet · "first 60
  characters of the task"  要請` (every kind's phrase is in `hooks/nerv.ts`).
  The state comes before the quoted text, so a narrow terminal cuts the text
  first: `running` while the call runs; once it returns, the reported
  `deliveryStatus` in words (`delivered`, `delivered mid-turn`, `queued, not
  read yet`, `sent, not confirmed`, `accepted, not confirmed` for a Codex
  steer, `running` for a headless worker, `failed`, `done`); `failed:
  NO_LIVE_PEER` with the error code; `interrupted`. The result beneath is
  Claude Code's own row, ctrl+o and all. A `ToolUse` row has no expanded state
  of its own, so each line carries a `▸ details` button (click it, or Enter
  when focused): it opens Claude Code's own row with every argument beneath the
  line, and `▾ hide` closes it. Other tools and a kind the mod does not know
  keep Claude Code's drawing.
- **The deck** (`/magi`), described below.
- **`/magi-working`** opens the deck with the keys and Working first.
- **The band** above the prompt shows two things. A delivery that failed on
  one of this session's cards: one line per failure, up to three, each a
  coloured edge and the words as a button that opens the deck at that card
  (no accent after it), then `N more alerts in /magi` past three. And, only
  while no turn is running, a calm dim line per card a peer still owes this
  session a reply on, so an idle session reads as waiting on purpose:
  `▎ Waiting on omp · magi-… DELEGATE · 4:12 · the reply comes back by
  itself`. The clock runs from the last delivery to the peer. The words
  after it say instead when the worker is blocked on a person (`omp is
  waiting on a person: approval of bash`), or when a headless run ended
  without a reply. The head is a button that opens the deck at the card; the
  line leaves as soon as a turn starts. A question is the coordinating
  agent's to answer, and never shows here. While the band shows anything it
  re-reads `magi status` every 15 seconds (and once when a turn ends with a
  reply owed), and stops once nothing is left.
- **Peers on another machine** are named with it wherever the mod draws
  them: `Sent request to omp on mac`, `Reply from omp on mac`, `Request from
  claude on devbox`, and `· with omp on mac` after an outcome, question or
  close on a remote card. It comes from the call itself (its `host`, or a
  relayed delivery's `via`), a request's `orchestrator_host`, or else the
  card's worker in `magi status`. A peer on this machine reads as before.
- **The status line** reads `Magi: claude ✓ · codex – · omp ✓` (✓ a live
  session, – none, `off` a provider turned off), then whose work is open:
  `· 1 working here · 4 in web-api` (this session's cards, then up to
  two other sessions', then `N more working`), `N more open` when the status
  lists fewer cards than are open, `· 1 question for claude` and `· 1 reply
  for claude to check` when they are not zero, and `(stale)` after a failed
  refresh. In the terminal it is pinned under the prompt (`$.ui.status`). On
  the desktop a button in the prompt footer takes its place, after Claude
  Code's own mode labels (the `SessionMode` render hook): pressing it opens the
  deck as `/magi` does. The footer holds about a dozen characters, so the
  button says `Magi` and the one most pressing fact, `Magi · 1 failed`,
  `Magi · 1 question`, `Magi · 2 to check` or `Magi · 2 working` (this
  session's), in that order, else `Magi` alone (`Magi · stale` after a failed
  refresh). A pinned line cannot be pressed, so once the footer carries the
  button the pinned line is cleared and no longer set on that surface.
- **Toasts** follow each Magi tool call once it resolves (`Request sent to omp
  (magi-…)`, `Outcome recorded: 5 accepted, 1 rejected, 0 open`, `Magi request
  to omp failed: NO_LIVE_PEER`) and the first drawing of a reply (`Reply from
  omp on magi-…`). The tool call itself is never changed.

`/magi-theme off` hands every row back to Claude Code's own drawing (a peer
message keeps its protocol text removed, under the same header line) and draws
the deck and band plain: no hazard tape, colours, beating marks, kanji or Svg
panels; the text deck with its rules on every surface; the units as boxes with
no triad or bus; the verdict bars dim. `/magi-theme on` restores them, and
`/magi-theme` alone toggles; the choice is kept.

### The deck

One pane: docked beside the transcript in fullscreen, one column at every
width; inline above the prompt on the main screen, a summary of at most 8 rows
(up to two things waiting on you, up to three working cards, the units).
`/magi layout mini` forces the summary and `compact` or `wide` the full deck
(the two now draw the same single column); `auto` goes back to choosing by
placement. `/magi close` closes it, and the `openOnStart` option (`/config`,
off by default) opens it when a session starts. It re-reads every ten seconds
while open, and on `Refresh`.

Its header is the hazard tape, `Magi deck · updated 14:07:12` and `Refresh`
(`r`). Each section below is a heading (an icon, the title in purple, a dim
count) with a hairline rule running from it to the right edge, over rows
separated by hairlines. On the desktop app, VS Code and mobile (the surfaces
that draw vectors), each section's body is an `Svg` panel (`hooks/panels.ts`)
drawn in the `font` option (`/config`; default `0xProto Nerd Font Mono`, any
monospace installed on the machine; the list falls back to JetBrainsMono Nerd
Font Mono, Cascadia Mono, Consolas, then monospace) with that font's Nerd Font
glyphs as the icons (`icons` option, on by default; off draws plain Unicode
marks for a font without them). The controls (Refresh, a card's open mark with
its hotkey, Details, Enable and Disable) and a card's clock stay native. Each
panel is drawn as an image: the sandboxed frame `isInteractive` asks for paints
a white page under it and reloads on every change of the markup, which showed
as a flicker; the `alt` says the same in English for a surface that cannot show
it. In the terminal, and after `/magi-theme off` everywhere, the same sections
are text with `─` rules under the headings and `╌` rules between rows.
Sections with nothing to show take no room.

- **Your move**, first: what waits on the orchestrator of this session. A
  row per question waiting on one of its cards (`omp (reviewer) asks: Which
  branch?` with how long ago at the right, amber), per failed delivery on
  one of its cards (`Delivery to omp failed on magi-…`, also for a round
  closed by one in the last hour; red, and in the terminal a button that
  opens the card), then the replies it still owes an outcome against the
  limit (`2 replies for claude to reconcile · 2 of 3 before new cards are
  refused`; red once over it). With nothing waiting, one dim line: `nothing
  waiting on you`. Another session's cards are its own business and never
  appear here.
- **Units**: on the vector surfaces, from 66 columns, the MAGI triad, one `Svg`
  element (`hooks/triad.ts`) in the same font: claude and codex across the
  top, omp beneath between them, each a cut-corner panel in the purple frame
  with the harness name, the codename small and dim at the right, a mark and
  its state in words (`● working`, `○ standby`, `no session`, `turned off`),
  and the counts that are not zero or the provider that is down. The links
  between the panels are the facts in motion: a card in flight is a packet
  moving along the link from its asker to its worker (orange for this
  session's cards, dim purple for another session's, amber running back for a
  question waiting on the asker, four at most per direction; the link itself
  shades purple at the asker to orange at the worker); the mark of a unit a
  card is in flight to breathes with a ring; an idle link carries a faint
  glint every six seconds and nothing more; a unit a delivery failed to wears
  a red hazard strip, and a provider down an orange one. The stamp between the
  top panels counts the cards between the units (`5 in flight · 1 question
  waiting`), or says `standby`; it carries no clock, so the drawing changes
  only when the facts do. The triad is the units: no boxes repeat it. Motion
  is SMIL inside the SVG. In the terminal, from
  66 columns, three equal boxes with the same words (the mark of a unit with a
  card in flight beats, `hooks/pulse.tsx`) over a bus (`hooks/bus.tsx`): a dim
  rail with a port under each box, and a packet per card in flight running
  from its asker's port to its worker's in the same colours. Below 66 columns,
  a line each.
- **Working**: every card a worker is on, grouped by the session that asked
  (`This session` first, then the others by name, e.g. `web-api`,
  drawn faded). Per card, two lines over a hairline. The first: the worker's
  state mark (green at work, amber waiting or stalled, dim otherwise), the
  harness, the worker's name, on the vector surfaces the task's first line,
  then at the right the mode as a small tag, the round and a bolt for a live
  session or a prompt for a headless run, and a live clock
  (`hooks/elapsed.tsx`). The round shows its cap only where the cap is real:
  `round 1/6` for a review, `round 3` for a live DELEGATE or PARALLEL card,
  which runs under an eight-hour window rather than a turn count, and never a
  round past the number. The second, dim: where the worker stands (`working`,
  `waiting on a person`, `idle`, `running`, `ended`, `not found`; a live
  session idle or gone for half an hour with no word on the card is
  `stalled · idle 3h05` in amber), its newest words on the card and how long
  ago, then at the right the receipt of the orchestrator's last message as
  ticks (`✓ sent`, `✓✓ delivered, unread`, `✓✓ read 15:41` in green,
  `✗ failed` in red) and a headless run's time left (`⧗ 23m left`). Past the
  20 cards the status lists, a dim line counts the rest and points at
  `magi channels`.

  `1`-`9` open a card (`▾`) once the deck has the keys: ctrl+x tab, or opened
  from an alert or `/magi-working`. Under dim labels: `Asked: <the task's first
  line>`, `Said (3m ago): <its newest words on the card>` (or `nothing yet`),
  `Delivery: queued, not read yet` (the tool rows' phrases; a receipt back to
  the coordinator follows as `to claude: delivered`); a dim line with the card
  id, `live session, working` / `headless worker running` / `session not
  found right now` and the session's first eight id characters; then the
  card's whole conversation: each message a dim line (its time, who to whom,
  the kind, the round) over its words in full, drawn as markdown, read on
  opening with `magi exchange <id> --json` (redacted; a message past 12,000
  characters is cut with a pointer to `magi exchange <id>`, and the oldest
  messages are left out past 90,000 in all, with a line saying how many).
  `Close messages` or the hotkey again closes it. A worker is named by its
  session's name, else its title, else `omp session 01a118ef`; an unnamed
  headless run is `headless omp`. A question waiting on the coordinator is not
  work.
- **Exchange**: the last eight messages on any card of the project, threaded
  by card, the card with the newest message first: a title line (the card id
  and its task line), then one line per message: the time, an arrow for its
  direction (green coming in to this harness), who to whom, the kind with its
  mark (a reply green, a request or a question amber, a note dim), the words.
  Each thread opens: the `▸` beside its drawing on the desktop, its title in
  the terminal. Opened there, the card's whole conversation shows under the
  thread, as it does under a Working card.
- **Ledger**: the week in one line, `Last 7 days · 942 cards · 870 checked ·
  96% held · 4304 accepted · 192 rejected · 1638 open` (the held rate is
  accepted of accepted plus rejected, green from 90%, amber from 70%, red
  below; a count of zero is left out), then a row per direction (`claude →
  omp`, `claude → codex`, `codex → omp`…, the most cards first): a bar of its
  verdicts (accepted green, rejected red, open amber, in proportion; in the
  terminal from 72 columns), its held rate in that colour, its counts and its
  cards. This is how an orchestrator decides which peer to trust for what.
  Last, what priced headless runs cost (`$12.40 over 7 days (38 priced
  runs)`). `Details` (`d`) opens the rows by mode and the last five verdicts;
  a row with nothing counted is never drawn.
- **Providers**: claude, codex and omp as chips in one row from 66 columns
  (a line each below), each the name, `up`, `down: <reason>` or `off`, and
  `Enable` or `Disable`, which runs `node <checkout>/bin/magi.mjs provider
  enable|disable <name>` and re-reads; a harness picks the change up when it
  restarts.

### Where the drawing comes from

The deck, band and status line come from `node <checkout>/bin/magi.mjs status
--json --cwd <session directory>`, run at session start, after each Magi tool
call, when a reply is first drawn, after a provider switch and while the deck
is open (`magi status` prints the units and cards as text). Each open card
carries its coordinator (the session that opened it: name and every id it goes
by, which the mod matches against `$.session.id()` for `This session`), its
worker (harness, name, short id, whether its session is live and its state, how
it was reached, and for a headless worker on another machine its host: the
row reads "headless omp on devbox"), the task's first line, the latest
delivery receipt each way, when an open question was asked and its last three
messages; the status also carries the providers, the remotes (each machine in
`remotes.json` with its running workers and open cards, drawn as the deck's
Remotes panel under Providers, and each unit's count of remote runs), the
last eight messages, the seven-day ledger and the delivery failures of the
last hour. All of it but the providers is the
session's project alone (its git repository's checkout and the worktrees of
it); sessions and cards in other projects are left out. Every message text is
redacted and cut to one line: 140 characters for a task line or a worker's
words, 100 for a message line. At most 20 cards are listed, the oldest, and the
whole answer stays under 40 KB: over that, the newest cards' message lines go
first, then their words, then their task line, then the exchange lines, then
the cards.

The clock is adapted from Flightdeck, and the beating mark and the bus follow
its frame-clock pattern (MIT; see `NOTICE`). The panels' icons were checked
glyph by glyph against `0xProtoNerdFontMono-Regular.ttf` (Nerd Fonts v3) by
reading its cmap; a font without them takes `icons` off.

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `CODEX_BIN` / `CLAUDE_BIN` / `OMP_BIN` | explicit paths to the CLIs | discovered |
| `MAGI_AS` | the name a server orchestrates under (`serve --as` sets it) | `claude` or `codex` |
| `MAGI_HOME` | ledger and mailbox location | `~/.magi` |
| `MAGI_TIMEOUT_MS` | fallback timeout for a headless run started without one; a request always carries `timeoutMs` (default 40 minutes, capped at 60), so this rarely applies | 2400000 |
| `MAGI_CONFIRM_MS` | request/note receipt-confirmation budget; reply/question routes do not wait | 3000 |
| `MAGI_MAX_BACKGROUND` | concurrent background headless runs per server; restart to change | 4 |
| `MAGI_OMP_ADVISOR` | `1`, `true`, `on` or `yes` runs omp's own advisor on every headless omp worker; a request's `advisor` overrides it; restart the harness to change it (`docs/usage.md`) | unset |
| `MAGI_OMP_ADVISOR_MODELS` | the models omp's advisor may run on, comma-separated in preference order (omp's own names, as `omp models ls` lists them); the first that is not the worker's own model is used, a different vendor first, and your omp `modelRoles.advisor` follows the list; restart the harness to change it (`docs/usage.md`) | unset |
| `MAGI_WORKER_WRAPPER` | a JSON array argv every headless worker starts under, `<argv...> -- <worker argv...>`: the operator's sandbox, which `allowCommands` requires; checked at server start (`BAD_CONFIG` if unusable); Magi enforces nothing itself (`docs/security.md`) | unset |
| `MAGI_CODEX_WORKER_TRACE` | a file the headless Codex worker appends its app-server messages to, one JSON line each (token deltas excepted) | unset |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `OMP_AGENT_DIR` (`PI_CODING_AGENT_DIR`) | where each harness's config lives, honoured by install, doctor and uninstall | the harness's own default |
| `PEER_DEPTH` | set to 1 in spawned peers; refuses orchestration | 0 |
