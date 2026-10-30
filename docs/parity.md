# Parity with native agent-to-agent messaging

What each harness does for its own peers, what Magi does across harnesses,
and the evidence. First audited 2026-09-08 against Claude Code 2.1.263 and
codex-cli 0.153.4 on Windows 11; rows updated since name their own version.
Every row was checked by reading the binary or source at the installed
version, or by running it; nothing here is from memory. Rows marked **no** or
**partial** are real gaps. How each transport works, and the evidence for it,
is in [transport-recon.md](transport-recon.md); this page compares.

## The native mechanisms

**Claude → Claude** (`SendMessage`): the body is wrapped in a
`<cross-session-message>` envelope carrying the reply address, the sender's
session id, a display name and the sender's permission class. The receiver
shows `Message from @<name>`, tells its model the name and reply address,
applies an inbound gate (deliver, hold for approval, refuse) based on the two
sessions' permission classes, and reports held/refused/expired back to a
sender it can vet. Read from the binary: functions `Lz`/`Cse`/`k` in
`claude.exe`.

**Codex → Codex** (multi-agent `send_input`, and the desktop's
`send_message_to_thread` tool): a turn is started or steered on the target
thread inside the same Codex process. The sender's thread id, nickname and
role travel as turn metadata (`CollabAgentRef`) and are recorded in the
rollout; for `send_input` and the desktop tool the model-visible input is plain
`UserInput` with no sender field. Multi-agent **V2** (`spawn_agent`,
`send_message`, `followup_task`; chosen per model, and 8 of 11 models in this
machine's cache) differs: the mail is a first-class
`ResponseItem::AgentMessage{author, recipient, content}` shown to the model as
`Message Type: MESSAGE|NEW_TASK|FINAL_ANSWER … Sender: <path>`, and a child's
result reaches its parent as a queued `FINAL_ANSWER` (read at `rust-v0.163.0`,
not run; [rea-codex-2026-10-29.md](evidence/rea-codex-2026-10-29.md)). No
app-server request reproduces either from outside the process, and the
app-server refuses direct input to a V2 sub-agent. Source:
`core/src/tools/handlers/multi_agents/send_input.rs`,
`core/src/agent/control.rs`, `protocol/src/protocol.rs` at `rust-v0.153.4`.

**omp → omp**: native **collab**, not a transport Magi uses. IRC and the agent
hub stay inside one process. Collab can prompt a TUI host on another process
or machine, but only through a hosted relay (`wss://my.omp.sh` by default),
with collab switched on, as a steer. It writes a `collab-prompt` custom message,
whose receipt Magi's transcript scanner cannot confirm
([REA evidence, Opportunities 5 and 6](evidence/rea-omp-2026-10-16.md)).
Magi's relay over the operator's ssh plus the receiver's inbox extension
remains its route (transport-recon.md, section 2). Magi exposes `omp_peer`
served `--as omp` for another omp session, with verified session identities
distinguishing the roles and self-targets refused. This is separate from
collab; a live OMP-to-OMP round trip has not been verified.

## Matrix

| Capability | Claude ↔ Claude | Codex ↔ Codex | Magi | How / evidence |
|---|---|---|---|---|
| Address a peer by name | yes | yes (thread name or id) | **yes** | `peer:` takes a Claude session name, id or pid, or a Codex thread name or id; several matches are refused as `AMBIGUOUS_PEER` |
| See who is reachable | `ListAgents`: name, cwd, status | desktop `list_threads` | **yes** | `kind:"peers"` and `magi peers`: name, id, purpose, branch, cwd, last active |
| Know what a peer is working on | session name only | thread name, first message, goal | **yes** | Codex rows carry `preview` (first user message), branch, nickname/role (Magi does not read the thread goal); Claude rows carry the registry name and cwd |
| Recipient knows who sent it | name + reply address in the envelope | thread id/nickname/role in metadata | **yes** | into Claude: the same envelope, verified 2026-09-08 (transcript `origin` gained `name`, `fromSession`, `fromMode`); into Codex: an explicit header naming session/thread id, name, cwd, `via=magi`, because `UserInput` has no sender field |
| Recipient knows it is not the human | envelope + peer framing | turn metadata | **partial** | Claude: yes, harness-level peer framing. Codex: the header text only; a queued message renders exactly like a typed turn (`tui/src/history_cell/messages.rs`) |
| Sender permission class | asserted in envelope, honest by construction | n/a | **yes, or unasserted** | Codex sender's class is read from its own rollout `turn_context` (`approval_policy=never` + `danger-full-access` = bypass); an omp sender's from its approval mode (`yolo` = bypass, `write` and `always-ask` = prompting; a per-session `--approval-mode` recorded by the extension, else `omp config get tools.approvalMode`, cached); unknown is left unasserted, which a bypass receiver holds |
| Delivered while the peer is busy | queued, read between tool calls | queued via `thread/queue` | **yes** | inherent to both transports |
| Know whether a peer is working, idle or blocked | `ListAgents` status | desktop thread status | **yes** | `peers` shows `working` / `idle 12m` / `blocked: permission prompt` and the Claude context size. Claude: the registry's `status`, `waitingFor` and `statusUpdatedAt` (strings in `claude.exe` 2.1.263; live files 2.1.270), context from the transcript's last `assistant.message.usage`. Codex: the newest `thread_turns` row, busy while `inProgress` with an item in the last 15 minutes (0.153.4, re-checked 0.160.1), plus `state_5.sqlite` and `thread-writer-locks/` for `magi status`. omp: the extension writes busy/idle on `agent_start`/`agent_end` (18.1.19), and `blocked: approval of <tool>` from omp's `tool_approval_requested`/`tool_approval_resolved` (18.10.4 and later). Claude also gives a free-text `needs` (2.1.290). A live worker on another machine: the state its relay last brought back (architecture.md, "A live session on another machine"). Fields and rules: transport-recon.md |
| Route around a peer its human must answer | n/a | n/a | **yes** | a request on `delivery:auto` to a `blocked` session runs a fresh headless peer instead and says why in the progress line and the footer; `live` still delivers, with a warning; notes and watches land (the inbox holds them) |
| Delivery receipt | held / refused / expired reported to a vettable sender | n/a | **partial** | Magi reads receipt from the destination's own records rather than an ack: Claude and omp by a per-write marker in the transcript or session file, Codex queue by the history `clientId` join, Codex steer by a per-send token in the thread. The statuses (`received`, `received_mid_turn`, `queued_unread`, `unconfirmed`, `accepted`, `failed`) and their evidence: transport-recon.md, "Delivery confirmation signals" and the Codex confirmation sections. Fleet polls upgrade the channel view without resending; reply and question routes return without a confirmation wait. Claude's unused bridge reply pipe was removed. |
| Idle notice | `notify_when_idle`, harness-level | none | **partial** | Co-operative watch remains engine-only, absent from the MCP schema; consumption can happen mid-turn, so it is not a native idle notification. Claude's native subscription never fired for the bridge target and was retired. `peers` reports current state, not a future idle event. |
| Loop protection | per-sender rate limit, duplicate drop, 50-message queue | n/a | **yes** | 5 note/engine-watch reservations a minute per sender session across recipients; identical payloads suppressed for 5 minutes (security.md, "Bounded by construction"). Definite pre-dispatch failure or a confirmed `failed` receipt releases the reservation; successful or uncertain dispatch retains it. |
| Size limit | about 1M chars, refused at sender | argv limit | **partial** | notes capped at 12000; requests spill to a file |
| Attachments | `@` mentions, `file_attachments` | images on `UserInput` | **across machines only** | `files` on a card message to a peer on another machine that cannot reach the file itself, copied and checked by sha256; on one machine a peer reads the path, and `files` is refused (usage.md, "Sending files to another machine") |
| Permission boundaries | per session, peer cannot approve | per thread | **yes** | delivery never widens anything; a peer message is plain text |
| Cross-machine | via Remote Control | via `--remote` | **partial** | headless workers on another machine over the operator's ssh (`host`, `remotes.json`; usage.md, "Workers on another machine"), and live sessions there through a card-scoped relay. Codex alone supports explicit remote steer through that machine's shared app-server daemon; the receipt is acceptance, not model consumption. Claude and omp remote steer remain refused. Offline tested; not run against a live daemon (transport-recon.md, section 3) |
| Either side can initiate | yes | yes | **yes** | one tool per direction |
| Lead approves a teammate's plan | `plan_approval_request` / `plan_approval_response` (agent teams) | n/a | **no** | Magi has no plan-approval handshake; a plan is just text in a card. Claude Code 2.1.310, [rea-claude-teams-2026-10-29.md](evidence/rea-claude-teams-2026-10-29.md) |
| Shut a peer down by agreement | `shutdown_request`, then `shutdown_approved` or `shutdown_rejected`; only the teammate approves | n/a | **partial** | The orchestrator can stop a headless worker it owns: `kind:"close"` with `stop:true` (or `magi close --task <id> --stop`) kills its process tree, closes the round `abandoned`/`STOPPED` and reports no failure (usage.md, "Checking state"). There is no agreement step, by design: the process is Magi's. A live session is not stopped, only asked by note. Same evidence for the native protocol |
| Peer's permission prompt answered by its lead | `permission_request` / `permission_response`, and `sandbox_permission_request` for a network host | n/a | **no** | A headless Claude worker has its prompts denied; relaying them is the unbuilt Opportunity 1 in [rea-claude-2026-10-16.md](evidence/rea-claude-2026-10-16.md) |
| Shared task list assigned to named teammates | `task_assignment`, `task_completed`, `TaskCreated` / `TaskCompleted` hooks | n/a | **partial** | The card ledger records who was asked what and the outcome, across harnesses, but nothing assigns from a shared list and nothing can veto completion |
| Typed idle result | `idle_notification`: `idleReason`, `completedStatus` (resolved, blocked, failed), `result`; `TeammateIdle` hook | n/a | **partial** | Every reply asks for a `STATUS` line (resolved, blocked or failed, plus why) and the result carries it as `structuredContent.status`, or `null` when the peer named none. It is the worker's word, not asserted by the harness, and it arrives with the reply; no separate event is pushed when a peer goes idle. `peers` still reports `idle` / `blocked` state |
| Team lifecycle and panes | `TeamCreate` / `TeamDelete`, a pane and backend per teammate | n/a | **no** | `magi spawn` starts one named session; there is no team object |
| Broadcast to every peer | removed: `to: "*"` is refused ("send a message per recipient") | n/a | **n/a** | Not a gap; Magi is one-to-one too |

## Agent teams are Claude-only and gated

The rows from "Lead approves a teammate's plan" to "Team lifecycle and panes"
describe Claude Code's agent teams, read from the 2.1.310 binary on
2026-10-29 and not run. They are on only when
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` or `--agent-teams` is set and the flag
`tengu_amber_flint` (default true) is on; the local cache has it true. The
mailbox is a private per-agent file, so Magi does not write to it. Evidence,
message shapes and what was not established:
[rea-claude-teams-2026-10-29.md](evidence/rea-claude-teams-2026-10-29.md).

## What is not native, and why

- **Into Codex the bridge uses the queue, not `send_input`.** `send_input` and
  `Op::InterAgentCommunication` exist only inside the Codex process that has
  the thread loaded; `turn/start`, `turn/steer` and `thread/inject_items`
  likewise act on a thread loaded in the caller's own app-server. On Windows
  at 0.153.4 the desktop's server had no control socket (`daemon` was
  Unix-only, `proxy` failed, `agents` needed `--remote`; the 0.160.1 source
  supports the daemon on Windows too). The one cross-process
  input another process's thread will pick up is the shared queue table, via
  `codex queue` or `thread/queue/add`. The desktop's own
  `send_message_to_thread` tool is the other route in, used for steer.
- **Into Claude the bridge is native.** The envelope is the format
  `SendMessage` itself produces and the inbox parses. The socket is the
  documented inbox; the frame body is not documented and was worked out from
  the binary.
- **What `codex queue` proves.** A persisted row, nothing more: two earlier
  test rows sat for hours in unloaded threads, and the 0.160.1 desktop also
  absorbed queued messages mid-turn. Persistence or disappearance alone is
  not receipt; the history client-id join is (transport-recon.md, "Queue
  delivery").

## Delivery into Claude: the gate

The gate's rules are in transport-recon.md, "The inbound gate". In short, a
`bypass` receiver holds every message whose sender does not assert `bypass`,
drops it after `dialogExpiry` (5 minutes), and tells only a sender it can
reach. Three of four messages Codex sent on 2026-09-08 were lost exactly this
way while the session was in plan mode. The envelope's `from-mode` is what
lets a same-class message through; it must be the sender's real class, never
a claim made to pass the gate.

## How this was audited

- The envelope grammar and gate were read out of `claude.exe` and matched to
  the documented behaviour, then proven with a sanctioned own-inbox probe.
- The cwd filter, `thread/list` fields, `thread/goal/get`, `thread/queue/list`
  (needs `experimentalApi`) and `hooks/list` were exercised against the local
  app-server. An earlier claim that the cwd filter needed forward slashes came
  from a probe whose backslashes a shell layer had eaten; it is withdrawn.
- The read-only headless Claude was tested negatively: with the pre-fix flags
  it wrote a file through `git diff --output` and still had MCP write tools.
  The isolation flags now used were re-tested by Codex against 2.1.263.
