// A reply must reach the orchestrator exactly once. The waiter polls the
// mailbox and clears its marker on exit, so it can consume the reply between the
// peer's mailbox write and the peer's "is anyone waiting?" check. The peer must
// then not send it a second time out of band.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from '../src/peer.mjs';
import { newTaskId } from '../src/protocol.mjs';
import * as state from '../src/state.mjs';

function fresh() {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-once-'));
}

function openTask(taskId) {
  state.openRound({ taskId, orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1, maxRounds: 2, replyTo: 'codex:thread-1', cwd: process.cwd() });
}

function peerEngine({ sent }) {
  return makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    resolveOrigin: async () => null,
    deliverReply: async (o) => { sent.push(o.text); },
  });
}

test('a reply the waiter already took is not sent again out of band', async () => {
  fresh();
  openTask('t-race');
  state.markWaiting('t-race', 1);
  const sent = [];
  const engine = peerEngine({ sent });
  const pending = engine.handleReply({ taskId: 't-race', body: 'SUMMARY\nfine' });
  // Race the durable mailbox, not identity resolution: identity is now checked
  // before a reply may mutate the ledger.
  while (!state.listMail('t-race').length) await Promise.resolve();
  const taken = state.takeReply('t-race', 1);
  state.clearWaiting('t-race', 1);
  await pending;

  assert.ok(taken, 'the waiter consumed the reply from the mailbox');
  assert.equal(sent.length, 0, 'nothing was queued to the orchestrator on top of the inline delivery');
});

test('with no waiter the reply goes out of band exactly once', async () => {
  fresh();
  openTask('t-none');
  const sent = [];
  const engine = peerEngine({ sent });

  await engine.handleReply({ taskId: 't-none', body: 'SUMMARY\nfine' });

  assert.equal(sent.length, 1);
  assert.equal(state.listMail('t-none').length, 1, 'the durable copy stays in the mailbox');
});

test('a reply written in the waiter\'s final half-second is still collected', async () => {
  fresh();
  openTask('t-late');
  // Timeout shorter than one poll interval: the loop exits from its sleep without
  // another take unless a final one runs.
  const waiter = state.waitForReply('t-late', 300, undefined, 1);
  await new Promise((r) => setTimeout(r, 200));
  state.putReply('t-late', { body: 'late but present', round: 1 });
  const got = await waiter;
  assert.equal(got?.body, 'late but present');
});

test('new task IDs use magi and both prefixes support reply, outcome, and close', async () => {
  fresh();
  const generated = newTaskId();
  assert.match(generated, /^magi-[0-9a-f]{8}$/);
  const coordinator = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'claude_peer' });
  const peer = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'codex_peer' });

  for (const taskId of [generated, 'cx-1a2b3c4d']) {
    openTask(taskId);
    state.markWaiting(taskId, 1);
    try {
      const reply = await peer.handleReply({ taskId, body: 'SUMMARY\nThe boundary check holds.' });
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
      assert.equal(state.readTask(taskId).rounds[0].replied, true);
      assert.equal(state.takeReply(taskId, 1).body, 'SUMMARY\nThe boundary check holds.');
    } finally {
      state.clearWaiting(taskId, 1);
    }

    const outcome = await coordinator.handleOutcome({ taskId, accepted: 1, rejected: 0, open: 0 });
    assert.equal(outcome.isError, undefined, JSON.stringify(outcome));
    const reconciled = state.readTask(taskId);
    assert.deepEqual([reconciled.outcome.accepted, reconciled.outcome.round], [1, 1]);
    assert.equal(state.outcomeCovers(reconciled), true);

    state.openRound({ taskId, orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 2, maxRounds: 2, cwd: process.cwd() });
    const closed = await coordinator.handleClose({ taskId, body: 'No further review needed.' });
    assert.equal(closed.isError, undefined, JSON.stringify(closed));
    const round = state.readTask(taskId).rounds[1];
    assert.equal(round.closeReason, 'abandoned');
    assert.equal(round.closeDetail, 'No further review needed.');
    assert.equal(round.replied, false);
  }
});
