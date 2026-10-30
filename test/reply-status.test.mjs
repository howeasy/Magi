// A peer says in one line whether it finished; a reply that does not say is unknown, never success.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace, textOf } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { parseReply, outputSections, composeRequest } from '../src/protocol.mjs';

const status = (text) => parseReply(text).status;

test('STATUS is read from a single line in each way a model writes it', () => {
  assert.deepEqual(status('STATUS: RESOLVED - all 12 tests pass\n\nSUMMARY\nok'), { state: 'resolved', reason: 'all 12 tests pass' });
  assert.deepEqual(status('**STATUS:** BLOCKED — needs the staging key'), { state: 'blocked', reason: 'needs the staging key' });
  assert.deepEqual(status('## STATUS\nFAILED: the build does not compile\n\nSUMMARY\nx'), { state: 'failed', reason: 'the build does not compile' });
  assert.deepEqual(status('- Status - resolved'), { state: 'resolved', reason: '' });
  assert.deepEqual(status('SUMMARY\nfine\n\nSTATUS\n**BLOCKED** needs a decision'), { state: 'blocked', reason: 'needs a decision' });
});

test('a reply that names no status has none, and prose that merely mentions the word is not one', () => {
  assert.equal(status(''), null);
  assert.equal(status(undefined), null);
  assert.equal(status('SUMMARY\nThe job is resolved and the status page is blocked by a proxy.'), null);
  assert.equal(status('STATUS: the review is done'), null);
  assert.equal(status('STATUS\n\nSUMMARY\nnothing under the heading'), null);
});

test('only the first STATUS counts, so a quoted reply further down cannot overrule it', () => {
  assert.deepEqual(status('STATUS: FAILED - nothing built\n\nFINDINGS\nThe old reply said:\nSTATUS: RESOLVED - done'), { state: 'failed', reason: 'nothing built' });
});

test('a STATUS line does not leak into the sections around it', () => {
  const p = parseReply('STATUS: RESOLVED - done\n\nSUMMARY\ntwo sentences\n\nFINDINGS\nnone');
  assert.equal(p.summary, 'two sentences');
  assert.equal(p.findings, 'none');
});

test('every mode asks for STATUS first, and the request text carries it', () => {
  for (const mode of ['SECOND_OPINION', 'REVIEW', 'ADVERSARIAL_REVIEW', 'FACT_CHECK', 'DELEGATE', 'BAKEOFF']) {
    assert.match(outputSections(mode)[0], /^STATUS - one line: RESOLVED/, mode);
  }
  const { text } = composeRequest({ taskId: 't1', orchestrator: 'claude', peer: 'codex', task: 'Look', mode: 'REVIEW', replyTool: 'claude_peer' });
  assert.match(text, /- STATUS - one line/);
});

test('a finished headless reply reports its status, and one without a status reports null', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'isolated-home');
  const replies = ['STATUS: BLOCKED - needs the staging key\n\nSUMMARY\nstopped at the login', 'SUMMARY\nplain answer'];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ inlineReply: replies.shift(), via: 'headless' }),
  });
  const first = await engine.handleRequest({ wait: true, task: 'Try it', mode: 'DELEGATE', delivery: 'headless', workingDirectory: ws });
  assert.equal(first.isError, undefined, textOf(first));
  assert.deepEqual(first.structuredContent.status, { state: 'blocked', reason: 'needs the staging key' });
  const second = await engine.handleRequest({ wait: true, task: 'Look', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  assert.equal(second.isError, undefined, textOf(second));
  assert.equal(second.structuredContent.status, null);
});

test('the ledger keeps the status per round, and magi log can show it', async () => {
  const { readTask, taskSummary } = await import('../src/state.mjs');
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'isolated-home');
  const replies = ['STATUS: FAILED - the build does not compile\n\nSUMMARY\nx', 'SUMMARY\nno status line'];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ inlineReply: replies.shift(), via: 'headless' }),
  });
  const failed = await engine.handleRequest({ wait: true, task: 'Try it', mode: 'DELEGATE', delivery: 'headless', workingDirectory: ws });
  const plain = await engine.handleRequest({ wait: true, task: 'Look', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  const a = taskSummary(readTask(failed.structuredContent.taskId));
  assert.equal(a.peerStatus, 'failed');
  assert.equal(a.peerStatusReason, 'the build does not compile');
  const b = taskSummary(readTask(plain.structuredContent.taskId));
  assert.equal(b.peerStatus, null, 'a reply that named no status is unknown, not resolved');
});
