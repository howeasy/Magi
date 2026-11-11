# Uninstall

```bash
node bin/magi.mjs uninstall
```

That removes:

- the `magi-view` mod and the `magi` plugin marketplace from Claude Code
  (`claude plugin uninstall magi-view@magi`, `claude plugin marketplace remove
  magi`), when the `claude` CLI is there to run them
- all Magi user-scope MCP entries (`magi`, `magi-omp`, `magi-codex`) in
  Claude, Codex and omp,
  including owned Codex child tables
- `~/.claude/skills/peer-codex/`, `peer-omp/` and `omp-advisor/`
- `~/.agents/skills/peer-claude/`, `peer-omp/` and `omp-advisor/`
- omp's `peer-claude`/`peer-codex`/`peer-omp` skills and the `magi`
  inbox extension beneath `~/.omp/agent/`
- `magi-dashboard.cmd` in the Windows
  Startup folder (`%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup`),
  left by the web dashboard Magi no longer has (`magi install` deletes them too)
- the optional Magi statusline, restoring its chained original command

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `OMP_AGENT_DIR` (or
`PI_CODING_AGENT_DIR`) are honoured. Claude's user registration is
`$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` without that override;
the `claude` CLI is not needed to remove those entries. Unrelated
registrations, extensions and Startup entries remain. Configuration updates
keep exact pre-write `.bak` files and use atomic replacement; unsafe JSON/TOML
is refused with `BAD_CONFIG` and repair instructions, not overwritten. A
refused file does not stop the rest: uninstall removes everything else it
installed, leaves that file's bytes as they were, and exits with the refusal
naming it, so the one entry left can be removed by hand. If
Claude settings are unsafe, uninstall still removes both owned dashboard
Startup files, preserves the settings bytes and reports `BAD_CONFIG`; repair
the settings and re-run uninstall to finish removing the optional statusline.

Restart all installed harnesses afterwards. Done when `claude mcp list` and
Codex's `config.toml` name no `magi` server. Removing the Startup entry
prevents future login launches; it does not stop a dashboard process an older
checkout already started (end the `node` process with `magi dashboard` in its
command line).

## By hand

```bash
claude plugin uninstall magi-view@magi
claude plugin marketplace remove magi
claude mcp remove magi -s user
claude mcp remove magi-omp -s user
rm -rf ~/.claude/skills/peer-codex ~/.claude/skills/peer-omp ~/.claude/skills/omp-advisor ~/.agents/skills/peer-claude ~/.agents/skills/peer-omp ~/.agents/skills/omp-advisor
```

Remove any `magi-codex` entry too. Delete the matching
`[mcp_servers.<name>]` sections and their children from Codex's config, and the
same owned names from omp's `mcp.json`. Remove omp's `magi`
extension directory, its peer skills, and the dashboard Startup file named above.
Leave every unrelated section in place.

## Leftover state

Uninstall preserves the state tree, including `~/.magi/magi.db`, memory,
historic files and CLI spill artifacts, and it does not run `sweep`. Task
metadata, reply payloads, outcomes, verdicts, round metadata and coverage
evidence in the database are kept indefinitely; what `sweep` trims and when is
[usage.md](usage.md), "Checking state". Memory is retained in `magi.db`; any
unimported legacy memory stays on disk (importing it is `magi migrate`,
[install.md](install.md#upgrading-a-loose-file-ledger)). Remove the tree
yourself if you want to forget that history:

```bash
rm -rf ~/.magi
```

`claude-mod/checkout.json` and `claude-mod/render-trace.json` in the checkout
are left too; both are ignored by git.
