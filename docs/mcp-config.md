# MCP configuration

`magi install` writes all of these. They are here for anyone who would rather
do it by hand, or who needs to check what was written.

## Claude Code, so Claude can consult Codex

```bash
claude mcp add magi -s user -e CODEX_BIN=/path/to/codex -e CLAUDE_BIN=/path/to/claude -- node /path/to/Magi/bin/magi.mjs serve codex
```

Claude then sees the tool as `mcp__magi__codex_peer`. The `-e` pins are the
CLI paths install resolved (`OMP_BIN` too when omp is found); leave out any
that are on PATH.

## Codex CLI, so Codex can consult Claude

In `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

```toml
[mcp_servers.magi]
command = "node"
args = ["/path/to/Magi/bin/magi.mjs", "serve", "claude"]
env_vars = ["PEER_DEPTH", "PEER_ROLE", "PEER_TASK_ID", "MAGI_HOME"]
tool_timeout_sec = 3700
startup_timeout_sec = 30

[mcp_servers.magi.env]
CLAUDE_BIN = "/path/to/claude"
CODEX_BIN = "/path/to/codex"
```

Codex then sees the tool as `claude_peer`. The `env` table also gains
`OMP_BIN` when omp is found.

## Oh My Pi, including OMP-to-OMP

With omp installed, `magi install` (or `install --omp`) writes instead:

- in Claude Code, the one `magi` server serves both peers: `serve codex omp
  --as claude`, seen as `mcp__magi__codex_peer` and `mcp__magi__omp_peer`;
- in `~/.codex/config.toml`, the one `[mcp_servers.magi]` table runs
  `serve claude omp --as codex`, with the same `env_vars` and
  `tool_timeout_sec`;
- in `~/.omp/agent/mcp.json`, `magi` (`serve claude --as omp`),
  `magi-codex` (`serve codex --as omp`) and `magi-omp`
  (`serve omp --as omp`), each with `timeout: 0`, because omp aborts any
  MCP request after 30 seconds unless its own config says not to. Their
  `env` pins the resolved CLI paths, including `OMP_BIN`.

Claude and Codex each use one server process per session for both peers. Each
used to start a second server for omp: about 60 MB of Node plus the MCP SDK
each, measured 2026-10-05 on Node 23.11 (19 magi processes, ~1.2 GB across
9 sessions); combining them halves that. A combined `serve` needs `--as`
(one identity for every tool it serves) and refuses the same peer twice.
`install` removes a leftover `magi-omp` entry from Claude and Codex; omp keeps
its separate server entries, including its own `magi-omp`.

`--as` is what makes a server speak for the harness that loaded it; the
servers' native defaults are only right for Claude and Codex.
For OMP-to-OMP, `--as omp` preserves the caller's harness name; verified,
distinct session identities determine the card's orchestrator and peer.

## The load-bearing settings

`env_vars` matters because Codex does not pass the parent environment to MCP
servers by default. Without it `PEER_DEPTH` is lost across the hop, and a
spawned peer would not know it is a peer. The `env` table pins the CLI paths for
the same reason: neither binary is reliably on PATH, least of all on Windows.

`tool_timeout_sec` has to exceed the longest wait the bridge itself allows, which
is sixty minutes, so `install` writes 3700. Codex kills the tool call at this
limit, and when it does the round is left open with no record of why: the
bridge never saw it end. `magi doctor` fails if the configured value is
below the bridge's own cap.

There is a third, on the Claude side, which install does not write:
`crossSessionInbound` in `~/.claude/settings.json` must be `"accept"`. Without
it, a session in `bypassPermissions` (or plan mode with bypass available, which
is how the desktop app runs) holds every incoming peer message for approval and
drops it five minutes later, and the sender is told nothing. `doctor` checks
this too.

## Naming and addressing sessions

Live delivery targets a session by name or id; `kind: "peers"` lists both.

- Claude: `claude --name <name>`, or `/rename <name>` in a running session.
  Unnamed sessions get a derived name such as `magi-15`. A session can also be
  addressed by its session id or pid.
- Codex: `/rename` in the TUI, or rename the task in the desktop app; the
  desktop also names threads itself. An unnamed thread is addressed by its id,
  which `peers` prints. `codex queue` accepts either.

Without an explicit `peer`, a Claude caller gets the most recently active Codex
thread in the same working directory; a Codex caller gets a Claude session in the
same directory and is refused, with the alternatives named, when there is none.

## Saying who you are

The bridge works out the sender on its own: a Claude session from its own inbox
socket, a Codex thread from the thread id Codex attaches to every MCP tool call.
`from` (a session or thread id or exact name) overrides that, and is refused when
it does not match the calling session. [mcp-caller-verification.md](mcp-caller-verification.md)
records the check of the Codex desktop path.
