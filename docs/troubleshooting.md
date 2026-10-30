# Troubleshooting

Start with `node bin/magi.mjs doctor`: it exits nonzero when a row reads
`FAIL`, and each row says what to fix. `node bin/magi.mjs log` shows what
actually happened: every task, how its last round ended (`replied`, `stale`,
`timed_out`, `delivery_failed` with the error code, `abandoned`, or `open`),
and the recorded outcome. Then find the symptom below. Every error the bridge
returns names its code and the next step; the [error codes](#error-codes) table
at the end is for looking one up.

## Doctor reports the database or stale workers

Doctor runs `PRAGMA quick_check` on `magi.db` before reading provider settings.
Corruption stops the database-dependent checks: stop Magi servers, restore a
known-good database backup and run `magi doctor` again. A busy database is not
corruption; leave it in place.

Doctor reports counts without sweeping them away:

- dead-PID waiters: run `magi sweep`;
- dead-PID or overdue workers: restart the server that owns them, then run
  `magi sweep`;
- questions unanswered for more than a day on open rounds: answer them, or
  `magi close --task <id>` for abandoned work.

Doctor's informational `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` line reports the
observed override, user `settings.json` env/`dialogExpiry`, or Claude's default
300000 ms (5 min; read in Claude Code 2.1.302). A held PEER message to Claude
is dropped after that deadline unless approved, which can look like a stalled
peer; `0`/`dialogExpiry: "never"` disables expiry. Forwarded permission/user
dialogs share it, but local-only prompts are unaffected. This is not a read of
a remote session's policy or environment, and no warning threshold is assumed.

A live Claude receipt still `unconfirmed` or `queued_unread` past the observed
timeout carries a short explanation in `magi status`, `magi peers`, card hints
and the `/magi` pane: it may have been held for approval there and dropped.
Ask the user to check/approve at that session, or resend after checking.
This is a possibility, not a native drop receipt: age never changes
`deliveryStatus`, and a `received` receipt is never downgraded. No clause is
shown for `never`/`0` or an unknown timeout; the receiver's own policy/env may
differ from the timeout observed by Magi.


## The tool does not appear in the harness

Restart the harness after installing; MCP servers are read at startup. Then
check the registration:

```bash
claude mcp list
grep -A6 "mcp_servers.magi" ~/.codex/config.toml
```

Doctor inspects Claude's user registration even when omp is absent. Set
`CLAUDE_CONFIG_DIR` to inspect the same configuration your harness uses: its
user registration is `.claude.json` inside that directory, whereas the default
is `~/.claude.json`. Re-run the relevant install after fixing unsafe config
syntax ([install.md](install.md#safe-configuration-updates)); `.bak` holds the
exact pre-write bytes.

Claude Code may also list `codex_peer` as a deferred tool until it is searched
for: the first call fails until its schema is loaded.

## A tool call dies at 60 seconds

On Codex, `tool_timeout_sec` is missing from the Codex MCP entry or below the
bridge's own cap. A blocking review waits up to forty minutes by default and
sixty at most; the Codex default aborts at one. Doctor reads only the active
`magi` table's `tool_timeout_sec`: a commented header, an old `magi-omp` table,
or an `.env` child table cannot make a bad timeout pass. Re-run `magi install
--codex`, or set it by hand from [mcp-config.md](mcp-config.md).

On any host, a quiet tool call may be given up on near 60 s. The bridge sends a
progress heartbeat every 10 s on a running call; if a host still aborts, raise
`MCP_TOOL_TIMEOUT` for Claude Code or `tool_timeout_sec` for Codex.

## omp: the tool call dies at 30 seconds

The `magi` entries are not in omp's own `~/.omp/agent/mcp.json`, or they are
there without `timeout: 0`. omp aborts any MCP request at 30 seconds unless the
server's own entry disables it, and only omp-owned config can; an entry it
imported from `~/.claude.json` cannot. Run `magi install --omp` and restart
omp. `doctor` reports both conditions.

## Every request goes headless; live delivery never happens

Look at the `via=` field in the reply footer: `live:<name>` or `headless`.
Then run `node bin/magi.mjs peers`. If the target side is empty:

- **No Codex threads**: the app-server may not be running, or no thread matches
  the working directory. Pass an explicit `peer` name or thread id. The
  listing shows addressable threads rather than confirmed-live ones, because
  liveness cannot be read from `thread/list`; only delivery confirms.
- **No Claude sessions**: sessions register on startup. A session in a container
  or under a different user cannot be reached, and neither can one started in
  bare mode, which binds no inbox.
- **No omp sessions**: see [omp: replies never arrive](#omp-replies-never-arrive-in-the-session).

If the request reads `via=live:<name>` but stays `unconfirmed` with no reply,
and Claude was upgraded recently, see the next entry.

## Live delivery to Claude stopped working after an upgrade

The inbox frame is a private format and can change in any Claude Code release.
The symptom is quiet: the socket still accepts the write, so nothing errors and
nothing falls back to headless (only a delivery error marked as never
dispatched does). The request reads `via=live:<name>`, but its
`deliveryStatus` stays `unconfirmed`, never `received`, because the Claude
transcript never records the message, and no reply arrives; a blocking request
times out. `doctor` prints a `warn` line whenever the installed CLI is
newer than the version in `VERIFIED_VERSIONS` in `src/install.mjs`; once a
newer release has been checked against the frame reference, bump that constant.

[transport-recon.md](transport-recon.md) has the full repair procedure: how to
find the handler in the client binary, how to reconstruct the frame, how to probe
it safely against your own session, and the dead ends worth skipping.

## A headless Codex peer seems unavailable

Headless Codex needs no live session and no desktop app, only `codex` on the
path and signed in: each run starts its own `codex app-server`, separate from
any other. Verified 2026-10-04 against codex-cli 0.155.1 on Windows with the
earlier `codex exec --json` launch: `codex_peer` with `delivery:"headless"`
returned a FACT_CHECK that read the repo. The app-server
worker that replaced it (2026-10-08) is checked offline only until a live run
is recorded here. The usual reasons it looks dead:

- **It returned at once with `deliveryStatus: "running"` and `via: "headless"`.**
  That is the default: the run is in the background and the reply arrives later
  as a `PEER REPLY` turn. Pass `wait: true` to block for it, or look in
  `magi log` / `magi mail`.
- **The tool is not loaded.** See [the tool does not appear](#the-tool-does-not-appear-in-the-harness).
- **`CLI_NOT_FOUND` or `AUTH_REQUIRED`.** Set `CODEX_BIN`, or run `codex login`.
  `CODEX_BIN points at /run/user/<uid>/fnm_multishells/...` means an older
  install recorded fnm's per-shell link, deleted with that shell; `magi doctor`
  fails it too. Close the harnesses, run `magi install`, restart them.
- **`PEER_FAILED: codex app-server refused thread/start` (or `turn/start`),
  `APPSERVER_TIMEOUT` or `PROTOCOL_ERROR`.** The installed Codex refused a
  parameter, stopped answering, or printed something that is not JSON-RPC.
  Set `MAGI_CODEX_WORKER_TRACE=<file>` in the Magi server's environment and
  run again; docs/transport-recon.md section 4 lists what is sent and expected.
- **The caller is itself a peer.** Inside a headless run `PEER_DEPTH=1` makes
  the bridge refuse (`RECURSION_BLOCKED`), by design.

`magi log` names the failing code for any run that did fail; the omp-side
`PEER_FAILED` entries there are a different peer.

## A headless run failed with `PEER_FAILED`

The text is the harness's own reported error first (omp's error events,
Claude's result text), then stderr. omp's `Warning: MCP server "..." failed to
connect ... its tools are unavailable for this run` lines are dropped from it:
the bridge's own servers exit inside a peer on purpose, so omp prints them on
every run, and until 2026-10-05 they were all a failed run reported (20 of 32
omp failures on 2026-10-02..04 read that way, omp 18.4.4). When nothing else
was captured the message says so; the cause is then in omp itself, so re-run
`omp -p` by hand with the same prompt. A Claude result that reported
`is_error` with subtype `success` used to read just "success"; it now carries
the result text.

## A spawned peer says it is not authenticated, but the CLI works

Codex does not forward the parent environment to MCP servers. If your auth
depends on an environment variable, add it to `env_vars` in the Codex MCP entry.

## The peer did the work but its reply never came back

Seen in a real cross-agent run: the request reached a live peer and it answered
in its own session, but the formal reply was refused because that session could
not call the bridge tool.

Two causes, both about the peer session rather than the bridge:

- **The session predates the install.** MCP servers are read at startup, so a
  session started before `magi install` has no bridge tool at all. Restart it.
- **The tool call needs approval that nobody gave.** An unattended or restricted
  session cannot answer a permission prompt. A denied call stays denied: the peer
  reports it and stops, and the fallback below does not get around it.

Every live request carries a fallback for a session where the tool is absent,
which needs no MCP permission:

```bash
node /path/to/Magi/bin/magi.mjs reply --task <task_id> --round <n> --from <claude|codex|omp> --file <path to the reply>
```

That files the reply through the same ledger, so the single-reply-per-round rule
still applies. `--text` works for short replies.

## omp: replies never arrive in the session

`peers` shows no omp session, so the inbox extension is not loaded: it is
missing from `~/.omp/agent/extensions/magi/`, or omp was not restarted after
install, or it was started with `--no-extensions`. The reply is not lost; it is
in the mailbox (`magi mail --task <id>`). A blocking request (`wait: true`)
never needed the extension in the first place.

## I asked for omp's advisor and saw no notes

Silence is the usual answer: the advisor speaks only on a concrete problem, and
most runs have none. To tell "nothing to say" from "not running":

1. The request must have gone **headless**, with a model that differs from the
   worker's. A live omp session keeps its own settings, and Magi's progress line
   (and `warning`, when the call does not wait) says `advisor not applied`. When
   `MAGI_OMP_ADVISOR=1` is the only thing asking and no different model was
   found, the reply says `advisor skipped (ADVISOR_...)` instead.
2. Find the worker's omp session (`thread_id` in the reply footer). With
   `--advisor` working, the session folder beside its `.jsonl` holds
   `__advisor.jsonl`, the advisor's own turns. Without it, the flag did not take
   effect: run `omp --help` and look for `--advisor`, and see
   `docs/transport-recon.md`, "The advisor".
3. If `__advisor.jsonl` exists but the reply shows no notes, the advisor reviewed
   and found nothing, or its review was still running when the worker finished
   and was dropped. A short run is the likelier case.
4. An advisor model that cannot be reached (no credentials for the provider in
   `modelRoles.advisor`) should not stall the worker (oh-my-pi's docs say a
   failing advisor never blocks it; not tested here) but gives no notes. Check
   `omp config get modelRoles` and `omp login`.

## A request stays `open` in the log

A task still `open` is a `wait: false` request whose reply never came. It
blocks nothing, since the next request gets a fresh task id. Check `peers`, the
peer's transcript and `magi mail --task <id>` first, since the reply may be
filed already; when you stop expecting it, `magi close --task <id>` marks it
abandoned so the log stops listing it as pending. A round with no reply after eight hours reads `stale`, and Magi closes it itself as `abandoned (STALE)` when a new card is opened.

## A note looked delivered but the peer never saw it

The sender is not told when a receiving Claude session holds a message for
approval or refuses it, because the bridge has no inbox of its own to receive
the status frame on. The socket accepting the frame is not proof the model read
it. A Claude session in `bypassPermissions` without `crossSessionInbound:
"accept"` holds every peer message and drops it five minutes later
([mcp-config.md](mcp-config.md)); `doctor` checks that setting. See
[parity.md](parity.md) for the full list of gaps like this.

Requests are unaffected in practice: a blocking request that is never answered
times out and says so.

## The review refers to code that has changed

By design. The diff hash pins the artifact. Re-run
`node bin/magi.mjs diff-hash` and compare with the `diff_sha256` in the reply
footer; if they differ, review the new diff rather than trusting the old pass.

## The `/magi` deck shows an error, or peer messages keep their protocol text

The mod runs `node <checkout>/bin/magi.mjs status --json` and says what went
wrong in red under the deck's header (the status line reads `Magi: status
unavailable (see /magi)`, or `(stale)` after an earlier success):

- **`magi status could not run (…)`**: `node` is not on the PATH Claude Code
  runs with, or the mod cannot find the checkout. Set the plugin's `checkout`
  option (`/config`) to the Magi folder, or re-run `magi install`, which
  writes `claude-mod/checkout.json`.
- **`magi status failed (exit N): …`**: the CLI's own error; run the same
  command in a terminal.
- **`… printed something this mod cannot read`**: the checkout and the cached
  mod are from different versions. Re-run `magi install`, which updates the
  cached copy, then `/reload-plugins`.

A peer message drawn with its protocol text, or drawn plain, says why in
`render-trace.json` beside the mod (the plugin's folder, or its cached copy):
its last 30 rows, each with the hook's decision, such as `plain: theme off`.
A row missing from it never reached the hook. How the mod is installed and
cached: [install.md](install.md#readable-peer-traffic-in-claude-code-the-magi-view-mod).

## `magi dashboard` prints the usage text

The web dashboard was removed in 2026-10; the command is unknown, so the CLI
prints its usage and exits 2. The view is the Claude Code mod's `/magi` deck,
and in a terminal `magi status`, `magi log`, `magi peers` and `magi mail`. A
browser tab still answering at `http://127.0.0.1:7355/` is a process started
before the upgrade: end the `node` process with `magi dashboard` in its command
line, or log out. `magi install` deletes its Windows login entry, so it does
not come back.

## Windows: a Codex peer receives a one-line instruction to read a file

Expected for npm `.cmd` Codex. Codex CLI 0.160.1's observed `queue --help`
offers `--message`, not a stdin/file argument, so Magi writes every peer
message to a durable, private `~/.magi/spill/<uuid>.queue.md` file and queues a
short one-line instruction to read it. Native Windows delivery uses the same
path when the complete encoded command line exceeds its 24,000 UTF-16-unit
budget, including the executable, thread, flags and quote/backslash expansion.
On other platforms the inline message limit is 24,000 characters.

These files are retained for seven days and swept independently of database
history, since the target may still be mid-turn when queue returns. Delete one
early only once the recipient has consumed it. Queue acceptance does not prove
that the live model read or acknowledged the full file. The checkout, spill
directory and selected CLI path must avoid shell-sensitive characters when
`.cmd` is used; otherwise `CMD_UNSAFE_ARGUMENT` explains the refusal. Spaces
alone are supported.

## Windows: paths, pipes and WSL

- npm-installed CLIs are `.cmd` shims. These are run through the command
  interpreter with a verbatim quoted command line, which is why paths with
  spaces work; a plain spawn would split them.
- The inbox is a named pipe and the auth line is mandatory, unlike macOS and
  Linux where it is optional; without the session's peer key delivery stops
  with `NO_PEER_KEY`.
- A session inside WSL 2 and a native Windows session cannot reach each other:
  different home directories, different socket types.

## Nothing works and you want out

```bash
node bin/magi.mjs uninstall
```

See [uninstall.md](uninstall.md).

## Error codes

| Code | Meaning | Fix |
|---|---|---|
| `CLI_NOT_FOUND` | the executable could not be located | set `CODEX_BIN`, `CLAUDE_BIN` or `OMP_BIN` to the full path |
| `EPHEMERAL_BIN` | install found a CLI only inside a per-shell folder (fnm's `fnm_multishells`, `$XDG_RUNTIME_DIR`) | set that `*_BIN` to the CLI's installed file outside it and re-run install; nothing was written |
| `AUTH_REQUIRED` | the peer CLI is not signed in | the message names the failing harness's own remedy: `codex login`; `claude` once, or `ANTHROPIC_API_KEY`; `omp login [provider]` or the provider's key variable (omp 18.4.4). On a remote Mac, a sign-in kept in the login Keychain may not be readable from an ssh session: usage.md, "Workers on another machine", macOS |
| `BAD_CONFIG` | an existing JSON file is invalid, Codex TOML uses forms the installer cannot safely edit, provider settings are malformed, or `MAGI_WORKER_WRAPPER` is not a JSON array argv whose first item is an absolute executable | fix JSON (including BOM/trailing commas); convert inline tables/dotted assignments/spaced headers/multiline strings to conventional TOML sections, or edit the MCP entry manually; the refused file is unchanged; for the wrapper, fix or unset it and restart the server |
| `COMMANDS_REQUIRE_WRAPPER` | a request asked for `allowCommands` on a server with no `MAGI_WORKER_WRAPPER` | send it without `allowCommands`, or have the operator configure a wrapper and restart the server (`docs/security.md`) |
| `UNKNOWN_HOST` | a request named a `host` that `<MAGI_HOME>/remotes.json` does not have | the message lists the configured ones; add the machine (usage.md, "Workers on another machine") or drop `host` |
| `REMOTE_UNREACHABLE` | ssh itself failed (exit 255): name, network, key or host key | run the `ssh -o BatchMode=yes <ssh args> true` the message names until it works without a prompt, then retry |
| `REMOTE_FAILED` | ssh worked but the remote Magi did not start a worker or a workspace step, or git could not push or fetch | the message carries the remote's stderr; check `node` and `magi` in `remotes.json` run there, and that `git` is on that machine's ssh `PATH`; a fetch that failed names the remote ref to fetch by hand |
| `REMOTE_VERSION` | the two machines' Magi speak different remote protocols | bring both to the same Magi (`REMOTE_PROTOCOL` in `src/remote.mjs`) |
| `FILES_OFF` | `files` on a message, or files sent to a machine, where files between machines are off (the default) | name a path both can read, or have the peer fetch it over ssh or scp; the operator runs `magi files on` on both machines if files should cross |
| `FILES_SETTING_REFUSED` | `magi files on` or `off` run from inside a peer worker | the operator runs it, in their own shell |
| `FILES_SAME_MACHINE` | `files` on a message whose receiver is on this machine | name the paths in the message; `files` is only for a peer on another machine that cannot reach the file itself |
| `ROUND_STALE` | an older round of a relayed card reached its mirror after a newer one | nothing to do: the newer round stands, and the late delivery was not mirrored |
| `FILE_NOT_FOUND` | a path in `files` does not exist | the message names where it looked; paths are relative to your working directory |
| `FILE_OUTSIDE_WORKTREE` | a path in `files`, once links are resolved, is outside your working directory | copy the file into the tree if it should go; nothing outside it is sent |
| `FILE_TOO_LARGE` / `FILES_TOO_MANY` | over 25 MB for a file, 50 MB for a message, or more than 20 files | commit it, share a link both sides reach, send fewer, or spread them over several messages |
| `FILE_CORRUPT` | a file arrived whose sha256 is not the one it was sent as | it was discarded; send the message again |
| `FILE_MISSING` | a message reached another machine before its files had | send it again; the relay pushes files first, so this means a push was cut short |
| `REMOTE_NEEDS_GIT` | a `host` request from a directory that is not in a git repository | run it from the repository, or drop `host` |
| `REGISTRATION_FAILED` | Claude rejected the isolated MCP add | check `CLAUDE_BIN`, run `claude mcp add --help`, fix the CLI error and retry; existing real registrations are retained and install exits nonzero |
| `CMD_UNSAFE_ARGUMENT` | a Windows `.cmd` argument contains `%`, `!`, newline, or NUL | use a native executable or a path/name without those characters; pass the message on whole, unescaped and untruncated |
| `LEDGER_BUSY` | another process holds the state lock | retry once it finishes |
| `PROVIDER_DISABLED` | the provider was turned off with `magi provider disable` | `magi provider enable <name>`, then restart the harness |
| `NO_LIVE_PEER` | no reachable live session | open and name one, or use `delivery: "headless"`; a named peer that missed lists the sessions that are listed, a close name first, so retry with one of those |
| `AMBIGUOUS_PEER` | several live sessions answer to that name | address one by its id or pid; for Codex, the thread UUID |
| `WORKER_FINISHING` | a note reached a headless worker that has already answered; its reply is being taken | send a follow-up request on the same taskId, which resumes the worker's thread with the point in it |
| `DELIVERY_FAILED` | the session socket refused or vanished, or the receiver rejected the request | check the session is still running; on `auto` a new request falls back to headless only when the session was unreachable before anything was sent |
| `NO_PEER_KEY` | no peer key for that Claude session (Windows) | the session exited, or belongs to another user or container |
| `NO_STEER_CHANNEL` | the Codex desktop app's tools pipe was not found | open the desktop app; if it is open, `doctor` warns and a desktop update moved the pipe (see `docs/transport-recon.md`, "Desktop steer channel") |
| `DAEMON_UNAVAILABLE` | an explicit remote Codex steer could not connect and initialize through `codex app-server proxy` | check the daemon and CLI on that machine, or send a queued note with `delivery:"live"`; Magi does not start a daemon or fall back automatically |
| `NO_ACTIVE_TURN` | the remote Codex thread has no in-progress turn to steer | send this as a note instead with `delivery:"live"` on its card (or retry the request explicitly as `live`); nothing was queued |
| `TURN_MISMATCH` | Codex's active turn changed between reading it and steering | inspect the new turn, then choose a note with `delivery:"live"` or a new explicit steer; Magi never refreshes and resends on its own |
| `TURN_NOT_STEERABLE` | Codex refused to steer a review or compact turn before submitting anything | send the same note explicitly with `delivery:"live"`; the definite refusal releases its note reservation and never queues automatically |
| `THREAD_NOT_LOADED` | the recorded Codex thread is not loaded in the remote's shared daemon | use the daemon that owns it, or send a queued note with `delivery:"live"`; do not resume the thread merely to observe it |
| `DAEMON_TIMEOUT` / `DAEMON_CLOSED` / `DAEMON_RPC` / `DAEMON_PROTOCOL` | a remote daemon call timed out, disconnected, failed or returned an invalid result | follow the dispatch warning: a steer may have landed, so inspect its history before retrying; no automatic queue fallback or resend |
| `STEER_TIMEOUT` | a steer was sent but not confirmed in time | it may have landed: check `peers` and the transcript before resending; a steered reply stays in `magi mail` |
| `TIMEOUT` | the peer did not finish in time (default 40 minutes) | narrow the task, or raise `timeoutMs` (cap 60 minutes) |
| `BACKGROUND_LIMIT` | the server's background headless allowance is full | wait for a run to finish, use `wait:true`, or raise `MAGI_MAX_BACKGROUND` (default 4) and restart the harness |
| `PEER_FAILED` | the headless peer ran and failed | [the PEER_FAILED entry](#a-headless-run-failed-with-peer_failed) |
| `OUTPUT_TOO_LARGE` | the peer exceeded the 32 MB stdout cap | narrow the request |
| `RECONCILE_FIRST` | more than three cards in your coordinator session have answered turns with no outcome | record `kind:"outcome"` on them (`magi exchange <task_id>` re-reads one); continuing an existing card is still allowed |
| `ADVISOR_UNSUPPORTED` | `advisor` was asked of a peer that is not omp | drop `advisor`, or send the request to `omp_peer`; `docs/usage.md`, "Having omp's advisor watch a delegated worker" |
| `ADVISOR_SAME_MODEL` | every advisor model available is the worker's own model, so none was started | add a different model to `MAGI_OMP_ADVISOR_MODELS` or omp's `modelRoles.advisor`, run the worker on another with `model`, or drop `advisor`; the request did not start and opened no card |
| `ADVISOR_NO_MODEL` | no advisor model is configured: the list is empty and `modelRoles.advisor` is unset or a role alias (`@slow`) | set one of them (`omp models ls` lists the names) and restart the harness |
| `ADVISOR_WORKER_UNKNOWN` | the worker's model cannot be told (no `model` on the request and no `modelRoles.default`, or the request resumes a session) | pass `model` on the request so the advisor can be compared with it |
| `CARD_FIXED` | a continuation changed the card's harness, mode or worker | keep its harness and mode, pass `peer` explicitly to switch worker, or open a new card without taskId |
| `RECURSION_BLOCKED` | a peer process tried to orchestrate | expected; the peer should reply, not request |
| `ROLE_VIOLATION` | the peer tried to open a round | expected; only the orchestrator opens rounds |
| `ROUNDS_EXHAUSTED` | the round cap was reached | raise `maxRounds` (hard cap 12) while evidence remains, or reconcile and report the disagreement as unresolved |
| `BAD_ROUND` | a round number that does not exist or skips one | continue with the taskId alone and let the engine assign the turn; `magi exchange <task_id>` lists the rounds |
| `ALREADY_REPLIED` | a second reply to one round | wait for the orchestrator to open the next round |
| `ALREADY_ANSWERED` | a second answer to one question | send a note to add to the answer |
| `CLARIFY_LIMIT` | a seventh question in one round | answer on your best reading and state the assumption |
| `UNKNOWN_TASK` | no such task id | replies must answer a request that was actually sent |
| `NOTE_RATE_LIMIT` | more than five notes a minute from one sender session, across recipients | batch them into one, or wait |
| `NOTE_DUPLICATE` | the same note was already sent recently, or is in flight | say something new, or nothing |
| `RELAY_EVENT_BUSY` | a relayed event is being applied by another call here | nothing: it is offered again; a claim whose call stopped renewing lapses within two minutes |
| `NOTE_TOO_LARGE` | a note over 12000 characters | send a request instead; it carries a diff and gets a reply |
| `BAD_REQUEST` | the call is malformed or asks for something the card, peer or mode cannot do (a bad field value, `allowCommands` without `allowWrites` or outside a headless `DELEGATE`, `host` on a peer that cannot run there), or a `magi` command got a bad argument | the message names the field and what to send instead |
| `CHANNEL_EXPIRED` | a live delegation card passed its 8-hour conversation window | record one `outcome` for its answered turns, then open a new card without `taskId` |
| `REPLY_FIRST` | you owe a reply on an open task to this counterparty and tried to open a new request to it | answer with `kind:"reply"` and that `taskId` first; clarifications and notes stay available |
| `ROUND_CLOSED` | a reply, question or answer for a round that already ended | stop; the orchestrator opens another round if it wants more, and `magi exchange <task_id>` shows what was said |
| `ROUND_PENDING` | a new round on a card whose last round is unanswered | wait for the reply, or `close` the round if you stopped expecting it |
| `NO_PENDING_QUESTION` | a `clarify_answer` with no open question, or after the round ended | wait for the worker to ask; send a note to add information |
| `NO_REPLY_ROUTE` | the originating session's address (or Codex thread id) was not recorded | the reply stays in the mailbox: `magi mail --task <id>` |
| `WORKER_CHANGED` | the card's recorded worker is no longer that session | list sessions with `kind:"peers"` and pass `peer` to move the next turn, or open a new card |
| `SELF_TARGET` / `AMBIGUOUS_ORIGIN` | an omp session asked to consult itself, or omp-to-omp routing without verified, distinct session identities | name a different registered session with `peer`; restart Magi from the registered omp session; leave `from` unset |
| `STEER_NEEDS_PEER` | `delivery:"steer"` to Codex without an explicit target | pass `peer` as the thread UUID or its exact name |
| `STEER_UNSUPPORTED` | `steerReply` (or a steer) toward a Claude session, which has no steer channel | omit it; a live Claude session reads messages between its own tool calls |
| `SPAWN_FAILED` | the new session or the desktop app's URL launcher did not start | the message carries the CLI's or launcher's error and the URL to open by hand; with `app`, check the app is installed (`doctor`) |
| `SPAWN_AMBIGUOUS` / `NAME_TAKEN` | several sessions carry the launch marker, or a live session already answers to the name | address the one you mean by id, or pick another `name` |
| `SPAWN_UNSUPPORTED` | `app` for a harness with no desktop app, or a claim for an omp session, which carries no marker | spawn without `app`; find an omp session with `kind:"peers"` by name |
| `STOPPED_BY_ORCHESTRATOR` / `CANCELLED` | the worker was stopped by `close` with `stop:true`, or the wait was cancelled | check any partial work and `magi mail --task <id>` before sending a new request |
| `EMPTY_REPLY` | a headless CLI finished without an assistant message | re-run the CLI by hand with the same prompt; see [the PEER_FAILED entry](#a-headless-run-failed-with-peer_failed) |
