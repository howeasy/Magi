// One MCP server process per harness session, serving every peer it consults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT, makeWorkspace, makeFakeBins, fakeEnv, startServer, textOf } from './helpers/harness.mjs';

const magi = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'serve', ...args], { encoding: 'utf-8', timeout: 15000, input: '' });

test('a combined server lists one tool per peer and answers each, in one process', async () => {
  const ws = makeWorkspace();
  makeFakeBins(ws, ['claude', 'omp', 'codex']);
  const { env } = fakeEnv(ws);
  const s = await startServer('codex omp', { env, cwd: ws, as: 'claude' });
  try {
    const { tools } = await s.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['codex_peer', 'omp_peer']);
    for (const name of ['codex_peer', 'omp_peer']) {
      const res = await s.call(name, { kind: 'peers', workingDirectory: ws });
      assert.ok(!res.isError, `${name}: ${textOf(res)}`);
    }
  } finally {
    await s.close();
  }
});

test('a combined server refuses to guess who loaded it', () => {
  const r = magi('codex', 'omp');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs --as/);
});

test('a combined server cannot include the harness it speaks for', () => {
  const r = magi('codex', 'omp', '--as', 'codex');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot consult itself/);
});

test('the same peer twice is refused rather than registered twice', () => {
  const r = magi('codex', 'codex', '--as', 'claude');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /same peer twice/);
});

test('a blank --as is no identity at all', () => {
  const r = magi('codex', 'omp', '--as', '   ');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs --as/);
});

test('serverTable finds a table however its header is quoted, and not a longer name', async () => {
  const { serverTable } = await import('../src/install.mjs');
  const cfg = '[mcp_servers.magi]\nargs = ["serve", "claude"]\n[mcp_servers."magi-omp"]\nargs = ["serve", "omp"]\n[mcp_servers.magi-omp.env]\nK = "v"\n[other]\nx = 1\n';
  assert.doesNotMatch(serverTable(cfg, 'magi'), /omp/);
  assert.match(serverTable(cfg, 'magi-omp'), /"serve", "omp"[\s\S]*K = "v"/);
  assert.equal(serverTable(cfg, 'nothing'), '');
  assert.equal(serverTable("[mcp_servers.'magi-omp']\nargs = []\n", 'magi-omp').length > 0, true);
});
