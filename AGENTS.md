# Working on Magi

Magi lets Claude Code, Codex CLI and Oh My Pi consult each other as peers.
The rule the whole thing serves, and the one to apply to your own work here:
**evidence > reasoning > model agreement**. Verify against the real CLI and
say what you checked; the docs record versions for that reason.

## What is live, and when

- The installed MCP servers run `bin/magi.mjs` from the main checkout,
  and every harness reads its MCP servers at startup. An edit is live only
  after it is on master, `magi install` has run (skills and the omp
  extension are installed by copy), and the harness restarted. Until then
  the running servers are the old code, whatever the worktree says.
- The magi-view mod (`claude-mod/`) runs from Claude Code's plugin cache,
  kept per version, in every project but the installed checkout: bump
  `version` in `claude-mod/.claude-plugin/plugin.json`, run `magi install`,
  then `/reload-plugins`.

## One source per thing

- `skills/PROTOCOL.md` is the one protocol; install copies it beside each
  installed `SKILL.md`. Each `SKILL.md` is a router, loaded whole whenever
  the skill triggers: the role check, the rule, when to call, one example
  call, this harness's delivery, and a table pointing at protocol sections.
  Detail goes in the protocol, never in three skills.
- `src/peer-schema.mjs` is the one tool schema for all three peer tools. Its
  descriptions are loaded into every host session on every turn, so they are
  pointers; the reasoning lives in the skill and the protocol.
- `src/serve.mjs` is the one server; each `*-adapter.mjs` is an adapter record
  handed to it, and each `*-server.mjs` is the two-line entry point that serves
  one. A fourth harness is a fourth record. The engine in
  `src/peer.mjs` carries no harness names: an adapter reports its delivery
  status in words and marks the errors a headless fallback may answer.
- Every `PEER <KIND> magi/1` line is composed in `src/protocol.mjs`. A reply
  finds its orchestrator through `originOf` and is delivered by `deliverTo` in
  `src/transport.mjs`; the one exception is a Codex steer reply, which
  `src/codex-delivery.mjs` sends with `steerCodexThread`.

## Verification

- `npm test` is offline: fake CLIs in `test/helpers/fake-cli.cjs`, an
  isolated `MAGI_HOME` per test, no model calls. Run it bare: each test
  process writes its temp under its own `magi-test-run-<pid>-*` root, and
  roots whose process has ended are swept when a test process starts and by
  the `posttest` step (`test/helpers/temp-sweep.mjs`); a test makes its
  folders with `tmpdir()`, nowhere else. `PEER_E2E=1` adds real
  Claude and Codex calls. Real-binary checks of a private format belong in
  the docs with the version they were run against.
- The mod's own tests (`claude-mod/tests/`) import `claude-code/testing` and
  run under Claude Code's mod tooling (the plugin-authoring skill), not
  `npm test`.
- `git diff --check` before a commit. Working copies here are CRLF; the repo
  stores LF.
- A behaviour change and the doc that describes it land in the same commit;
  `docs/` is the spec and the evidence record.

## Conventions

- Add a runtime dependency only when the standard library cannot meet the
  need.
- Comments say why. `// ponytail:` marks a deliberate ceiling and names the
  upgrade path.
- Every error the bridge returns names its code and what to do next; the
  agent reading it has no other feedback.
- Private formats (the Claude inbox frame, the Codex desktop steer channel,
  the omp extension API) are pinned to versions in `VERIFIED_VERSIONS`
  in `src/install.mjs`; bump after re-checking.

## Where things are

- Mechanisms (ownership, the shape, state layout, a new mechanism):
  `docs/architecture.md`.
- Headless limits (what a headless path may do): `docs/security.md`.
- Prompts and commands (what a prompt triggers, what a command does):
  `docs/usage.md`.
- Private formats, when one breaks: `docs/transport-recon.md`.
- Native messaging, compared: `docs/parity.md`.
- The mod as a person sees it, and installing: `docs/install.md`.
- Symptoms and error codes: `docs/troubleshooting.md`, after `magi doctor`.
