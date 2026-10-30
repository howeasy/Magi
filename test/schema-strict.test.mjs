import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeWorkspace, startServer, textOf } from './helpers/harness.mjs';

// An unknown field was once stripped silently: outcome with verdict: recorded
// zero findings and reported success.
test('the peer tool rejects unknown fields by name', async () => {
  const ws = makeWorkspace('strict schema');
  const server = await startServer('codex', { cwd: ws, env: { MAGI_HOME: join(ws, 'state'), CODEX_BIN: join(ws, 'absent') } });
  try {
    const result = await server.call('codex_peer', { kind: 'outcome', taskId: 'magi-00000000', verdict: 'accepted', workingDirectory: ws });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /verdict/);
  } finally { await server.close(); }
});

test('CLI-only modes, watch and bakeoff input are refused at the MCP boundary', async () => {
  const ws = makeWorkspace('hidden schema');
  const server = await startServer('codex', { cwd: ws, env: { MAGI_HOME: join(ws, 'state'), CODEX_BIN: join(ws, 'absent') } });
  try {
    for (const input of [{ kind: 'watch' }, ...['DEBATE', 'PARALLEL', 'BAKEOFF'].map((mode) => ({ task: 'review', mode })), { task: 'review', bakeoff: { a: ws, b: ws } }]) {
      const result = await server.call('codex_peer', input);
      assert.equal(result.isError, true, JSON.stringify(input));
    }
  } finally { await server.close(); }
});
