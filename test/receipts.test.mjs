import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace } from './helpers/harness.mjs';

test('a watch is always the co-operative kind: the peer is asked, nothing subscribes', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const sent = [];
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'live', target: 't1' }),
    deliverLive: async ({ text }) => {
      sent.push(text);
      return { via: 'live:t1' };
    },
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
  });
  const res = await engine.handleWatch({});
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.native, false);
  assert.match(res.content[0].text, /co-operative/);
  assert.match(sent[0], /PEER WATCH/);
});
