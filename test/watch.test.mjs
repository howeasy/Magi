// One-shot idle notice. Neither harness exposes a busy/idle status worth
// polling, so this is cooperative: a queued message is read exactly when the
// peer next takes input, which is the moment it has finished.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { makeWorkspace } from './helpers/harness.mjs';
import { composeWatch } from '../src/protocol.mjs';

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

test('a watch asks for exactly one note and does not block', async () => {
  const ws = makeWorkspace();
  const { engine, sent } = await freshEngine(ws);
  const res = await engine.handleWatch({});
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.watch, true);
  assert.match(res.content[0].text, /Nothing is blocking/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /PEER WATCH magi\/1 from=claude/);
  assert.match(sent[0], /send exactly one note back/);
  assert.match(sent[0], /kind="note"/);
});

test('a watch tells the peer not to interrupt itself or answer twice', () => {
  const text = composeWatch({ from: 'codex', replyTool: 'codex_peer' });
  assert.match(text, /Do not start new work for this/);
  assert.match(text, /do not interrupt what you are doing/);
  assert.match(text, /not\n?\s*reply more than once/);
  assert.match(text, /If you are already free, send the note now/);
});

test('a watch opens no task and spends no round', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  await engine.handleWatch({});
  assert.equal(existsSync(join(ws, 'home', 'tasks')), false, 'a watch must not create a task');
});

test('watches share the note budget, so they cannot be used to spam a peer', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws);
  const first = await engine.handleWatch({ body: 'run one' });
  assert.equal(first.isError, undefined);
  const repeat = await engine.handleWatch({ body: 'run one' });
  assert.equal(repeat.isError, true);
  assert.match(repeat.content[0].text, /NOTE_DUPLICATE/);
});

test('a watch needs a live peer', async () => {
  const ws = makeWorkspace();
  const { engine } = await freshEngine(ws, {
    pickDelivery: async () => {
      throw Object.assign(new Error('nobody home'), { code: 'NO_LIVE_PEER' });
    },
  });
  const res = await engine.handleWatch({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_LIVE_PEER/);
});

test('an accompanying message is redacted like anything else that leaves', () => {
  const text = composeWatch({ from: 'claude', replyTool: 'claude_peer', note: 'creds are token=abc123def456ghi789' });
  assert.doesNotMatch(text, /abc123def456ghi789/);
  assert.match(text, /REDACTED/);
});
