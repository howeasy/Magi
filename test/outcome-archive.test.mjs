// Historic outcome summaries remain readable alongside indefinitely retained tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './helpers/harness.mjs';
import { getRecord, setRecord, listRecords, statement } from '../src/store.mjs';
import { setEmbedder } from '../src/embeddings.mjs';

const CLI = fileURLToPath(new URL('../bin/magi.mjs', import.meta.url));

async function setup() {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  setEmbedder(async () => Float32Array.of(1, 0));
  const state = await import('../src/state.mjs');
  const put = (taskId, { outcome, openedAt = 1 } = {}) => {
    const task = {
      taskId, orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', maxRounds: 2, cwd: 'E:/secret/project', ...(outcome ? { outcome } : {}),
      rounds: [{ round: 1, openedAt, replied: true, brief: 'FULL TASK TEXT', usage: { costUsd: 0.25 } }],
    };
    setRecord(home, 'tasks', taskId, task);
    return task;
  };
  return { home, state, put };
}

test('repeated sweeps summarize old closed cards and preserve task metadata and verdicts', async () => {
  const { home, state, put } = await setup();
  const scored = put('cx-scored01', { outcome: { accepted: 3, rejected: 1, open: 2, notes: 'n'.repeat(500), at: 123, round: 1 } });
  const unscored = put('cx-unscored1');
  const fresh = put('cx-fresh0001', { openedAt: Date.now() });
  state.recordExchange(scored.taskId, { kind: 'request', task: 'Audit rotation', context: 'Large context' });
  state.recordExchange(scored.taskId, { kind: 'reply', text: 'Rotate the key', verdict: 'held', round: 1 });
  state.recordExchange(scored.taskId, { kind: 'outcome', text: scored.outcome.notes });

  await state.sweep(1);
  const trimmed = state.readTask(scored.taskId);
  await state.sweep(1);
  assert.deepEqual(state.readTask(scored.taskId), trimmed, 'second sweep does not resummarize');
  const { bodiesTrimmedAt, summaryMemoryId, ...metadata } = trimmed;
  assert.deepEqual(metadata, scored);
  assert.ok(bodiesTrimmedAt);
  const exchanges = state.readExchange(scored.taskId);
  const marker = `[trimmed after 30 days; summary in memory ${summaryMemoryId}]`;
  assert.equal(exchanges[0].task, marker);
  assert.equal(exchanges[0].context, marker);
  assert.equal(exchanges[1].text, marker);
  assert.equal(exchanges[1].verdict, 'held');
  assert.equal(exchanges[1].round, 1);
  assert.equal(exchanges[2].text, scored.outcome.notes, 'verdict note is never trimmed');
  const summary = statement(home, 'SELECT value,vector FROM memory WHERE id=?').get(summaryMemoryId);
  assert.match(JSON.parse(summary.value).content, /Audit rotation.*Rotate the key/);
  assert.ok(summary.vector);
  for (const task of [unscored, fresh]) assert.deepEqual(state.readTask(task.taskId), task);
  assert.deepEqual(listRecords(home, 'archive'), [], 'retained tasks do not need lossy archive summaries');
});

test('a sweep retains later rounds and the original outcome rather than replacing a task with a summary', async () => {
  const { state, put } = await setup();
  put('cx-retained1', { outcome: { accepted: 1, rejected: 0, open: 0, notes: null, at: 1, round: 1 } });
  state.openRound({ taskId: 'cx-retained1', orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', round: 2 });
  state.recordReply({ taskId: 'cx-retained1', from: 'omp', round: 2, payload: { body: 'FULL REPLY TEXT', at: 1 } });
  const before = state.readTask('cx-retained1');

  await state.sweep(1);

  assert.deepEqual(state.readTask('cx-retained1'), before);
  assert.equal(state.takeReply('cx-retained1', 2).body, 'FULL REPLY TEXT');
  assert.equal(state.listTasksWithArchive().filter((t) => t.taskId === 'cx-retained1').length, 1);
});

test('magi log counts historic archives without double-counting a retained task', async () => {
  const { home, state, put } = await setup();
  const summary = {
    taskId: 'cx-gone0001', orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', maxRounds: 2,
    openedAt: 1, replied: true, answeredRound: 1, repliedAt: 2, round: 1, costUsd: 0.25,
    outcome: { accepted: 4, rejected: 1, open: 1, notes: 'archived verdict', at: 5, round: 1 },
  };
  setRecord(home, 'archive', summary.taskId, summary);
  setRecord(home, 'archive', 'cx-live0001', { ...summary, taskId: 'cx-live0001', outcome: { ...summary.outcome, accepted: 99 } });
  put('cx-live0001', { openedAt: Date.now(), outcome: { accepted: 1, rejected: 0, open: 0, notes: null, at: 6, round: 1 } });
  await state.sweep(1);
  assert.deepEqual(getRecord(home, 'archive', summary.taskId), summary);
  assert.deepEqual(state.listTasksWithArchive().map((t) => t.taskId).sort(), ['cx-gone0001', 'cx-live0001']);
  assert.equal(state.listTasksWithArchive().find((t) => t.taskId === 'cx-live0001').outcome.accepted, 1, 'the full task takes precedence over its historic summary');

  const out = execFileSync(process.execPath, [CLI, 'log'], { env: { ...process.env, MAGI_HOME: home }, encoding: 'utf-8' });
  assert.match(out, /cx-gone0001/);
  assert.match(out, /archived verdict/);
  assert.match(out, /2 task\(s\); 2 with a recorded outcome/);
  assert.match(out, /5 accepted, 1 rejected, 1 open/);
});
