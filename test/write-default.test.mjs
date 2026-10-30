// Read-only is the default, and a DELEGATE that was meant to edit has to say so.
// In the ledger 504 of 644 DELEGATE cards carried no write grant (2026-10-14):
// the request read write_policy=read-only and told the worker to change nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf } from './helpers/harness.mjs';
import { getRecord } from '../src/store.mjs';
import { composeRequest } from '../src/protocol.mjs';
import { peerInputSchema, peerToolDescription } from '../src/peer-schema.mjs';

const base = { taskId: 'magi-1', orchestrator: 'claude', peer: 'omp', task: 'Rename the loader', replyTool: 'claude_peer', replyVia: 'inline' };

test('a DELEGATE sent without allowWrites says so to its worker instead of asking it to work and touch nothing', () => {
  for (const compact of [false, true]) {
    const ro = composeRequest({ ...base, mode: 'DELEGATE', compact });
    assert.match(ro.text, /write_policy=read-only/);
    assert.match(ro.text, /READ-ONLY: file tools/);
    assert.match(ro.text, /This task arrived without write access: change nothing, and say in your reply what you would have changed and that the orchestrator must resend it with write access\./);
    const rw = composeRequest({ ...base, mode: 'DELEGATE', allowWrites: true, compact });
    assert.match(rw.text, /write_policy=workspace\b/);
    assert.doesNotMatch(rw.text, /READ-ONLY|without write access/);
  }
});

test('a mode that cannot write is read-only without the extra sentence, and allowWrites changes nothing for it', () => {
  for (const mode of ['REVIEW', 'FACT_CHECK', 'SECOND_OPINION', 'ADVERSARIAL_REVIEW']) {
    for (const allowWrites of [undefined, true]) {
      const text = composeRequest({ ...base, mode, allowWrites }).text;
      assert.match(text, /write_policy=read-only/, mode);
      assert.doesNotMatch(text, /without write access/, mode);
    }
  }
});

test('the schema and the tool description say read-only is the default and where writes come from', () => {
  const schema = peerInputSchema({ deliveries: ['auto', 'live', 'headless'], peerHint: 'x' });
  assert.match(schema.allowWrites.description, /^READ-ONLY unless true; only DELEGATE honours it/);
  assert.match(schema.allowWrites.description, /live or headless/);
  assert.match(schema.mode.description, /DELEGATE \(edits only with allowWrites: true\)/);
  assert.match(peerToolDescription('Codex'), /Read-only unless a DELEGATE has allowWrites: true/);
});

async function send(ws, env, paths, args) {
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'claude' } });
  try {
    return await s.call('omp_peer', { delivery: 'headless', workingDirectory: ws, ...args });
  } finally {
    await s.close();
  }
}

test('a DELEGATE with no allowWrites goes out read-only and the caller is told on the spot', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env } = fakeEnv(ws);
  const slip = await send(ws, env, paths, { task: 'Add the test', mode: 'DELEGATE' });
  assert.equal(slip.isError, undefined, textOf(slip));
  assert.match(textOf(slip), /\[magi\] DELEGATE went out READ-ONLY \(allowWrites was not set\): the worker was told to change nothing on disk\. If it should edit files, continue this card with allowWrites: true\./);
  assert.match(slip.structuredContent.warning, /went out READ-ONLY/);
});

test('stated either way it is not a slip, and only a granted card is launched able to write', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const ask = (task, args) => send(ws, env, paths, { task, wait: true, ...args });
  const slip = await ask('Slip task', { mode: 'DELEGATE' });
  assert.match(textOf(slip), /\[magi\] DELEGATE went out READ-ONLY/, 'on a blocking reply it rides the footer');
  const granted = await ask('Granted task', { mode: 'DELEGATE', allowWrites: true });
  assert.doesNotMatch(textOf(granted), /READ-ONLY/);
  const onPurpose = await ask('Audit task', { mode: 'DELEGATE', allowWrites: false });
  assert.doesNotMatch(textOf(onPurpose), /READ-ONLY/, 'an explicit false is a decision, not a slip');
  const review = await ask('Review task', { mode: 'REVIEW' });
  assert.doesNotMatch(textOf(review), /READ-ONLY/, 'a review is read-only by design');

  const launches = readCalls(logFile).filter((c) => c.args).map((c) => ({ write: c.args.includes('write'), task: /(Slip|Granted|Audit|Review) task/.exec(c.stdin ?? '')?.[1] }));
  assert.deepEqual(launches, [{ write: false, task: 'Slip' }, { write: true, task: 'Granted' }, { write: false, task: 'Audit' }, { write: false, task: 'Review' }]);
});

test('a read-only card can be granted writes on a later turn, and the grant stays', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const first = await send(ws, env, paths, { task: 'Add the test', mode: 'DELEGATE', wait: true, maxRounds: 4 });
  const taskId = first.structuredContent.taskId;
  assert.equal(getRecord(env.MAGI_HOME, 'tasks', taskId).allowWrites, false);
  await send(ws, env, paths, { task: 'Now do it', mode: 'DELEGATE', taskId, allowWrites: true, wait: true });
  assert.equal(getRecord(env.MAGI_HOME, 'tasks', taskId).allowWrites, true, 'true on a continuation is the card\'s grant from then on');
  const third = await send(ws, env, paths, { task: 'And the next part', mode: 'DELEGATE', taskId, wait: true });
  assert.doesNotMatch(textOf(third), /READ-ONLY/, 'a third turn that omits it keeps the grant');
  const writes = readCalls(logFile).filter((c) => c.args).map((c) => c.args.includes('write'));
  assert.deepEqual(writes, [false, true, true]);
});
