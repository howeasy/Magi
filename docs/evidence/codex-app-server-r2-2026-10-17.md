# Codex app-server over the shared daemon: the contract R2 builds on (2026-10-17)

Groundwork for REA track R2 (Codex on another machine through `ssh host
codex app-server proxy`), from the openai/codex source at **rust-v0.160.1**
(commit `d27764b82f7118f674371e6d6e76271d9d606edb`; paths under `codex-rs/`).
Researched read-only by an omp peer, source only: no
daemon, socket, sign-in or traffic. Spot-checked by me: the auto-attach of
every initialized connection to a new thread (`app-server/src/lib.rs`,
`thread_created_rx` branch), and Magi's own `appServerRpc` declining every
server request with -32601 (`src/transport.mjs`, `decline`). Everything else
is the peer's reading at that tag, cited below; verify live before shipping.

## The handshake and framing

Over the proxy's stdin, CRLF lines and a blank line:

```http
GET /rpc HTTP/1.1
Host: localhost
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64 of 16 random bytes>
Sec-WebSocket-Version: 13
```

- `/rpc` and `/` both work; only `/daemon/shutdown` is special
  (`app-server-transport/src/transport/unix_socket.rs:168-203`; the daemon's
  own probe uses `ws://localhost/`, `app-server-daemon/src/client.rs:63-74`).
  No token, Origin, subprotocol or compression on this route
  (`transport/websocket.rs:183-193`).
- Check `101`, Upgrade and Connection, and `Sec-WebSocket-Accept =
  base64(SHA1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`. The framing is
  tungstenite 0.27.0 pinned at `4fffad30fe37…` (`Cargo.lock:16157-16159`).
- Client frames masked, server frames unmasked; an unmasked client frame is
  refused. One JSON object per UTF-8 **text** message (binary is dropped:
  `transport/websocket.rs:310-377`). The server sends one FIN frame per
  message and accepts fragmented client messages. Ping gets a Pong with the
  same payload; there is no server ping timer; Close ends the connection, so
  never wait forever for a close reply. Limits in: 16 MiB a frame, 64 MiB a
  message; nothing bounds what the server sends (a large history read is one
  frame).
- A minimal client: send unfragmented text, no extensions; handle leftover
  bytes after the HTTP response, split and joined chunks, 7/16/64-bit
  lengths, a fresh mask per frame, control frames, bounded buffers, and EOF
  failing every pending call.

## The calls

No `jsonrpc` member: requests `{id, method, params}`, results `{id,
result}`, errors `{id, error:{code, message, data?}}`, notifications without
an id (`app-server-protocol/src/rpc.rs:1-88`). A notification can arrive
before its call's result, so correlation is set up before a send.

- `initialize` `{clientInfo:{name:"magi", title:"Magi", version}, capabilities:
  {experimentalApi:true, requestAttestation:false, optOutNotificationMethods:
  [the item/*/delta methods]}}` → `{userAgent, codexHome, platformFamily,
  platformOs}`; then the notification `initialized`. Queue methods need
  `experimentalApi`. The daemon is shared: do not send
  `explicitGatewayOauth`, which sticks for later connections
  (`app-server/src/request_processors/initialize_processor.rs:139-215`).
- `thread/list` `{limit:≤100, archived:false, modelProviders:[],
  useStateDbOnly:true, searchTerm}` → `{data: Thread[], nextCursor,
  backwardsCursor}`. `searchTerm` is a substring filter over name, title and
  preview: match the name exactly and refuse zero or several. `modelProviders:
  []` is all providers; no `sourceKinds` is interactive sources only.
- `thread/read` `{threadId, includeTurns}` → `{thread}`; `thread/loaded/list`
  → `{data: string[]}`, the ids loaded in this daemon. Neither loads a
  thread. The active turn's id comes from `thread/read` with turns (the
  in-progress one); status has none.
- `thread/queue/add` `{threadId, clientUserMessageId, input:[{type:"text",
  text, text_elements:[]}]}` → `{queuedSubmission:{id, clientUserMessageId,
  input}}`. It wakes an idle loaded thread, never loads one, and does not
  wake an interrupted one; success means accepted, not read.
- `turn/steer` `{threadId, expectedTurnId, clientUserMessageId, input}` →
  `{turnId}`; never starts an idle turn. Errors, with no `data`: `-32600 "no
  active turn to steer"`, `-32600 "expected active turn id \`U\` but found
  \`V\`"`, `"expectedTurnId must not be empty"`, `"thread not found: T"`
  (`request_processors/turn_processor.rs:374-389, 1024-1164`).
- `clientUserMessageId` correlates; it does not deduplicate. A lost response
  after a send is an uncertain dispatch, never a safe resend.

## What arrives unasked, and what proves a message was taken

| Notification | Params | Who gets it |
|---|---|---|
| `thread/status/changed` | `{threadId, status}` | every initialized connection, on change only |
| `turn/started`, `turn/completed` | `{threadId, turn}` | the thread's subscribers |
| `item/completed` | `{threadId, turnId, item, completedAtMs}` | the thread's subscribers |
| `thread/queue/changed` | `{threadId}` | the thread's subscribers |

The receipt: `item/completed` whose `item` is a `userMessage` with
`clientId` equal to the id sent. It proves the harness recorded the input,
not that the model read it.

**Connecting does not subscribe to existing threads.** initialize, list,
read, queue and steer subscribe to nothing, and there is no read-only
subscribe. `thread/resume` subscribes but is not passive: it replays pending
requests and runs idle handling (`thread_lifecycle.rs:694-718, 807-814`). So
for a thread the daemon already has, only `thread/status/changed` arrives;
receipts must come from reading (history, the queue) as Magi does today.

**Approval hazard.** A thread created after Magi connects attaches every
initialized connection, Magi's included (`app-server/src/lib.rs`, the
`thread_created_rx` branch). Its server requests, among them
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/tool/requestUserInput` and `mcpServer/elicitation/request`, then reach
Magi too, and the first answer or error from any subscriber settles them; an
error is a denial (`outgoing_message.rs:330-443, 561-579`;
`bespoke_event_handling.rs:1923-1961`). `appServerRpc` declines every server
request with -32601, so used unchanged it would deny another session's
approval. A daemon client answers no request it does not own: it leaves it
to its owner.

## Loaded, stored, steerable

`thread/list` includes stored threads; `notLoaded` means not loaded here,
not inactive anywhere. Status is `notLoaded | idle | systemError |
active{activeFlags}`, flags `waitingOnApproval`, `waitingOnUserInput`
(`app-server/src/thread_status.rs:447-468`). Loaded is not steerable:
spawned subagents and review/compact turns refuse input
(`thread_input.rs:8-35`; `turn_processor.rs:1101-1135`). Queue-add success
says nothing about who owns the thread.

## Where it fits in Magi

- Today `src/transport.mjs` runs its own stdio app-server for metadata and
  the queue, a separate server from the user's; live delivery is `codex
  queue` (`deliverToCodex`), and steer goes through the desktop's app-tools
  pipe (`send_message_to_thread`). The headless path shares the app-server
  arguments; leave them alone.
- The route that fits: a daemon client behind the far end's Codex adapter,
  inside the relay, returning card-scoped status and receipts only, so the
  mirror and reply route and the relay's card-traffic limits stay as they
  are. A near end holding its own ssh would need the same mirror and could
  carry unrelated threads' events across machines.
- `src/peer.mjs` refuses `host` with steer, and serve.mjs turns a remote
  steer into live; the relay's receipt carries no clientId or turnId. Those
  change with R2.

Verify before shipping, on a real daemon: existing versus new threads, a
pending approval, idle, active and interrupted queueing, a turn-id mismatch,
a response lost after acceptance, a notification before its response, and a
reconnect without a blind resend.
