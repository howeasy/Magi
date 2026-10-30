# Native MCP caller identity

The record of how Magi learns which Codex thread called it, and the live
check that confirmed it (2026-09-08). The mechanism is summarised in
transport-recon.md, "Who is calling".

## How it works

The MCP SDK copies `request.params._meta` to the server handler's
`extra._meta` (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`).
The `claude_peer` handler reads it on each call rather than assuming that a
shared server environment identifies the caller.

`src/mcp-caller.mjs` accepts the known direct thread-id aliases and both JSON
string/object forms of `X-Codex-Turn-Metadata`. Conflicting identifiers
produce `ORIGIN_MISMATCH`. A valid metadata caller outranks the optional
model-supplied `from`: a `from` that names neither that thread's id nor its
name is refused with `ORIGIN_MISMATCH`, and a contradictory environment id
(`CODEX_THREAD_ID`) is ignored. The ledger receives the resolved identity.

## Desktop path: confirmed after restart

A real `claude_peer` request omitted `from`; its ledger
recorded the exact originating desktop task id
`01a080a3-16b5-7f01-8d56-936c04be5504` and return route. Claude received the
request live, echoed both session identities, and filed its reply through the
normal peer tool into the durable mailbox. The
[captured evidence](evidence/desktop-caller-roundtrip-2026-09-08.json)
preserves those facts without raw metadata or transport credentials. This
confirms the desktop metadata-to-ledger and live peer receipt/reply paths.
The matching `PEER REPLY` subsequently reached the originating Codex
conversation as well, completing the observed exchange. Envelope attributes
remain a separate validation.

## Offline tests and the CLI probe

Tests through the actual MCP SDK client/server (`test/mcp-caller.test.mjs`)
confirm that `_meta.threadId` reaches the handler and ledger, that a
contradictory `from` is refused while a contradictory environment id is
ignored, and that unrelated metadata is absent from diagnostics. These are
protocol integration tests, not proof of what every native Codex host
supplies.

A fresh Codex CLI 0.153.4 probe attempted `magi.claude_peer(kind="peers")`.
The native harness blocked it before delivery with:

```
MCP tool call requires approval, but approval policy is never
```

No native caller trace was produced by that isolated CLI probe. The live test
(`PEER_E2E=1`, same file) reports this gate as a skip, not a successful
identity verification; it leaves the approval policy as it is rather than
forcing the call through. The subsequently approved call from the restarted
desktop server supplied the confirmation above.

## Repeating the check

1. Set `MAGI_IDENTITY_TRACE_FILE` in the environment of a fresh
   `serve claude` process to an operator-chosen local file. The handler then
   appends only timestamp, process id, call kind, resolved thread id, matched
   identity-key names and the identity source. It never writes the raw
   `_meta` object, prompts, or unrelated fields. With the variable absent,
   tracing is disabled.
2. Make an approved call from a Codex desktop task (on 2026-09-08 this was
   **Start Magi audit**).
3. Compare the traced thread id with that task's id (then
   `01a080a3-16b5-7f01-8d56-936c04be5504`).
4. Clear the trace setting.

Done when the traced id equals the calling task's id and the source reads
`mcp_request_meta`. The 2026-09-08 check changed no global MCP configuration
and did not restart the desktop server itself; the user restarted it.
