# Interoperability decisions

## A2A (Agent2Agent)

**Decision: not adopted. Revisit when a trigger below fires.**
Recorded 2026-09-07, against A2A v1.0 (Linux Foundation, April 2026).

### What A2A is

An open protocol for agents built by different vendors to discover and delegate
to each other. Agents publish a JSON Agent Card describing their capabilities;
clients send task objects over HTTP with JSON-RPC and SSE; tasks have a
lifecycle and produce artifacts. It is explicitly positioned as complementary to
MCP: MCP gives one agent tools and context, A2A coordinates across agents. By
its first anniversary it had v1.0, 150+ supporting organisations, and
integration in the major cloud platforms.

### Why not here

**Neither endpoint speaks it.** Checked directly: no occurrence of
`agent2agent` or an agent-card well-known path in either the Codex or the Claude
Code executable, and nothing in either CLI's flags. A2A adoption is on
server-side agent platforms, not on these two local coding CLIs. Using A2A would
mean writing and running an A2A server wrapper around each one.

**It does not solve the problem this project had.** A2A models a peer as an
addressable service you post a task to. The difficulty here is the opposite
shape: reaching a *live interactive session that already holds context*, which is
the entire reason a second opinion is worth having. An A2A wrapper would still
have to call `codex queue` and post the Claude inbox frame underneath, exactly as
`src/transport.mjs` does now. It would be an envelope around the same work, plus
two long-running servers to supervise.

**The valuable part is not transport.** What makes this more than plumbing is the
policy in the skills: independent first passes, evidence over agreement,
mandatory reconciliation, bounded debate. A2A standardises how agents talk, not
whether they should believe each other. Changing the wire format would not change
the deliverable.

Thin equivalents already exist here: the ledger is a task lifecycle, the
structured request and reply is a message and artifact envelope, and
`magi peers` is discovery across known agents (two then, three since omp).

### What adopting it would cost

Two HTTP servers with agent cards and task state, a mapping between A2A task
states and the ledger, authentication between them, and lifecycle management for
both. All of it on top of, not instead of, the live-delivery code, since that is
what actually reaches a running session.

### Revisited 2026-10-05

The first trigger below has fired: omp is a third harness, and it carries most
of the traffic (on the first week of the ledger, 756 of 905 tasks went to it).
The decision stands, for the reason it was made. omp is reached by an inbox
extension and a headless `omp -p` (since 2026-10-08, `omp --mode rpc`), both of which fit the adapter record the
way a fourth transport would; A2A would be an envelope around that, and omp
does not speak it either: no occurrence of `agent2agent`, `agent-card.json` or a
`.well-known/agent` path in the omp 18.4.4 executable (checked 2026-10-05). The other three triggers have not fired: nothing
reaches across machines, no vendor ships native A2A, and no outside agent
consults this one. Revisit when one of those does.

### Triggers to revisit

- A third or fourth agent joins, especially from another vendor. (Fired
  2026-10-05 with omp; see above.)
- Peers need to be reached across machines or organisational boundaries.
- Either vendor ships native A2A, at which point the wrapper problem disappears
  and the fragile private frame below could be retired.
- Someone else's agent needs to consult yours, rather than the reverse.

### How to adopt it later

Transport is already isolated. Each server is one
adapter record handed to `serve()` in `src/serve.mjs`: how to list live
sessions, deliver into one, and run a headless one. An A2A transport is a
fourth adapter record; the engine, the protocol contract, the ledger, the modes
and the skills are untouched. This is additive, not a rewrite,
which is the main reason not to pre-build it now.

### What A2A would not fix

The most fragile dependency here is the Claude inbox frame, an undocumented
private format that can change in any Claude Code release. A2A does not help,
because Claude Code exposes no A2A endpoint to use instead. See
[transport-recon.md](transport-recon.md) for the frame and its repair procedure.

## MCP

Used, and correct for this. All three harnesses load MCP servers natively, so
the tools appear without a wrapper process, and the permission model is the
harness's own. The bridge is an MCP server in each.

## Claude Code cross-session messaging

Used for delivery into a live Claude session; see transport-recon.md,
section 1. Its own
`ListAgents` and `SendMessage` tools are Claude-to-Claude only and cannot address
Codex, so they are not a substitute for the bridge.
