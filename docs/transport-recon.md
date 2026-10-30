# Transport reference and repair guide

Magi reaches a live session through five transports. `codex queue` and the
omp extension API are supported surfaces. The Claude inbox frame, the Codex
desktop steer channel and the desktop apps' URL routes are private formats:
any release can change them, and the break is silent. The headless workers'
line protocols (section 4) are documented by their vendors but were partly
taken from documentation rather than observed.

To repair one: find the symptom below, go to its section, run the check
there, apply the fix there, then record the version you checked against
(see "Version pins").

## Find the symptom

| Symptom | Transport | Go to |
|---|---|---|
| A live request to Claude reports a successful write but nothing arrives: `deliveryStatus` stays `unconfirmed` | Claude inbox frame | 1, "Repair procedure" |
| A message to a Claude session in plan or bypass mode looks delivered and never arrives | Claude inbound gate | 1, "The inbound gate" |
| `peers` reads every Claude session as `unknown`, and requests wait on a dialog again | Claude session registry | 1, "Session registry" |
| `peers` shows no omp session, or omp replies never arrive | omp extension | 2, "When it breaks" |
| The parent omp session's replies are refused `ROLE_VIOLATION`, or it reads `NO_LIVE_PEER`, while a `task` subagent runs | omp extension | 2, "When it breaks" |
| An omp frame stays `queued_unread`, or its confirmation reports `failed` | omp extension | 2, "Submission and session-file receipt" |
| `No active session found matching '<name>'`, or `Cannot verify a unique session label` | Codex queue | 3, "Queue delivery" |
| A queued Codex request is never answered | Codex queue | 3, "Queue delivery" |
| Codex queue delivery fails with `spawn ENAMETOOLONG` | Codex queue | 3, "Queue text length" |
| A steer to a terminal Codex fails `NO_STEER_CHANNEL` or `NO_ACTIVE_TURN` | Codex steer | 3, "Steer through the local daemon" |
| `NO_STEER_CHANNEL` while the Codex desktop app is running | Codex steer | 3, "Desktop steer channel" |
| A steer stays `accepted` or `queued_unread` | Codex steer | 3, "Steer delivery confirmation" |
| `magi status` or `peers` miscounts Codex threads or busy turns | Codex databases | 3, "Discovery" and "Presence without an app-server" |
| `ORIGIN_MISMATCH` on a call from Codex | Codex caller metadata | 3, "Who is calling" |
| A headless run never ends until `TIMEOUT`; a note stays `queued_unread`; `PEER_FAILED` naming `thread/start` or `turn/start`; `PROTOCOL_ERROR`; `APPSERVER_TIMEOUT` | headless channels | 4, "When one of these breaks" |
| `magi spawn --app` opens the app and nothing registers, or returns `pending` / `SPAWN_AMBIGUOUS` | desktop URL schemes | "The desktop apps' URL schemes" |

## Version pins

`VERIFIED_VERSIONS` in `src/install.mjs` holds the version each private
format was last checked on. `magi doctor` warns when an installed CLI or app
is newer. Newer means unverified, not broken. The checks below ran on
Windows 11 unless a line says otherwise.

| Key | Covers | Evidence recorded below |
|---|---|---|
| `claude` | inbox frame, envelope and gate; session registry fields; transcript delivery signals; headless `stream-json` | frame and envelope worked out on 2.1.260 and 2.1.263 (2026-09-08); delivery signals on 2.1.290 (2026-10-06); headless channel on 2.1.290 (2026-10-08); **2.1.310 (2026-10-29)**: inbox frame, envelope, gate reasons, registry fields, key-file name and transcript `origin` read in the bundle ([rea-claude-teams-2026-10-29.md](evidence/rea-claude-teams-2026-10-29.md)), and the headless stream-json channel run live through `PEER_E2E=1` (a real Claude answered with a session id and a parsed `STATUS`). **Not re-run on 2.1.310:** a live delivery into a running session and its transcript receipt. |
| `codex` | `codex queue` and its receipts; app-server `thread/list`; `thread_history_1.sqlite` and `state_5.sqlite` columns; steer receipts; the headless app-server | 0.153.4 (2026-09-08); 0.155.1 (2026-09-22); 0.160.1 (2026-10-06 to 2026-10-08); steer through the local daemon and its client-id receipt on 0.163.0 with daemon 0.161.0 (2026-10-18), the pin left where the rest was checked |
| `omp` | extension events and registry contract; `sendUserMessage` receipt; headless `--mode rpc` | 18.1.19 (first extension check); 18.4.4 (2026-10-05 to 2026-10-08) |
| `claudeApp` | `claude://` routes; registry `entrypoint: "claude-desktop"` | 2.110.0.0 with CLI 2.1.271 (2026-09-16) |
| `codexApp` | `codex://` routes; the desktop steer channel | 26.908.9136.0 (2026-09-16); 26.915.4065.0 (2026-09-22). Desktop 26.930.7945.0 appears in the 2026-10-08 research; the pin stays at the version its routes were checked on |

To move a pin:

1. Run the section's check against the new version.
2. Record the result in that section: what was checked, the version, the date.
3. Bump the key in `VERIFIED_VERSIONS` and the comment above it.

Done when the section names the new version and `magi doctor` no longer
warns for it.

---

## 1. Claude Code inbox (delivering into a live Claude session)

### Status

**Undocumented private format.** Anthropic documents the socket path, the
credential and the auth line for scripts posting into a session. The frame
body is not documented; it was determined empirically. Treat every detail
below as version-pinned (`VERIFIED_VERSIONS.claude`).

### Repair procedure

Use this when live delivery into Claude starts failing after an upgrade. The
symptom: `deliverToClaude` reports success (the socket accepts and closes)
but nothing arrives, because a malformed frame is dropped silently.

**Step 0: check the cheap causes.** The target session is alive and its pid
matches the descriptor; `crossSessionInbound` is not set to `hold` or
`refuse`; both sessions are on the same filesystem, since a container or WSL
session cannot reach a native one.

**Step 1: locate the handler in the binary.** The client is a compiled bundle
with the JavaScript source embedded. Two regions contain the strings: a
constant pool, which is not useful, and the actual code, which is. Search
for a *code-shaped* marker, not a bare string. Use the path of your own
`claude` binary.

```bash
python - <<'PY'
import sys
data = open(r"C:\Users\<user>\.local\bin\claude.exe","rb").read()
marker = b'Ignoring message without valid type field",{level:"warn"}'
i = data.find(marker)
print(data[max(0,i-200): i+2500].decode("utf-8","replace"))
PY
```

That prints the dispatch function. Useful anchors, in rough order of value:

- `Ignoring message without valid type field",{level:"warn"}`: the dispatcher
- `Ignoring user message with missing or non-string content`: the `user` handler
- `session_id mismatch`: the session check
- `Routed user message to queue (priority=`: the success path; everything
  before it is a gate
- `[uds-messaging]`: every log line in the module

If a marker has moved, search for `[uds-messaging]` and read outward.

**Step 2: find all occurrences and pick the code one.** Strings appear at
least twice. Print each hit with a printable-character ratio; the constant
pool scores well below 1.0, the code region scores 1.0.

```bash
python - <<'PY'
import sys
data = open(r"C:\Users\<user>\.local\bin\claude.exe","rb").read()
m, start, n = b"session_id mismatch", 0, 0
while (i := data.find(m, start)) >= 0:
    start, n = i+1, n+1
    txt = data[max(0,i-900): i+400].decode("utf-8","replace")
    ratio = sum(1 for c in txt if 32 <= ord(c) < 127 or c in "\n\t")/len(txt)
    print(f"--- hit {n} offset {i} printable={ratio:.2f}")
    print(txt.replace("\x00",""))
PY
```

Read the validators the handler calls and reconstruct the required shape.
Compare it with "Wire format", "Validation" and "The envelope" below.

**Step 3: probe against your own session.** Post to your own inbox with the
environment variables the session exports. This is the sanctioned path and
needs no other session's credentials.

```js
// probe.mjs - node probe.mjs '<json frame>'
import net from 'node:net';
const c = net.connect(process.env.CLAUDE_CODE_MESSAGING_SOCKET);
c.on('connect', () => {
  c.write(JSON.stringify({ type: 'auth', token: process.env.CLAUDE_CODE_MESSAGING_TOKEN }) + '\n');
  c.write(process.argv[2] + '\n');
  c.end();                      // close cleanly; do not destroy
});
c.on('close', () => process.exit(0));
```

Run it, then make one more tool call. A correct frame surfaces between tool
calls. There is no ack, so delivery is the only signal.

**Step 4: update the code and pin the version.** The frame is built in
`postToClaude` and the envelope in `wrapForClaude`, both in
`src/transport.mjs`. Update them, add a regression test, update this section
with the new shape, and move the pin.

Done when a frame in the new shape surfaces in your own session from the
probe, a test pins that shape, and this section and
`VERIFIED_VERSIONS.claude` name the version you checked.

### Dead ends

Recorded so nobody spends the time twice.

- **A top-level string `message`.** A transcript helper elsewhere in the
  bundle tests `typeof e.message === "string"`. It is unrelated to the inbox
  and will send you down the wrong path. The inbox reads `e.message?.content`.
- **Guessing frame shapes.** Five plausible variants were dropped in silence.
  Reading the handler took minutes; guessing took far longer and taught
  nothing.
- **`grep -a -o` with a large context window.** It matches nothing on this
  binary because the lines are enormous. Slice by byte offset in Python.
- **Hashing the raw socket path for the key filename.** It is the sha256 of
  the *canonical* path (below); the glob stays the fallback.
- **Destroying the socket instead of closing it.** Use `end()`.

### Session registry

Each live session publishes two files in `~/.claude/sessions/` (or
`$CLAUDE_CONFIG_DIR/sessions/`). The descriptor below was recorded with
`peerProtocol: 1`.

`<pid>.json`

```json
{"pid": 40172,
 "sessionId": "39f9b91a-...",
 "cwd": "C:\\Users\\<user>\\Orch",
 "startedAt": 1788828248563,
 "procStart": "134333018480636630",
 "version": "2.1.260",
 "peerProtocol": 1,
 "peerFeatures": ["notify_idle", "artifact_yield"],
 "kind": "interactive",
 "entrypoint": "claude-desktop",
 "pidDomain": "win32:<host>",
 "messagingSocketPath": "\\\\.\\pipe\\LOCAL\\cc-msg-<32 hex>",
 "name": "orch-a1",
 "status": "waiting",
 "waitingFor": "permission prompt",
 "statusUpdatedAt": 1789428790278,
 "updatedAt": 1789428790278}
```

`status` is one of `busy`, `shell`, `idle`, `waiting` (the literal list
`["busy","shell","idle","waiting"]` in `claude.exe` 2.1.263); `kind` one of
`interactive`, `bg`, `daemon`, `daemon-worker`. `waitingFor` is set with
`waiting` and names the dialog: `permission prompt`, `dialog open`, `input
needed`, `sandbox request`, `worker request`, and (found in 2.1.290 and
2.1.302) `goal proposal`; a free-text `needs` field says what it waits for in
words, e.g. "choose: allow or deny the computer-use action". `peers` reads these as
working / idle / blocked. If a future version renames them, every session
reads as `unknown` and nothing is routed around, so the symptom is a request
that waits on a dialog again.

`<pid>.<64 hex>.key`

```json
{"peerToken": "<32 hex>", "procStartFt": "...", "pidDomain": "win32:<host>"}
```

The key filename matches `^(\d+)\.[0-9a-f]{64}\.key$`: `<pid>.<sha256 of
the canonical socket path>.key`, the canonical form on Windows being
`\\.\pipe\` plus the pipe name (`LOCAL\cc-msg-…`) with A-Z lowercased. Read
from the 2.1.290 and 2.1.302 binaries and checked live on 16 of 16 key files
of 2.1.295 sessions, none of which matched a hash of the raw path (REA,
2026-10-16; an earlier note here said it was not derived). `peerTokenFor` in
`src/transport.mjs` matches the filename pattern above instead of
recomputing the hash, which still finds it.

A session's own values are also exported to its child processes as
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. That is the
sanctioned way to post into your *own* session, and the safest thing to probe
with.

The socket is a named pipe on Windows and a Unix domain socket elsewhere. On
Windows the auth line is mandatory; elsewhere it is optional.

### Wire format

One connection per message. Line-delimited JSON. The server writes nothing
back, so there is no ack and no error: a malformed frame is dropped silently.

```
line 1:  {"type":"auth","token":"<peerToken>"}
line 2:  {"type":"user",
          "message": {"content": "<non-empty string>"},
          "uuid": "<optional, generated when absent>",
          "session_id": "<optional, validated when present>",
          "from": "uds:<socket path of the sender>",
          "file_attachments": []}
then:    close the connection
```

**The body lives at `message.content`, an object, not a top-level string.**
This is the single most important detail, and the one that cost the most
time; see "Dead ends".

`from` is the reply address the receiver would send a status to, and it is
only used when it passes the reply-target checks. The sender's identity the
model sees comes from the envelope in `message.content`, described below.

`postToClaude` sends `type`, `message.content`, `uuid`, `msg_id` and
`msgV: 1`, plus `session_id` and `from` when it has them. It sends no
`file_attachments`. `msg_id` is a fresh UUID per frame with `msgV: 1`, as
Claude's own senders supply them: the receiver keeps a `msg_id` only when it
is a UUID (read in the 2.1.290 and 2.1.302 bundles, REA 2026-10-16; the
2.1.290 inbox does not read `msgV`, so it is not refused), so its hold, drop
and expiry notices can name the message. Magi reuses that UUID as the
frame's `uuid`, its own choice: native senders draw `uuid` separately.
Until 2026-10-17 Magi
sent `magi-<8 hex>`, which the receiver dropped; receipts recorded then keep
that id. Magi does not read those notices yet (it sends no `from`). The new
form has not been run against a live 2.1.295 session; the delivery marker,
not the frame id, is what confirmation reads.

### Validation, in the order it is applied

| Check | Failure |
|---|---|
| frame is an object with a string `type` | dropped, logs `Ignoring message without valid type field` |
| `type` dispatches to a known handler | dropped, logs `Received unhandled message type` |
| for `user`: `message.content` is a non-empty string | dropped, logs `Ignoring user message with missing or non-string content` |
| `session_id`, when present, equals the receiver's | dropped, logs `session_id mismatch (got ..., expected ...)` |
| inbound controls (`crossSessionInbound`, permission parity) | delivered, held for approval, or refused |

Omitting `session_id` skips its check entirely, which is the more robust
choice when the sender cannot be sure of the target's id.

### Known frame types

`user`, `control`, `peer_message_status`, `notify_when_idle`,
`peer_idle_notice`, `yield_artifact_replies`, `unyield_artifact_replies`,
`artifact_replies_yielded`.

`control` carries an `action`, including `rename`, `notify_when_idle`, and
`peer_message_status` with a `status` of held, denied, expired, delivered,
refused, or dropped.

Magi uses only `user`.

### The envelope: who sent it, and its permission class

The frame says nothing about the sender beyond `from`. Identity and
permission class are parsed out of `message.content` itself, by the same code
that reads messages `SendMessage` produces (functions `Lz`, `Cse`, `gce`; tag
constant `d4 = "cross-session-message"`):

```
<cross-session-message from="uds:<addr>" from-session="<id>" hop-chain="a,b" from-name="<name>" from-mode="bypass|prompting" from-plugin="<plugin>">
<body>
</cross-session-message>
```

Rules, all enforced by the receiver:

- Every attribute is optional, but the order is fixed as shown.
  `from-plugin` follows `from-mode`; it is in the 2.1.290 and 2.1.302 bundles
  (REA 2026-10-16). `wrapForClaude` reproduces it, but Magi never sets one.
- `from` matches `[A-Za-z0-9%:_/.\-]{1,200}`; `from-session` matches
  `[A-Za-z0-9_-]{1,80}` (a longer one makes the receiver refuse the whole
  envelope, so `wrapForClaude` leaves it out); `from-name` may not contain
  `"<>` or line breaks and is sanitised (control/format characters stripped,
  64 code points, ellipsis); `from-mode` is exactly `bypass` or `prompting`.
- A nested `<cross-session-message` or `</cross-session-message` in the body
  is rewritten to `<\`.
- The receiver re-serialises what it parsed and rejects the envelope if the
  bytes differ, so a writer must reproduce this exactly. `wrapForClaude` in
  `src/transport.mjs` does, and `parseClaudeEnvelope` is the receiver's parse
  kept for the regression test.

What the receiver does with it: `from-name` becomes the `Message from @<name>`
preview and the `name` the model is told; `from-session` and `from-mode` are
stored on the message's `origin`; `from-mode` feeds the inbound gate below.
`from-mode` sent over the socket is honoured (flag
`tengu_harbor_kite_mode_emit`, default on).

Verified 2026-09-08 with the sanctioned own-inbox probe: the transcript's
`origin` for the probe reads
`{"kind":"peer","from":"unknown","name":"claude:magi-15 (envelope self-test)","fromSession":"87fcbc3f-…","fromMode":"prompting",…}`,
while every un-enveloped message received earlier reads
`{"kind":"peer","from":"unknown"}`.

### The inbound gate

Function `k` in the binary:

1. An explicit `crossSessionInbound` (`accept` / `hold` / `refuse`) wins.
2. Otherwise a message verified as the session's own child (own-child token)
   is accepted.
3. Otherwise the receiver's class is computed: `bypassPermissions`, or `plan`
   with bypass available, is `bypass`; every other mode is `prompting`.
4. If the sender asserted `from-mode`: same class → accept, different → hold
   (`mode-mismatch`).
5. If not: a `bypass` receiver holds (`no-mode-asserted`); a `prompting`
   receiver accepts.

A held message opens an approval dialog; unanswered past `dialogExpiry`
(5 min) it is dropped. The status frame goes to `from` only when that address
passes the reply-target checks (`errors.md`: not a symlink, vettable, expected
process, owned by the user), which a bare bridge pipe does not, so the sender
hears nothing. This is why an unwrapped message to a desktop session in plan
mode looks delivered and never arrives.

### Delivery behaviour

An accepted frame goes to the receiving session's prompt queue. It surfaces
between tool calls during an active turn, or starts a new turn when the
session is idle. It arrives labelled as a peer message with the safety
framing that a peer cannot approve permissions or change configuration.

### Delivery confirmation signals

These apply to Claude and omp; omp's own evidence is in section 2,
"Submission and session-file receipt".

A read-only research pass on 2026-10-06 reported these transcript signals on
**Claude Code 2.1.290**. `src/delivery-confirm.mjs` polls the destination
JSONL after a successful socket write, for **3 seconds** by default;
`MAGI_CONFIRM_MS` overrides that deadline (`0` inspects one bounded chunk).
Every Claude and omp write captures the target file's byte size **before**
dispatch and appends `<!-- magi-delivery:<full random UUID> -->` to the body.
The delivery UUID is independent of the task id and inbox frame id. Receipts
retain the exact marker, cursor, destination and transcript/session path.
Scanning starts at that stored pre-send cursor, so reused-marker history
cannot confirm a new write, even when a fast receiver appends before
confirmation. Each inspection reads at most **256 KiB**, in **16 KiB**
chunks; it checks the deadline between reads and yields to the event loop
after each chunk. Truncation does not rewind the cursor into older evidence.

| `deliveryStatus` | Evidence |
|---|---|
| `received` | A `type:"user"` record with `origin.kind:"peer"` and the marker in its content. |
| `received_mid_turn` | A `queue-operation`, `operation:"remove"`, `reason:"absorbed_mid_turn"` matched by content, or joined by `commandUuid` / `deliveryId` to a matching enqueue or peer `queued_command` attachment (`delivery_id`). |
| `queued_unread` | A matching enqueue was observed, without a matching consumption record before the deadline. |
| `unconfirmed` | No matching signal was readable before the deadline. A successful socket write alone is not receipt. |

A queued attachment alone, an unrelated removal, or ordinary user text is not
consumption evidence. CLI transcript buffering can delay confirmation;
`/clear` can move consumption to another transcript. This bounded check
reads the selected destination's transcript only and does not follow
session switches. These statuses describe observed transport evidence, not a
peer answer; a missing confirmation is never grounds for an automatic
resend.

Reply and question routes return the write receipt immediately, without a
confirmation wait: Claude reports `unconfirmed`; omp reports `queued_unread`
while its inbox frame is queued. The engine records that receipt on the
card. Later fleet polls inspect its exact marker, cursor, path and frame id
with a zero confirmation deadline, upgrading the channel view to `received`,
`received_mid_turn`, or a definite `failed`. Polling does not send again or
rewrite the ledger. A request rejected with `failed` returns
`DELIVERY_FAILED` and names the receiver inspection/retry step; it is not a
delivered request.

The bridge's experimental reply inbox and opt-in receipt wait were removed:
neither a status frame nor an idle notice was observed reaching it.
Transcript evidence, not silence on that unvetted reply address, establishes
receipt.

### Failure mode by design

If the frame is wrong, `deliverToClaude` still resolves, because the socket
accepts and closes regardless. The bridge treats that as transport success
only. A successful write with no transcript evidence is `unconfirmed`; a
later live timeout preserves the reply route, not a duplicate headless
launch. Only an adapter-marked fallback error with `dispatchUncertain:false`
can switch an `auto` request to headless. When this format breaks, inspect
the stored marker/cursor and the destination transcript; a silent drop is
not a safe resend signal.

---

## 2. omp extension (delivering into a live omp session)

### Status

**Documented extension API; Magi's own registry contract.** omp has no
cross-process way to hand a running session a message. The extension
`omp/magi-omp-extension.js` runs inside the session and does the delivery.
`magi install --omp` copies it, as `index.js` with `process-identity.js`
beside it, into `~/.omp/agent/extensions/magi/`. Being a copy, a fix is live only after
`magi install --omp` and an omp restart. The mechanism and its history are
in architecture.md, "A harness that is neither Claude nor Codex"; this
section is what to check when it stops working. Pinned as
`VERIFIED_VERSIONS.omp`.

### What the extension relies on

From the extension source:

- **Events**: `session_start` (register, start polling), `session_switch`
  (register again), `agent_start` / `agent_end` (status `busy` / `idle`),
  `session_shutdown` (stop polling, unregister), and
  `tool_approval_requested {sessionId, toolCallId, toolName, reason?,
  approvalMode}` / `tool_approval_resolved {sessionId, toolCallId, toolName,
  approved, reason?}` (status `blocked` with `waitingFor: "approval of
  <tool>"`, and the session's real `approvalMode`, which only the requested
  event carries). omp emits these two only when a handler is registered.
  Read in the 18.10.4 binary (exe@188278834-188279576) and the 18.11.3 source
  (`extensibility/extensions/types.ts:1243-1259`, `wrapper.ts:369-393`);
  fact-checked 2026-10-16; not yet run against a live
  approval prompt.
- **Context**: `ctx.setInterval` (the global one when absent; it polls every
  750 ms), `ctx.isIdle()`, `ctx.cwd`, and `ctx.sessionManager`'s
  `getSessionFile()`, `getSessionId()` and `getSessionName()`.
- **Send**: `pi.sendUserMessage(text, {deliverAs})`: no option when the
  session is idle (a new turn), `aside` when busy, `steer` when the sender
  asked for one, and `aside` again while a tool waits on approval. From omp
  18.11.0 a message queued as steering while an approval is pending denies
  the pending call; the steer's text arrives as its own user message, not
  as the denial's reason (`modes/controllers/extension-ui-controller.ts:
  676-708`, CHANGELOG 18.11.0). The receipt then says `deliveredAs: "aside"`
  and why. An idle steer or followUp is not stranded: the queue drain
  starts a turn for it (`agent-session.ts:8691`, `:4821`, 18.11.3).
- **Logging**: `pi.logger.warn`, for the `magi:` lines below.
- **Storage**: `node:sqlite` or `bun:sqlite`, opening `$MAGI_HOME/magi.db`
  directly, since a copy cannot import the checkout's store. The registry row
  is `records` namespace `agents`, key pid. Frames are
  `frames(to_pid, id, body, state, created_at)` with `state` `queued`,
  `processing` or `failed`. Receipts are `records` namespace `delivery-acks`,
  key frame id.

Evidence: omp 18.1.19 loaded the extension, registered with its actual
session id, consumed a frame, and started a turn with the frame as the user
message. That check covered the earlier file-based inbox; architecture.md
records that the SQLite inbox still needs the same runtime check. Re-check
those four on a new omp, plus the receipt below.

### Submission and session-file receipt

On **omp 18.4.4**, the extension loader's `sendUserMessage` wrapper returns
`void` and discards the runtime promise (`loader.ts:309`). A successful
invocation proves **submission only**, even when the extension awaits it.
After invocation, the extension writes
`records(namespace='delivery-acks', key=<frame id>)` in `$MAGI_HOME/magi.db`,
with `{pid, sessionId, sessionFile, cursor, marker, status:"submitted", at}`.
The receipt records the sessionManager file path and its size before invoking
the send API. The installed copy uses `node:sqlite` or `bun:sqlite` directly.
Confirmation uses a read-only receipt connection, without store
initialization, migrations, or a SQLite busy wait on the bounded hot path.

`confirmOmp` matches the frame id and destination pid/session. A matching
submission ack, or a frame still in the inbox, yields `queued_unread`, never
`received`. Only a new `type:"message"` record with `message.role:"user"`
and the per-write body marker in the target session JSONL yields `received`.
The target file comes from the registry row, or the receipt's sessionManager
path when necessary. The adapter's pre-dispatch cursor takes precedence over
the receipt cursor. The scan uses the same budgets, deadline and yields as
Claude ("Delivery confirmation signals", section 1). A missing frame without
submission or session evidence is `unconfirmed`.

Before invoking send, the extension moves a frame to `processing`, where it
is never automatically polled again. A known synchronous throw or
returned-promise rejection preserves its body and failure record as
`failed`; confirmation reports `failed`. The discarded runtime promise in
omp 18.4.4 cannot supply such a rejection. Successful invocation removes the
processing frame; an ack write failure logs `DELIVERY_ACK_FAILED` and does
not cause a resend. Session generation checks after awaits and before each
next frame fence shutdown and root-session switches; an interrupted send can
leave a processing frame with uncertain delivery. Inspect the evidence before
any manual resend.

Confirmation applies to live request adapters, not reply delivery paths.
The versions named above pin the underlying signals; changes here require
reinstalling the extension and restarting omp before they are live.

### When it breaks

- **No omp session in `peers`.** The extension is not loaded: see
  troubleshooting.md, "omp: replies never arrive in the session".
- **Frames do not move.** Read the `frames` rows for the session's pid in
  `$MAGI_HOME/magi.db`. `queued` rows that stay queued mean the poll is not
  running: compare omp's current event and context names with the list above.
  A `processing` row is an interrupted send whose delivery is uncertain. A
  `failed` row carries the body and the error. omp's log carries the
  extension's own lines: `INBOX_DRAIN_FAILED`, `DELIVERY_FAILED`,
  `DELIVERY_FAILURE_RECORD_FAILED`, `DELIVERY_ACK_FAILED`,
  `REGISTRY_REMOVE_FAILED`, `could not register session`.
- **The parent's replies are refused `ROLE_VIOLATION`, or it reads
  `NO_LIVE_PEER`, while a `task` subagent runs.** A subagent's copy of the
  extension registered over the parent. Check the `agents` row's
  `sessionFile`: a path inside `<parent>/` is the subagent's. The guard is
  `helperFile` and the process-wide `rootFiles` set in the extension; the two
  times this broke (omp 18.1.19, 2026-09-17; omp 18.4.4, 2026-10-08) are in
  architecture.md.
- **A registry row from before an upgrade of the extension** is not a live
  route: run `magi install --omp` and restart omp.

---

## 3. Codex (delivering into a live Codex session)

### Status

**Supported CLI surface** for the queue: stable, and the reason this
direction needed no reverse engineering. The desktop steer channel and the
history databases are private (`VERIFIED_VERSIONS.codex` and `.codexApp`).

The Codex side was re-checked at **codex-cli 0.155.1** on 2026-09-22: a live
queued request was delivered and answered, the binary still prints the
`Queued message … for thread …` receipt and the `No active session found
matching` error the bridge parses, and `thread_turns` / `thread_items` read
as described below.

### The shared daemon on another machine

The far end of the card relay (`remote-worker.mjs`) and the local steer route
("Steer through the local daemon", below) use `connectCodexDaemon`
(`codex-daemon-proxy.mjs`). It resolves that machine's
Codex binary, including `bins.json`, then starts only `codex app-server proxy`
over stdio. One two-second deadline covers the HTTP WebSocket upgrade and
app-server initialization; failure closes the connection and schedules
nonblocking proxy cleanup. Cleanup has its own one-second grace on Windows
(`taskkill`, then the owned child handle on failure/stall), not extra time on
the setup or response path. Descendants are not guaranteed terminated if tree
cleanup fails. While stdout is open, write-side terminal events, failed
callbacks and synchronous write throws are deferred, whether or not exit
has arrived. One one-second drain grace starts at the first such condition
or exit; later conditions do not reset it. Acceptance buffered on stdout
settles before deferred failures at EOF/close; a non-draining pipe is closed
when the grace expires. Exit is recorded immediately for pid safety. It never
starts a daemon or passes `explicitGatewayOauth`.

For card state, one connection serves all Codex cards in a relay `state` call.
`thread/read` with `includeTurns:false` reads only the recorded id. Loaded
`active` maps to working, or blocked on `approval` / `input` for
`waitingOnApproval` / `waitingOnUserInput`; `idle` maps to idle, and
`systemError` to unknown. Absent, `notLoaded` and failed daemon reads fall back
to the existing strict observer. Only each mirrored card's normalized state
crosses machines; no unrelated thread listing, history or notification does.

An explicit remote Codex `delivery:"steer"` reads the active turn with turns,
then sends `turn/steer` with `expectedTurnId` and a fresh
`clientUserMessageId`. The returned `turnId`, `threadId`, `clientId` and
`messageId` identify an accepted dispatch, not model receipt. `NO_ACTIVE_TURN`,
`TURN_MISMATCH`, `THREAD_NOT_LOADED` and `TURN_NOT_STEERABLE` say to send a
note instead (`delivery:"live"`). The latter maps the native -32600 review
and compact-turn refusals: nothing was submitted, so a note reservation is
released and an explicit queued retry is allowed. No failure chooses the
queue or resends. A relay delivery's actual write attempt is tracked: ssh
exit (255 or other), a subsequent pipe failure, timeout or unknown rejection
is uncertain, unless a coded server refusal proves non-dispatch. The failed
request preserves `taskId` and `round` and says to inspect history before
resending. This machine never confirms that receipt against its own history.

Steer preflight runs before the request is mirrored. A definite mutation
refusal removes only the round newly created by that delivery attempt,
guarded under the task lock against racing replies/questions, closes,
another attempt or outgoing card traffic. Event admission checks the round,
revokes rollback and commits the outbox row in one transaction; a missing
round refuses the send before reporting success. Proven pre-insert
`UNKNOWN_TASK`, `BAD_ROUND` and `ROLE_VIOLATION` errors carry
`dispatchUncertain:false` through the server and relay, so a refused note
does not spend its rate/dedupe charge. Unknown/post-commit failures still do.
Existing mirror rounds are never rolled back by a retry. Relay events bind their worker identity and
exact round from the far ledger; the owner rejects a missing or mismatched
worker before applying the event. Protocol 4 requires both ends updated.
The far end claims older unstamped events only after recovering identity from
that mirror's exact round, never a newer worker. Missing/ambiguous metadata
and expired legacy events stay unclaimed and retained, not forwarded or
acknowledged away. Run `magi doctor` on the holding machine with its relay's
`MAGI_HOME`; every invocation reports each held event's id, task, exact round,
age and reason, using bounded redacted metadata and no body. The healthy
relay's buffered stderr is not the operator-facing diagnostic. Ordinary
stamped-event retention is unchanged.

The client sends **no response**, including an error, to a reverse server
request. A newly created thread attaches all initialized connections, so an
unsolicited approval can belong to another session; replying could deny it.
The RPC client records only the method/count, not its approval payload.
The source and exact framing/error contract are
[`evidence/codex-app-server-r2-2026-10-17.md`](evidence/codex-app-server-r2-2026-10-17.md).
Offline WebSocket/fake-SSH checks cover this integration; **it has not been
run against a live shared daemon**. Local Codex delivery and headless workers
are unchanged, as are ordinary queued remote notes. Claude and omp have no
remote steer route.

### Queue delivery

```bash
codex queue --thread <uuid | exact session name> --message <text>
```

This calls `thread/queue/add`, which **writes a row** to
`~/.codex/queue_1.sqlite` (`queued_items`) and returns
`Queued message <id> for thread <id>.` Whichever process has the thread
loaded polls that table (10 s watcher) and submits the row as a user turn.
CLI delivery may wait for idle; the 0.160.1 desktop also absorbed queued
messages into running turns, as recorded below. If no process has the thread
loaded, the row waits indefinitely; two bridge test rows did exactly that.
The message id means "written", not "read". `thread/queue/list {threadId}`
(needs `experimentalApi: true` at `initialize`) shows what is still waiting;
disappearance alone is not receipt because deletion and supersession also
remove rows.

An unknown name returns `Error: No active session found matching '<name>'`.
From codex 0.155.1 a name is also refused when the thread list spans more
than one page: `Cannot verify a unique session label across server pages;
matching session UUID: <uuid>`. Magi resolves names itself (`pickSession`)
and queues by id.

The recipient sees the text as an ordinary user turn: `UserInput` has no
sender field and the TUI renders no label, which is why the bridge's header
names the sending session explicitly.

There is no reply channel. The peer answers through the bridge's MCP tool,
which is exactly what the tool exists for.

### Queue text length

Queue text goes through argv, so it is subject to command-line length
limits. Messages beyond `MAX_QUEUE_INLINE` are written to a file and replaced
with a short pointer. On native Windows CLIs the budget counts the complete
quoted command line in UTF-16 units, including quote/backslash expansion and
fixed arguments, not just the raw message. npm `.cmd` queue delivery always
uses a file. Verified on Windows with Node 23.11.0 as a native queue fixture:
17,000 quotes fail inline with `spawn ENAMETOOLONG`; file spill preserves
every quote and receives the CLI receipt. This proves native spawning and
body retention, not that a real Codex model consumed the file.

### Queued delivery confirmation (codex-cli 0.160.1)

The read-only research pass of 2026-10-06 observed an exact join:
`thread_items.item_type = 'userMessage'` in
`~/.codex/thread_history_1.sqlite`, with `item_json.clientId` equal to the
queue receipt's client id. **33 of 34** inspected receipts matched; the
unmatched receipt was superseded. **16 of 33** matching messages had an
earlier item in the same thread and `turn_id`, indicating mid-turn
absorption; 17 started a new turn. This is recorded research evidence, not a
new real-binary check.

`confirmCodex({threadId, clientId, timeoutMs})` uses the existing read-only
history reader and the same **3-second** default / `MAGI_CONFIRM_MS` deadline
as the other confirmation readers (`0` inspects once):

| `deliveryStatus` | Evidence |
|---|---|
| `received` | Exact destination-thread `userMessage.clientId`, without an earlier same-turn item. |
| `received_mid_turn` | The exact matching item has an earlier item in the same thread and turn; this remains observable after the turn completes. |
| `queued_unread` | A recoverable client id exists, but no matching history item is readable before the deadline. |
| `unconfirmed` | No recoverable client id or destination thread id; the write alone cannot establish consumption. |

Queue-add and hygienic-note receipts retain `clientId`. The public
[`codex queue` output in 0.160.1](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/session_queue_commands.rs)
prints only the queue item id and thread id; Magi recovers its client id
from that exact queue row, waiting at most another 3 seconds for request
delivery. Reply and question delivery skip that lookup wait and return the
CLI write receipt immediately. If the row is already consumed, lookup is
unavailable, or the route omits recovery, the receipt is `unconfirmed`, not
`queued_unread`; identity is never guessed from text or queue disappearance.
A receipt without its client id cannot later be upgraded from history.

Each card's current round retains its latest delivery receipt per direction
(`round.deliveries[to]`), so the peer's reply home does not erase the receipt
of the request it answers. The channel pane rechecks uncertain receipts
during later fleet polls, without another send or a ledger write. Receipt
states are not a peer answer; a missing confirmation is never a reason to
resend.

### Who is calling

Codex attaches request metadata to every MCP tool call
(`core/src/mcp_tool_call.rs` at `rust-v0.153.4`): `callId`, `threadId`,
`itemId` and `X-Codex-Turn-Metadata` (`{thread_id, turn_id}`), sent as
`_meta` on the modern protocol and as request-option meta on the legacy one.
Its own desktop tools read exactly these keys. `codexCaller` in
`src/mcp-caller.mjs` (through `codexThreadFromMeta` in `src/transport.mjs`)
reads them from the MCP `extra._meta`, so the bridge knows the calling thread
without a model-supplied `from`. Two different ids among those keys fail with
`ORIGIN_MISMATCH`. A `from` that is neither the calling thread's id nor its
name fails the same way; `from` is used only when a call carries no metadata,
and is then recorded as an unverified claim. The live check of this path is
in [mcp-caller-verification.md](mcp-caller-verification.md).

### Discovery

Over the app-server JSON-RPC, spoken on stdio:

```bash
codex app-server --listen stdio://
```

```json
{"method":"initialize","id":1,"params":{"clientInfo":{"name":"magi","title":"Magi","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
{"method":"initialized","params":{}}
{"method":"thread/list","id":2,"params":{"limit":40,"archived":false,"cwd":"C:\\work\\Magi"}}
```

Each thread returns `id`, `name`, `cwd`, `status.type`, and
`canAcceptDirectInput`. Prefer threads whose `canAcceptDirectInput` is not
`false` and whose `cwd` matches the request. `status.type` is a
`ThreadStatus`: `notLoaded`, `idle`, `systemError` or `active`. With no
`sourceKinds` the list holds interactive threads only (`cli`, `vscode`), and
its own default order is `created_at`, not recency; `listCodexThreads`
re-sorts by `recencyAt`.

Other useful methods: `thread/name/set`, `thread/read`, `thread/start`,
`turn/start`, `turn/steer`.

Whether a thread is mid-turn is not in `thread/list` from a second
app-server (everything is `notLoaded`). It is in
`~/.codex/thread_history_1.sqlite`, which the owning process keeps current
(0.153.4, re-checked 0.160.1): `thread_turns(thread_id, turn_id, status,
started_at, completed_at)` with `status` in `inProgress`, `completed`,
`failed`, `interrupted`, and `thread_items(thread_id, turn_id, item_type,
item_json, created_at_ms)` with `userMessage` / `agentMessage` items.
`src/codex-history.mjs` opens the database read-only (WAL, so it never
blocks Codex) with `node:sqlite`, and reads `unknown` on a Node without it.

A turn is busy while it is `inProgress` and its newest item
(`max(created_at_ms)` for the turn) is under 15 minutes old. A process that
dies mid-turn leaves its row `inProgress` for good: on 2026-10-08 the
database held 31 `inProgress` rows, two of them live, the oldest from July.
Measuring from the turn's start instead dropped every turn longer than 15
minutes; one tool call silent for longer still reads `unknown`.

The rollout JSONL under `sessions/` was written once when the thread started
at 0.153.4. At 0.160.x it is appended live: on 2026-10-08 the rollout of a
thread created two days earlier (`cli_version` 0.160.0) had an mtime of
seconds ago. Nothing reads it for the present either way.

`codex app-server daemon` lifecycle subcommands were Unix-only at 0.153.4;
the 0.160.1 source supports Unix and Windows (refusing an elevated launch on
Windows; fact-check 2026-10-16, evidence/rea-codex-2026-10-16.md; not run
here). Either way the CLI
still reaches the running daemon on Windows, as `codex queue` demonstrates.

### Presence without an app-server

`magi status` (the Claude Code mod polls it) counts Codex threads on the
whole machine and never starts an app-server, which costs about 3 s a run.
Checked on codex-cli 0.160.1 with desktop 26.930.7945.0 (Windows,
2026-10-08):

* `~/.codex/state_5.sqlite`, table `threads`: one row per thread with `id`,
  `name`, `cwd` (a verbatim path, `\\?\E:\repo`, which the reader strips),
  `preview`, `git_branch`, `model`, `agent_nickname`, `agent_role`,
  `recency_at` (epoch seconds), `archived` (0/1) and `source`. `source` is
  `vscode` or `cli` for interactive threads, `exec` for headless runs, and a
  JSON object (`{"subagent":…}`) for subagents and guardian reviews.
  `codexPresence` takes `archived = 0 and source in ('cli', 'vscode')`, most
  recent first, 40 rows: the same set thread/list returns by default.
* `~/.codex/thread-writer-locks/<threadId>.lock`: empty files. On that day
  they existed for exactly the two threads open in the desktop and three
  subagents of theirs. Read as `open: true` on the row and counted live
  however long the thread has been quiet. This is an inference from one
  observation; nothing documents the directory.

Any error opening or querying either database falls back to `thread/list`
with no `cwd`. Routing still uses `thread/list` scoped to the request's
directory. If the schema moves, compare `pragma table_info(threads)` and the
two history tables with the columns above.

### Desktop steer channel

When this machine's daemon does not hold the thread ("Steer through the
local daemon", below),
`delivery: "steer"` calls the desktop app's `codex_app` MCP tool
`send_message_to_thread` (`{threadId, prompt}`, caller in `_meta.threadId`)
by starting the bundled plugin's own `server.mjs` with
`CODEX_APP_TOOLS_PIPE_PATH` set. The only moving part is finding that pipe
(`findAppTools` in `src/transport.mjs`):

* **Older app-servers**: the desktop inlines
  `-c mcp_servers.codex_app={cwd=…,env={CODEX_APP_TOOLS_PIPE_PATH=…}}` on the
  app-server command line, and magi parses it from the process list.
* **Desktop 26.915.4065.0** (checked 2026-09-22 on Windows, plugin
  `codex-app-tools` 0.1.4): when the app-server supports
  `pluginMcpConfigOverrides`, the command line carries only
  `-c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`.
  The plugin's `.mcp.json` forwards the pipe through `env_vars`, inherited
  from the app-server's environment, which the Electron main process sets
  after creating the pipe. On Windows the pipe is named with the app's
  browser-use prefix, `\\.\pipe\codex-browser-use-<uuid>`, beside real
  browser-use pipes. So magi takes the newest
  `~/.codex/plugins/cache/openai-bundled/codex-app-tools/<ver>`, sends
  `tools/list` through each such pipe, and uses the one listing
  `send_message_to_thread`. A live `deliverToCodexSteer` into a mid-turn
  thread then landed as a `<codex_delegation>` item inside that turn,
  between two of Codex's own edits, with no queue row created (discovery
  plus send took about 1 s). Only macOS peer-checks the socket; on Windows
  any same-user process is accepted. macOS names it `<dir>/<uuid>.sock` and
  is not probed.
* **Desktop 26.1023.6621.0** (read 2026-10-29 in its `main` bundle, plugin
  `codex-app-tools` 26.1021.31345; **not seen live**, the desktop was not
  running): the app-tools server creates its own pipe directory,
  `nativePipeDirectory: win32 ? "\\\\.\\pipe\\codex-app-tools" : "/tmp/codex-app-tools"`,
  where 26.915 shared `codex-browser-use`. `probeAppToolsPipe` now lists
  both `codex-app-tools-*` and `codex-browser-use-*` pipes and still keeps the
  one whose `tools/list` offers `send_message_to_thread`. Before this, a
  26.1023 desktop whose app-server did not inline the config would have given
  `NO_STEER_CHANNEL`. `tools/call` there requires `callerSource`, `callId`,
  `namespace`, `threadId`, `tool` and `turnId`; the plugin's `server.mjs` fills
  them from `_meta`, which Magi already sends. Details:
  [rea-codex-2026-10-29.md](evidence/rea-codex-2026-10-29.md).

**When steer returns `NO_STEER_CHANNEL` while the desktop app is running**
(`magi doctor` warns about the same): search the app's `resources/app.asar`
for `CODEX_APP_TOOLS_PIPE_PATH` to see how the path is passed now, then list
`\\.\pipe\` and probe each candidate with `tools/list`. The fix belongs in
`findAppTools`.

### Steer delivery confirmation (codex-cli 0.160.1; desktop 26.930.7945.0 per the 2026-10-08 research)

Read-only research on `~/.codex/thread_history_1.sqlite` (2026-10-08):
`send_message_to_thread` returns only `{threadId}` (531 of 531 recorded tool
calls, `structuredContent` null), so there is no client id to join. The
steered text is stored in the target thread as
`thread_items.item_type = 'functionCallOutput'` with `item_json`
`{type, id, name: 'send_message_to_thread', namespace: 'codex_app', output}`
(1446 of 1446), where `output` is

```text
<codex_delegation>
  <source_thread_id>…</source_thread_id>
  <input>ESCAPED TEXT</input>
</codex_delegation>
```

and the input is XML-escaped (`<` → `&lt;`, `&` → `&amp;`). 914 of the 1446
name the target thread itself as the source (Magi's self-relay).

`deliverToCodexSteer` therefore appends a bare token,
`\n\nmagi-delivery:<uuid>` (no HTML comment: escaping would mangle it), and
before the send reads the thread's `max(rollout_ordinal)` as the cursor
(`codexThreadCursor`, -1 for an empty thread). `rollout_ordinal` is unique
per thread (`idx_thread_items_page`); `created_at_ms` is not write order: of
the 1431 first model items written after a steer, 57 (all
`commandExecution`) carry an earlier `created_at_ms` than the steer, by up
to 424 seconds. `codexSteerState(threadId, marker, cursor)`:

| `deliveryStatus` | Evidence |
|---|---|
| `accepted` | No matching item after the cursor yet (or the history is unreadable). |
| `queued_unread` | The marker is in a `functionCallOutput` after the cursor, but nothing in that turn shows the model read it. |
| `received` | Read: a later `reasoning`/`agentMessage` item in the same turn, or a later `commandExecution`/`mcpToolCall` created at or after the steer, and no earlier item in that turn. |
| `received_mid_turn` | As `received`, with an earlier item (by `rollout_ordinal`) in the same turn. |

A command already running when the steer landed can finish, and be written,
after it; that is why tool items count only when created after the steer.
Of the 1446 recorded steers, 1431 have a later `reasoning`/`agentMessage` in
their turn. The 15 that do not sit in turns that ended `failed`
(`usageLimitExceeded`, `serverOverloaded`, or `other`), one turn left
`inProgress`. They stay `queued_unread`, not `failed`: the item is stored in
the thread, so a resend risks a duplicate.

The native-lane rejection seen on gpt-6-astra/gpt-6.1-sol threads
(`unsupported_native_inflight_message`, "The experimental native turn lane
cannot accept stateful WebSocket messages while a native turn is running")
was not found in any store Magi can read: not in `thread_turns.error_json`
(74 failed turns, none with it), `thread_items`, `thread_realtime_items`,
`~/.codex/logs_2.sqlite` (rows covering 2026-10-05 to 2026-10-08), the
rollout JSONL under `~/.codex/sessions`, or the desktop logs under
`%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Codex\Logs`.
The desktop log records each steer as `turn/start` and
`Sending server response … success=true tool=send_message_to_thread`,
nothing more. The model does not predict it either: 288 of 294 steers into a
gpt-6.1-sol thread (01a0ef8a) and 7 of 8 into a gpt-6-astra thread on
0.160.0 (01a111ec) were absorbed mid-turn and read, and `models_cache.json`
carries no lane flag. So Magi neither reports it as `failed` nor reroutes
steer by model; a rejected steer stays `accepted`.

### Steer through the local daemon (codex-cli 0.163.0, daemon 0.161.0)

A terminal Codex is a client of the machine's shared app-server daemon, so
its threads are loaded there and any other client of that daemon can steer
them. Checked on Windows 11, 2026-10-18:

* `codex app-server daemon version` reported the daemon running, its socket
  at `~/.codex/app-server-control/app-server-control.sock`.
* Both `codex --remote unix://` and plain `codex` put their thread in the
  daemon's `thread/loaded/list`; closing the TUI leaves it loaded ("Any
  running work continues"). With `--remote` the thread's cwd is the daemon's
  own folder unless `-C <dir>` is passed; plain `codex` records the terminal's
  folder. `state_5.sqlite` records both with `source = 'vscode'`, so the
  source column cannot tell a terminal thread from a desktop one, and both
  get a `thread-writer-locks/` file.
* `turn/steer` with `expectedTurnId` sent over `codex app-server proxy` into
  a running turn landed as a `userMessage` in that turn, carrying the
  `clientUserMessageId` as its `clientId`, and the model's next item answered
  it. Through the shipped `makeCodexLiveDelivery`, against a plain `codex`
  session: accepted in 857 ms, `received_mid_turn`, and the model replied as
  told. `codex queue` to the same daemon-held thread, idle, was taken as a new
  turn within a second.
* `thread/read` of an id the daemon does not hold fails `thread not loaded:`
  (`THREAD_NOT_LOADED`); it does not load the thread.
* On Windows the live socket is a reparse point that `lstat` refuses with
  `EACCES` (Node 24.20), so `existsSync` reads it as absent. Magi counts any
  error except `ENOENT`/`ENOTDIR` as present.

`steerCodexThread` (`src/transport.mjs`) is every Codex steer: a live
request, note or watch, and a steer reply or answer to a Codex orchestrator.
It asks `steerLocalDaemon` (`src/codex-daemon-proxy.mjs`) first, which starts
`codex app-server proxy` only when the socket is there, reads the thread, and
steers its active turn with a fresh client id (`steerLoadedThread` in
`src/codex-daemon.mjs`, shared with the remote far end). The daemon not
running, not answering, or not holding the thread hands over to the desktop
route above. Any other refusal is the answer and nothing falls through: an
idle thread is `NO_ACTIVE_TURN`, and the error says to send the message with
`delivery:"live"`, which an idle terminal session takes at once. When the
desktop route then finds no channel, its `NO_STEER_CHANNEL` says that the
daemon did not hold the thread either.

The receipt is the queue's: `confirmCodex({threadId, clientId})` joins the
history's `userMessage.clientId`. The steered item always follows the turn's
own first item, so a confirmed daemon steer reads `received_mid_turn`; before
the history shows it, `queued_unread`. Steer replies return at once with the
client id, which the fleet poll can upgrade later. No marker is appended to
the text.

A thread held by a terminal Codex that is not on the daemon (an older CLI,
or a daemon that is not running) has no steer route into it. Steering it
through the desktop tool would make the desktop load a thread another process
writes; that was not tried. Send it with `delivery:"live"`.

**When a steer to a terminal Codex stops arriving:** run `codex app-server
daemon version` to see whether the daemon runs and where its socket is, then
compare that path with `codexDaemonSocket()`. Check `thread/loaded/list`
through `codex app-server proxy` for the thread. If the socket moved, read
`socketPath` from `daemon version` instead of composing it.

---

## 4. Headless channels (a headless omp, Claude or Codex that takes notes)

`runHeadless` (`src/serve.mjs`) holds a headless worker on its stdin for the
length of the run (`src/worker-channel.mjs`), so a card note reaches it
mid-run. All three are
line protocols, one JSON object per line each way.

### When one of these breaks

Symptoms: a headless run that never ends until `TIMEOUT` (the finish
condition is never met), a note that stays `queued_unread`, or, for Codex, a
`PEER_FAILED` naming `thread/start`, `turn/start` or an unexpected
parameter, or `PROTOCOL_ERROR`/`APPSERVER_TIMEOUT` (rerun with
`MAGI_CODEX_WORKER_TRACE`).

1. Run the harness by hand with the launch line below.
2. Paste the request frame(s) from the table.
3. Compare its stdout with the table, line by line.
4. Fix the session code: `ompRpcSession` (`src/omp-launch.mjs`),
   `claudeStreamSession` (`src/exec.mjs`) or `codexAppServerSession`
   (`src/codex-launch.mjs`); the fake in `test/helpers/fake-cli.cjs`; and the
   tables and versions here.

Done when the hand-run session reaches the finish condition stated under its
table, the fake speaks the same frames, and `npm test` passes.

### What was checked, and against what

* **Flags, on the installed binaries.** `omp --help` on **omp 18.4.4** lists
  `--mode rpc` and `--no-ui`; `claude --help` on **Claude Code 2.1.290** lists
  `--input-format`, `--replay-user-messages`, `--permission-prompts` and
  `--verbose`; `codex app-server` on **codex-cli 0.160.1** accepts `-c
  key=value` and `--enable/--disable`.
* **Codex parameter schema, on the installed binary.** `codex app-server
  generate-json-schema` on **0.160.1**: `TurnSteerParams` is `{threadId,
  input, expectedTurnId, clientUserMessageId}`, with `threadId`, `input` and
  `expectedTurnId` required. The method list and the
  `turn/start` fields, including `clientUserMessageId` and `sandboxPolicy`,
  are in `docs/evidence/codex-messaging-schema-0.153.4.json`.
* **Frame shapes, from documentation first.** omp: `docs/rpc.md` in
  can1357/oh-my-pi (main, read 2026-10-08). Claude and Codex: the design
  research behind these channels. The offline fakes in
  `test/helpers/fake-cli.cjs` speak exactly what is written below; a live
  smoke (`PEER_E2E=1`, or one headless note by hand) is what confirms it.
  The live checks made since are recorded under each harness below.

### omp `--mode rpc --no-ui`

Launch: `omp --mode rpc --no-ui --no-extensions --no-skills --no-title
[--cwd D] [--model M] [--resume S] [--advisor] [--config F] [--tools read,grep,glob,web_search]
--approval-mode always-ask|write|yolo`. `--tools` goes only with the read-only
`always-ask`; `write` is a request that may edit, `yolo` one that may also run
commands (under the operator's launch wrapper, see
[security.md](security.md)); `--config F` is the per-run overlay described
under "The advisor".

| Direction | Frame | Use |
|---|---|---|
| out | `{type:"ready", protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes, maxReassembledFrameBytes}` | first line; nothing is written before it |
| in | `{id, type:"negotiate_protocol", protocolVersion:2}` | after its success, an oversized frame arrives as `rpc_chunk` sequences instead of being truncated |
| out | `{type:"rpc_chunk", chunkId, index, count, byteLength, data}` | base64 parts of one UTF-8 JSON object, in order, never interleaved; reassembly capped at 64 MiB; a broken sequence is a run error |
| in | `{id, type:"set_event_filter", events:["agent_start","agent_end","message_end"]}` | drops `message_update` (per-token deltas); responses, `prompt_result` and `session_settled` are never filtered |
| in | `{id:<request id>, type:"prompt", message}` | the request |
| in | `{id, type:"get_state"}` | response `data.sessionId` is the thread a follow-up resumes |
| in | `{id:<note id>, type:"prompt", message:"<note>\n<!-- magi-delivery:<note id> -->", streamingBehavior:"steer"}` | a note: steered into the running turn, or a fresh turn when idle |
| out | `{id, type:"response", command, success, data?, error?}` | `success:true` for a prompt means admitted (the note's `queued_unread`); `data.agentInvoked:false` means it finished locally and no `prompt_result` follows |
| out | `{type:"message_end", message:{role, content, usage?, stopReason?}}` | assistant: the reply text and usage, as in `--mode json`; user: the note's receipt, found by its marker |
| out | `{type:"agent_start"}`, `{type:"agent_end", yielded?, isTerminal?}` | run boundaries; a note that is not its run's first user message was received mid-turn |
| out | `{type:"prompt_result", id, agentInvoked, status, error?, sessionSettled}` | exactly one per accepted prompt; `status` `error`/`aborted` is a run error |
| out | `{type:"session_settled"}` | nothing (no queued note, no background job) can wake the agent again |

The run is finished when every prompt id it sent has its outcome and the
session is settled (`prompt_result.sessionSettled:true` or a later
`session_settled`); then stdin is closed, and omp drains, disposes the
session and exits 0.

Observed live on omp 18.4.4 (2026-10-08): `ready`, a steered note's user
`message_end` inside the running turn, `prompt_result {status,
sessionSettled}`, `session_settled`, clean exit on stdin close;
`negotiate_protocol` takes `protocolVersion`.

#### The advisor (`--advisor`)

`omp --help` on **omp 18.10.4** lists `--advisor` ("Enable the advisor runtime
(passively reviews each turn and injects notes)"). oh-my-pi's
`docs/advisor-watchdog.md` (main, read 2026-10-14) says an RPC host starts with
the advisor off whatever `advisor.enabled` holds, which is why Magi passes the
flag (`headlessOmpArgs({ advisor: true })`). With no override the advisor runs
on the user's `modelRoles.advisor`. Magi picks one that differs from the worker's
model instead (`src/omp-advisor.mjs`) and passes it as a `--config` overlay
(below).

Run on **omp 18.10.4** (2026-10-14), real binary, the launch above plus
`--advisor`, a read-only worker reading a file whose answer sat in the middle:

* The run adds `advisor_yielded` to the event stream, and omp writes
  `<session>/__advisor.jsonl` (the advisor's own turns, with its usage). A run
  without the flag has neither. `advisor_cost_changed` appears **with or
  without** the flag, so it is not evidence the advisor ran.
* A note arrives in the worker's own stream as `{type:"message_end",
  message:{role:"custom", customType:"advisor", display:true, content}}`, so it
  passes Magi's `set_event_filter` (`message_end`). `content` is one or more
  `<advisory severity="nit|concern|blocker" guidance="weigh, don't blindly
  obey">…</advisory>` elements with the note XML-escaped; a named advisor adds
  `advisor="Name"`. `advisorNotes` (`src/omp-launch.mjs`) reads them. The same
  message is a `custom_message` record in the worker's session file.
* In the first of three runs the advisor read the worker's file read, saw that
  the middle of the file had been elided, ran its own `grep`, and sent a
  `concern` naming the line; the worker's next call was a targeted `grep` and it
  answered correctly. Three small advisor turns cost under $0.005. The control
  run without the flag also answered correctly, so this shows the mechanism, not
  that the advisor improves outcomes.
* Through Magi's own `omp_peer` server (three requests): the flag took effect
  each time, one request returned a note under the reply, and the other two had
  nothing to say. In one the advisor's review (a `read` and a `glob`) was still
  running when the worker finished and the run ended without it. Magi does not
  wait for the advisor, so a note counts only if it lands before the worker's
  last message.

**Choosing the model.** omp has no flag for the advisor's model (`--smol`,
`--slow` and `--plan` exist; `--advisor` is a switch), and no environment
variable for it. oh-my-pi's `docs/config-usage.md` ranks a `--config <file>`
overlay above the user's global and project config for that process.
Run on **omp 18.10.4** (2026-10-14), real binary, the launch above plus
`--advisor --config <file>` where the file held
`modelRoles:\n  advisor: "openai-codex/gpt-6.1-sol:medium"` and the user's own
`modelRoles.advisor` was `openrouter/deepseek/deepseek-v4.1-flash:high`: all
three of the advisor's turns in `__advisor.jsonl` carry `model: gpt-6.1-sol`. The
overlay wins; it is strict (a missing file is a hard error), so Magi writes it
before the launch and deletes it after. `omp config get modelRoles` prints the
record as one line of JSON (`{"advisor":"...","default":"..."}`); that is how
Magi learns the worker's default model and the user's advisor role. The rpc
`get_state` response carries `data.model` (`{provider, id, ...}`), which Magi reads
to check, after the run, which model the worker actually ran on. A real request
through Magi's `omp_peer` server with a `gpt-6.1-sol` default and a DeepSeek
advisor role chose DeepSeek, said so under the reply, and left no overlay behind.

Not checked: the advisor's `WATCHDOG.md` / `WATCHDOG.yml` guidance, and the
`advisor.reviewMode`, `reviewInterval` and `syncBacklog` settings, under this
launch. Read in the 18.10.4 source (fact-check 2026-10-17): an RPC host's protocol defaults for `advisor.*` are soft
(`config/settings.ts:1010-1014`), so a configured value from any layer
(global, project, an overlay, the environment) survives them, oh-my-pi's docs
notwithstanding. A user's `advisor.enabled: true` therefore turned the
advisor on for every headless worker; every run's overlay now sets
`advisor.enabled` itself. `syncBacklog` takes the strings `"off" | "1" | "3"
| "5" | "strict"`; a bare number is invalid and reads as `off`. Not yet run
against a user config with the advisor on.

omp 18.14.0 (read, not run; [rea-omp-2026-10-29.md](evidence/rea-omp-2026-10-29.md)):
`advisor.continueSeverity` defaults to `concern`, so a note after the final
answer wakes the worker; the overlay pins it to `blocker`. `--approval-mode`
gained `always-ask-cached`, which Magi reads as `prompting`.

When it breaks: no `advisor_yielded` and no `__advisor.jsonl` with `--advisor`
means omp stopped honouring the flag under `--mode rpc`; a note that no longer
reaches `result().advice` means the custom message changed shape. Re-run the
check above by hand, then fix `advisorNotes` and `test/helpers/fake-cli.cjs`
(which emits the message the way omp does).

### Claude `-p --input-format stream-json`

Launch: `claude -p --input-format stream-json --output-format stream-json
--verbose --replay-user-messages [--model M] [--resume S]
--permission-prompts none` plus the per-branch restrictions in
[security.md](security.md), "What a headless peer may do".

| Direction | Frame | Use |
|---|---|---|
| in | `{type:"user", message:{role:"user", content}, parent_tool_use_id:null, session_id:"", uuid}` | the request; every message carries a fresh uuid |
| in | the same with `priority:"next"` | a note: taken at the next step boundary of the running turn |
| out | `{type:"user", uuid, isReplay:true, ...}` | `--replay-user-messages` echo: the note's `queued_unread` |
| out | `{type:"result", subtype, is_error, result, session_id, usage, total_cost_usd, ..., user_message_uuids:[...]}` | ends each turn; the uuids it lists were consumed by that turn |

The run is finished when every uuid sent appears in some result's
`user_message_uuids`; the last result is read by the same code as
`--output-format json` (`claudeResult`). A result without
`user_message_uuids` is taken to consume everything outstanding.

Observed live on Claude Code 2.1.290 (2026-10-08, haiku): the replay echo
carries the sent uuid with `isReplay:true`; each `result` carries
`user_message_uuids` and `user_message_uuid`. A note sent 3.4 s into a turn
that made no tool call was not taken mid-turn: the turn ended (result for the
request uuid) and the note opened the next turn (result for the note uuid),
whose answer reflected it. So a note lands mid-turn only at a step boundary
between tool calls; otherwise it is `received` on the following turn. An
expired login returns a result with `is_error:true` and
`terminal_reason:"api_error"`, reported as AUTH_REQUIRED.

### Codex `app-server` as a headless worker

Launch: `codex app-server --listen stdio://` plus `-c
mcp_servers.<name>.enabled=false` for each bridge server the user's
`config.toml` defines, with `PEER_DEPTH=1` in its environment and the
request's directory as its cwd. A process of its own per run, never the
shared client `src/transport.mjs` keeps for listing threads. No `"jsonrpc"`
member on any message; `id` and `method` together are a request from the
server.

| Direction | Message | Use |
|---|---|---|
| in | `{id, method:"initialize", params:{clientInfo, capabilities:{experimentalApi:true}}}`, then `{method:"initialized"}` | as the shared client introduces itself |
| in | `{id, method:"thread/start", params:{cwd, model?, approvalPolicy:"never", sandbox:"read-only"\|"workspace-write", threadSource:"exec"}}` | result `thread.id` is the session id a follow-up resumes; `threadSource` lists the thread as `codex exec` threads were |
| in | `{id, method:"thread/resume", params:{threadId, cwd, model?, approvalPolicy:"never", sandbox}}` | a follow-up round; the sandbox is set again, as `exec resume` did not |
| in | `{id, method:"turn/start", params:{threadId, input:[{type:"text", text, text_elements:[]}], clientUserMessageId, cwd, approvalPolicy:"never", sandboxPolicy:{type:"readOnly"}\|{type:"workspaceWrite"}}}` | the request; result `turn.id` is the turn a note steers into |
| out | `{method:"turn/started", params:{threadId, turn:{id}}}` | the turn is active (also learned from the `turn/start` result) |
| in | `{id, method:"turn/steer", params:{threadId, expectedTurnId, input, clientUserMessageId:<note id>}}` | a note; a success result is its `queued_unread`, an error after the turn ended is `WORKER_FINISHING`, no answer in 60 s leaves it `unconfirmed` |
| out | `{method:"item/started"\|"item/completed", params:{threadId, turnId, item:{type:"userMessage", content, clientId?}}}` | if it comes: the note's `received_mid_turn` (`received` when it opened a later turn), matched by our id (`clientId` or `clientUserMessageId`), else by its text |
| out | `{method:"item/completed", params:{threadId, turnId, item:{type:"agentMessage", text, phase}}}` | the reply: `phase:"final_answer"`, else the turn's last one |
| out | `{method:"thread/tokenUsage/updated", params:{threadId, turnId, tokenUsage:{total, last, modelContextWindow}}}` | `total`/`last` are `{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens}`; usage is the last `total` less the first event's `total - last` |
| out | `{method:"error", params:{error:{message}, willRetry}}` | an unretried one explains a failed turn that carries no error of its own |
| out | `{method:"turn/completed", params:{threadId, turn:{id, status, error?}}}` | `completed`, or `failed`/`interrupted`, a run error; `completed` is also `received_mid_turn` for every note accepted into that turn and not yet matched |
| out | `{id, method:<anything>, params}` | a server request (approval, `item/tool/requestUserInput`, elicitation): answered `{id, error}` |
| in | `{id, method:"thread/unsubscribe", params:{threadId}}` | once the turn and every steer have settled; the tree is then killed |

Magi stops the run itself, without waiting for its timeout, when the server
does not answer `initialize`, `thread/start|resume` or `turn/start` within
60 s (`APPSERVER_TIMEOUT`), when it answers one without the thread or turn id
or writes a stdout line that is not JSON (`PROTOCOL_ERROR`), or when it
refuses one (`PEER_FAILED`, or `AUTH_REQUIRED` when the refusal reads as a
sign-in failure). A server that exits first is judged from its exit and
stderr as `codex exec` was; its stdout is closed 2 s after the exit even if
a descendant still holds it.

`MAGI_CODEX_WORKER_TRACE=<file>` in the Magi server's environment appends
every message the worker's app-server sends (per-token deltas excepted, long
lines truncated) and any non-JSON stdout line, one JSON object per line.

Notifications carrying another `threadId` (a subagent's) are ignored. The
`exec` flag `--skip-git-repo-check` has no counterpart: the trusted-directory
check is `codex exec`'s own, and the app-server is not expected to make it.

Checked against **codex-cli 0.160.1** (orchestrator, 2026-10-08):
`generate-json-schema` gives `SandboxMode` `read-only|workspace-write|
danger-full-access` (the thread's `sandbox`), `SandboxPolicy` types
`readOnly|workspaceWrite|...` (the turn's), `approvalPolicy`, `cwd`, `model`
and `sandbox` on both `ThreadStartParams` and `ThreadResumeParams`, and
`threadSource` (`ThreadSourceKind`, which includes `appServer`, `exec`,
`cli`, `vscode`) and `ephemeral` on `ThreadStartParams` only. A live run
through `runHeadless` and `deliverHeadlessNote` answered, took a note sent at
7 s into its running turn (the reply used it), reported usage and a thread
id, and left no worker process. No `userMessage` item for that note was
matched by the rules above as they then stood (id, or exact text, when the
item carried no id), so its receipt stayed `queued_unread`; the
turn-completion rule and the looser text match are the response, and that
completion means the input was taken is an inference from the reply, not an
observed item.

Still open, for the next live probe:

- the actual shape of a steered input on the notification stream (run with
  `MAGI_CODEX_WORKER_TRACE`);
- whether `threadSource:"exec"` is accepted (a refusal fails every headless
  run at `thread/start` with `PEER_FAILED`; drop the field then, and the
  default `appServer` source is still outside `codexPresence`'s `source in
  ('cli','vscode')`), and what `thread/list`'s default listing makes of the
  thread either way;
- the exact error text of a steer into an ended turn;
- whether `thread/unsubscribe` answers before the rollout is flushed.

---

## The desktop apps' URL schemes

`magi spawn --app` opens a session in the Claude Code desktop app or the
Codex desktop app through the URL scheme each registers with the OS. Neither
vendor documents any of this; the routes were read from the installed
bundles and every observation below was made live on this machine on
2026-09-16 (Windows 11; Claude Code app 2.110.0.0 with CLI 2.1.271; Codex app
26.908.9136.0 with CLI 0.153.4). `VERIFIED_VERSIONS.claudeApp` / `.codexApp`
pin them; `magi doctor` says when the installed app is newer, and warns
`no URL handler seen` (spawn then reports `SPAWN_FAILED`) when the scheme is
not registered. Codex app 26.915.4065.0 was re-read from its bundle on
2026-09-22, not opened: `codex://threads/new` still routes to a new thread
and reads `path` and `prompt` (alongside `browserUrl`, `mode`, `originUrl`).

**When it breaks**: the launcher exiting 0 says only that the OS took the
URL; whether the app accepted the route is established by correlation, never
assumed. Re-read the route table from the app's `app.asar` URL handler and
compare it with the tables below; then open one URL by hand and watch for
the prefilled composer and, after sending, the marker in the first user
message.

### Launching a URL

`openUrl` in `src/spawn.mjs` hands the URL to the scheme's registered
handler with `rundll32.exe url.dll,FileProtocolHandler <url>` on Windows
(`open` / `xdg-open` elsewhere). Not `cmd /c start`: cmd splits a URL at
every `&` and expands `%x%`, and the first Step 0 launch reached the app
with only the part before the first `&` (the app focused and did nothing).
Through rundll32, a folder with a space and a prompt containing `&`, `é`
and `100%` arrived intact in the app's composer (checked in the Claude app).

### Claude Code desktop (`claude://`)

Registered by the Store package: `HKCR\claude` carries the `URL Protocol`
value and no command of its own (a `shell\open\command` key pointing at
`…\WindowsApps\Claude_<version>_…\app\Claude.exe` was there earlier on
2026-09-16 and gone by the evening, so `doctor` reads the value, and the
version from `Get-AppxPackage Claude`). Routes, from `app.asar`'s URL
handler:

| Route | What it does |
|---|---|
| `claude://code/new?folder=<abs dir>&q=<text>` (`prompt=` alias; `source=` optional) | opens the new-session view for that folder with the text **prefilled** in the composer, not sent. Observed: nothing registers and no transcript exists until the human presses Enter. The app's own jump list issues `code/new?folder=…&source=jump_list`. |
| `claude://code/continue?session=<local_id>`, `claude://code/needs-input?session=<local_id>`, `claude://claude.ai/epitaxy/<local_id>` | open an existing app session |
| `claude://resume?session=<cli uuid>` | imports a stopped CLI transcript as an app session (`adoptCliSession`). Not for a live session; not used. |

The Code UI itself is served from the claude.ai origin (`DI()` navigates the
webview to `/epitaxy?q=…&folder=…&src=external`), so `q`'s behaviour is the
web UI's and was settled only by watching it: prefilled, not sent.

After the human sends, the app starts a new session **in a worktree it
makes under the folder**, `<folder>/.claude/worktrees/<slug>`, not in the
folder itself (its default; the slug is derived from the prompt). The CLI
process registers in `~/.claude/sessions/<pid>.json` like any other, with
`entrypoint: "claude-desktop"`, `kind: "interactive"`, `name` = a slug
derived from the worktree (`magi-peer-step0-410be6-a8` for a prompt
beginning "…Magi peer step0…"), `nameSince === startedAt`. The app's own
title ("Magi peer step0 setup") is separate and not in the registry.

The app id is **not** derivable from the CLI session id in general: it is
`local_<cliSessionId>` for a session never cleared or resumed, and something
else after a `/clear` (the app keeps the same app id and moves to a new
CLI session; observed: app `local_0c2e2741…` running CLI session
`783e059b…`). The app's own records are the mapping: one JSON per app
session under `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude-code-sessions\<account>\<org>\local_<appId>.json` (Store
install; `%APPDATA%\Claude\claude-code-sessions\…` otherwise) with
`sessionId` (the app id), `cliSessionId` (current) and `priorCliSessionIds`.
`claudeAppSessionIndex` in `src/transport.mjs` reads them (10 s cache) and
`claudeAppLink` gives `claude://claude.ai/epitaxy/<appId>` only when a
record names the CLI session; a session the app has not recorded yet gets
no link rather than a guessed one. Checked against the app's own session
list on 2026-09-16: every link matched.

The session's transcript (`~/.claude/projects/<slug of the worktree>/
<sessionId>.jsonl`) has the prompt in its **first `user` record**, after a
`<system-reminder>…</system-reminder>` block the harness prepends to the
same record:

```
<system-reminder>
You are operating in a git worktree.
…
</system-reminder>

magi-spawn:c03b28bb-… You are the Magi peer "step0". …
```

`firstUserMessage` (`src/session-tail.mjs`) reads the file forwards, strips
the leading reminder blocks, and that is where the marker is matched. A
live `FACT_CHECK` sent to the new session by id (`delivery: "live"`) was
answered from inside the app.

### Codex desktop (`codex://`)

Declared as `Protocol Name="codex"` in the Appx manifest
(`HKCU\Software\Classes\codex` carries the `URL Protocol` value and no
command; the package handles it). Routes, from `app.asar`:

| Route | What it does |
|---|---|
| `codex://threads/new?path=<abs dir>&prompt=<text>[&mode=…]` | opens the app on that project (`path` must resolve to a directory) with the prompt **prefilled** (`prefillPrompt`), not sent. Observed. `codex app [PATH]` is the supported CLI form without a prompt; `Codex.exe --open-project <path>` is what it runs. |
| `codex://threads/<threadId>` | opens an existing thread |

Nothing exists until the human sends. Then the thread is in `thread/list`
and in `thread_history_1.sqlite`; `codexFirstUserMessage`
(`src/codex-history.mjs`) reads the marker from the earliest `userMessage`
row (`order by created_at_ms asc limit 1`; checked against an existing
thread, whose earliest row is its opener, not its latest). Sending was not
exercised on 2026-09-16 (the account's window was at 99 %); the prefilled
composer was observed and the query was checked on existing threads.

### What `spawn --app` therefore is

Pending by default: the launch opens the app with the prompt ready, waits
30 s for a human who is right there to press Enter, and otherwise returns
`pending` with the `spawnId`; `magi spawn <harness> --name <n> --cwd <dir>
--resume <spawnId>` claims the session once it exists, by the marker in its
first human message and nothing else. Two sessions carrying the same marker
is `SPAWN_AMBIGUOUS`. `permissionMode` and `model` cannot travel through a
URL and are refused with `app` rather than dropped.
