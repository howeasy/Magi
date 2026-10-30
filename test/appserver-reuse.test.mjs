// One codex app-server per bridge process. Every call used to spawn its own,
// which is where the multi-second latency of `peers` and notes came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls } from './helpers/harness.mjs';
import { listCodexThreads, readCodexThread } from '../src/transport.mjs';

const ws = makeWorkspace('appserver reuse');
const { paths } = makeFakeBins(ws, ['codex']);
const { env, logFile } = fakeEnv(ws, { scenario: 'appserver' });
Object.assign(process.env, env, { CODEX_BIN: paths.codex });

test('repeated calls share one app-server process', async () => {
  const a = await listCodexThreads({ cwd: ws });
  const b = await listCodexThreads({ cwd: ws });
  await readCodexThread('th-1');
  assert.equal(a[0]?.id, 'th-1');
  assert.equal(b[0]?.id, 'th-1');
  const spawns = readCalls(logFile).filter((c) => c.args?.[0] === 'app-server');
  assert.equal(spawns.length, 1, `three RPCs, one process; saw ${spawns.length} spawns`);
});

test('a thread read is cached, so identity lookups stop costing a round trip', async () => {
  const reads = () => readCalls(logFile).filter((c) => c.rpc === 'thread/read').length;
  const before = reads();
  assert.ok(before >= 1, 'the first read above went to the server');
  const a = await readCodexThread('th-1');
  const b = await readCodexThread('th-1');
  assert.equal(a?.name, 'peer-thread');
  assert.equal(b, a, 'the same object came back');
  assert.equal(reads(), before, 'neither repeat reached the server');
});
