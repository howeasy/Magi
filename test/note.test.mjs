// Notes are conversation, optionally attached to a card. They spend no turn;
// rate limits and dedupe bound successful or uncertain dispatches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace } from './helpers/harness.mjs';
import { composeNote } from '../src/protocol.mjs';
import * as state from '../src/state.mjs';

async function freshEngine(ws, overrides = {}) {
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const sent = [];
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    pickDelivery: async () => ({ mode: 'live', target: 'peer-thread' }),
    deliverLive: async ({ text }) => {
      sent.push(text);
      return { via: 'live:peer-thread' };
    },
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
    ...overrides,
  });
  return { engine, sent };
}

test('a note opens no task and spends no round', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  await engine.handleNote({ body: 'just so you know' });
  assert.deepEqual(state.listTasks(), [], 'a note must not create a task');
});

test('notes are rate limited per sender', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  for (let i = 0; i < 5; i++) {
    const ok = await engine.handleNote({ body: `distinct note ${i}` });
    assert.equal(ok.isError, undefined, `note ${i} should be accepted`);
  }
  const res = await engine.handleNote({ body: 'one too many' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOTE_RATE_LIMIT/);
});

test('an identical note is suppressed rather than repeated', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  await engine.handleNote({ body: 'the build is green' });
  const res = await engine.handleNote({ body: 'the build is green' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOTE_DUPLICATE/);
});

test('a note needs a live peer', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws, {
    pickDelivery: async () => {
      throw Object.assign(new Error('nobody home'), { code: 'NO_LIVE_PEER' });
    },
  });
  const res = await engine.handleNote({ body: 'anyone there' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_LIVE_PEER/);
});

test('a note without a body is refused', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  const res = await engine.handleNote({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /BAD_REQUEST/);
});

test('secrets are redacted from notes too', () => {
  const text = composeNote({ from: 'claude', body: 'use api_key=sk-abcdefghijklmnopqrstuvwxyz123456' });
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/);
  assert.match(text, /REDACTED/);
});

// Seen live (cx-99da13de): the peer finished in seven minutes, mistyped the
// task id in its reply, read "no open task" as "the task closed", and sent
// the review as a note; the orchestrator waited the full forty minutes.
test('a reply to a mistyped task id names the task the peer owes; a note while owing says so too', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  const s = await import('../src/state.mjs?' + Math.random());
  s.openRound({ taskId: 'cx-99da13de', orchestrator: 'codex', peer: 'claude', mode: 'ADVERSARIAL_REVIEW', round: 1, maxRounds: 2 });

  const wrong = await engine.handleReply({ taskId: 'cx-99ad13de', body: 'FINDINGS: ...' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /UNKNOWN_TASK/);
  assert.match(wrong.content[0].text, /waiting on your reply: cx-99da13de \(round 1, from codex, ADVERSARIAL_REVIEW\)/);

  const note = await engine.handleNote({ body: 'Here is the review instead.' });
  assert.equal(note.isError, undefined);
  assert.match(note.content.map((c) => c.text).join('\n'), /still owe a reply on cx-99da13de/);

  s.recordReply({ taskId: 'cx-99da13de', from: 'claude' });
  const after = await engine.handleNote({ body: 'All done here.' });
  assert.doesNotMatch(after.content.map((c) => c.text).join('\n'), /still owe/);
});

test('a confirmed failed note releases dedupe and rate reservations before retry', async () => {
  const ws = makeWorkspace();
  let failed = true;
  const { engine } = await freshEngine(ws, {
    deliverLive: async () => ({ via: 'live:peer-thread', deliveryStatus: failed ? 'failed' : 'queued_unread' }),
  });
  for (let i = 0; i < 6; i++) {
    const result = await engine.handleNote({ body: 'retry this failed note' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /DELIVERY_FAILED/);
    assert.match(result.content[0].text, /fix the receiver before retrying/);
  }
  failed = false;
  assert.equal((await engine.handleNote({ body: 'retry this failed note' })).isError, undefined);
  for (let i = 0; i < 4; i++) assert.equal((await engine.handleNote({ body: `successful note ${i}` })).isError, undefined);
  assert.match((await engine.handleNote({ body: 'over budget' })).content[0].text, /NOTE_RATE_LIMIT/);
});

test('an unconfirmed note keeps its reservation to prevent a duplicate dispatch', async () => {
  const ws = makeWorkspace();
  let sends = 0;
  const { engine } = await freshEngine(ws, {
    deliverLive: async () => { sends++; return { via: 'live:peer-thread', deliveryStatus: 'unconfirmed' }; },
  });
  assert.equal((await engine.handleNote({ body: 'possibly received' })).isError, undefined);
  const duplicate = await engine.handleNote({ body: 'possibly received' });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /NOTE_DUPLICATE/);
  assert.equal(sends, 1);
});

test('a confirmed failed request is not a delivered round or a headless fallback', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws, {
    deliverLive: async () => ({ via: 'live:peer-thread', deliveryStatus: 'failed' }),
    deliverHeadless: () => assert.fail('a confirmed rejection must be surfaced'),
  });
  const result = await engine.handleRequest({ task: 'inspect', wait: false, workingDirectory: ws });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DELIVERY_FAILED/);
  assert.match(result.content[0].text, /retry the request after fixing the receiver/);
  assert.deepEqual(state.listTasks(), []);
});
