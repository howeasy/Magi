// Starting a named live peer: the command per harness, the window launcher,
// the background fallback, and the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import { spawnCommand, spawnPeer } from '../src/spawn.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls } from './helpers/harness.mjs';

test('spawnCommand passes the permission mode through in each harness\'s own words and adds nothing else', () => {
  assert.deepEqual(spawnCommand({ harness: 'claude', name: 'r1' }), ['claude', '--name', 'r1']);
  assert.deepEqual(spawnCommand({ harness: 'claude', name: 'r1', permissionMode: 'acceptEdits' }), ['claude', '--name', 'r1', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(spawnCommand({ harness: 'codex', name: 'r1', permissionMode: 'workspace-write' }), ['codex', '-s', 'workspace-write']);
  assert.deepEqual(spawnCommand({ harness: 'codex', name: 'r1', permissionMode: 'never' }), ['codex', '-a', 'never']);
  assert.deepEqual(spawnCommand({ harness: 'omp', name: 'r1', permissionMode: 'write' }), ['omp', '--approval-mode', 'write']);
  assert.deepEqual(spawnCommand({ harness: 'claude', name: 'r1', model: 'opus' }), ['claude', '--name', 'r1', '--model', 'opus']);
  assert.deepEqual(spawnCommand({ harness: 'codex', name: 'r1', model: 'gpt-5.5' }), ['codex', '-m', 'gpt-5.5']);
  assert.throws(() => spawnCommand({ harness: 'bash', name: 'x' }), (e) => e.code === 'BAD_REQUEST');
  for (const c of [spawnCommand({ harness: 'claude', name: 'x', permissionMode: 'bypassPermissions' })]) assert.ok(!c.some((a) => a.startsWith('--dangerously')));
});

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('Claude starts in the background, then with Windows Terminal an attach tab opens in the magi window; a new directory is created and git-initialised', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['wt', 'claude']);
  const { env } = fakeEnv(ws);
  const cwd = join(ws, 'brand new project');
  const sessions = async () => (readCalls(env.FAKE_CLI_LOG).some((c) => c.args.includes('--bg')) ? [{ name: 'r1', sessionId: 's-1', pid: 42, cwd, jobId: 'abc123' }] : []);
  const row = await withEnv({ ...env, WT_BIN: paths.wt, CLAUDE_BIN: paths.claude }, () =>
    spawnPeer({ harness: 'claude', name: 'r1', cwd, permissionMode: 'acceptEdits', sessions }),
  );
  const calls = readCalls(env.FAKE_CLI_LOG);
  const bg = calls.find((c) => c.name === 'claude');
  assert.deepEqual(bg.args, ['--bg', '--name', 'r1', '--permission-mode', 'acceptEdits']);
  assert.equal(bg.cwd, cwd);
  assert.equal(row.created, true);
  assert.ok(existsSync(join(cwd, '.git')));
  assert.equal(row.id, 's-1');
  assert.equal(row.bgId, 'abc123');
  // The fake prints no "backgrounded" line, so no attach tab can be opened
  // for it; the row still says how to reach the session.
  assert.match(row.where, /background session/);
});

test('with Windows Terminal, Codex and omp open directly as a titled tab in the magi window', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['wt', 'omp']);
  const { env } = fakeEnv(ws);
  mkdirSync(join(ws, 'proj'));
  const sessions = async () => (readCalls(env.FAKE_CLI_LOG).some((c) => c.name === 'wt') ? [{ name: 'o1', sessionId: 'omp-1', pid: 9, cwd: join(ws, 'proj') }] : []);
  const row = await withEnv({ ...env, WT_BIN: paths.wt, OMP_BIN: paths.omp }, () => spawnPeer({ harness: 'omp', name: 'o1', cwd: join(ws, 'proj'), permissionMode: 'write', sessions }));
  const wt = readCalls(env.FAKE_CLI_LOG).find((c) => c.name === 'wt');
  assert.deepEqual(wt.args.slice(0, 7), ['-w', 'magi', 'new-tab', '--title', 'omp:o1', '-d', join(ws, 'proj')]);
  assert.match(wt.args[7], /omp/);
  assert.deepEqual(wt.args.slice(8), ['--approval-mode', 'write']);
  assert.equal(row.created, false);
  assert.match(row.where, /tab "omp:o1" in the magi window/);
});

test('without wt, Claude still starts in the background; omp is refused with the manual step', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['claude']);
  const { env } = fakeEnv(ws);
  mkdirSync(join(ws, 'proj'));
  const sessions = async () => (readCalls(env.FAKE_CLI_LOG).some((c) => c.args.includes('--bg')) ? [{ name: 'bg1', sessionId: 's-2', pid: 7, cwd: join(ws, 'proj'), jobId: 'abc123' }] : []);
  const row = await withEnv({ ...env, WT_BIN: join(ws, 'no-wt.exe'), CLAUDE_BIN: paths.claude }, () => spawnPeer({ harness: 'claude', name: 'bg1', cwd: join(ws, 'proj'), sessions }));
  assert.deepEqual(readCalls(env.FAKE_CLI_LOG).find((c) => c.args.includes('--bg')).args, ['--bg', '--name', 'bg1']);
  assert.equal(row.bgId, 'abc123');
  assert.match(row.where, /claude attach abc123|background session/);
  await assert.rejects(
    withEnv({ ...env, WT_BIN: join(ws, 'no-wt.exe') }, () => spawnPeer({ harness: 'omp', name: 'o1', cwd: join(ws, 'proj'), sessions: async () => [] })),
    (e) => e.code === 'SPAWN_UNSUPPORTED' && /run "omp"/.test(e.message),
  );
});

test('a bad name and a name already live are refused before anything starts', async () => {
  const ws = makeWorkspace();
  await assert.rejects(spawnPeer({ harness: 'claude', name: 'Bad Name', cwd: ws, sessions: async () => [] }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(spawnPeer({ harness: 'claude', name: 'r1', cwd: ws, sessions: async () => [{ name: 'r1' }] }), (e) => e.code === 'NAME_TAKEN');
});
