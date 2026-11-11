// Findings from the 2026-11-10 review where Magi told a
// person or an agent something wrong: doctor passing a registration whose
// checkout is gone, MAGI_TIMEOUT_MS changing nothing, `--help` running the
// command, a bare "database is locked", and a Codex tab's prompt cut by wt.
// The mod's two are in claude-mod/tests and magi-view-contract.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf, ROOT } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import { setRecord, removeRecord, getRecord } from '../src/store.mjs';
import { spawnPeer } from '../src/spawn.mjs';
import * as state from '../src/state.mjs';

const CLI = join(ROOT, 'bin', 'magi.mjs');

async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('doctor fails a registration whose checkout is gone, and passes one that runs this checkout', async () => {
  const ws = makeWorkspace('doctor checkout');
  const home = join(ws, 'home');
  const cfg = join(home, '.claude');
  const codex = join(home, '.codex');
  const appdata = join(home, 'AppData', 'Roaming');
  for (const d of [cfg, codex, appdata, join(home, '.omp', 'agent')]) mkdirSync(d, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: appdata, CLAUDE_CONFIG_DIR: cfg, CLAUDE_APP_SESSIONS_DIR: join(appdata, 'Claude', 'claude-code-sessions'), CODEX_HOME: codex, OMP_AGENT_DIR: join(home, '.omp', 'agent'), MAGI_HOME: join(ws, 'magi-state'), MAGI_TEST_HOME: join(ws, 'magi-state'), CLAUDE_BIN: join(ws, 'absent-claude'), CODEX_BIN: join(ws, 'absent-codex'), OMP_BIN: join(ws, 'absent-omp') };
  const register = (script) => {
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { magi: { command: 'node', args: [script, 'serve', 'codex'] } } }));
    writeFileSync(join(codex, 'config.toml'), `[mcp_servers.magi]\ncommand = "node"\nargs = [${JSON.stringify(script)}, "serve", "claude"]\ntool_timeout_sec = 3700\n`);
  };
  try {
    await withEnv(env, async () => {
      const api = await import('../src/install.mjs');
      const gone = join(ws, 'moved-away', 'bin', 'magi.mjs');
      register(gone);
      let rows = await api.doctorReport();
      for (const where of ['codex \\[mcp_servers\\.magi\\]', 'claude mcpServers\\.magi']) {
        assert.ok(rows.some((r) => r.level === 'fail' && new RegExp(`${where} runs .*magi\\.mjs, which does not exist`).test(r.text)), where);
      }
      register(CLI);
      rows = await api.doctorReport();
      assert.equal(rows.filter((r) => r.level === 'ok' && /runs this checkout's CLI/.test(r.text)).length, 2);
      // Another checkout that does exist is a warning, not a failure.
      const other = join(ws, 'other', 'bin', 'magi.mjs');
      mkdirSync(join(ws, 'other', 'bin'), { recursive: true });
      writeFileSync(other, '');
      register(other);
      rows = await api.doctorReport();
      assert.equal(rows.filter((r) => r.level === 'warn' && /not this checkout's/.test(r.text)).length, 2);
    });
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* magi.db stays open in-process on Windows */ }
  }
});

test('MAGI_TIMEOUT_MS is the default a request without timeoutMs gets', async (t) => {
  setEmbedder(null);
  const cwd = makeWorkspace('timeout default');
  const seen = [];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', id: 'owner', sessionId: 'owner', cwd }, identityVerified: true }),
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async (o) => { seen.push(o.timeoutMs); return { inlineReply: 'SUMMARY\nok', via: 'headless' }; },
    deliverReply: async () => ({ via: 'live' }),
  });
  const ask = (extra = {}) => engine.handleRequest({ task: 'x', mode: 'DELEGATE', wait: true, workingDirectory: cwd, ...extra });
  await withEnv({ MAGI_AS: 'claude', PEER_DEPTH: '0', MAGI_TIMEOUT_MS: undefined }, async () => {
    assert.notEqual((await ask()).isError, true);
    process.env.MAGI_TIMEOUT_MS = '120000';
    assert.notEqual((await ask()).isError, true);
    assert.notEqual((await ask({ timeoutMs: 5000 })).isError, true, 'a request\'s own timeoutMs wins');
    process.env.MAGI_TIMEOUT_MS = '99999999';
    assert.notEqual((await ask()).isError, true, 'capped like any other');
    assert.deepEqual(seen, [2400000, 120000, 5000, 3600000]);
    process.env.MAGI_TIMEOUT_MS = 'soon';
    const bad = await ask();
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /BAD_REQUEST: MAGI_TIMEOUT_MS on this Magi server is "soon"/);
    assert.equal(seen.length, 4, 'nothing was launched');
  });
});

test('asking for help prints usage, exits 0 and never runs the command', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 60000, env: process.env });
  // The isolated home's registration: `uninstall --help` must leave it alone.
  const claudeJson = join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const before = JSON.stringify({ mcpServers: { magi: { command: 'node' } } });
  writeFileSync(claudeJson, before);
  for (const args of [['--help'], ['-h'], ['help'], ['uninstall', '--help'], ['doctor', '-h'], ['install', '--help']]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /magi serve codex/, args.join(' '));
  }
  assert.equal(readFileSync(claudeJson, 'utf8'), before, 'nothing was uninstalled');
  const typo = run('uninstall', '--force');
  assert.equal(typo.status, 1, 'an argument uninstall does not know is refused');
  assert.equal(readFileSync(claudeJson, 'utf8'), before);
  assert.equal(run('nonsense').status, 2, 'an unknown command is still a usage error');
  const limit = run('log', '--limit', 'abc');
  assert.equal(limit.status, 1);
  assert.match(limit.stderr, /BAD_REQUEST: --limit must be a positive whole number/);
});

test('a record write that meets a busy ledger says LEDGER_BUSY, with or without a transaction', async () => {
  const home = state.magiHome();
  setRecord(home, 'probe', 'k', { v: 1 }); // opens the database
  const other = new DatabaseSync(join(home, 'magi.db'));
  other.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => setRecord(home, 'probe', 'k', { v: 2 }), { code: 'LEDGER_BUSY' });
    assert.throws(() => removeRecord(home, 'probe', 'k'), { code: 'LEDGER_BUSY' });
    assert.throws(() => state.putRequestBody('magi-busy0001', 'body'), { code: 'LEDGER_BUSY' });
    // Coded, so the standing retry covers it once the other writer is done.
    setTimeout(() => other.exec('COMMIT'), 150);
    await state.retryState(() => setRecord(home, 'probe', 'k', { v: 3 }));
    assert.deepEqual(getRecord(home, 'probe', 'k'), { v: 3 });
  } finally {
    try { other.exec('ROLLBACK'); } catch { /* committed */ }
    other.close();
  }
});

test('a Codex tab\'s arguments reach Windows Terminal with every ";" escaped', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['wt', 'codex']);
  const { env } = fakeEnv(ws);
  const cwd = join(ws, 'proj');
  mkdirSync(cwd);
  const sessions = async () => (readCalls(env.FAKE_CLI_LOG).some((c) => c.name === 'wt') ? [{ name: 'c1', id: 'codex-1', cwd }] : []);
  await withEnv({ ...env, WT_BIN: paths.wt, CODEX_BIN: paths.codex }, () =>
    spawnPeer({ harness: 'codex', name: 'c1', cwd, model: 'gpt-5; new-tab cmd /k echo injected', sessions, deadlineMs: 1500 }).catch(() => null));
  const wt = readCalls(env.FAKE_CLI_LOG).find((c) => c.name === 'wt');
  assert.ok(wt, 'the tab was opened');
  const after = wt.args.slice(wt.args.indexOf('new-tab'));
  assert.ok(after.some((arg) => /answer them\\; do not start work/.test(arg)), 'the bootstrap prompt keeps its second half');
  for (const arg of after) assert.doesNotMatch(arg, /(?<!\\);/, `unescaped ; in ${arg}`);
  assert.ok(existsSync(cwd));
});
