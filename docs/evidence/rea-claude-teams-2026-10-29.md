# Claude Code agent teams: what Magi has no equivalent for (2.1.310, 2026-10-29)

Static analysis of the installed Claude Code 2.1.310 (win32), done to answer
"what does Claude Code do between its own agents that Magi cannot?". Nothing
was run inside the target: no team was created and no mailbox was read. The one
value read from `~/.claude.json` was `cachedGrowthBookFeatures.tengu_amber_flint`.

## Target and method

| Build | Where | Binary sha256 | Embedded JS |
|---|---|---|---|
| 2.1.310 (win32) | `C:\Users\<user>\.local\bin\claude.exe` | `f9a3920634ae3b961ee92c2eb58d0051f5f8852b120983d0a4f57b6a5efeba61` | 2798 Bun modules |

The Bun trailer `\n---- Bun! ----\n` is preceded by the 32-byte Offsets struct;
the module table has 52-byte records, as in
[rea-claude-2026-10-16.md](rea-claude-2026-10-16.md). Each module was written
out by a read-only script and then read. Offsets below are **zero-based
character offsets within the extracted chunk**; the chunk's binary file offset
is given once per chunk.

REA evidence: `analyze_javascript_application` on the extracted directory,
`detail: summary`, `source_paths` set to the six chunks that contain the
teams strings (`chunk-yjgs2fkw`, `-gyme4870`, `-zzrefkjk`, `-4g7pca7j`,
`-4f0ryhew`, `-gts4frtm`): `ev_91163fa5879e05bfa4b38ec1fb23c441f052354cb5d2a27e6b211a46350a619a`
(parent `ev_2a105ec54cc991f34cf926edd88652e78020d1004e92601c493070f897f80f09`).
It parsed 6 files with 0 failures and left 2548 files unselected. The graph is
partial; it gave no module-level answer to this question. **Every claim below
rests on reading the chunk text, not on the graph.**

## Verified

- **Mailbox.** Each agent has `inboxes/<agent>.json` under a team directory
  (`Mz`, chunk-yjgs2fkw 24248). Reads and writes are atomic and locked
  (`[TeammateMailbox]` log strings).
- **Typed messages, in `cbi` and the zod schemas** (chunk-yjgs2fkw ~33500 to
  45200; binary offset 252511297):
  - `plan_approval_request {from, timestamp, planFilePath, planContent,
    requestId}` and `plan_approval_response {requestId, approved, feedback?,
    timestamp, permissionMode?}`.
  - `shutdown_request {requestId, from, reason?, timestamp}`,
    `shutdown_approved {requestId, from, timestamp, paneId?, backendType?}`,
    `shutdown_rejected {requestId, from, reason, timestamp}`. A session that is
    not a teammate refuses to approve: "Only a teammate can approve a shutdown
    request".
  - `task_assignment {taskId, subject, description, assignedBy, timestamp}`,
    `task_completed {from, taskId, taskSubject?, timestamp}`,
    `teammate_terminated {message}`.
  - `idle_notification {from, timestamp, idleReason: available|interrupted|
    failed, summary?, completedTaskId?, completedStatus: resolved|blocked|
    failed, failureReason?, result?}`.
- **Permission relay to the lead.** `permission_request {request_id, agent_id,
  tool_name, tool_use_id, description, input, permission_suggestions}` and
  `permission_response` (`success` with `updated_input` and
  `permission_updates`, or `error`); `sandbox_permission_request {requestId,
  workerId, workerName, workerColor, hostPattern.host}` and its response
  (`allow`). chunk-yjgs2fkw 43252 to 45000.
- **Teammate message wrapper.** A delivered message is rendered as
  `<teammate-message teammate_id=... color=... summary=...>` with
  `verified="false"` when the sender's provenance is `forged` (`Xcn`,
  chunk-yjgs2fkw 33532).
- **Lifecycle.** `TeamCreate` and `TeamDelete` are tool names (chunk-b37qf4mh,
  and the `eMe` exempt set in the tool-schema repair code); the backend records
  `paneId` and `backendType` for a teammate pane.
- **Hooks.** `TeammateIdle`, `TaskCreated` and `TaskCompleted` exist, and the
  strings "TeammateIdle hook prevented continuation" and "TaskCompleted hook
  prevented continuation" show a hook can stop the teammate.
- **Broadcast is not supported.** chunk-gyme4870 62881 (binary offset
  277913764): `if(e.to==="*")return{result:!1,message:'broadcast (to: "*") is no
  longer supported — send a message per recipient',errorCode:9}`.
- **Gate.** chunk-q8x537x5 811 (binary offset 252167560): `bs()` is false unless
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set or the argv has `--agent-teams`,
  and false unless the flag `tengu_amber_flint` (default true) is on. The local
  cache has `tengu_amber_flint: true`. chunk-pmj368m7 22920 shows the teammate
  launch environment carrying `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

## Inferred or not established

- Whether the env var or `--agent-teams` is set for a given session here; the
  gate needs both it and the flag.
- The team directory's root path: `Pit()` was not resolved.
- That `FetchInboxMessage` belongs to this subsystem. The tool name is in the
  tool table (chunk-b37qf4mh); its purpose was not read.
- Runtime behaviour of any message type. No live team was created.

## Re-check of what Magi depends on, on 2.1.310 (2026-10-29)

The rows of the "Verification table" in
[rea-claude-2026-10-16.md](rea-claude-2026-10-16.md), read again in the
2.1.310 chunks (win32, sha256 above). Static only: nothing was sent to a
session. Chunk offsets are zero-based characters within the chunk; the
chunk's binary file offset follows the chunk name. **No row changed in a way
that affects Magi.**

| Item | 2.1.310 | Where |
|---|---|---|
| Inbox frame: `message.content` must be a non-empty string; `session_id` mismatch refused | holds | chunk-wq5eg52g (272791909) @5177: `let r=e.message?.content;if(typeof r!=="string"\|\|r.length===0)`, preceded by the `session_id mismatch` check |
| First-line deadline | holds (value not read) | chunk-wq5eg52g @12407 `firstLineDeadlineMs`; the same chunk @21141 shows the Node recipe writing `{type:'auth',token}` then the frame |
| Windows auth line; `peerToken` 32 hex; child token env | holds | chunk-pwq128qa (246586194) @4602: `J="auth"`, `peerToken:o().regex(/^[0-9a-f]{32}$/)`, `dor()` true only on windows; chunk-5vrg9hxy @21324 `CLAUDE_CODE_MESSAGING_TOKEN` |
| Key file name `<pid>.<64 hex>.key` | holds | chunk-pwq128qa @4602: `/^(\d+)\.[0-9a-f]{64}\.key$/`. Live: 4 `.key` files in `~/.claude/sessions`, named that way |
| `msg_id` must be a UUID; `msgV` | holds | chunk-g3xfwg2w (252173444) @844: `P8(){return{msgV:n,msg_id:r()}}`, `tbt` tests the UUID shape |
| Frame fields `priority` (now, next, later), `file_attachments`, `from_plugin` | holds | chunk-32qahhrc (245739574) @245320, @258558; `from_plugin` in chunk-5dcjr6n4 @7912 |
| Envelope attributes in order `from`, `from-session`, `hop-chain`, `from-name`, `from-mode`, `from-plugin`; `from-session` is `^[A-Za-z0-9_-]{1,80}$` | holds | chunk-11cgzz79 (245675825) @3354 and @3857 to @4143 |
| Reply address `^(?:uds\|bridge\|did):…{1,200}$`; pipe shape `^(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$` | holds | chunk-11cgzz79 @5896 and @8875 |
| Inbound gate: hold reasons `mode-unknown`, `mode-mismatch`, `no-mode-asserted`; `crossSessionInbound` setting; `from-mode` emit flag | closed reason set holds; the full order was **not** re-read | chunk-32qahhrc @396547; chunk-aqqc875k (271697734) @1317 `tengu_harbor_kite_mode_emit` default true |
| `dialogExpiry` `60s`, `5m` (300000), `10m`; env `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` | holds | chunk-sdqv4jyz (248283744) @226593; chunk-71ecwgsb @34947 |
| Registry writer fields | holds, plus `hostSessionId`, `pidDomain`, `nameSource`, `nameSince` | chunk-gsynb80s (246685745) @822991: `peerProtocol`, `peerFeatures`, `kind`, `entrypoint`, `messagingSocketPath` |
| Registry reader: `status`, `waitingFor`, `statusUpdatedAt`, `needs`, `tempo`; status list `busy shell idle waiting`; kinds `interactive bg daemon daemon-worker`; only `<pid>.json` read | holds | chunk-zacbn4zj (252174325) @19691; chunk-35c7kxxa (246530971) @911 and @1007; chunk-gsynb80s @829472 |
| `waitingFor` value `goal proposal` | holds | chunk-hhz96zbz (280270452) @1369983 |
| `peerFeatures` `notify_idle`, `artifact_yield` | holds | chunk-gsynb80s @817181 |
| `--replay-user-messages`, `isReplay`, `user_message_uuids`, `--permission-prompts host\|none` | holds | chunk-8b69jhhx (263844023) @47473 and @49442; chunk-frft21wz @49707; chunk-32qahhrc @246760 |
| `session_state_changed`, `can_use_tool`, `peer_message_hold` | holds | chunk-32qahhrc @410156, @517248, @394887 |

Live, keys only, on this machine: the 3 registry rows are on **2.1.309**
(sessions started before the upgrade), carry the fields above, and show
`status` `busy` or `idle` and `peerFeatures` `["notify_idle","artifact_yield"]`.

**Later the same day:** `PEER_E2E=1` ran the real Claude 2.1.310 and Codex
0.163.0 through the headless channel (all 5 live tests pass; three had been
failing because they never passed `wait: true`, a stale-test fault that predates
this work and is fixed in `test/e2e.test.mjs`), and `VERIFIED_VERSIONS.claude`
moved to 2.1.310. **Still not re-run:** a live delivery into a running Claude
session and its transcript receipt. Offline `npm test` on the working tree before any change:
1029 pass, 13 skipped, 1 fail (`test/store-cancellation.test.mjs:91`, an
`ESRCH` assertion about killing a process; unrelated to Claude's formats, and
it passed on two reruns alone, so it looks load-sensitive). Only
the Windows build was read; the macOS and Linux builds were not.

## What this means for Magi

Magi has no equivalent of plan approval, a shutdown handshake, typed idle
results, a lead-side permission relay, a shared task list assigned to named
teammates, or teammate panes. Its cards, ledger, notes and `blocked`
state cover the nearest ground between harnesses, not these. The mailbox is a
private format; writing to it would need a pin in `VERIFIED_VERSIONS` and a
live probe first, and posing as a teammate would break the no-impersonation
rule in [rea-claude-2026-10-16.md](rea-claude-2026-10-16.md), "What a Magi
Claude-to-Claude route must respect".
