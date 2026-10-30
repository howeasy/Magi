// Neither harness shows a tool call's arguments, so the bridge announces the
// prompt it composed over the progress channel. That has to happen at send time:
// on a blocking review the result is up to 40 minutes away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine, makeProgress, sentLine, SENT_PREVIEW_CHARS } from '../src/peer.mjs';

function harness(cfg = {}) {
  const seen = [];
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: { name: 'web' } }),
    deliverLive: async () => ({ via: 'queue', deliveryStatus: 'queued_unread' }),
    ...cfg,
  });
  return { engine, seen, ctx: { progress: (m) => seen.push(m) } };
}

test('a blocking request announces what it sent without waiting for the reply', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-prog-'));
  const { engine, seen, ctx } = harness();

  // No reply ever arrives, so this returns only on the timeout. The announcement
  // must already have happened.
  const res = await engine.handleRequest({ wait: true, task: 'find the off-by-one', mode: 'REVIEW', timeoutMs: 500, workingDirectory: process.cwd() }, ctx);

  assert.equal(res.structuredContent.timedOut, true, 'the call did block and time out');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith(`sent REVIEW request ${res.structuredContent.taskId} to web (`));
  assert.doesNotMatch(seen[0], /PEER REQUEST/, 'the header is what the prefix already says; the preview is the task');
  assert.ok(!seen[0].includes('\n'), 'a progress message is a status line, not a block');
});

test('a note and a watch announce their own composed text', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-prog-'));
  const { engine, seen, ctx } = harness();

  await engine.handleNote({ body: 'the migration landed', workingDirectory: process.cwd() }, ctx);
  assert.match(seen[0], /^sent note to web \(\d+ chars\): the migration landed$/);

  await engine.handleWatch({ body: 'before I rebase', workingDirectory: process.cwd() }, ctx);
  assert.match(seen[1], /^sent watch to web \(\d+ chars\):/);
});

test('the preview is capped, and the real length is still reported', () => {
  const line = sentLine('x'.repeat(5000), 'web', 'note');
  assert.match(line, /\(5000 chars\)/);
  assert.ok(line.length < SENT_PREVIEW_CHARS + 60);
  assert.ok(line.endsWith('...'));
});

test('no progress token means no notifications, not a crash', () => {
  assert.equal(makeProgress(undefined), undefined);
  assert.equal(makeProgress({ _meta: {} }), undefined, 'a call that asked for no progress');
  assert.equal(makeProgress({ _meta: { progressToken: 1 } }), undefined, 'no way to send it');
  assert.equal(typeof makeProgress({ _meta: { progressToken: 1 }, sendNotification: async () => {} }), 'function');
});
