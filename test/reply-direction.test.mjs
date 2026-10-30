// An out-of-band reply must travel to the OTHER agent. Both handlers originally
// delivered back to the replying agent's own side; the blocking path masked it
// because a waiting orchestrator is served from the mailbox instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace } from './helpers/harness.mjs';

async function stateFor(ws) {
  process.env.MAGI_HOME = join(ws, 'home');
  return import('../src/state.mjs?' + Math.random());
}

test('a reply with nobody waiting is routed, not silently dropped', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'd1', orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', round: 1, maxRounds: 2, cwd: ws });
  assert.equal(s.isWaiting('d1'), false, 'an async request leaves no waiting marker');

  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const sent = [];
  const engine = makeEngine({
    orchestrator: 'codex', // this side is the PEER replying
    peerName: 'claude',
    replyTool: 'codex_peer',
    replyAddress: () => null,
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async ({ task }) => sent.push(task.orchestrator),
  });

  const res = await engine.handleReply({ taskId: 'd1', body: 'SUMMARY\ndone' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(sent, ['claude'], 'the reply must be addressed to the orchestrator, not back to the peer');
});

test('the ledger records the working directory so a reply can find its way home', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  const rec = s.openRound({ taskId: 'd2', orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1, maxRounds: 2, cwd: ws });
  assert.equal(rec.cwd, ws);
});

test('a failed out-of-band delivery leaves the reply in the mailbox', async () => {
  const ws = makeWorkspace();
  const s = await stateFor(ws);
  s.openRound({ taskId: 'd3', orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', round: 1, maxRounds: 2, cwd: ws });

  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'codex',
    peerName: 'claude',
    replyTool: 'codex_peer',
    replyAddress: () => null,
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverLive: async () => ({ via: 'live' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {
      throw Object.assign(new Error('no live peer'), { code: 'NO_LIVE_PEER' });
    },
  });

  const res = await engine.handleReply({ taskId: 'd3', body: 'SUMMARY\ndone' });
  assert.equal(res.isError, true);
  assert.equal(s.takeReply('d3')?.body, 'SUMMARY\ndone', 'the reply must survive a delivery failure');
});
