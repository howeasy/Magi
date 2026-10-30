# Recursion model

## The problem

Every skill says a second model is often worth consulting. Run that
instruction on both sides at once and Claude asks Codex, Codex asks Claude,
and so on until the user's quota is gone.

## The rule

Every task has exactly one orchestrator. The peer answers and stops. Roles are
per task, so both directions work; what is forbidden is a peer becoming an
orchestrator inside someone else's task.

A live session that owes a reply on an open task cannot start a reverse
request to that same counterparty, even under a new task id (`REPLY_FIRST`).
It must answer the owed task first. Replies, clarifying questions,
clarification answers and notes remain available. Another worker or
counterparty session is independent when both identities are known; unknown
identities fall back to harness checks.

This does not make the exchange one-shot. See "Turns" below.

## Four independent layers

1. **The ledger and session identity.** Task records in `~/.magi/magi.db`
   record the orchestrator and worker targets. Role checks compare sessions
   when both are known, falling back to harness otherwise. A different session
   of the same harness cannot answer clarifications, close, record an outcome,
   or open a later round for someone else's task (`ROLE_VIOLATION`).
   Reply and clarify likewise belong to the recorded worker. omp uses pid as
   the stable identity across session-id rotation; Codex uses the calling
   thread, not its root session. Debt for reconciliation is scoped to the
   orchestrator session across directories, or to the directory when the
   session cannot be identified, not to every session of that harness.
   The records live on disk because the servers are separate processes.
2. **The process flag.** Spawned peers get `PEER_DEPTH=1`. `magi serve`
   started with that set exits at once (stderr names `RECURSION_BLOCKED`), and
   the engine refuses requests with `RECURSION_BLOCKED` as a second check
   (`assertNotPeerProcess` in `src/peer.mjs`). The Codex MCP entry lists
   `PEER_DEPTH` in `env_vars` so it survives the hop, and omp forwards its
   environment to the servers it spawns.
3. **Harness-level removal.** A spawned Codex peer runs with
   `-c mcp_servers.<name>.enabled=false` for each of `magi`, `magi-omp` and
   the legacy `claude` that its config defines. A spawned Claude peer runs
   with an empty `--strict-mcp-config` and `--disallowedTools mcp__magi
   mcp__codex`. omp has no such switch: its bridge servers start and exit at
   once on layer 2 (security.md, "omp"). Where a switch exists, the reverse
   bridge is not discouraged, it is absent.
4. **The message text.** Every request states the role, names the reply tool,
   and says a further round comes only from the orchestrator. Each skill's
   first instruction is the role check.

Layer 1 is what matters for live sessions, where the peer is a full session
that could otherwise call anything. Layers 2 and 3 cover the headless case.
Layer 4 makes the model a willing participant rather than merely a fenced one.

## Turns

```
orchestrator -> request (round 1)
peer         -> clarify         (optional, as many as needed; 6 per round is the loop guard)
orchestrator -> clarify_answer  (does not spend a round)
peer         -> reply
orchestrator -> request (round 2, carrying the peer's claims back)   [DEBATE]
peer         -> reply
```

A clarifying question returns inline to a waiting orchestrator or arrives out
of band on async work. Answering resumes only an interrupted blocking round
still awaiting its reply; async answers return after delivery. Each
`questionId` is answered once. Clarify never opens a round or transfers the
orchestrator role.

Discovery failure spends no round. A failed live dispatch removes only the
newly opened round, so the same round number can be retried; replies or
questions that raced the error are retained. An unconfirmed send keeps its
closed round and route because it may already have reached the peer. A
reply-wait timeout after successful dispatch also keeps its round and accepts
late replies.

## Bounds

Delegation depth is 1 and cannot be raised: a peer never opens a request of
its own (layer 2). The round, clarification, reply and note limits are listed
once, in security.md, "Bounded by construction". Notes open no task, so no
round cap applies to them; they are bounded instead by a per-sender rate
limit and suppression of identical notes (parity.md compares this with
Claude's own peer messages).

Later rounds remain the orchestrator's decision. When rounds run out with a
disagreement standing, the protocol requires reporting it as unresolved
rather than continuing or manufacturing consensus.

## Metadata on every request

```
PEER REQUEST magi/1 task_id=magi-xxxxxxxx orchestrator=claude peer=codex
             mode=REVIEW round=1/2 delegation_depth=1 write_policy=read-only
```

A live delegation card has no round cap, so its header carries `turn=<n>`
in place of `round=<n>/<max>`.
