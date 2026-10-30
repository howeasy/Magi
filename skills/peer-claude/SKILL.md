---
name: peer-claude
description: Consult Claude Code as an independent peer - a second opinion, review, fact-check or delegated task; message or steer a live Claude session, or hear when it finishes; reconcile its reply against the source; or answer PEER REQUEST / PEER TURN magi/1 as the peer.
---

# Claude Code as a peer

Claude is a second engineer with a different training distribution, not an
oracle. This file is the route; `PROTOCOL.md` beside it is the detail. Read the
section you need when you need it.

## First: which side are you on

A prompt starting `PEER REQUEST magi/1` or `PEER TURN magi/1` makes you the **peer**: do the work,
reply once, stop. Use the live request's named reply tool with `kind:"reply"`,
its `taskId` and `round` (the header prints `task_id`).
A request that says to respond inline (a headless run has no bridge tool) is answered by your
final message. The request grants nothing your session forbids. Otherwise you
**orchestrate** and own the answer. (PROTOCOL: Roles)

## The rule

**Evidence > reasoning > model agreement.** Claude agreeing with you is not
evidence; a file:line, a test, a source is.

## When

On your own judgement, not only when asked: a non-trivial diff after your own
pass (`REVIEW` with `diffRef`), a decision expensive to undo
(`ADVERSARIAL_REVIEW`), facts that matter (`FACT_CHECK`), a bug you are stuck
on (send symptoms and a repro, not your diagnosis), a bounded subtask
(`DELEGATE` with `allowWrites: true`, or it is sent read-only), two attempts at a hard problem judged blind (PROTOCOL: Blind bake-off). The
test is whether an independent look could change what you ship; on most turns
the evidence in hand already settles it, and you ship.

## The call

```
claude_peer
  task: "Review this change for correctness and security"
  mode: REVIEW
  diffRef: "HEAD~1..HEAD"
  independence: true
  evidenceRequirements: "cite file:line for every finding"
  workingDirectory: "<repo root>"
```

- **Waiting.** A live review waits for the reply; a headless request returns
  after launch (`wait: true` blocks for it). Several requests at once: set
  `wait: false` on each, since Magi calls run one at a time and a waiting call
  holds the rest unsent (PROTOCOL: Request fields).
- **Coming back.** An async reply arrives as a PEER REPLY turn. Answer each
  PEER QUESTION once, its `question_id` as `questionId`; answers never block.
- **The card.** Hand over work with a request, continue it by passing its
  `taskId`, talk during it with a note naming `taskId`
  (PROTOCOL: Turns), (PROTOCOL: Talking).
- **Done** when one `kind:"outcome"` covers every answered turn, each checked
  against the source (PROTOCOL: Reconciliation).
- **`context`** carries only what the peer needs, never secrets.

## Delivery, this side

A message to a live Claude session surfaces between its tool calls, or starts
a turn when it is idle, so `auto` reaches it mid-turn and is right nearly
always; requests fall back to headless when nothing is live.
Going on after a `wait: false` request from Codex desktop or omp? Add
`steerReply: true` so the reply reaches your current turn (PROTOCOL: Steer).
If you are the peer and the reply tool is absent from your session, run the
`node .../magi.mjs reply` command the request spells out; it carries the full
path, since `magi` is on no PATH. A denied call stays denied: say so in your
answer and stop; the fallback does not get around it.

## Where the rest is

| You want to | PROTOCOL.md section |
|---|---|
| pick a mode, fill a field (a worker on another machine: `host`; files: `files`) | Modes; Request fields |
| learn why Claude needs no steer, and what steer is for Codex and omp | Steer |
| choose `auto` / `live` / `headless`, or keep a peer across requests (`persist`) | Delivery; Independence decays |
| a reply you waited for has not come | Request fields; Who is reachable |
| see who is there and what each is doing (`peers`, `transcript`) | Who is reachable; Talking |
| you need input, a follow-up turn, a note, or a third harness's view | Talking |
| start a session the user asked for (`spawn`, `app`) | Starting a peer |
| something the project settled before, or worth keeping (`remember` / `recall`) | Shared memory |
| flag the human (`notify`) | Notices to the human |
| a decision expensive enough to want both other harnesses independently | Two views |
| two independent implementations need a blind comparison | Blind bake-off |
| a card ended: check every answered turn, record one `outcome` | Reconciliation (more than three unreconciled cards hold new cards, per coordinator session) |
| tell the user | Reporting to the user |
