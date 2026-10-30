# Usage

What a prompt triggers, and what happens underneath. You rarely call the tool
yourself: the skills decide when a peer is worth it and fill in the request.

How an agent conducts a card (turns, delivery, talking, reconciliation, the
reply format) is the protocol's to say, in `skills/PROTOCOL.md`. A section
here that rests on it names the protocol section as `PROTOCOL: <heading>`.

## Independent code review

> Ask Codex to independently review this implementation.

Claude reviews the change itself first, then sends Codex the diff with
`independence: true`, so Codex forms its own view without seeing Claude's
findings. Both reviews refer to the same SHA-256 diff hash. Claude then checks
each of Codex's findings against the source, fixes what holds, rejects what the
evidence disproves, and tells you which is which (PROTOCOL: Reconciliation).

When no live Codex is reachable the request runs a fresh headless Codex in the
background. Since 2026-09-17 that no longer freezes your session for the length
of the review: the call returns at once ("running in the background, up to 40
min", `deliveryStatus: "running"`), the run shows on the board as a headless
worker, and the reply arrives in Claude's session as a `PEER REPLY` turn when
it finishes, the same way a live peer's `wait: false` reply does. Claude
reconciles it then. If the run fails, a `PEER NOTE` says why and the round is
closed. `wait: true` returns the reply inline in the same call, for when the
answer is needed before the turn can go on.

## Adversarial design review

> Use Codex as an adversarial reviewer of this architecture.

`ADVERSARIAL_REVIEW` asks the peer to assume the design is wrong and find out
why: hidden assumptions, counterexamples, failure modes, security, operational
complexity, migration and rollback, and simpler alternatives.

Worth it before adding a dependency, changing a security boundary or public API,
altering a data model, introducing distributed behaviour, or any decision that
is expensive to undo. Where being wrong is expensive, ask both other harnesses
(Two views, below).

## Fact-checking

> Have Claude fact-check these claims before you answer.

The orchestrator verifies the important claims itself first, then asks the peer
to check them independently against primary sources. Each claim comes back as
`VERIFIED`, `FALSE`, `MISLEADING`, or `UNVERIFIED`, with a source and a
confidence (PROTOCOL: Reply format). Anything the parser cannot classify is
treated as `UNVERIFIED` rather than assumed true.

## Independent debugging

> Have Claude and Codex independently investigate this bug and reconcile.

The peer gets symptoms, logs, the relevant source, and how to reproduce, but
deliberately not the orchestrator's own diagnosis. It returns ranked hypotheses.
The orchestrator then tests where the two disagree, which is where the
information is.

## Delegation

> Delegate the test implementation to Codex, then review its changes.

**Every request is read-only unless it says otherwise.** A `DELEGATE` that should
edit files has to carry `allowWrites: true`. Without it the request reads
`write_policy=read-only` and tells the worker to change nothing on disk, so a task
meant as work comes back as a description of what the worker would have changed.
Magi says so when that happens: the result carries `[magi] DELEGATE went out
READ-ONLY (allowWrites was not set)`. `allowWrites: false` sends a `DELEGATE`
read-only on purpose, and then there is no notice. Only `DELEGATE` honours the
field; every other mode is read-only whatever it says.

The grant belongs to the card. Passing `true` on a later turn, which is the usual
repair for a card sent read-only by mistake, grants writes from then on, and
`false` narrows one turn. On a headless run the grant is also what the launch
enforces (omp `--approval-mode write`, Claude `--permission-mode acceptEdits`,
Codex `workspace-write`); a live peer is told, and its own session permissions
still apply. Most `DELEGATE` cards in a real ledger carry no grant (504 of 644
in one), so read-only is the common case.

Delegation returns immediately by default (`wait: true` blocks). Peer-written
code gets reviewed like anyone else's.

> Delegate the clippy fixes to omp; it may run cargo fmt and the focused tests.

A headless worker edits but runs no shell command, since nobody can answer
its permission prompt. On a server whose operator set a launch wrapper
(`MAGI_WORKER_WRAPPER`, the worker's sandbox; `docs/security.md`), a new
headless `DELEGATE` with `allowWrites: true` may run commands without being
asked: omp with `--approval-mode yolo`, Claude with
`--permission-mode bypassPermissions`, Codex unchanged. The result says so
in a `[magi]` line; `allowCommands: false` withholds them. Since 2026-10-21:
before, the coordinator had to pass `allowCommands: true`, and it almost
never did (1 of 158 write-granted DELEGATE cards over the two weeks before),
while dozens of replies said their tests could not run because `bash`
needed an approval nobody could give. A continuation keeps the grant;
`allowCommands: false` narrows one turn. An explicit `allowCommands: true`
without a wrapper, in a review mode, without `allowWrites` or toward a live
session is refused, so it never runs with less than was asked without saying
so; left unset in those cases, the request goes out without commands.
`magi log` shows `commands=N rounds` on such a card and `magi exchange` marks
each request `with shell commands allowed` (PROTOCOL: Request fields).

A live `DELEGATE` card is a conversation, not a single turn: it can run past
twelve turns, but it expires eight hours after it opened; reconcile it then and
open a new card. The engine-only `PARALLEL` mode has the same window. Reviews
keep the small loop guard (PROTOCOL: Turns).

### Continuing a card

```
kind:   "request"
taskId: "magi-1a2b3c4d"
task:   "Now handle expiry using the interface we just checked."
```

The engine assigns the next turn; the orchestrator does not track `round` or
`maxRounds`. Mode and peer harness stay fixed, and the request goes to the
recorded worker; pass `peer` only to deliberately select another session in
the same harness. On a continuation, `persist` or a differing `resumeThreadId`
without an explicit `peer` returns `CARD_FIXED` without opening a turn, and so
does a different mode or harness, which needs a new card without taskId.

The worker gets the full protocol preamble once per coordinator/worker pair and
a compact `PEER TURN` after that; when the full one is sent again is in
PROTOCOL: Turns.

### Talking on a card

```
kind:   "note"
taskId: "magi-1a2b3c4d"
body:   "The interface now returns an expiry timestamp; use that version."
```

The note is recorded in the card's exchange, not counted as a reply or a
verdict, and steered automatically to a working worker when its harness
supports steer. It targets the recorded session or alias, not another process
that later reuses its pid. Without taskId, a note is independent session
conversation. A delivered note whose accounting or exchange record then fails
returns a warning: inspect the exchange and do not resend it. Budgets and
refusals: Just telling the peer something, below.

### A worker asks a question

A live worker can ask `kind: "clarify"` on its task and round; Magi returns its
`questionId` and tells it to go on with work that does not depend on the
answer. The coordinator receives the question inline on a blocking request, or
as a `PEER QUESTION` turn on an async one. Questions have their own database
records and mailbox slots; they never replace the final reply. If a waiter
exits before taking a question, Magi delivers that question out of band rather
than leaving it stranded. Six questions per round is the loop guard
(`CLARIFY_LIMIT` on the seventh).

The coordinator answers once with `kind: "clarify_answer"`, `taskId`,
`questionId` (copied from the frame's `question_id`) and `body`. How the answer
is delivered, what `delivery` and `deliveryStatus` report, and the
`BAD_REQUEST` and `ALREADY_ANSWERED` refusals are in PROTOCOL: Talking.

Live Claude delivery receipts that remain `unconfirmed` or `queued_unread`
past the dialog timeout observed by Magi add one short clause to `magi status`,
`magi peers`, the card's next/status text and the `/magi` pane: the message may
have been held for approval at that session and dropped after that many
minutes; ask the user to check/approve there, or resend after checking.
The receipt's status is unchanged by age, and real consumption evidence
removes the clause. `never`/`0` disables it. This uses the same environment
and user-settings observation as `magi doctor`, not a read of the recipient's
actual policy or proof of expiry (troubleshooting.md, the dialog-timeout line).


## Workers on another machine

> Delegate the flaky-test fix to omp on devbox.

```
kind:        "request"
mode:        "DELEGATE"
allowWrites: true
host:        "devbox"
task:        "Fix the race in test/ledger-busy.test.mjs; run nothing."
```

`host` runs a fresh headless worker on a machine named in
`<MAGI_HOME>/remotes.json`, over your own ssh, and everything else stays
here: the card, notes into the running worker, the advisor, timeouts, the
reply arriving as a PEER REPLY turn when the request did not wait, outcomes,
memory, `magi status` and the deck. The worker gets a copy of this tree
(HEAD plus uncommitted and untracked files; ignored files stay here) in a
worktree on that machine. What it changes comes back as the local branch
`magi/<taskId>`, named under its reply with the files and the `git diff` to
review; your working tree and current branch are not touched. A continuation
on the card goes back to the same machine and the same worktree, so the
worker keeps its own edits; naming another host is `CARD_FIXED`. A read-only
mode runs on the copy and brings nothing back.

> Ask the omp session on devbox that is already in the parser work to review it.

```
kind: "peers"
host: "devbox"
```

then

```
kind: "request"
mode: "REVIEW"
host: "devbox"
peer: "<name or id from the listing>"
task: "Review the parser change on your branch."
```

With `peer`, `host` reaches a **live session on that machine** instead: one
that keeps its own context and works its own checkout there. It takes part
in the card exactly as a session here would. It gets the request, notes
while it works and the answers to its questions; its reply and its questions
come back as PEER REPLY and PEER QUESTION turns; a review blocks for the
reply unless `wait:false`. Its edits stay on its machine. The request tells
it so, and asks it to say where they are, ideally a commit or branch. A file
it attaches to its reply comes here ("Sending files to another machine" below). Only card
traffic crosses: Magi does not read that session's transcript, start
sessions there or type into one. `kind:"peers"` with `host` lists that
machine's sessions, and a worker row reads "<its name> on devbox". The relay
brings back the recorded worker's state for status; without a fresh observation
it says "not seen lately", not gone. For Codex it first asks that machine's
shared app-server daemon; approval and input waits are visible there.

Not yet on a remote: `allowCommands` (this server's launch wrapper contains
workers here, not there) and `persist`. Explicit `delivery:"steer"` works for a
live Codex worker loaded in that machine's shared daemon; Claude and omp still
refuse it. An absent daemon or idle/unloaded/mismatched turn is an error, not a
queue fallback: choose a note with `delivery:"live"` instead. This daemon route
is offline tested, not yet run live. All three harnesses run there if that
machine has them signed in.

**Setting a machine up.** It needs sshd that this user reaches without a
prompt (`ssh -o BatchMode=yes <host> true` succeeds), Node 22, git, a Magi
checkout at the same remote protocol (`REMOTE_PROTOCOL` in `src/remote.mjs`)
with its `node_modules`, and the harness CLIs signed in there. No `magi
install` is needed on it. Then one entry per machine:

```json
{
  "devbox": { "ssh": ["<user>@devbox"], "node": "/home/<user>/.local/bin/node",
               "magi": "/home/<user>/projects/Magi/bin/magi.mjs",
               "path": ["/home/<user>/.local/bin", "/home/<user>/.cargo/bin"] },
  "macbook": { "ssh": ["<user>@macbook.local"], "node": "/opt/homebrew/bin/node",
               "magi": "/Users/<user>/projects/Magi/bin/magi.mjs",
               "path": ["/opt/homebrew/bin", "/Users/<user>/.local/bin"] },
  "winbox":  { "ssh": ["winbox"], "shell": "powershell",
               "node": "C:\\Program Files\\nodejs\\node.exe",
               "magi": "C:\\Users\\<user>\\Magi\\bin\\magi.mjs",
               "path": ["C:\\Users\\<user>\\.local\\bin", "C:\\Users\\<user>\\AppData\\Local\\omp"] }
}
```

- `ssh` is the argv after `ssh`: a `~/.ssh/config` alias, or options then
  the destination last. git reaches the machine through the same argv.
- `node` and `magi` are absolute paths on that machine. A non-interactive
  ssh command gets a short `PATH` on every platform, so the CLIs are found
  through what `magi install` recorded there: it pins each CLI's path into
  the harness configs and also into `<MAGI_HOME>/bins.json`, which `magi
  worker`, `magi relay` and `magi doctor` read when `PATH` lacks the CLI. On
  a machine where install has run, `path` is optional; it puts directories
  first on `PATH` for the rest (a codex npm shim needs its `node` beside it).
- **Linux:** `shell` defaults to `posix`. Checked on devbox (Ubuntu 24.04),
  2026-10-16.
- **macOS:** turn on Remote Login (System Settings, General, Sharing). sshd
  runs commands with `/usr/bin:/bin:/usr/sbin:/sbin`, so `node` names its
  file in full, and the CLIs are found through `bins.json` (above). Seen on a
  fresh Apple-silicon Mac, Darwin 27.0.1: node under a tool's own prefix
  (`~/.toolbox/node/bin`, linked from `~/.local/bin`), codex as an npm shim in
  that prefix, omp from `bun install -g` in `~/.bun/bin`, claude in
  `~/.local/bin`; none on the ssh `PATH`. `/usr/bin/git` is Apple's shim and
  needs the Command Line Tools (`xcode-select --install`), or it stops at a
  dialog nobody can answer over ssh. `shell` is `posix`.
  **A headless worker needs a sign-in its ssh session can read.** A CLI
  started by an ssh command may not be able to read, or prompt for, a
  sign-in kept in the login Keychain, and then ends `AUTH_REQUIRED` though
  it works in a Terminal on that Mac. That much is untested: on the one Mac
  tried (2026-10-16), `security show-keychain-info` on the login keychain
  said "User interaction is not allowed" over ssh, but `claude auth status`
  and `codex login status` read signed out on its desktop too, so the CLIs
  were simply never signed in. Check what each CLI reports, over ssh and on
  the desktop, before deciding why (`claude auth status`, `codex login status`), then
  sign it in for ssh use, on that Mac, as its owner:
  - Codex: set `cli_auth_credentials_store = "file"` in that Mac's
    `config.toml` (`~/.codex`, or `$CODEX_HOME`), which the login and every
    worker both read, then run `codex login --device-auth` over ssh. Device
    sign-in must be allowed for the account. It replaces the CLI's current
    sign-in, and the resulting `auth.json` is a password; keep it private.
  - Claude: `claude setup-token` prints a long-lived (one-year) token for a
    subscription; it must reach the worker as `CLAUDE_CODE_OAUTH_TOKEN` in
    the environment the ssh command runs with. On an account whose shell
    is zsh with the default startup directory (that Mac's), that is
    `~/.zshenv`, which every zsh on the account also reads: every process
    started from one inherits the token. If you take that trade, keep the
    file mode 600 and out of dotfile sync, and revoke the token when the
    machine stops being a worker. ponytail: a per-remote secret Magi hands
    only to the worker process would be the narrower route. Avoid
    `ANTHROPIC_API_KEY` for this: where it is set it takes precedence over
    the subscription in `-p` runs, so every headless Claude there moves to
    API billing.
  - omp: having no model is configuration, not the Keychain: sign in with
    `omp login <provider>` (omp keeps it in its own store) or choose a
    model, then check with `omp -p "say ok"` over ssh.
  What matters is how the process was started, not live or headless: a
  session started from that Mac's own desktop login is signed in as usual
  (that is how live sessions there are reached, through the relay); one
  started over ssh has the same question.
- **Windows:** install OpenSSH Server (Settings, System, Optional features)
  and set its `DefaultShell` to PowerShell
  (`HKLM\SOFTWARE\OpenSSH\DefaultShell`); `shell` is `powershell`. cmd.exe
  will not do: git's transport single-quotes the repository path, which
  cmd.exe keeps as part of the path. `git` must be on the system `PATH` (Git
  for Windows' "Git from the command line" option). Not yet run on Windows
  as the remote.

`magi status` and the deck's Remotes panel list each configured machine
with its running workers and the open cards routed to it; a worker row reads
"headless omp on devbox". Nothing in status reaches over ssh, so a machine
that is down costs it nothing; the next request to it fails with
`REMOTE_UNREACHABLE`. Worktrees on the remote live under its
`<MAGI_HOME>/remote/work/` and are swept after seven days.

A live session on that machine answers through its own Magi server, so that
machine's installed Magi must be one with the relay (`magi relay`, this
remote protocol); a session started before the install keeps the old server
until it restarts. `home` in an entry names the `MAGI_HOME` the remote's
Magi uses for this work, when it is not that user's default; its sessions
must run with the same one.

## Sending files to another machine

> Send the omp session on devbox the failing fixture; it has no copy of this
> checkout.

```
kind:  "request"
host:  "devbox"
peer:  "<the session there>"
task:  "Why does the parser reject this fixture?"
files: ["test/fixtures/empty-case.json"]
```

Files between machines are **off by default**. The operator turns them on
for one machine at a time:

```bash
magi files on
```

Both ends need it on: a machine with it off refuses to send (`FILES_OFF`)
and takes nothing sent to it. A reply that arrives with files where they are
off still lands, saying its files stayed on the other machine. `magi files`
shows the setting, `magi files off` turns it off, and `magi status --json`
and `magi doctor` report it. It is a setting in that machine's ledger, never
an argument a call can pass, and `magi files on` refuses to run inside a
peer worker Magi started (`FILES_SETTING_REFUSED`).

`files` is for one case: a peer on another machine that cannot reach the
file itself. It is the last resort. On one machine a peer reads a file where
it is, so `files` is refused there (`FILES_SAME_MACHINE`): name the path in
the message. Across machines a path both machines can read, or the peer
fetching it over ssh or scp, comes before it. A fresh worker on another
machine already gets your whole tree (uncommitted and untracked files
included) and returns its code as the branch `magi/<taskId>`, so `files` is
for what is outside the tree, or for a live session there working its own
checkout: a spec, a fixture, a log, a report, a screenshot.

It takes up to 20 paths inside your working directory, at most 25 MB each, on
a request, note, reply, question or answer. Magi copies each file when you
send it into `<MAGI_HOME>/artifacts/blobs/<sha256>`, and the files cross to
the other machine before the message, over the same ssh as the card. That
machine keeps a file only when its sha256 matches, and checks a copy it
already had before reusing it. The message ends with a FILES block: each
file's name in your tree (as a quoted string), its size, its sha256 and a
path on the receiver's own machine. A reply's files come back the same way
and are checked here before the reply arrives.

A file outside your working directory is refused (`FILE_OUTSIDE_WORKTREE`),
links included, so nothing can be sent from `~/.ssh` by a path that only
looks local; a worker's working directory is its own session's, whatever
`workingDirectory` its call names. A worker on a read-only card can send
files it already has, but writing a new one is a write; one checked live
correctly asked before creating one. Copies are swept 30 days after they
were sent; the card keeps each file's name, size and hash.

## Parallel work

> Research this and have the other model verify the important claims.

Concurrent work goes out as `DELEGATE` with `wait: false`: each call returns
once its request is delivered, both sides run at once, and the replies come
back as `PEER REPLY` turns. The orchestrator merges the results and remains
responsible for them. `PARALLEL`, which splits the work and returns at once, is
retained in the engine for non-tool callers but is not an MCP mode.

The same holds for several reviews at once: set `wait: false` on each. Claude
Code runs Magi tool calls one after another, never in parallel, so a live
review that waits for its reply holds the calls after it unsent. Seen in the
ledger: on 2026-10-10 an omp request called five seconds after a Codex one was
sent only when the Codex call returned, five minutes later; on 2026-10-12 (UTC)
six parallel review calls left one request delivered and five unsent four
minutes on. PROTOCOL: Request fields (`wait`).

## Two views

> Get Codex's and omp's take on this migration plan.

For a decision that is expensive to undo, the orchestrator writes its own
answer down, then sends the same independent request to both other harnesses
itself, as two cards. Neither peer is told the other is asked or asked to
consult the other. The orchestrator reconciles each reply against the source,
treats their agreement as no evidence, and reports where they differed.
Headless workers cannot consult anyone (`RECURSION_BLOCKED`); a live session
may bring in the third harness for its own answer. PROTOCOL: Two views.

## Debate

`DEBATE` is retained in the engine, not exposed by peer tools. Tool callers use
`SECOND_OPINION` or `REVIEW` and continue the card with `taskId` and
`counterpartyClaims`.

Escalate only when a real disagreement survives the evidence. Round 1 is
independent on both sides. In round 2 each side receives the other's claims and
evidence via `counterpartyClaims`. The orchestrator verifies the disputed points
and reconciles one card. DEBATE defaults to six turns, with a hard loop guard of
twelve; the engine assigns continuation turns. When the guard runs out,
whatever is still open is reported as open.

## Blind bake-off

> Have Codex and you each implement this independently, then judge both blind.

For a hard bug or an algorithm where two attempts beat one. The orchestrator
records the base commit, makes two neutrally named worktrees, implements in one
and delegates the same task to the peer in the other without sharing its
approach; both judge A against B with authorship withheld and return a
`VERDICT`. Where the two verdicts disagree, that disagreement is the finding.
The steps are PROTOCOL: Blind bake-off.

Peer tools expose neither `mode: BAKEOFF` nor the `bakeoff` field; non-tool
engine callers can still send `mode: BAKEOFF` with `bakeoff: { a, b, base }`.
The bridge then diffs each worktree whole against the base, untracked files
included, hashes both, and labels them A and B. `base` matters: a delegated
peer may commit in its worktree, and without the base its implementation would
diff to nothing against its own HEAD. The reply footer carries both hashes as
`bakeoff=A:<12>,B:<12>`.

## Recording what reconciliation decided

The reply proves the peer answered. Whether it was right is a separate fact,
and it is the one the whole design rests on, so the orchestrator records it as
the last reconciliation step (PROTOCOL: Reconciliation), once per card for all
its answered turns:

```
kind:     "outcome"
taskId:   "magi-1a2b3c4d"
accepted: 2
rejected: 1
open:     1
body:     "off-by-one held; the perf claim did not reproduce"
```

New task IDs are `magi-` followed by eight hexadecimal characters. Task
IDs from an older install, with a different prefix, remain valid for replies,
outcomes, follow-up rounds, and closing; use the ID from the original request
rather than changing its prefix.

Only the orchestrator of a task can record its outcome, and the notes are
redacted like everything else on disk. `magi log` then shows every task with
its mode, who asked whom, how the round ended, what a headless run cost
(`$0.12`, from the CLI's own accounting; Codex reports tokens but no price),
and the outcome, plus a tally of how often peer findings held up once settled
and the total peer spend and tokens. Without outcomes the log still shows the
rounds; it just cannot say whether the peer was worth asking.

Reconciliation is enforced. Every successful result names the unreconciled
cards in your coordinator session, across directories. Debt counts cards, not
individual replies. More than three outstanding cards (the fourth) hold new
requests with `RECONCILE_FIRST` until outcomes are recorded; continuing a card
with its taskId is not held. `magi exchange <task_id>` prints a card's turns to
check. `open` honestly covers claims you did not check. A verdict covers the
turns answered when it was recorded: a later answer, including a late reply to
an older turn, makes the same card owe an updated outcome rather than a second
debt item. A reply unchecked for 24 hours expires without a verdict, which
lifts the hold without confirming a finding.

## A peer that remembers the project

> Keep working with the same Codex reviewer on this migration.

A headless peer normally starts cold every time, which is wasteful on a long
project and forces the peer to re-learn the work on every request. `persist`
gives the orchestrator a long-lived peer of its own:

```
persist: "migration-reviewer"
task:    "Continue the review; here is what changed since last time"
```

The first request under a name creates a headless session and records the
session it produced. Every later request with that name resumes it, so context
accumulates. Nobody has to open a session by hand for the agent to talk to.

The name is scoped to the agent, the harness it is aimed at and the working
directory, so the same name in another project, or aimed at omp instead of
Codex, is a different peer, and a session is never resumed into the wrong tree
or the wrong harness. A persistent peer saved before the harness was part of
its key has no recorded harness and is not resumed; the first request under
that name starts a fresh session. `persist` implies headless delivery, because
the point is the caller's own durable session rather than whichever live peer
happens to exist; an explicit `resumeThreadId` still wins. It is not a session
in the Claude or Codex desktop app and does not appear there.

Weigh it against independence: a peer that has absorbed your framing over many
turns is no longer an independent reviewer, so omit `persist` when a genuinely
cold first pass is the point (PROTOCOL: Independence decays).

## From a third harness

> (in omp) Ask Claude to review this change, and Codex to fact-check the claims.

Once `install --omp` has run and omp is restarted, `claude_peer`, `codex_peer`
and `omp_peer` are there under omp's own name: the ledger records `omp` as
the orchestrator, the peer is told
`orchestrator=omp`, and a reply, note or clarifying question comes back as a
user turn in the omp session through the inbox extension. `magi log` shows
`omp->claude`, `omp->codex` and `omp->omp` rows like any other. The skills load from
omp's own skill directory, so the reconciliation and outcome steps apply
unchanged (PROTOCOL: If you are neither Claude nor Codex).

## Consulting omp

> Ask omp to independently review this implementation.

Claude, Codex and omp reach another omp session through `omp_peer`, with the
same modes, fields and reconciliation. A live omp session in the working
directory gets the request through its inbox and answers with the reply tool
named in the request; with
none reachable a fresh `omp --mode rpc` runs with read-only tools, no
extensions and no skills. `delivery: "steer"` interrupts a busy omp session's current turn
instead of waiting for its next step boundary. Since omp runs whatever model it
is configured for, this is also how a third model joins a bake-off or a
fact-check without any other change.

From omp, choose a distinct registered session with `peer` when targeting a
particular worker. Both sessions stay labeled `omp`; verified session
identities determine their roles, and self-targets or ambiguous roles are
refused. The receiving omp uses `omp_peer kind:"reply"` with the request's
`taskId` and `round` to answer an omp orchestrator, not a new request.
If `omp_peer` is missing, reinstall with `magi install --omp` and restart omp.
This installation and protocol support is not a claim of a verified live
OMP-to-OMP round trip.

> Have Codex fact-check this on a specific model (name it as Codex does).

`model` on a request names the model a headless peer runs, passed as the
harness's own setting (`claude --model` and `omp --model`, checked against
Claude 2.1.263 and omp 18.1.19; Codex's `thread/start`/`thread/resume`
`model`, not yet run live, where `codex exec -m` was checked against 0.153.4).
It applies only when the request goes headless: a live session runs whatever
its human picked, and the bridge does not change that. Pair it with
`delivery: "headless"` when the model is the point, or the request may land in
a live session instead.

## Having omp's advisor watch a delegated worker

> Delegate the rename to omp with its advisor on.

omp can run a second model beside a worker. It reads each turn, checks what it
doubts with read-only tools, and speaks only when it finds a concrete problem:
a read that skipped the part that mattered, work heading somewhere the task did
not ask for, a claim the transcript does not back. Its notes go to the worker
while it runs, and the worker can change course. Magi switches this on with
`advisor: true` on an `omp_peer` request that runs headless:

```
omp_peer  task: "Rename the config loader and update every caller"
          mode: DELEGATE  allowWrites: true  delivery: "headless"  advisor: true
```

What you see afterwards, under the reply:

```
[magi] omp's advisor sent the worker 1 note during this run. They are its view, not verdicts; check what matters against the source.
  - concern: config-notes.md holds two max_attempts values: 3 (## Defaults, line 4) and 7 (## Retry policy, line 168)...
```

The same notes are `advice` on the result and an `advice` row in the card's
exchange (`magi exchange <task_id>`). The worker's reply is stored unchanged.
They are another model's view, so they go through reconciliation like any
finding.

- **No notes** means the advisor saw nothing worth saying. It is quiet most of
  the time, and it does not mean the worker is right.
- **It steers a run in flight.** A review still running when the worker
  finishes is dropped, so it does not check the final answer. It suits long or
  wide delegations, where a wrong turn costs minutes; a short review does not
  need it.
- **It is always a different model from the worker's.** An advisor on the same
  model shares its blind spots, so Magi never starts one. It takes the first
  candidate that is a different model, a different vendor first, and the reply
  says which model watched (`omp's advisor ran on openrouter/deepseek/... (a
  different vendor from the worker's openai-codex/<worker-model>)`). The worker is
  the request's `model`, else your omp `modelRoles.default`; the candidates are
  `MAGI_OMP_ADVISOR_MODELS` (an ordered, comma-separated list on the server)
  and then your omp `modelRoles.advisor`. When none differs, an explicit
  `advisor: true` is refused before any work starts (`ADVISOR_SAME_MODEL`,
  `ADVISOR_NO_MODEL`, or `ADVISOR_WORKER_UNKNOWN` when the request resumes a
  session and names no `model`), and a server default quietly skips the advisor
  and says so.
- **It costs a second model per turn,** on the advisor model chosen above. Three
  small turns cost under half a cent on DeepSeek flash (docs/transport-recon.md).
- **Headless only.** A live omp session keeps its own settings, so `advisor:
  true` to one is not applied and Magi says so. Claude and Codex have no
  advisor (`ADVISOR_UNSUPPORTED`).
- **Make it the default** for every headless omp worker by setting
  `MAGI_OMP_ADVISOR=1` on the server and restarting the harness (the table in
  [install.md](install.md#environment)); `advisor: false` turns it off for one
  request.

Every headless omp worker gets a temporary `--config` overlay, with or without
the advisor. It disables Magi's `mcp:magi`, `mcp:magi-codex` and `mcp:magi-omp` servers before
startup, so the worker does not call back into its bridge. Overlays replace
arrays, so Magi first asks `omp config get disabledExtensions` in the worker's
directory and writes the union with the user's effective list. An unreadable
list refuses the launch with `OMP_CONFIG_READ_FAILED`, the config paths and a
repair command; Magi does not guess an empty list and re-enable extensions.

**Advisor catch-up, operator only.** `magi advisor-sync` shows the setting;
`magi advisor-sync off|1|3|5|strict` sets it in this machine's Magi ledger.
`magi advisor-sync default` clears the override. It is never a peer-tool
argument, and a headless peer cannot change it. On a remote worker, set it on
the machine that starts that worker, using its Magi home.

The overlay writes `advisor.syncBacklog` as a quoted string only when this
operator setting exists; otherwise it leaves the key unwritten, preserving
omp's own configuration (its default is `"off"`). `"1"`, `"3"` and `"5"` are
backlog thresholds with a 30-second wait cap, not a promise that every review
finishes first. `"strict"` has no wall-clock cap but releases on abort or
failure. None guarantees advice before the final answer. This does not turn
the advisor on: `advisor: true` or the server default still decides that.

omp's advisor can also be told what to watch for in a `WATCHDOG.md` (oh-my-pi's
`docs/advisor-watchdog.md`). Magi has not checked that a headless worker's
advisor reads it. The skill for all of this is `omp-advisor`, installed beside
`peer-omp`; the rules agents follow are PROTOCOL: Advisor.

## Starting a peer

> Spawn a Claude called reviewer in this repo and have it review the diff.

`kind: "spawn"` with `name` (and optionally `workingDirectory`,
`permissionMode`, `model`) starts a live, named session that every agent
can then address with `peer: "reviewer"`. Claude is started as a background
session (`claude --bg --name`) and, with Windows Terminal on PATH, opened as a
tab titled `claude:reviewer` in one window named `magi`; Codex and omp
open directly as tabs there. A directory that does not exist is created and
`git init`ed first, so a brand-new project starts from a spawn. The session
runs with the user's normal permissions unless a mode is named; the bridge
adds no `--dangerously-*` flag of its own. Spawning is for when the user asks
for a session; an agent never spawns to satisfy a request, since headless is
that fallback (PROTOCOL: Starting a peer).

```bash
node bin/magi.mjs spawn claude --name reviewer --cwd E:/repo --model opus
node bin/magi.mjs spawn codex --name impl --permission-mode workspace-write
```

Verified 2026-09-14 with claude 2.1.263 on Windows 11: `magi spawn claude
--name reviewer7 --model opus` registered within 3 s, opened the attach tab,
and answered a `SECOND_OPINION` request live (`via=live:reviewer7`). Two
things learned on the way: a plain `claude --name` started directly in a
`wt` tab never registered, which is why Claude goes through `--bg` and
`attach`; and a session whose model has no usage credits receives the request
and fails it silently, so pass `model` when the CLI default is not one you
can run.

### In the desktop app

> Open a Claude session for this in the app so I can work with it there.

`app: true` (CLI `--app`) opens the session in the harness's desktop app
instead of a terminal: the Claude Code app or the Codex app, on the folder,
with a bootstrap prompt prefilled in the composer. Neither app sends on its
own, so the human presses Enter; the app then starts the session (Claude:
in a worktree it makes under the folder) and it registers like any other.

```bash
node bin/magi.mjs spawn claude --name gui1 --app --cwd E:/repo
node bin/magi.mjs spawn codex --name gui2 --app --cwd E:/repo
```

Three outcomes, on the CLI and the tool alike:

- **ready**: the session was claimed and is addressed by its observed name
  (a Claude app session is titled by the app, not by `--name`; when it has
  no name yet the result says to address it by id), with `appLink`, the
  `claude://` / `codex://` link that opens it in the app;
- **pending** (not an error; exit 0): the app is open with the prompt
  ready and nothing was claimed within 30 s. The result carries a `spawnId`
  and says what to do: send the prompt if it is still in the composer, then
  `magi spawn <harness> --name <n> --cwd <dir> --resume <spawnId>` (or
  `kind:"spawn"` with `spawnId` and `workingDirectory`), which claims the
  session without launching anything. Pending replaced the old
  `SPAWN_TIMEOUT` error for terminal launches too, since "it did not
  register in 20 s" was never a failure of the bridge; a terminal Claude
  or omp launch has no marker, so its pending text says to find it with
  `kind:"peers"` by name instead;
- **failed**: `SPAWN_UNSUPPORTED` (omp has no app), `BAD_REQUEST`
  (`permissionMode` / `model` cannot travel through a URL and are refused
  rather than replaced by the app's defaults), `SPAWN_FAILED` (the OS took
  no URL), `SPAWN_AMBIGUOUS` (two sessions carry the same marker),
  `NAME_TAKEN`.

How a session is claimed: every launch that carries a prompt starts it with
`magi-spawn:<uuid>`, and a candidate is claimed only when the first human
message of its own record begins with that marker; nothing is claimed for
being new. A Codex tab launch carries the same prompt as its `[PROMPT]`
positional, so it is claimed the same way. Recovery with `--resume` assigns
`--name` to a claimed Codex thread (replacing whatever title the app gave
it) after checking no other thread in the directory holds that name.

Verified 2026-09-16 (Claude Code app 2.110.0.0 / CLI 2.1.271, Codex app
26.908.9136.0): both apps opened on the folder with the prompt prefilled and
sent nothing; after Enter the Claude session registered from a worktree the
app made under the folder and answered a live `FACT_CHECK` by id; `magi
spawn claude --name gui1 --app` through the shipped code returned pending
after 30 s with the prompt in the composer. One more thing learned: the
app pauses an idle session's process after its idle timeout, and a paused
session drops out of the registry until the app resumes it, so a claim by
`--resume` finds nothing until the session is open in the app again.
`docs/transport-recon.md`, "The desktop apps' URL schemes", has the routes
and the observations.

## Seeing who is there

> Which Codex sessions can you reach?

`kind: "peers"` lists the sessions on the other side: name, id, whether each is
`working`, `idle 12m` or `blocked: permission prompt` (with `ctx 87k` when the
context size can be read), what each is working on (for Codex, the thread's
first message; nickname and role when it was spawned by another agent), branch,
directory, when it was last active and the last thing it said, and which one a
note or request would go to. It is the same information as `magi peers`, as a
tool call the agent can make before sending rather than guessing. A request on
`delivery: "auto"` never waits on a blocked peer: it runs a fresh headless one
and says so. Address one by `peer: "<name or id>"`.

It also lists the persistent peers the agent has created, with their run counts
and last use. `persist: "<name>"` selects one on a new headless request;
continuing a card keeps its recorded worker, not an arbitrary persona.

`kind: "transcript"` with `peer` reads the last lines of one session's
conversation (20 by default, at most 50) before an agent decides what, or
whether, to ask. PROTOCOL: Who is reachable.

## Just telling the peer something

> Let Codex know the migration landed.

A note is free-form text with an optional taskId, no mode and no round. It
reaches a live peer, blocks nothing and expects no structured reply. Identical
notes from one sender are suppressed for five minutes, and more than five sends
a minute per sender session, across recipients, are refused; how failed and
uncertain sends count is PROTOCOL: Talking.

> Tell the background reviewer to also check the empty case.

A note on a card whose worker is a headless Claude, omp or Codex that is
still running reaches it mid-run: the worker's request told it notes may
arrive, and it folds the note into its one reply (Codex takes it as a steer
into the running turn). Once it has answered, the note is refused
(`WORKER_FINISHING` while the reply is being taken, `NO_LIVE_PEER` after) and
the remedy is a follow-up request on the same taskId, which resumes the
worker's thread.

The recipient sees who sent it (PROTOCOL: Who is reachable): a Claude session
sees `Message from @codex:<thread name>` with the thread id, exactly as it
would see a message from another Claude session, and a Codex
thread a header marked `via=magi`, because Codex shows a queued message the
same way it shows the human typing.

### From a script

A scripted orchestrator has no bridge tool, so it sends with the CLI:

```
magi send --to <name | session id | pid> (--text <text> | --file <path>) [--agent claude|omp] [--name <label>] [--json]
```

The target is found as `peer:` finds it for a note (`magi peers --json`
lists names, ids and pids; `--agent` picks Claude, the default, or omp), and
the text is delivered and confirmed by the same live path, outside any card:
no round, no ledger entry, no note rate limit. Output is one line,
`<deliveryStatus>: live:<name> (message <id>)`, or with `--json` one object:
`{ok, agent, to: {name, sessionId, pid, cwd}, via, messageId, deliveryStatus,
statusText, warning?}`, and on failure `{ok: false, deliveryStatus, code,
error}`. Exit codes:

| Exit | Meaning |
|---|---|
| 0 | written and confirmed: `received`, `received_mid_turn` or `queued_unread` |
| 3 | written, not confirmed (`unconfirmed`): it may yet land, or be held for the receiver's user; do not resend |
| 1 | not delivered: no such session (`NO_LIVE_PEER`, naming the ones listed), several (`AMBIGUOUS_PEER`), no peer key (`NO_PEER_KEY`), socket or inbox failure, or omp rejected the frame |
| 2 | usage |

The receiver sees `Message from @script:<label>` (`--name`, default `magi
send`); its preview cuts the label near 20 characters (`@script-nightly-orche…`
for "nightly orchestration test"), so a short label reads better. `magi install`
puts no `magi` command on `PATH`: a script runs `node <checkout>/bin/magi.mjs
send …`, the same absolute pair `remotes.json` records for each machine. A script has no permission class, so none is asserted; Claude's inbox
gate (transport-recon.md, "The inbound gate") then hands it straight to a
receiver of its `prompting` class (default, auto, acceptEdits, and plan
unless bypass is available) and holds it at a `bypassPermissions` receiver
for that user's approval, dropped unanswered after the dialog timeout (5 min
by default; exit 3 here). omp's inbox has no such gate. Confirmation waits
3 s by default (`MAGI_CONFIRM_MS`).

Checked 2026-10-22 on Claude Code 2.1.308 with an own-inbox probe into an
auto-mode session: accepted without a dialog, shown as `Message from
@script:send-probe`, and recorded in its transcript as a peer attachment
(`origin.kind:"peer"`, `name:"script:send-probe"`, the frame's `msg_id`)
then `absorbed_mid_turn`. The CLI said `unconfirmed`, rightly: the receiver
was the session running the send, and it wrote both records only after that
tool call returned. The hold at a bypass receiver is as recorded for 2.1.290,
not re-checked on 2.1.308.

## Hearing when the peer is free

Peer tools offer `peers` for current state and `note` for conversation; there
is no `watch` tool, and an acknowledged background request brings its reply
back by itself. The engine keeps co-operative watches for non-tool callers: one
note back, sharing the note budget, and no proof the worker has finished, since
Codex can absorb queued messages mid-turn. PROTOCOL: Talking.

## Steering it directly

The fields that override how a message travels. When to steer is PROTOCOL:
Steer; the delivery modes are PROTOCOL: Delivery.

- **Reach a busy Codex desktop task during its current turn**: `codex_peer`
  with `delivery: "steer"` and an explicit `peer` UUID or exact task name
  (names must resolve uniquely; UUIDs avoid ambiguity). It also applies to
  notes, replies and clarification messages; replies always return to their
  recorded origin, not an arbitrary `peer` override. An explicit steer returns
  its failure as an error rather than becoming queue or headless delivery.
  On this machine, steer uses the desktop app's private tools channel and
  needs the desktop app; the native caller context is fixed to the recipient,
  with the external sender identified in the body. With `host`, an explicit
  steer to a Codex worker instead uses that machine's already-running shared
  daemon through the card relay (transport-recon.md, section 3). It does not
  start a daemon, load a thread or automatically retry a lost response.
- **Have the reply steered back to you**: `steerReply: true` on the request,
  from a Codex desktop or omp orchestrator (from Claude it is refused with
  `STEER_UNSUPPORTED`). A background headless peer cannot call a tool, so Magi
  steers its reply (or its failure notice) home when the run ends. Here a
  failed steer does fall back to the normal route, with a `[magi] steer
  failed` line on the reply, because nobody is left to return the error to;
  `STEER_TIMEOUT` keeps the reply in `magi mail` instead, since the steer may
  have landed.
- **Force a live peer**, failing if none is reachable: `delivery: "live"`.
- **Force a fresh restricted peer**: `delivery: "headless"`; controls vary by
  harness (`docs/security.md`).
- **Target a specific session**: `peer: "<session name>"`. A name that matches
  no live session is refused with the listed names, the close ones first.
- **Pin the artifact under review**: `diffRef: "HEAD~1..HEAD"`, `"--staged"`, or
  `"worktree"`.

## Keeping queued status updates current

Use `steer` for coordination needed before the current turn ends. For a queued
note that replaces an older status on the same topic, set a stable
`queueKey`, for example `queueKey: "release-status"`. The new body must fully
replace the old status, not merely add another detail. Different topics use
different keys. Omit the key for independent messages that must all survive.

Magi first confirms the replacement was queued, then removes only its own
older, still-pending item from the same sender, target, kind and topic. Ownership
requires its recorded client id and unchanged payload hash; `via=magi` text
alone is insufficient. Without a key, only identical pending duplicates coalesce.
Requests, replies, edited messages, attachments and unverified legacy items are
preserved. No automatic age-based deletion of queue items is performed.

Cleanup attempts at most 20 replacements per pass and reports any deferred work.
Completed receipt history retains at most 200 entries for seven days; uncertain
reservations also expire from the local receipt ledger after seven days. Receipt
expiry never deletes a queue item. A queue item that disappears is labeled
`not_pending`, which does not claim the peer received it.

Preview cleanup of already recorded replacements with
`magi queue-clean --thread <UUID-or-exact-name>`; add `--apply` to execute it.
The public API has no atomic compare-and-delete, so the recheck and deletion are
not a transaction against simultaneous manual edits. Cleanup failure is reported
separately from successful delivery; an already queued message needs no resend.

## Seeing what was sent

Neither harness shows a tool call's arguments, and the prompt the bridge
composes out of them is longer than the arguments anyway. So the moment a
message goes out, it says what it sent, as a progress line under the running
call:

```
sent REVIEW request magi-1a2b3c4d to reviewer (2365 chars): Review the force-faint change for correctness.
```

Send time is the point: a blocking review returns nothing for up to 40 minutes,
so anything carried on the result would arrive far too late to be any use.
Requests, notes, replies and clarifications announce themselves; engine-only
watches do too. The preview is the first 200 characters of what you actually
wrote (the task, note or reply text), not the protocol header the prefix
already summarises, with whitespace collapsed because a progress message
renders as one status line. The length stated is that of the full composed
message. Nothing is announced when the client did not ask for progress on the
call.

## A memory all three share

> Remember that the auth tokens rotate every 14 days. What do we already know about the deploy pipeline?

Each harness has its own memory; none of them is shared, and none is put in
front of a peer at the moment it is asked something. Magi keeps one shared
memory in `<MAGI_HOME>/magi.db`, one bank per repository (`_global` for every
project; git worktrees share their repository's bank, see
`docs/architecture.md`). Markdown is an explicit import/export format, not the
live store. What an agent saves and when is PROTOCOL: Shared memory. The bridge
exposes:

- `kind: "remember"` with `body` (one claim, under 600 characters, usable
  by someone who was not there), optional `tags`, `scope: "global"`,
  `validUntil` (an ISO date after which it never scores).
- `kind: "recall"` with `body` as the question; local semantic similarity plus
  keyword overlap (tags double), newest first on ties; `limit` defaults to 8.
  If the local model/vectors are unavailable, output says `MEMORY_KEYWORD_ONLY`.
- `kind: "forget"` with `memoryId`. A correction is a remember then a forget.

An outgoing request can carry a `MEMORY` section with relevant matches under
4 KB. Items already sent to the same worker by the same coordinator in the
last eight hours are skipped. Recorded outcome notes are saved automatically,
tagged `outcome`, expire after 14 days, and stay out of digests unless strongly
relevant (three meaningful note-word matches, excluding mode/peer framing and
tags, or cosine at least 0.45). Ordinary semantic recall starts above 0.2;
digest outcome admission intentionally requires stronger evidence.

```bash
node bin/magi.mjs memory recall "deploy pipeline"
node bin/magi.mjs memory remember "The build needs Node 22 or newer" --tags build
node bin/magi.mjs memory forget m-1a2b3c4d
node bin/magi.mjs memory stats
node bin/magi.mjs memory export --out ./memory-export
```

Export creates markdown on demand, preserves each bank/id pair with bank
metadata and collision-safe filenames, and refuses to overwrite files; use a
fresh `--out` directory for each snapshot. Older markdown memory units are
imported once, explicitly, by `magi migrate` (`docs/install.md`, "Upgrading a
loose-file ledger").

The small local model runs in-process through `@huggingface/transformers`,
cached under `<MAGI_HOME>/models`. Model loading/downloads and unit embedding
run lazily in the background: a request never waits for a download. Recall
uses keywords until the model/vectors are ready, or if loading fails; fix
network/cache access and restart to retry. No remote embedding service or
Python runtime is required. The old mnemosyne experiment was removed on
2026-09-15 because it added both a Python runtime and an MCP hop.

## Flagging something for you

> If the migration needs a decision from me, flag it and carry on.

`kind: "notify"` writes a notice for the operator: a decision only a human
can make, or a finding they must act on. It is delivered to nobody; it sits
in `magi.db` under the `notices` namespace until read. Agents keep it for
those two cases, never progress, because the operator works across many
sessions and a notice interrupts (PROTOCOL: Notices to the human).

```bash
node bin/magi.mjs notices            # unread, newest first
node bin/magi.mjs notices --all
node bin/magi.mjs notices --read n-1a2b3c4d
```

Read notices are swept after a week; unread ones stay.

## Subscription usage, not dollars

> How much of my Claude and Codex allowance is left?

Under a subscription the dollar figure on a headless run is notional; the
unit that matters is the rolling window. `magi usage` prints both
accounts' windows:

```
claude: 5h 37% (resets 2026-09-15 02:40), 7d 61% (resets 2026-09-20 10:26)
codex (pro): 7d 99% (resets 2026-09-19 11:34)
```

Codex is read live from the app-server (`account/rateLimits/read`, 0.153.4:
plan, primary window, per-model breakdown). Claude only reports its windows
to its statusline, as JSON on every render (2.1.263: `rate_limits.five_hour`
/ `seven_day`, `context_window`, `cost`, `prompt_cache.warm`), so
`magi install --usage` chains `magi statusline` in front of whatever
statusline you already have (`docs/install.md`, "Subscription usage"). The
original command is kept in `magi.db`, namespace `settings`, key
`statusline-chain`, and runs after ours with the same input; `magi uninstall`
restores it. Each Claude session's row in `peers` then also says
`ctx 84k/200k (42%)` and `cache warm` or `cache cold`. Account windows come
from whichever session rendered most recently. `usage-claude` database records
older than a week are swept; legacy usage files are a read-only migration
fallback.

## Providers

```bash
magi provider list
magi provider list --json
magi provider disable codex
magi provider enable codex
```

The provider names are `claude`, `codex` and `omp`. All are enabled until
explicitly disabled. Disabling one:

- hides its sessions from `magi peers`, shows it as `turned off` in the `/magi`
  deck, and skips its provider-specific doctor checks;
- makes a running server refuse new `request` and `spawn` calls to it with
  `PROVIDER_DISABLED`, naming `magi provider enable <name>` as the remedy.
  Already-admitted work continues: `reply`, `clarify`, `clarify_answer`,
  `outcome`, `close` and notes on an existing task remain usable, and other
  non-admission calls are not blocked;
- cancels no running work and erases no ledger history.

The tool leaves a harness's advertised list only when that harness restarts,
and a tool omitted at startup returns after enabling only on a restart too.
Installation registration shapes do not change when a provider is disabled.

An enabled provider whose executable cannot be resolved is shown as **down**
with its `resolveBin` reason, not hidden; an authentication failure observed
during a CLI call also marks it down, with login instructions. Down providers
stay visible and their tools stay registered. Restoring a missing executable
clears that status automatically; a successful headless reply clears a
recorded auth failure. `up` means the executable resolves and no auth failure
is recorded, not that an independent authentication probe succeeded.
`provider list` shows disabled providers as well; `peers` shows only enabled
ones. Server discovery asks Codex for strict errors before falling back, so an
empty peer list does not hide an authentication failure. Health recording is
best-effort: a busy or unreadable health ledger never replaces a successful
reply or the peer's original error.

The settings boundary is `getProviders()` / `setProvider()` in
`src/providers.mjs`. Policy and recorded auth failures persist in the Magi
database (`$MAGI_HOME/magi.db`, row settings/providers; `~/.magi/magi.db` by
default), and changes are read on subsequent calls. Writes use the shared state
lock and atomic replacement, so a health update cannot overwrite a concurrent
manual disable. Health rows retain `observedAt` and `lastClearAt`; an
observation older than the latest health update, or an auth failure no newer
than the last clear, is ignored under the provider lock. Malformed settings
produce `BAD_CONFIG` and are left untouched rather than overwritten; repair
them before changing providers. `LEDGER_BUSY` means another process owns the
settings lock; retry the command after it finishes.

## Seeing the fleet

In Claude Code, the `magi-view` mod's `/magi` deck shows claude, codex and omp
with their open cards and recent outcomes, and its status line their state
([install.md](install.md#readable-peer-traffic-in-claude-code-the-magi-view-mod)).
In a terminal, or with Codex or omp alone:

```bash
magi status     # the units, open cards, unreconciled debt, last five outcomes
magi peers      # every live session and its state
magi log        # every task: mode, who asked whom, how the round ended, the verdict
magi mail       # retained replies; --drain consumes them
magi channels   # conversations by coordinator/worker: whose turn, current card
magi notices    # what agents flagged for you
```

These read (`magi` on the PATH is the `npm link` step in `docs/install.md`).
The commands that act are `magi notices --read`, `magi close`, `magi spawn`,
`magi sweep` and `magi mail --drain`. The local web dashboard (`magi
dashboard`) was removed in 2026-10.

## Checking state

```bash
node bin/magi.mjs peers
node bin/magi.mjs log
node bin/magi.mjs diff-hash HEAD~1..HEAD
node bin/magi.mjs doctor
node bin/magi.mjs close --task magi-5e6f7a8b --reason "peer session was closed"
node bin/magi.mjs sweep
```

`log` is the ledger as a human reads it: one line per task, newest first,
`--task <id>` for one. A line shows `peer=resolved|blocked|failed` (with its
reason for the last two) when the peer's reply carried a `STATUS` line; no
`peer=` means it named none, which is unknown, not success. `--limit` (default 50) trims the listing only; the
closing tally covers every task matched and says so ("listing the newest 50 of
906; totals cover all 906"). Its held rate is accepted over accepted plus
rejected, so it also prints how many findings are still open, which that rate
leaves out: one real ledger showed 92% held with 24% of findings open. Held
is the orchestrator's own verdict on its peer, so compare it across
orchestrators with care.

`close` ends a round whose reply never came, acting as whichever side the
ledger says orchestrated it; the agent does the same with `kind: "close"`, and
a reply that turns up later is still recorded. Task metadata, reply payloads
and outcomes remain indefinitely in `~/.magi/magi.db`; listing limits do not
delete history.

`close` with `stop` (`kind: "close", stop: true`; `magi close --task <id>
--stop`) also kills the card's headless worker: its process tree, not a request
it may refuse (Claude Code's teams ask the teammate to approve a shutdown; Magi
owns this process, so it does not). The round is closed first as `abandoned`
with code `STOPPED`, so the worker's exit is not reported back as a failure and
no reply will come. The answer says what happened: `stopped`; `finishing`, when
the worker had already answered, so that reply stands and is still recorded;
`queued`, when the server that holds the worker has not taken the stop within 5
seconds (it polls about once a second; `magi status` shows whether it ended);
or `none`, when no headless worker runs on the card. A live session is never
stopped by this: send it a note asking it to stop. A stop is for background
(`wait:false`) runs, since a blocking request holds the orchestrator's own
call; and on a worker on another machine it kills the local ssh client, after
which that machine's `magi worker` sees its stdin close and stops the CLI after
its grace (`MAGI_REMOTE_EXIT_GRACE_MS`). `stop` also works on a round closed
earlier, for a worker that is still running.

`reply` is the fallback for a live peer whose bridge tool is unavailable or
denied: `magi reply --task <id> --from <claude|codex|omp> (--file <path> |
--text <text>)`, with `--round <n>` after round 1. It files the reply the way
`kind: "reply"` does and exits nonzero if the ledger refuses it.

`sweep` maintains stale usage, read notices, queue receipts, dead workers and
waiters, and dead-process inbox frames. It also summarizes closed cards older
than 30 days into memory and awaits their embeddings before trimming exchange
bodies; a failed embedding keeps the bodies. Servers run it at startup.
Oversized requests are stored in the database and materialized under `spill/`
when a live peer needs a readable path. These transport artifacts, including
Codex queue files, are swept after seven days; they are never a second ledger.

Cancelling a blocking MCP call releases its own waiter or stops its blocking
headless process; it does not close a live peer's round. A reply already
assigned to that cancelled waiter remains durable and is handed out of band
once no other waiter owns it. An acknowledged background headless run
continues independently of that call, but not of its server: server exit,
stdin closure and SIGTERM stop tracked headless children. Each server permits
four concurrent background runs by default (`MAGI_MAX_BACKGROUND`);
`BACKGROUND_LIMIT` names waiting, `wait:true`, or changing the cap and
restarting as the next step. Worker cleanup failures do not discard completed
answers. A failed background ledger commit reports the answer or execution
error in a notice and the server error log; inspect `magi log --task <id>` and
`magi mail --task <id>` before retrying.

Historic task, mail, exchange and outcome files are imported only by an
explicit `magi migrate --home <state directory>`; startup and ordinary reads
never import files (`docs/install.md`, "Upgrading a loose-file ledger").
