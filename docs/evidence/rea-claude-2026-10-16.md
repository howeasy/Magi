# Claude Code binary research for Magi (2.1.290 local, 2.1.302 Mac, 2.1.289 devbox)

Date: 2026-10-16. Static analysis only: no probe was sent into any session and nothing ran inside the targets.
I read only key file *names* from `~/.claude/sessions/`, never tokens. The only values I read from
`~/.claude.json` were the four feature-flag entries named below.

## Targets and method

| Build | Where | Binary sha256 | Embedded JS |
|---|---|---|---|
| 2.1.290 (win32, BUILD_TIME 2026-10-05T16:12:37Z, GIT_SHA 3897a650...) | `C:\Users\<user>\.local\bin\claude.exe` | `467d3dff...86386b2` | 2470 Bun modules, 51 MB |
| 2.1.302 (darwin, BUILD_TIME 2026-10-16T15:52:41Z, GIT_SHA 2ef144e6...) | Mac, copied to `scratchpad/rea/bin/claude-2.1.302-macos` | `5262ce9d...6662d37` | 2705 modules, 60 MB |
| 2.1.289 (linux) | devbox, not copied; read-only `grep -c` of markers over ssh | n/a | n/a |
| 2.1.295 | the CLI the live desktop sessions on this machine run (registry `version`) | n/a | registry files only |

How I got the JS out. The Bun trailer `\n---- Bun! ----\n` is preceded by a 32-byte Offsets struct. The module
table has 52-byte records holding name and contents StringPointers. I wrote each module out with
`scratchpad/rea/scripts/bun_probe.py`, so the trees are `scratchpad/rea/x290/` and `scratchpad/rea/x302/`.
Offsets below are **binary file offsets of the chunk start**, taken from `x290.log` / `x302.log`.

REA evidence (MCP session; exported bundle `scratchpad/rea/evidence-bundle.json`, 14 records):
- `ev_6230e2518500e30a627da0476fe6007b9d44bad3fdfcbfe943c47524a16f6b4d`: `analyze_javascript_application` on the 2.1.302 tree, with these 14 selected chunks: inbox, key/ListAgents, envelope, gate, peer files, SendFile flag, SendFile prompt, bridge peers, channels, channel flags, registry reader, idle notices, channel capability, sessions-events URL. Summary view: `ev_f8abf8d6...`. Module page: `ev_6fd673e8...`, which gives node ids, e.g. jqeffzbz `jag_node_020c3875...`, ybwzc8q6 `jag_node_004d232c...`, 0p2b124d `jag_node_002ad757...`, 5w8txcza `jag_node_01467499...`, vsj75eyd `jag_node_014c6183...`, 1fschhqb `jag_node_01e0a369...`.
- `ev_aa5f79fbefc6e90b48a94b67322b684d2ab90f38cdfd680fe55e576b85f8e328`: the same analysis on the 2.1.290 tree with the equivalent chunks. Summary view: `ev_7a6ec00b...`.
- `ev_28c3eeb000273535a10d7d591407dab621dc4e6d8d96a7a3025eba1fc39445eb`: `compare_application_versions` 290 vs 302. The minified chunk names change between builds, so REA paired only 2 entities by content digest and left 12180 unknown. **It does not support any added/removed claim.** I paired modules myself by unique code markers (log strings) and compared them by reading. Those claims are marked VERIFIED with chunk and offset.
- `ev_d60a9b91...`: a string-seed trace that found no match (string literals are not graph nodes). It is not evidence of absence.

Platform caveat: the 290 build is Windows and the 302 build is macOS. Bun drops some platform code at build time. For example, socket-directory vetting (`socketsDirVetKind`) exists only in the Mac build. So a size difference between the two is not by itself a version change.

---

## Opportunities (ranked by value to Magi)

### 1. Headless Claude worker: relay its permission prompts and turn state instead of auto-denying (`--permission-prompts host` + `can_use_tool`)
- **What.** With `-p --input-format stream-json --output-format stream-json`, the default `--permission-prompts host` sends every prompt to the stdio host as a `control_request` with `subtype:"can_use_tool"`, carrying `tool_name, input, tool_use_id, requires_user_interaction, decision_reason_type, classifier_approvable, matched_ask_rule`. The host replies with `control_response` `{behavior:"allow", updatedInput?, updatedPermissions?}` or `{behavior:"deny", message, interrupt?}`. Either side can withdraw a request with `control_cancel_request`.
- **Turn state.** `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` adds `system/session_state_changed` with `state: idle|running|requires_action`. The schema describes it as the "authoritative turn-over signal". Other frames Magi does not read yet: `system/peer_message_hold` (`held|released|dropped`, lanes bridge/stdin/socket), `system/permission_denied` (with `decision_reason_type/code`), and `system/notification`.
- **Evidence.**
  - VERIFIED: the help string `"--permission-prompts <target>","Who answers permission prompts with --print: \"host\" (the SDK host or --permission-prompt-tool) or \"none\" ..."` with `.default("host")`, in both builds.
  - VERIFIED: the schema strings `subtype:T("can_use_tool")`, `type:T("control_response")`, `control_cancel_request` and the `behavior:T("allow")/("deny")` result in 2.1.302.
  - VERIFIED: `if(a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)ki({type:"system",subtype:"session_state_changed",state:e})` in 2.1.302.
  - VERIFIED: every marker is also present in 2.1.290 and 2.1.289 (string counts).
- **Minimum seen.** ≤2.1.289.
- **Suggested change.**
  - Offer `permissions:"ask-orchestrator"` on a headless Claude request. Launch with `host` instead of `none`.
  - Turn each `can_use_tool` into a card question (`clarify` to the orchestrator) and answer it with the control_response.
  - Set `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` and use `requires_action` to show "blocked: permission prompt" for a headless worker in `magi status` and the deck.
  - Over ssh this rides the existing stdio channel unchanged. It is an approval path, not containment, so it does not lift the `allowCommands` ponytail for remote hosts by itself.
  - This is the documented Agent SDK surface, the most stable thing in this report.

### 2. MCP channels: a sanctioned push into a live session, plus remote approval of its permission prompts
- **Push.** An MCP server that declares `capabilities.experimental["claude/channel"]` can send `notifications/claude/channel` with `{content, meta?}`. Claude enqueues it as `<channel source="<server>" k="v">content</channel>` with `priority:"next"`, `isMeta`, and `origin:{kind:"channel"}`.
- **Permission relay.** A server that also declares `claude/channel/permission` receives `notifications/claude/channel/permission_request` with `{request_id, tool_name, description, input_preview}`. It answers with `notifications/claude/channel/permission` `{request_id, behavior:"allow"|"deny"}`. The prompt resolves "Denied via channel <server>" or allowed.
- **Evidence.**
  - VERIFIED: 2.1.302 chunk-9ah6nahr (file offset 234983954) holds `vCt`, `Yar`, `h7r` and the gate `CCt`.
  - VERIFIED: chunk-kcxn4chw holds `function Tot(e){return!!e?.experimental?.["claude/channel"]}`.
  - VERIFIED: the register and enqueue path is in chunk-bpv43c1t, and the relay send is in chunk-a14ghztk.
  - VERIFIED: 2.1.290 chunk-mnzp3n4y (offset 227922942) has the same strings, and 2.1.289 has them too.
- **Gate (VERIFIED, `CCt`).** Every one of these must hold:
  - The server declares the capability.
  - The connection is not a "modern" protocol era, described as "no unsolicited notification path".
  - The provider is first-party.
  - `TCt()`: flag `tengu_harbor`, default false, plus the policy limit `allow_channels`.
  - Org policy, for team/enterprise accounts: managed `channelsEnabled:true`.
  - The server is named in the session's `--channels` list.
  - A plain (non-plugin) server must be loaded with `--dangerously-load-development-channels`, which "Shows a confirmation dialog at startup". A plugin must be on the allowlist: Anthropic's ledger, or managed `allowedChannelPlugins`.
  - At runtime, `K$()` = `sn("allow_channels") && tengu_harbor`.
  - The local GrowthBook cache has `tengu_harbor: true` (VERIFIED, `~/.claude.json` `cachedGrowthBookFeatures`).
- **Minimum seen.** ≤2.1.289.
- **Suggested change.** Prototype a channel-capable Magi MCP server, or ship it through the `magi-view` plugin so managed `allowedChannelPlugins` can list it.
  - For sessions the operator launches with `--channels`, deliver requests and replies by channel notification instead of the private inbox frame. This removes the dependency on the undocumented frame and the Windows key file.
  - Use `permission_request` to bring a live session's permission prompt to the orchestrator. That closes the "a session there waiting at its own permission prompt is not routed around" gap in architecture.md, "A live session on another machine".
  - Keep the inbox route for sessions that were not launched with `--channels`.
  - INFERRED: whether `allow_channels` is granted to this account cannot be read statically. Test it with one dev-channel launch.

### 3. Frame and envelope corrections, and a route back to the native receipts and idle notice
- **`msg_id` must be a UUID.** VERIFIED: `Fpt` is `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. It is in 2.1.302 chunk-8an09rj1 (offset 220115294), and the same regex is in 2.1.290.
  - The inbox keeps `msg_id` on the origin only when `Fpt(e.msg_id)`.
  - The original Magi sender used `msg_id: "magi-xxxxxxxx"`, which Claude dropped. R4 corrected this: `postToClaude` now draws a fresh full UUID for both `uuid` and `msg_id`, and sends `msgV:1` (`src/transport.mjs:450-475`). This makes native receipts correlatable; it does not itself give Magi a return inbox.
  - Native senders also send `msgV:1` (`u5()`).
- **`priority` is a frame field, not an envelope attribute.** VERIFIED: `Uit(e.priority)??"next"` accepts `now|next|later`. A `priority:"now"` frame without `file_attachments` bypasses the processing chain.
  - INFERRED: the queue code treats `now` as preempting the running turn (`preempt`, `turn_preempted`). It may be a steer primitive into Claude, but test it before relying on it.
- **Envelope grammar.** VERIFIED in 2.1.290 chunk-1v9ekyb2 (offset 207956176) and 2.1.302 chunk-1fschhqb (offset 213944798); the two are the same apart from minified names. Order: `from, from-session, hop-chain, from-name, from-mode, from-plugin`.
  - `from-session` must match `^[A-Za-z0-9_-]{1,80}$`. Magi's writer allows 128, so a session id of 81 to 128 characters would make the receiver drop the attribute, and the byte comparison then rejects the whole envelope.
  - `hop-chain` items must be 24-hex (sha256 prefixes), 1 to 32 of them.
  - `from-plugin` is a new optional attribute that Magi's `parseClaudeEnvelope` cannot parse.
  - Reply addresses must match `^(?:uds|bridge|did):[A-Za-z0-9%:_/.\\-]{1,200}$`.
- **Receipts and idle notice.** VERIFIED: on Windows a reply target is vetted only by pipe-name shape, `^(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$` (`hNo`, `re`), when the receiver's own inbox is a pipe.
  - VERIFIED: the sender side (`we()` in chunk-0p2b124d) refuses "an unvouched pipe" unless a key file exists for that path or a live registry row names it.
  - INFERRED: the earlier bridge reply inbox never heard back because its pipe name did not fit that shape and nothing vouched for it.
  - INFERRED: to try again, listen on `\\.\pipe\LOCAL\cc-msg-<32hex>` from the sending process and publish `<pid>.<sha256(canonical path)>.key` for it. The key alone does not create a ListAgents row; the reader takes only `*.json` (VERIFIED, `F()` filters `/^\d+\.json$/`). Then `notify_when_idle` and `peer_message_status` could come back to Magi.
  - This writes into Claude's private directory. Treat it as an experiment, not a default.
- **Suggested change.**
  - Send `msg_id` as a full UUID, plus `msgV:1`.
  - Cap `from-session` at 80, and send `hop-chain` only as 24-hex items.
  - Teach `parseClaudeEnvelope` about `from-plugin`.
  - Optionally offer `priority:"now"` as Claude steer after a live test.

#### Follow-up: where hold, approval, refusal and expiry are recorded

Static follow-up against the extracted **2.1.302 macOS artifact above**, not a live
Claude session or a new transcript capture. Chunk names below mean
`$bunfs__root__chunk-<name>.js` in `scratchpad/rea/x302/`. Offsets here are
**zero-based UTF-8 byte offsets within the extracted chunk**, not the binary
chunk-start offsets used elsewhere in this report.

| Surface | Native record and identity | Source |
|---|---|---|
| Receiving TUI transcript | `DFe` appends `system/informational` warnings: a held-message sender/preview/count and an aggregate release count. Exceptional failed approval gets generic “not delivered” text; ordinary denial/expiry has no per-message transcript append in this handler. No original `uuid`, `msg_id` or complete body is copied into these warnings. | bpv43c1t:55-58, `DFe` at byte 334959, `ZPt` at 338392 |
| Informational record factory and persistence | `Bt` delegates to `Cv`, which creates `{type:"system",subtype:"informational",content,isMeta:false,timestamp,uuid:<fresh>,level}`; its UUID identifies the notice, not the peer frame. The TUI recorder subscribes to transcript changes and calls `Ov`; `cw` allows these records (only `persist:false` system records are excluded). Thus these are persistable transcript warnings, not a typed per-delivery drop ledger; actual disk writes still depend on normal persistence being enabled and succeeding. | hqtnbrjd:69 (`Cv`, 153398), :4001 (`Bt`, 4946740), :246 (`cw`, 507197), :222 (`Ov`, 388412); bpv43c1t:209 (`dxe`, 1517685; `cxe`, 1520832) |
| Receiving headless SDK stream | `Vu` emits `{type:"system",subtype:"peer_message_hold",state:"held"|"released"|"dropped",message_uuid?,lane,from,from_name?,cause?,outcome?,uuid:<fresh>,session_id}`. `message_uuid` is the inbound command/frame `uuid` (validated for the socket lane); `cause` accompanies held, `outcome` accompanies dropped. The expiry handler emits `state:"dropped",outcome:"expired"`. These go to the SDK **outbound queue**, not the receiver transcript writer. | 1w3j266c:73 (`Vu`, 515156), :106 (callbacks at 550877, expiry at 551464); compare the separate `ot`/`Ko`/`IV` transcript path later on :106 |
| Native return socket | A separate control frame carries `action:"peer_message_status"` and `orig_msg_id:<original origin.msg_id>`. It is sent to a vetted sender address, not appended as a typed receiver JSONL record. | jqeffzbz:12, receipt callback at 32090 |
| Sending native Claude session | `GGr` turns received statuses into informational notices and queued meta-prompts. The meta-prompt names up to five original `msg_id`s; this is the **sender's** path, driven by its in-memory outstanding sends, not a receiver-side record Magi can poll. | kd235v5v:11 (`GGr`, 873; ID formatter `g`, 2440); jqeffzbz:11, `Rko(e.orig_msg_id,...)` at 7756 |

**Held does not mean a user turn was recorded.** Socket intake `ze` returns
before `ET(R)` unless `HVt(R) === "accept"` (jqeffzbz:11, byte 5224).
The gate holds the command in its in-memory `held` array. Approval rechecks
policy and queue admission before releasing it; denial/expiry removes it
without submitting its body (`R`, `A`, `ikt` in tbtk3zbk:11, bytes 6012,
8537, 9603). The TUI preview is sanitized and truncated, not an exact body or
delivery-marker copy. A held-then-expired frame therefore supplies neither a
peer user turn nor a reliable marker/UUID-bearing drop row for
`confirmClaude` to match.

**Decision:** leave `src/delivery-confirm.mjs:82-117` and
`src/fleet.mjs:295-318` unchanged. A timeout or a generic warning cannot prove
which message failed. The smallest honest diagnostic would say that an
unconfirmed Claude message *may* have been held and expired, name the locally
observed dialog timeout, and ask the user to check/approve at the receiver;
do not change a receipt to `failed` on elapsed time or downgrade `received`.
This diagnostic is a proposal, not implemented here. No synthetic transcript
test establishes a native record shape.

#### Opportunity: a real per-message native status return, without a false identity

- **Wire.** `zfe`/`GHt` send a fresh connection and newline-delimited
  `{type:"control",action:"peer_message_status",status,reason,from,orig_msg_id?,msgV:1,msg_id:<new UUID>}`.
  A refusal is deliberately encoded as `status:"expired",status_detail:"refused"`.
  Guard drops add `drop_reason` and `dropped_msg_ids`; the control frame's own
  `msg_id` is not the original message ID. Sources: jqeffzbz:12, byte 32090;
  0p2b124d:11, `zfe`/`GHt` at 14075/14134; 8an09rj1:11, `u5`.
- **States, not consumption.** Internal states are `held`, `denied`, `expired`,
  `delivered`, `refused`, `dropped`; there is no `approved` status.
  `delivered` means a previously held message was approved/policy-released
  **to the queue**, not read by Claude. `expired` also covers shutdown and
  held-capacity eviction; it does not prove a timer fired. A refusal is
  distinguishable on the wire by `status_detail`. Sources: jqeffzbz:12,
  `pn` at 34760; tbtk3zbk:11, `IVt` at 2525, `R` at 6012, `A` at 8537,
  `ikt` at 9603.
- **Address and vetting.** The reply target is the incoming frame's top-level
  `from`, retained in `origin.from`, not the existing write-only connection
  or the envelope's display name. It must be a valid `uds:` address;
  `nsr` decodes it and calls `hNo` against the receiver's own inbox path.
  On POSIX, a non-symlink `.sock` in that same resolved directory qualifies.
  Cross-default-directory replies additionally require a verified connecting
  PID and an allowed owner-UID/default-directory/basename combination.
  With a verified PID, `we` checks the return listener's actual OS PID, UID
  and recorded process-start token before writing. Sources: jqeffzbz:11,
  `ze`/`nsr` at 5224/7065; 1fschhqb:14, `hNo` at 7981, `D` at 8446;
  0p2b124d:11, `we` at 15514.
- **POSIX candidate — INFERRED, not live verified.** A Magi process could bind
  its **own** `magi-<unique>.sock` alongside the recipient's inbox and put that
  address in `from`, keeping the same process alive to receive statuses.
  These checks require endpoint ownership, not a Claude session registry row
  or a claim that Magi is Claude. No native PID/session/token need be copied
  or forged. Whether a particular receiver directory permits this, and
  whether its platform supplies the required peer credentials, need an
  isolated live probe before relying on it. Keep the sender's real permission
  class; the address must not be used to bypass the receive policy.
- **Windows is a different, private-registration dependency.** `hNo` accepts
  only `cc-msg-<32 hex>` pipes (optional `LOCAL\\` prefix). `we` then requires
  a usable live-owner key or a live native registry row. A key is
  `<own pid>.<sha256(canonical pipe path)>.key`, containing a self-generated
  `peerToken` and process provenance; an auth line precedes the control frame.
  Publishing an own-PID key would not forge someone else's identity, but it
  **does adopt Claude's private native inbox namespace/auth registration**.
  There is no supported third-party registration contract established here.
  Do not fabricate a `sessions/<pid>.json` Claude session or reuse another
  process's key. Given the no-impersonation constraint, do not implement this
  Windows route without an explicitly supported registration path.
  Sources: 1fschhqb:14 (`hNo`, pipe regex at 8842);
  0p2b124d:11 (`we`, `Ve` at 15271);
  5w8txcza:14 (`t9n`, 4707; key name `V`, 5073; `Uzs`, 5223;
  `jzs`, 6587).
- **Recommendation:** a separately authorized POSIX prototype only, never a
  default or a transcript-derived failure heuristic. Authenticate the actual
  receiver process and correlate only outstanding UUIDs before accepting a
  terminal status; unsolicited control messages must not be able to mark a
  card failed. Receiving these frames is not built or live-tested here.


### 4. Native file transfer (`SendFile`, `file_attachments` on the inbox frame), when its flag is on
- **What.** The frame may carry `file_attachments:[{path, file_name, file_size, sha256(64 hex), media_type?}]`. The receiver handles them in `materializeLocalPeerFiles`:
  - It requires each path to be a regular file whose **parent directory is named `file-transfers`**.
  - It re-reads the file, bounded to 30 MiB (`ose=31457280`), and verifies size and sha256.
  - It writes a copy into its uploads directory and prepends `@"<path>"` mentions after the envelope opener.
  - At most 16 files per message (`iZ=16`); spool entries expire after 1 day (`rMn=1`).
  - Over Remote Control the same field rides the bridge event (`file_attachments` in `postInterClaudeMessage`).
- **Evidence.**
  - VERIFIED: 2.1.302 chunk-gqntw2d4 (offset 231525091) and chunk-4g00q9yk (offset 231524171), the latter with `function sFe(){return Yi()&&k("tengu_send_file",!1)}`.
  - VERIFIED: chunk-vetj44mn holds the SendFile tool text, "Send files to another Claude Code session — a peer session on this machine, or a Remote Control / cloud session on another machine".
  - VERIFIED: 2.1.290 chunk-7ndyywwb and chunk-xrx5yzj9 (`N4=31457280,d8=16`), and 2.1.289 has the strings.
- **Gate.** VERIFIED: the receiver materializes only when `tengu_send_file` is on, and its default is false. The flag is absent from this machine's cache, so it is INFERRED off here.
- **Suggested change.** When the target's flag is on (best guess: its `cachedGrowthBookFeatures.tengu_send_file`), deliver files natively.
  - Stage them in `<MAGI_HOME>/.../file-transfers/` and send `file_attachments`, so the receiving Claude gets real `@` attachments with Claude's own sha256 check.
  - Keep `filesBlock` as the fallback, and as the only route across harnesses.

### 5. Native peer framing for headless notes (an envelope on stdin)
- **What.** In a local stream-json session, a stdin user message whose content starts with `<cross-session-message from="...">` is classified as a host-injected peer message: `origin {kind:"peer", hostInjected:true, fromMode}`. It goes through the inbound gate, which always honours `from-mode` on this lane (`e8r` → `E(e,!0)`).
- **Evidence.**
  - VERIFIED, 2.1.302 chunk-cgx41xfz (offset 248165608): `function Br(e,n){return e?e.kind==="peer"?e.from:void 0:vRt(n)}`, where `vRt(e)` is `e.match(/^<cross-session-message from="([^"]+)"/)?.[1]`.
  - VERIFIED: the log string "local stdin (host-injected): dropped before attachment materialization" is in 2.1.290, 2.1.302 and 2.1.289.
- **Suggested change.** Wrap headless notes in the same envelope `deliverToClaude` writes. The headless worker then knows who is talking and gets the harness's peer safety framing.
  - The gate needs care. A bypass-mode headless worker holds an envelope with no asserted mode, and with no human there to approve, it is dropped. So always assert the sender's real class, and watch `peer_message_hold`.
  - INFERRED: not live-tested.

### 6. Mod hook points in place of transcript polling
- **What.** 2.1.302 exposes plugin/mod hook points that Magi's mod does not use.
  - `session.receive`: sees every inbound message with `{origin, text, event?, agentId?}`; may rewrite or consume it.
  - `session.send`: its result may say `{isDelivered:false, reason}`.
  - `turn.start`, `turn.complete`, `turn.step`, `tool.check`, `agent.offer`.
  - The inbox calls `Ext({origin:{kind:"peer",...}, content})`, which runs `session.receive`, before it queues a peer message.
- **Evidence.** VERIFIED: the strings and the `session:{start,receive,append,send,...}`/`turn:{start,step,complete}` table are in 2.1.302 (chunk-hqtnbrjd and others). `"session.receive"` appears 8 times in 2.1.290 and 11 times in 2.1.302.
  - Magi's mod registers only `session.start`, `command.run`, `tool.call` and `ui.render` (`claude-mod/hooks/register.ts`).
- **Suggested change.** In `magi-view`, observe `session.receive` for messages with `origin.kind==="peer"` and the `magi-delivery:` marker. Write a receipt into `MAGI_HOME`, and on `turn.complete` write an idle/finished record.
  - Sessions with the mod then get an exact receipt and an idle signal without polling the transcript. The transcript poll stays for sessions without it.
  - INFERRED: the exact payload types are not established statically. Check them with the plugin-authoring tooling.

### 7. Registry fields and key-file name Magi can use
- **Fields.** VERIFIED, reader `j()` in 2.1.302 chunk-0p2b124d (offset 220116175) and the same in 2.1.290 chunk-sbq6yzz4 (offset 213863214):
  - `needs`: a human-readable string, e.g. "choose: allow or deny the computer-use action".
  - `bridgeSessionId`: set when Remote Control is on; seen live on 3 of 16 sessions here.
  - `nameSource` (`user|peer|derived|collision|auto|hook`), `formerNames`, `logPath`, `agent`, `jobId/parkedJobId`, `spare`.
  - For background jobs: `state`, `detail`, `tempo` (`active|idle|blocked`).
- **Key filename.** VERIFIED: it is `${pid}.${sha256(canonical socket path)}.key`.
  - 2.1.302 chunk-5w8txcza `function V(e,n){... return \`${e}.${r}.key\`}` with `Z(e)=sha256(tA(e))`. The canonical form on Windows is `\\.\pipe\` plus the pipe name (`LOCAL\cc-msg-...`) with A–Z lowercased.
  - The same function is in 2.1.290 chunk-p7tpp2jr (offset 209047850).
  - **Checked live: 16 of 16 key files matched on 2.1.295 sessions; none matched a hash of the raw path** (`scripts/keyname.py`).
  - This **contradicts** transport-recon.md ("not a hash of the session id, socket path ..."; "Glob for the file").
- **Suggested change.**
  - Show `needs` in `peers`, `status` and the deck ("blocked: choose: ...").
  - Treat `bridgeSessionId` as "reachable natively over Remote Control".
  - Compute the key filename directly, keeping the glob as fallback.
  - Correct transport-recon.md.

### 8. Remote Control messaging is native Claude-to-Claude across machines: reuse it, do not reimplement it
- **Summary.** Covered in Same-harness notes. In short, `SendMessage` and `SendFile` reach `bridge:<session id>`, and names resolve against Remote Control and cloud sessions through Anthropic's sessions API, under the sender's claude.ai OAuth.
- **Suggested change.** For a Claude orchestrator and a Claude worker that are both on Remote Control under one account, Magi can point the model at native `SendMessage` rather than its ssh relay.
  - Magi's relay stays the route across harnesses and for machines without Remote Control.
  - Do not call the sessions API from Magi: it needs the user's OAuth token, a private beta header, and a trusted-device token.

### 9. Smaller items
- **Claude's own `--advisor <model>`.** Hidden; "Enable the server-side advisor tool with the specified model". VERIFIED help string in 2.1.290 and 2.1.302. A possible Claude-worker analogue of the omp advisor Magi already switches on. INFERRED behaviour: untested.
- **Hold expiry.** The setting `dialogExpiry` (`60s|5m|10m|never`, default 300000 ms) can be overridden by `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`. VERIFIED, 2.1.302 chunk-2bb0j573: `Rme(){return a.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS??cy(Jun())??dy}`. Doctor could report it.
  - **Scope clarified from the 2.1.302 schema:** `chunk-jfv2evcj`, line 28,
    describes parked permission/user dialogs forwarded to a remote client and
    HELD cross-session messages awaiting approval. They resolve to the safe
    no-action default (cancelled / dropped-with-denial); **local-only permission
    prompts are unaffected**. This is not `askUserQuestionTimeout`, whose
    adjacent description is local question auto-continue and defaults to never.
  - `dialogExpiry` reads trusted policy/flag/user settings, in that order
    (`chunk-1pjd7qsk`, line 24, `Jun`/`eO`/`Jge`); the environment override wins
    over that preference. User `settings.json` also declares an `env` block for
    Claude sessions (`chunk-jfv2evcj`, line 28). Doctor observes only the one
    override in its own environment or user settings, then the user's
    `dialogExpiry` and the built-in default; it cannot guarantee another
    session's managed/flag/environment values. No warning threshold was verified.
- **Hooks.** `Notification`, `Stop`, `StopFailure`, `PermissionRequest`, `TeammateIdle`, `SubagentStop` and others exist in both builds (VERIFIED, hook schema strings). Settings hooks could write Magi state; the registry already covers most of it.

---

## Verification table (what Magi depends on)

| Item | 2.1.290 (local) | 2.1.302 (Mac) | Evidence |
|---|---|---|---|
| Inbox frame `{type:"user", message:{content:<non-empty string>}}`, one line, optional `uuid`, `session_id` checked when present | **holds** | **holds** | 290 chunk-sst0qvra (off 236162870); 302 chunk-jqeffzbz (off 242882318): `let s=e.message?.content;if(typeof s!=="string"||s.length===0)`; `Ie()` session_id mismatch. REA `ev_aa5f79fb...`, `ev_6230e251...` |
| Extra frame fields | present | present | `priority` (now/next/later, default next), `from_plugin`, `file_attachments`, `msg_id` (honoured only if UUID), `from` (reply address, vetted). Magi's `magi-…` msg_id is dropped (Opportunity 3) |
| Auth line `{"type":"auth","token":...}` required on Windows only | **holds** | **holds** | `function t9n(){return O()==="windows"}` (302 chunk-5w8txcza); `COn()` same in 290 chunk-p7tpp2jr. Tokens: `peerToken` (key file) is classed "peer", `childToken` (env `CLAUDE_CODE_MESSAGING_TOKEN`) "child" (`zzs`) |
| First-line deadline | present | present | `rsr=30000`: a connection that sends no complete line in 30 s is closed. Magi writes immediately, so no impact |
| Envelope `from`, `from-session`, `hop-chain`, `from-name`, `from-mode` | **holds**, with constraints | **holds**, with constraints | 290 chunk-1v9ekyb2, 302 chunk-1fschhqb, the same. Plus an optional `from-plugin` after `from-mode`; `from-session` ≤80; `hop-chain` = 1–32 24-hex items; byte re-serialisation check unchanged |
| "priority" as an envelope field | **not found** | **not found** | Not an attribute; it is the frame-level `priority` |
| `from-mode` honoured over the socket (`tengu_harbor_kite_mode_emit`, default true) | **holds** | **holds** | `function tkt(){return k("tengu_harbor_kite_mode_emit",!0)}` (302 chunk-tbtk3zbk); local cache `true` |
| Inbound gate order | **holds**, with additions | **holds**, with additions | 302 chunk-tbtk3zbk (off 242854770), 290 chunk-v4e2rysd (off 233796285). (1) a kill switch (`Yi()` false) → refuse; (2) explicit `crossSessionInbound` (policy, then flag, then user; local/project may only tighten; an invalid setting → hold); (3) `selfSent` (own child) → accept; (4) mode unknown → hold; (5) same asserted class → accept, different → hold `mode-mismatch`; (6) none + bypass receiver → hold `no-mode-asserted` |
| Bypass class = `bypassPermissions` or plan with bypass available | **holds** | **holds** | `C(e){return e.mode==="bypassPermissions"||oN(e.mode,e.isBypassPermissionsModeAvailable)}` |
| `dialogExpiry` 5 min | **holds** | **holds** | `dy=300000`, `sxo={"60s":60000,"5m":300000,"10m":600000}`, `never`→0; env `CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS` overrides (302 chunk-2bb0j573; string count 4 in both builds) |
| Registry `messagingSocketPath`, `status`, `waitingFor`, `statusUpdatedAt`, `kind` | **holds** | **holds** | Writer: 290 chunk-90hy7a55 (off 209161353), 302 chunk-2jyw98bz (off 214885527), the same field list. Reader: 302 chunk-0p2b124d. `status` list `["busy","shell","idle","waiting"]`; `kind` `interactive|bg|daemon|daemon-worker`. Live files (2.1.295) carry all five |
| `waitingFor` values | **changed** (superset) | **changed** (superset) | `permission prompt`, `input needed`, `dialog open`, `sandbox request`, `worker request`, plus **`goal proposal`** (missing from transport-recon.md). Also a `needs` free-text field |
| `peerProtocol:1`, `peerFeatures:["notify_idle",("peer-pid" non-Windows),"artifact_yield"]` | **holds** | **holds** | `Adr=1`/`LLr=1`; `QF()`/`yG()`. Live: 16/16 `["notify_idle","artifact_yield"]` |
| Windows `.key` `{peerToken, procStart?, procStartFt?, pidDomain?}`, peerToken 32 hex | **holds** | **holds** | Schema `Q=u({peerToken:o().regex(/^[0-9a-f]{32}$/),...})` (302 chunk-5w8txcza) |
| `.key` filename "not derived" | **changed (doc wrong)** | **changed (doc wrong)** | It is `<pid>.<sha256(canonical socket path)>.key` in both builds; live check 16/16 on 2.1.295 |
| `--permission-prompts host|none` | **holds** | **holds** | Help string and `.default("host")` in both builds and 2.1.289 |
| `--replay-user-messages` and its `isReplay:true` echo | **holds** | **holds** | Help "Re-emit user messages from stdin back on stdout for acknowledgment"; `isReplay:!0` in the enqueue echo |
| `user_message_uuids` on `result` | **holds** | **holds** | 290: schema text "Client uuids of every user message whose prompt this turn has consumed so far, in consumption order"; reader caps at 64 (`B=64`). 302: emitted from the turn accumulator; INFERRED: 302 also adds it to `system/init` (`vR`) |
| `user_message_uuid` (singular) | **holds** | **holds** | Same schemas |

---

## Same-harness notes (Claude asking Claude on another machine)

**How native cross-machine messaging works.** VERIFIED from 2.1.302 chunk-ybwzc8q6 (off 237660730), chunk-vetj44mn, chunk-hxa4e8pb and chunk-8kpc2qba. 2.1.290 equivalents: chunk-awqppqez (off 230406452) and chunk-1pjhc53c.

- **Who is reachable.** `ListAgents` and name resolution merge several sources:
  - local registry rows (`where:"this-machine"`), in-process agents and teammates;
  - **bridge sessions**: the account's Remote Control sessions, from `listBridgePeerSessions`;
  - **cloud sessions** (`walkCcrSessionList`, when `hasCloudPeerAccess()`).
  - Bridge rows report `where:"remote"`, shown as "on another machine (Remote Control)". They carry `status` (running/idle/requires_action/pending), `connected`, and `acceptsPeerMessages` from `external_metadata.cross_session_inbound` (`available|unavailable`).
- **Listing call.** `GET ${BASE_API_URL}` sessions API (`v1`, or `v1alpha2` with `statuses=active,paused`), up to 5 pages. Headers: OAuth bearer from `prepareApiRequest`, `x-organization-uuid` (v1), optional `X-Trusted-Device-Token`.
- **Send call.** `postInterClaudeMessage` does `POST ${BASE_API_URL}/v1/sessions/{session_id}/events`, or `/v1/code/sessions/{id}/events` on the v2 path.
  - Body: `{events:[{type:"user", message:{role:"user", content:<cross-session envelope>}, parent_tool_use_id:null, session_id, uuid, msgV, msg_id, from_plugin?, file_attachments?}]}`.
  - Headers: `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid`, bearer, optional trusted-device token.
  - The target id must match `^session_[A-Za-z0-9_-]+$`.
  - The sender's address is `bridge:<own bridge session id>` (`Q0e`), so the receiver can reply to it.
- **Account.** INFERRED: both sessions must be visible to the same claude.ai account and org. The listing is of the caller's own account sessions, the request carries the caller's org UUID, and a cloud session "cannot message other sessions back yet" (one-way).
- **Approval.** With the setting `isolatePeerMachines:true`, every cross-machine send asks for explicit approval, with `classifierApprovable:false` (VERIFIED, prompt "It reaches the receiving Claude (on another machine) via Anthropic's servers as a cross-session message — marked as from another Claude session, not from its user"). Without it, auto mode sends it to classifier review.
- **Not supported over Remote Control.** `notify_when_idle` works only for "Claude sessions on this machine" (VERIFIED string). The tool text adds: "for a Remote Control, cloud or Claude Desktop session nothing reports back, so never treat silence as agreement".
- **Receiver.** Bridge-delivered peer messages pass the same inbound gate. The `peer_message_hold` lane is `bridge`.
- **Desktop-hosted sessions.** They also accept messages from the desktop's session-management MCP. VERIFIED: `inbound_origin:"mcp_send_message"` is treated as peer-gated (`LVt`), in 302 chunk-2jyw98bz and the 290 equivalents.

**What a Magi Claude-to-Claude route must respect, or could reuse.**
1. It must not forge a native sender. `from` must be an address Magi actually owns, `from-mode` must be Magi's real class, and `from-name` must stay recognisably Magi (already Magi's rule).
2. For a Claude pair that is already on Remote Control under one account, the native route already gives addressing, the gate, receipts-as-silence, and SendFile with sha256. Magi's added value there is the card: ledger, rounds, notes, outcomes. So route the *transport* natively only when both ends are Claude, both are bridged, and both accept peer messages, or keep Magi's ssh relay so the card semantics stay identical. The relay is simpler and already harness-neutral.
3. Through Magi's relay, the far end delivers into the remote session with the same inbox frame, so everything in the verification table applies on that machine and at that machine's Claude version. The relay should report the remote Claude version, and doctor there should warn against `VERIFIED_VERSIONS`.
4. The remote session's permission prompt is visible natively over Remote Control (`requires_action`), and locally in its registry (`status:"waiting"`, `waitingFor`, `needs`). A relay op that reads the remote registry row for the worked session would close the "state unknown" gap without asking any API.
5. The `did:` address scheme is reserved: it is parsed, rendered, and refused for files with "DID peers accept text only". No send path was found in the 302 bundle. INFERRED: an internal or future transport; do not depend on it.

---

## Limits (what I could not establish, and why)

- **Static only.** Nothing was executed against a session. Every "Suggested change" needs a live probe: the channel registration, the `priority:"now"` preemption, envelope-wrapped stdin notes, the reply pipe with a key file, mod hook payloads, and `--advisor`.
- **Feature flags are decided at runtime.** `tengu_send_file`, `tengu_session_stable_address`, `allow_channels` and `hasCloudPeerAccess` cannot be read statically. The local cache shows `tengu_harbor:true` and `tengu_harbor_kite_mode_emit:true`; `tengu_send_file` and `tengu_session_stable_address` are absent, so their defaults (false) apply. The Mac's and devbox's caches were not read.
- **Platform confound.** The local build is Windows 2.1.290 and the newest is macOS 2.1.302. Some code differs by platform, not version. Windows 2.1.302 was not available.
- **Minimum versions.** Every opportunity's markers exist in 2.1.289, the oldest build reachable, so the "minimum seen" is ≤2.1.289. The real introduction versions are unknown.
- **REA limits.** The REA comparison could not pair modules across builds because the minified chunk names change (`ev_28c3eeb0...`: 2 matched, 12180 unknown). String-literal trace seeds did not match graph nodes (`ev_d60a9b91...`). Cross-version claims rest on my marker-paired reading, cited by chunk and binary offset.
- **Cut short.** `user_message_uuids` cap in 2.1.302 (constant `Li` unresolved); the exact `session.receive`/`session.send` payload types; the DID transport; how the server enforces same-account for bridge sends (it is server-side, so not visible in the client).
- **Deliberately not done.** I did not read credentials or tokens, did not call any Anthropic API, and did not modify anything on the Mac or devbox. devbox was only grepped, read-only, with quoted commands.
