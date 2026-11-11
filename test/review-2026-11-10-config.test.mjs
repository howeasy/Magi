// Findings from the 2026-11-10 review that could damage a
// user's files or config: Codex config.toml editing, a half-finished
// uninstall, retention trimming an unchecked reply, and redaction gaps.
// The temp sweep's own case is in cleanup.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeWorkspace, ROOT } from './helpers/harness.mjs';
import { redact } from '../src/protocol.mjs';
import { setRecord } from '../src/store.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import * as state from '../src/state.mjs';

// Every home the installer honours, pointed into a workspace; no CLI is found.
async function installer(fn) {
  const ws = makeWorkspace('review config');
  const saved = { ...process.env };
  const home = join(ws, 'home');
  const cfg = join(home, '.claude');
  const codex = join(home, '.codex');
  const agent = join(home, '.omp', 'agent');
  const appdata = join(home, 'AppData', 'Roaming');
  for (const d of [cfg, codex, agent, appdata]) mkdirSync(d, { recursive: true });
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: appdata, CLAUDE_CONFIG_DIR: cfg, CLAUDE_APP_SESSIONS_DIR: join(appdata, 'Claude', 'claude-code-sessions'), CODEX_HOME: codex, OMP_AGENT_DIR: agent, MAGI_HOME: join(ws, 'magi-state'), MAGI_TEST_HOME: join(ws, 'magi-state'), CLAUDE_BIN: join(ws, 'absent-claude'), CODEX_BIN: join(ws, 'absent-codex'), OMP_BIN: join(ws, 'absent-omp') });
  const log = console.log;
  console.log = () => {};
  try { await fn({ home, cfg, codex, agent, appdata, api: await import('../src/install.mjs') }); }
  finally {
    console.log = log;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* magi.db stays open in-process on Windows */ }
  }
}

test('a comment above another table survives Magi\'s section being replaced or removed', () => installer(async ({ api }) => {
  const before = [
    'model = "keep"', '',
    '[mcp_servers.magi]', 'command = "node"', '',
    '# github token rotates monthly, see vault', '',
    '[mcp_servers.github]', 'command = "gh"', '',
  ].join('\n');
  const after = api.withoutMagiConfig(before);
  assert.match(after, /# github token rotates monthly, see vault\n\n\[mcp_servers\.github\]/);
  assert.doesNotMatch(after, /mcp_servers\.magi\]/);
  // Removing and re-adding the section never grows the file.
  const section = '[mcp_servers.magi]\ncommand = "node"\n';
  assert.equal(api.withoutMagiConfig(after + section), after);
  assert.equal(api.withoutMagiConfig(before.replace('command = "node"', 'command = "node"\n')), after, 'extra blank lines above the comment go with the section');
  // A comment inside Magi's own tables is Magi's, and goes with them.
  assert.equal(api.withoutMagiConfig('[mcp_servers.magi]\n# ours\ncommand = "node"\n[mcp_servers.magi.env]\nA = "b"\n'), '');
}));

test('a Codex-only install keeps the file\'s line ending and a literal-string env value', () => installer(async ({ codex, api }) => {
  const file = join(codex, 'config.toml');
  const before = [
    'model = "keep"', '',
    '[mcp_servers.magi]', 'command = "old"', '',
    '[mcp_servers.magi.env]',
    "MAGI_WORKER_WRAPPER = '[\"C:\\tools\\wrap.exe\",\"--net=none\"]'",
    'OTHER = "kept"', '',
  ].join('\r\n');
  writeFileSync(file, before);
  assert.deepEqual(api.tomlEnv(before), { MAGI_WORKER_WRAPPER: '["C:\\tools\\wrap.exe","--net=none"]', OTHER: 'kept' });
  await api.install({ codex: true, root: ROOT });
  const installed = readFileSync(file, 'utf8');
  assert.equal(/(?<!\r)\n/.test(installed), false, 'no bare LF in a CRLF file');
  const env = api.tomlEnv(installed);
  assert.equal(env.MAGI_WORKER_WRAPPER, '["C:\\tools\\wrap.exe","--net=none"]', 'the operator\'s wrapper survives, value unchanged');
  assert.equal(env.OTHER, 'kept');
  assert.doesNotMatch(installed, /command = "old"/);
}));

test('uninstall removes everything else when Codex\'s config.toml cannot be edited', () => installer(async ({ home, cfg, codex, agent, appdata, api }) => {
  const claudeJson = join(cfg, '.claude.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: { magi: { command: 'node' }, other: { command: 'x' } } }));
  // An inline table on an unrelated server is one the line editor refuses.
  const toml = join(codex, 'config.toml');
  const tomlBefore = '[mcp_servers.magi]\ncommand = "node"\n\n[mcp_servers.other]\nenv = { "API_KEY" = "v" }\n';
  writeFileSync(toml, tomlBefore);
  const skill = join(cfg, 'skills', 'peer-codex');
  const agentsSkill = join(home, '.agents', 'skills', 'peer-claude');
  const extension = join(agent, 'extensions', 'magi');
  for (const d of [skill, agentsSkill, extension]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'x.md'), 'x'); }
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(startup, { recursive: true });
  writeFileSync(join(startup, 'magi-dashboard.cmd'), 'x');

  await assert.rejects(api.uninstall(), (e) => e.code === 'BAD_CONFIG' && /Everything else Magi installed was removed/.test(e.message));
  assert.equal(readFileSync(toml, 'utf8'), tomlBefore, 'the refused file keeps its bytes');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers), ['other']);
  for (const gone of [skill, agentsSkill, extension, join(startup, 'magi-dashboard.cmd')]) assert.equal(existsSync(gone), false, gone);
}));

test('retention never trims a card with an answer nobody gave a verdict on, even after a later round closed', async (t) => {
  const home = join(makeWorkspace('review retention'), 'home');
  mkdirSync(home, { recursive: true });
  const saved = { MAGI_HOME: process.env.MAGI_HOME, MAGI_TEST_HOME: process.env.MAGI_TEST_HOME };
  Object.assign(process.env, { MAGI_HOME: home, MAGI_TEST_HOME: home });
  setEmbedder(async () => Float32Array.of(1, 0));
  t.after(() => {
    setEmbedder(null);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const at = Date.now() - 40 * 86400000;
  const rounds = [
    { round: 1, openedAt: at - 3, replied: true, repliedAt: at - 2, replySeq: 1 },
    { round: 2, openedAt: at - 1, replied: false, closedAt: at, closeReason: 'timed_out' },
  ];
  const card = (id, extra) => {
    setRecord(home, 'tasks', id, { taskId: id, cwd: home, orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', maxRounds: 2, replySeq: 1, rounds, ...extra });
    state.recordExchange(id, { kind: 'request', task: `Inspect ${id}`, round: 1 });
    state.recordExchange(id, { kind: 'reply', text: 'Reproduced stale cache', round: 1 });
  };
  card('unchecked', {});
  card('checked', { outcome: { accepted: 1, rejected: 0, open: 0, notes: 'held', at, seq: 1, seen: [1] } });
  await state.sweep();
  assert.equal(state.readTask('unchecked').bodiesTrimmedAt, undefined);
  assert.equal(state.readExchange('unchecked')[1].text, 'Reproduced stale cache', 'the reply can still be read back and checked');
  assert.ok(state.readTask('checked').bodiesTrimmedAt, 'a card whose answer has a verdict is still trimmed');
  assert.match(state.readExchange('checked')[1].text, /^\[trimmed after 30 days/);
});

test('redaction covers AWS secret keys, fine-grained GitHub, GitLab and npm tokens, and basic auth', () => {
  const secrets = [
    'AWS_SECRET_ACCESS_KEY=abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd',
    'aws_secret_access_key = "abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd"',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghi',
    'glpat-abcdefghijklmnopqrst',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==',
  ];
  for (const secret of secrets) {
    const { text, count } = redact(secret);
    assert.ok(count >= 1, secret);
    assert.doesNotMatch(text, /abcdEFGH1234|ABCDEFG0abcdefghijkl|abcdefghijklmnopqrst|dXNlcjpwYXNzd29yZDEy/, secret);
  }
  // Ordinary text that only resembles them is left alone.
  for (const plain of ['Basic authentication is not supported here.', 'run npm_config_registry=https://example.test npm ci', 'the secret access key rotates monthly', 'see github_pat_ docs']) {
    assert.equal(redact(plain).text, plain, plain);
  }
});
