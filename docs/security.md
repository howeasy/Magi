# Security model

This is the source of truth for what a headless peer may do and what Magi
keeps on disk. The rules an agent follows are in `skills/PROTOCOL.md`,
"Security".

## Permissions never widen

A peer request cannot do anything the initiating workflow could not. It is a
message, not a grant. It cannot approve a pending permission prompt, change
settings or `CLAUDE.md`, or run a slash command; those arrive as plain text.

`skills/PROTOCOL.md` carries the rule for all three skills: if a peer asks for
something the session forbids, refuse and surface it to the user. Routing a
denied action through another agent is laundering, and the protocol names it
so.

A spawned peer (`kind: "spawn"`) is an ordinary interactive session started
with the user's own CLI in the user's own account: its permissions are the
CLI's defaults, or the `permissionMode` the caller named, passed through as
given. The bridge never adds a `--dangerously-*` flag, and a spawn kind is
only reachable from a session that already holds the peer tool. Naming a
mode is the user's act; the docs say what each mode means in its harness.
With `app: true` the bridge hands the OS one URL carrying a folder and one
line of text; the desktop app applies its own workspace trust and its own
permission defaults, and `permissionMode` / `model` are refused rather than
passed, since the URL cannot carry them. A session the bridge opened is
claimed only by the marker in its own first message, never by being new, so
a launch cannot be made to claim, or rename, someone else's session.

## What a headless peer may do

Read-only is the default for every request. Only a `DELEGATE` (or the
engine-only `PARALLEL`) with `allowWrites: true` may write; the engine ignores
`allowWrites` in every other mode. A `DELEGATE` sent without it is framed
`write_policy=read-only`, its worker is told it arrived without write access, and
the caller gets a `[magi] ... went out READ-ONLY` notice, so a slip is visible
and costs a turn, not a silent no-op. The field selects the headless policy
below and what a live peer is told; it does not change the tools or permissions
of an already-running live peer. Live review compliance remains a session
policy, not a new sandbox.

What that produces on the wire:

| Headless path | Review controls | Writes allowed | Writes and commands (`allowCommands`, under the wrapper) |
|---|---|---|---|
| Codex | `sandbox:"read-only"` on `thread/start`/`thread/resume` and `sandboxPolicy:{type:"readOnly"}` on the turn, `approvalPolicy:"never"` | `sandbox:"workspace-write"` and `sandboxPolicy:{type:"workspaceWrite"}`, scoped by the request's `cwd` | unchanged: workspace-write already runs commands |
| Claude | `--safe-mode --restricted --strict-mcp-config`, empty MCP config, `dontAsk`, `--permission-prompts none`, and only Read/Grep/Glob/WebFetch/WebSearch | `--permission-mode acceptEdits`, `--permission-prompts none`, `--strict-mcp-config` with an empty MCP config | `--permission-mode bypassPermissions`, `--strict-mcp-config` with an empty MCP config |
| omp | `--mode rpc --no-ui --no-extensions --no-skills`, `--tools read,grep,glob,web_search --approval-mode always-ask` | `--mode rpc --no-ui --no-extensions --no-skills`, `--approval-mode write` | the same, `--approval-mode yolo` |

Every headless Claude launch also passes `--disallowedTools mcp__magi
mcp__codex`. The exact argument lists are `headlessClaudeArgs`
(`src/claude-launch.mjs`), `headlessOmpArgs` (`src/omp-launch.mjs`) and the
Codex app-server session in `src/codex-launch.mjs`.

### Commands, and the operator's launch wrapper

Nobody can answer a headless worker's permission prompt, so by default a
delegated worker edits files but runs no shell command: omp's `write` and
Claude's `acceptEdits` refuse them. A supervisor that needs a worker to run
`cargo fmt` or a focused test supplies the containment itself and tells Magi
so with two opt-ins:

- **`MAGI_WORKER_WRAPPER`** on the server, a JSON array argv such as
  `["/usr/local/bin/phx-sandbox","--profile","worker"]`. Every headless
  worker the server starts then runs as `<wrapper argv...> -- <worker
  argv...>`: a bubblewrap sandbox, a systemd scope, a Windows job object or
  AppContainer launcher. The server refuses to start (`BAD_CONFIG`) unless it
  is a JSON array of non-empty strings whose first item is an absolute path
  to an executable (on Windows an `.exe`, `.com`, `.cmd` or `.bat`).
- **`allowCommands`** on a request: honoured only for `DELEGATE` or
  `PARALLEL` with `allowWrites: true`, delivered headless, on a server with a
  wrapper. Left unset, a new card that meets all of that gets commands
  (since 2026-10-21; `false` withholds them): the wrapper is the operator's
  consent, and coordinators asked so rarely that delegated work came back
  untested. An explicit `true` anywhere else is refused
  (`COMMANDS_REQUIRE_WRAPPER` without a wrapper, `BAD_REQUEST` otherwise),
  never quietly dropped. So configuring a wrapper now means commands for
  every headless writing worker on that server, not only those asked for:
  a pass-through wrapper (no sandbox) gives them the operator's own reach.

**Magi does not enforce the sandbox; the wrapper's owner does.** Magi checks
only that a wrapper is configured and well formed, starts the worker under
it, and tells the worker it is in one. What the worker can then reach (which
paths are writable, which credentials are visible, the network, the
environment) is whatever the wrapper allows. Without a wrapper Magi never
grants commands. The wrapper receives `MAGI_WORKER_TASK_ID`,
`MAGI_WORKER_ROUND`, `MAGI_WORKER_HARNESS`, `MAGI_WORKER_CWD` (absolute),
`MAGI_WORKER_COMMANDS` (`1` or `0`) and `MAGI_WORKER_CONFIG`: a file the
worker must be able to read, outside its working directory, or empty when
there is none. Every headless omp run has one (its overlay, in the server's
temp folder), and omp refuses to start without it, so a wrapper that gives
the worker a private `/tmp` binds that one file in read-only. It also gets
the worker's command fully resolved
(a CLI that is a node script runs as this server's node plus the script, so
the sandbox needs no node on its `PATH`). The worker row records the
wrapper's argv[0] and the spawned process's pid and start time; the
mechanism is in `docs/architecture.md`, "A headless worker under a launch
wrapper".

A wrapper has a second thing to contain on an omp worker: omp's own `read`,
`write` and `grep` take `ssh://<alias>/path` (found in the 18.10.4 bundle,
2026-10-16), so a worker in `--approval-mode yolo` reaches every host the
operator's ssh keys and config reach, whatever the wrapper does to the local
filesystem. A wrapper meant to confine such a worker hides `~/.ssh` and the
ssh agent from it. Without commands the gate is closed: checked 2026-10-16, a
headless review worker's `read` of `ssh://devbox/etc/hostname` was refused,
"requires approval but no interactive UI available".

Checked on 2026-10-12 with real workers and a test wrapper that runs them in
`bwrap --ro-bind / /` with only the task directory and the engines' state
folders writable (Ubuntu 24.04, kernel 7.0, uid 1000). Each was asked to run
`uname -s`, write a file in its directory, and `touch $HOME/…`:

- **omp 18.10.3** (`--approval-mode yolo`): the commands ran, the file was
  written, and the home write failed with `Read-only file system`, from the
  sandbox.
- **Codex 0.160.1**, an fnm npm install whose `codex` is `codex.js`: the
  wrapper got the server's node plus `codex.js`. Codex's own workspace-write
  sandbox ran nested inside `bwrap`, with the same three results.
- **Claude Code 2.1.289**: it accepted `--permission-mode bypassPermissions`
  with the other flags and stopped at its own sign-in check (the machine was
  not signed in), so a command run under Claude is not yet confirmed. Claude
  is documented to refuse a bypass mode when running as root unless told it
  is in a sandbox, so a wrapper that maps the worker to uid 0 needs checking.

On Windows (omp 18.8.6, a pass-through wrapper, no sandbox) the wrapper got
`omp.exe` with `--approval-mode yolo`, and the worker ran a command and wrote
in its directory.

### Claude

The review path removes shells, editors, inherited MCP servers, hooks,
plugins and project customizations. This was checked against the actual tool
manifest of Claude Code **2.1.263**, with permissive project settings and a
test startup hook: only the five expected tools appeared, source reading
worked, and neither the hook nor the requested write produced a marker. The
launch flags must be supported; an unsupported CLI fails rather than retrying
with weaker controls. This is tool restriction, not an OS filesystem sandbox.

The old git-prefix allowlist was unsafe: `git diff --output` writes a file.
`--tools` alone also left MCP tools available, and `mcp__codex` did not name
the installed `mcp__magi` server. Both bridge names are now excluded on every
headless Claude launch; review launches additionally disable all MCP
configuration.

A delegated Claude peer inherits no MCP servers at all, for the same reason
the review path does not: a peer editing the tree has no business reaching
the user's connectors, and the reverse bridge would otherwise arrive through
them. Project instructions and hooks are kept, since a delegated task should
follow the repository's conventions. `acceptEdits` is still not an OS
workspace sandbox.

### Codex

`danger-full-access` is never passed. The sandbox is set on every headless
run including resumes, on the thread and again on the turn, because `codex
exec resume` once dropped `--sandbox` and silently inherited whatever the
user's config allowed. On a machine configured for full access, that alone
turns a "read-only" review into an unrestricted one. A workspace-write turn
carries no extra writable roots and Codex's default of no network; a user
who set `sandbox_workspace_write.network_access` in `config.toml` no longer
gets it on a headless delegate (unverified whether the turn policy or the
config wins on 0.160.1).

The Codex sandbox constrains command execution. It does not establish that
every inherited MCP connector is incapable of an external mutation. That
separate capability boundary remains to be audited.

### omp

omp has no switch that keeps its MCP servers out of a headless run, so it
starts the bridge's own servers inside an omp peer. They inherit
`PEER_DEPTH=1` (omp forwards its environment to the servers it spawns) and
exit before serving, so the peer has no bridge tools at all; omp warns and
answers normally (checked on 18.3.0). Its tool whitelist is a model-facing
restriction, not an OS sandbox, the same caveat as Claude's.

Headless omp sender provenance uses its actual launch approval mode
(`always-ask` or `write`), never the global configured mode.

### The advisor on an omp worker

`advisor: true` (or `MAGI_OMP_ADVISOR=1`) adds `--advisor` to a headless omp
launch and nothing else: the worker keeps its tool whitelist and approval mode,
and the rest of the launch is unchanged. What the advisor adds is a second model
that reads the worker's whole run, including every file and tool result it
saw, and sends the worker notes. Three things follow.

- **A second vendor may see the run, by design.** The reviewer is deliberately a
  different model from the worker's, and where it can be, a different vendor's.
  Magi picks it only from the user's own lists (`MAGI_OMP_ADVISOR_MODELS` on the
  server, then omp's `modelRoles.advisor`), never from a request, and writes the
  choice into an overlay in the temp folder that says the advisor is on and
  names that model, and nothing else, deleted when the run ends. A run without
  the advisor gets one saying it is off, since a configured
  `advisor.enabled` would otherwise turn it on for every worker. Magi's redaction does not apply to what omp
  sends it; omp has its own secret obfuscator for it
  (`docs/advisor-watchdog.md` in oh-my-pi). A user who does not want a task's
  files read by that model leaves the advisor off, which is the default.
- **Its notes are a model's text going into the worker's context.** Tool output
  the worker reads (a web page, a file) can carry instructions, and an advisor
  that read them may repeat one. omp wraps a note as `<advisory ... guidance="weigh,
  don't blindly obey">` (seen on the wire), and its docs say it discards a review
  that reads as an order to do harm (not tested here). A note changes none of the
  worker's permissions, and the same headless limits above still bind it. Notes
  are redacted and cut before they reach the orchestrator's reply
  (`adviceLines`).
- **It is outside the ledger's accounting.** The advisor's turns are billed to
  its model and recorded by omp in the worker's session (`__advisor.jsonl`);
  Magi's `usage` for the run is the worker's alone.

### Web access

Full and compact review frames disclose read-only file tools plus web
search/fetch. Reviewers must never send repository content to the web.
Network tools remain enabled; the instruction is not an exfiltration sandbox.

### Notes into a running headless worker

A headless Claude or omp stays on its stdin for the whole run, and a headless
Codex is a `codex app-server` of its own for the whole run, so a card note
can reach it (architecture.md, "A headless worker takes notes"). That channel
widens nothing, and these invariants are what keep it so:

- Only the bridge writes to that stdin, and only two things: the request, and
  a note from the card's recorded coordinator (`handleNote`'s role check, the
  same as for a live note), plus, for Codex, the JSON-RPC that carries them
  (`initialize`, the thread and turn calls, declines, `thread/unsubscribe`).
  A note from another process goes through the frames inbox to the server
  whose pid and OS birth marker the worker row names; a reused pid is refused.
- `PEER_DEPTH=1` is set on the worker exactly as before, so any `magi serve`
  it starts refuses to serve: a peer still cannot open a request of its own.
- omp keeps `--no-extensions`, so the worker registers no session and runs no
  inbox of its own (the Magi extension is what would otherwise make it a live,
  addressable session), and `--no-ui`, so it emits no UI request that the
  bridge would have to answer. omp in `--mode rpc` would otherwise accept
  extension UI responses and host-tool results on the same stdin; the bridge
  sends neither and registers no host tools or URI schemes.
- Claude gets `--permission-prompts none` on both branches: with stdin carrying
  the conversation there is nobody to answer a prompt, and a denied tool stays
  denied rather than waiting.
- Codex runs on a dedicated app-server per run, never the shared client
  `src/transport.mjs` keeps for `thread/list`: that one has no `PEER_DEPTH`,
  keeps the bridge's MCP servers enabled and starts no turns. The worker's
  process gets `PEER_DEPTH=1` and the same `-c
  mcp_servers.<name>.enabled=false` flags `codex exec` had, its thread and
  turn get `approvalPolicy:"never"`, and every request the server sends back
  (an approval, `tool/requestUserInput`, an MCP elicitation) is declined with
  an error: nothing on the channel can grant what the sandbox withholds. The
  process tree is killed when the run settles, so the thread is not left
  loaded in a server nobody owns.
- A note is text in the conversation, like the request. It cannot change the
  launch flags, the tool set, the sandbox or the approval mode of the run it
  joins (a Codex note is `turn/steer` input only; the turn's policy was set
  at `turn/start`).

## Context stays small

Only the composed request leaves the orchestrator. Never the transcript,
never files the peer was not pointed at. Outgoing text is scanned for common
secret shapes and redacted, with a count of redactions appended. `redact` in
`src/protocol.mjs` holds the patterns: OpenAI-style `sk-` and Stripe
`sk_live_` keys, Google `AIza` keys, JWTs, GitHub tokens (classic and
fine-grained `github_pat_`), GitLab `glpat-` and npm `npm_` tokens, AWS access
key ids and `SECRET_ACCESS_KEY` values, Slack tokens, bearer and basic
`Authorization` values, private key blocks, credentials in URLs, and
`password`, `passwd`, `secret`, `api_key` or `token` assignments, quoted or
bare. A bare assignment on a source declaration line whose value is an
expression (`const token = getToken()`) stays readable.

That is a backstop, not a licence. The protocol tells every agent not to send
secrets, `.env` contents, or unrelated source in the first place.

Exchange metadata and notice sender fields are recursively redacted before
persistence. Tool results get the same recursive redaction at the engine's
one outbound boundary, including credential-valued metadata fields, and
`magi channels` redacts exchange text before clipping it. Memory Markdown
exports escape metadata backslashes and CR/LF so a field cannot inject a
second header. These backstops do not guarantee all secrets are detected.

## Bounded by construction

- Rounds: 2 by default (6 for DEBATE and ADVERSARIAL_REVIEW), raisable per
  round, hard cap 12. A live delegation card has no round cap; it has an
  8-hour conversation window instead (`CHANNEL_EXPIRED`).
- Clarifications: 6 per round (a loop guard, not a talk limit)
- Replies: 1 per round
- Notes: 12000 characters each (`NOTE_TOO_LARGE`); 5 a minute per sender
  session, across recipients (`NOTE_RATE_LIMIT`); an identical note from the
  same sender is suppressed for 5 minutes (`NOTE_DUPLICATE`)
- Headless peers: 40-minute default timeout, 60-minute cap, killed by process
  tree
- Background headless peers: 4 concurrent runs per server process, including
  combined adapters; `MAGI_MAX_BACKGROUND` changes the cap on restart.
  `BACKGROUND_LIMIT` refuses excess work before launching it. Blocking calls
  are not charged to this cap. Server exit, stdin closure and SIGTERM kill
  tracked CLI children; POSIX runs own a process group so descendants die too.
- Output: 32 MB combined stdout/stderr cap, 80k character response cap

## Local only

Delivery stays on the machine: a named pipe or Unix socket for Claude; for
Codex, the `codex queue` CLI and, for steer, the desktop app's local tools
pipe; for omp, frames in the local `magi.db` that the session's own
extension reads. Nothing is relayed through a third party and no network
listener is opened. Socket access is limited to the operating-system user,
and on Windows every connection to a Claude inbox must present the session's
own token. On Windows the Codex steer pipe accepts any same-user process
(transport-recon.md, "Desktop steer channel").

### A worker on another machine

A request with `host` (architecture.md, "A headless worker on another
machine") runs a headless worker on a machine in `<MAGI_HOME>/remotes.json`,
over the operator's own ssh with `BatchMode=yes`, so it never prompts and
uses only the keys and agent the operator already set up. Magi still opens no
port: the listener is that machine's sshd, and whoever can ssh there as that
user can already do anything a worker could. What travels is this tree as a
git commit (HEAD plus uncommitted and untracked files; `.gitignore`d files
such as `.env` stay here) into a Magi-owned bare repo on the remote, the
request text over the ssh pipe, and the worker's changes back as a local
branch that nothing merges. The remote keeps that copy until seven days
after the card was last used there (a marker per card, never a commit's
date), then sweeps its worktree, its refs and the objects only they kept,
packed ones included; anything secret that git tracks goes with it until
then.

The worker runs with the same headless launch as here (review tools only, or
writes inside its worktree), built by the remote's own Magi. `allowCommands`
is refused on a remote: this server's launch wrapper contains workers on this
machine, and nothing here can vouch for containment there. The far end kills
the CLI's process tree when its input ends, after the same finish grace as
here, and at once when ssh goes away, so a dropped connection leaves no
worker running on its own.

A live session there (`host` with `peer`) is reached by `magi relay` on that
machine, which does four things and no others: list and pick that machine's
sessions, deliver Magi's own card frames into one after mirroring the card,
and push back the answers its sessions file for this machine. It reads no
transcript, starts no session and sends no free text, so the relay is not a
remote control for that machine's sessions. A note or an answer reaches only
the recorded worker of a card mirrored there for the calling machine, and a
request only with the card its envelope names. A relayed answer is applied here
as from the round's recorded worker (`identitySource: "ssh_relay"`): that
machine's Magi verified the session; this one trusts that machine as far as
its ssh login. The receiving session's own permissions apply unchanged, and
the sender's permission class in the envelope is the one this side resolved.

What decides reach is the operating-system user, not a harness account:
the relay runs as the ssh login and reaches only that user's sessions there
(the inbox socket, the Codex queue, the omp inbox are per user). A session
signed in to another Claude, OpenAI or provider account, even another
organization's, is reachable all the same, unlike a harness's own
cross-machine messaging, which needs the same account. What is sent to it
(the request, its files, the tree for a fresh worker) then goes to that
account's model provider under its terms, and its usage is that account's.
Magi records the worker by machine and session, never by account.

### Files

Files between machines are off unless the operator runs `magi files on`, on
each machine: off, a machine neither sends a file nor takes one in
(`FILES_OFF`), checked at each transfer, so turning it off also stops files
already attached to queued messages, and a copy cached there is not used.
The setting lives in that machine's ledger, not in any call,
and a headless worker cannot switch it. A file is sent with card traffic
(`files`; architecture.md, "Files on card traffic") only to a peer on another
machine; on one machine it is refused and the peer reads the path. It must be inside the sender's working directory
once links are resolved, a root the sender's side sets (a worker's is its own
session's, whatever directory its call names), so a prompt-injected worker
cannot be talked into sending `~/.ssh/id_ed25519` or `~/.aws/credentials`.
Only a regular file is read, through one open handle that does not block,
and its path is resolved again after, so a link swapped in while it is read
is caught. That bounds what a sender can name; it does not contain another
writer on the same machine that swaps a link in for the instant of the open
and back before the check. Its bytes are copied as they are: **message text is
redacted, files are not**. A file holding a secret goes as a secret, to the
receiver's machine, and its copy stays in each store until it is swept 30
days on. Copies are named by sha256 and checked on arrival and again before
reuse, so what a receiver reads is what was sent. A file is data for the
receiver, never something Magi opens or runs.

## The statusline hook reads what Claude hands it

`magi install --usage` edits `settings.json` once, with the user's own
command, to put `magi statusline` in front of the existing statusline.
The hook reads the JSON Claude gives every statusline (a documented input),
writes the parts `magi usage` and `magi peers` show to `magi.db`
(`usage-claude` records), and runs the original command with the same input.
It sends nothing anywhere, reads no credential, and calls no API of its own:
the windows it reports are the ones Claude already fetched for its own
`/usage`.

## No listening port

Magi opens no listening port. The web dashboard (`magi dashboard`, an HTTP
server on `127.0.0.1` that had to check Host and Origin against DNS
rebinding) was removed in 2026-10. The Claude Code mod that replaces it runs
`magi status --json` as a child process and reads its stdout; that output
carries only redacted one-line excerpts of requests, replies and notes, and
stays under 40 KB (`STATUS_MAX_BYTES` in `src/status.mjs`). A card's whole
conversation, which the deck reads when a card is opened, comes from
`magi exchange <id> --json`: redacted, each message cut at 12,000 characters
and the whole at 90,000.

## The SQLite ledger retains history

Task metadata, mailbox replies and outcomes are retained indefinitely in
`~/.magi/magi.db`. Closed cards' exchange `text`, `task` and `context` fields
are trimmed after 30 days, never before a redacted summary and its local
embedding are persisted. Outcome notes, metadata, verdicts and reply-coverage
evidence stay. Open cards and unchecked replies are not trimmed; failed
embeddings retain bodies. Sweep also removes stale usage, read notices, dead
workers/waiters/process frames. There is no seven-day expiry for database
ledger content.

Legacy state is imported only by explicit `magi migrate --home <state
directory>`. This decision follows an implicit migration that moved the live
ledger from a test. Opening the database or starting a server never
imports/deletes legacy files. Back up and stop old servers first. Usage and
statusline reads may inspect legacy files once as a read-only fallback.
CLI-readable copies of oversized requests and Codex queue bodies live under
`spill/`, removed after seven days by sweep. Uninstall preserves the state
tree; remove it yourself to forget retained history.

## Memory is model-written text, and it stays here

A memory unit is one claim an agent wrote, stored in `<MAGI_HOME>/magi.db`.
Bodies, tags and source/task metadata are redacted at persistence, including
explicit imports of legacy markdown. Body redaction precedes whitespace
normalization; card summaries redact complete fields before clipping them.
Nothing leaves the machine. When units come back they are rendered under a
`MEMORY` header that says they were written by agents and are evidence to
check, not instruction to follow, the same framing the protocol applies to
every peer body. `forget` deletes matching database rows and sent receipts.

## Notices are text for a human

A notice (`kind: "notify"`) is model-written text stored for the operator.
It is redacted like everything else on disk, capped like a note, never
delivered to any session, and shown only by `magi notices`, as text. Nothing
acts on it.

## The part that is not a published API

The Claude inbox frame format was determined empirically and is recorded in
[transport-recon.md](transport-recon.md). It is not a documented contract and
may change between Claude Code releases. A socket write can complete without
model receipt. Ambiguous delivery is reported without launching a duplicate
headless request. Permission holds or refusals must not be bypassed.
