import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveSteerTarget, makeCodexLiveDelivery, makeCodexReplyDelivery } from '../src/codex-delivery.mjs';
import { makeEngine } from '../src/peer.mjs';
import { openRound, recordClarify, setPeerTarget } from '../src/state.mjs';
import { makeWorkspace, startServer, textOf } from './helpers/harness.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const other = '99999999-2222-3333-4444-555555555555';

test('steer accepts an explicit UUID without discovery and refuses an implicit target', async () => {
  assert.equal(await resolveSteerTarget(id, () => assert.fail('UUID needs no name search')), id);
  await assert.rejects(resolveSteerTarget(), { code: 'STEER_NEEDS_PEER' });
});

test('exact name resolution checks later pages for ambiguity', async () => {
  let calls = 0;
  const query = async ([request]) => {
    assert.equal(request.params.searchTerm, 'Audit');
    calls++;
    return [{ result: { data: [{ name: 'Audit', id: calls === 1 ? id : other }], nextCursor: calls === 1 ? 'next' : null } }];
  };
  await assert.rejects(resolveSteerTarget('Audit', query), { code: 'AMBIGUOUS_PEER' });
  assert.equal(calls, 2);
});

test('exact name resolution rejects substring-only matches and broken pagination', async () => {
  await assert.rejects(resolveSteerTarget('Audit', async () => [{ result: { data: [{ name: 'Audit other', id }], nextCursor: null } }]), { code: 'NO_LIVE_PEER' });
  await assert.rejects(resolveSteerTarget('Audit', async () => [{ result: { data: [{ name: 'Audit', id }], nextCursor: 'same' } }]), { code: 'STEER_LOOKUP_FAILED' });
});

test('a unique exact name resolves after pagination', async () => {
  const target = await resolveSteerTarget('Audit', async ([request]) => [{ result: request.params.cursor
    ? { data: [{ name: 'Audit', id }], nextCursor: null }
    : { data: [{ name: 'Other Audit', id: other }], nextCursor: 'next' } }]);
  assert.equal(target, id);
});

for (const kind of ['request', 'note', 'watch', 'reply', 'clarify', 'clarify_answer']) {
  for (const code of ['NO_STEER_CHANNEL', 'STEER_FAILED', 'STEER_TIMEOUT']) {
    test(`${kind} surfaces ${code} without queue or headless fallback`, async () => {
      const ws = makeWorkspace('steer failure');
      process.env.MAGI_HOME = join(ws, 'state');
      let attempted = 0;
      let questionId;
      if (['reply', 'clarify', 'clarify_answer'].includes(kind)) {
        openRound({ taskId: 'return', orchestrator: kind === 'clarify_answer' ? 'claude' : 'codex', peer: kind === 'clarify_answer' ? 'codex' : 'claude', mode: 'REVIEW', round: 1, cwd: ws, orchestratorTarget: { agent: kind === 'clarify_answer' ? 'claude' : 'codex', id } });
        if (kind === 'clarify_answer') {
          setPeerTarget('return', id);
          questionId = recordClarify({ taskId: 'return', from: 'codex', round: 1 });
        }
      }
      const steer = async (args) => {
        attempted++;
        assert.equal(args.thread, id);
        assert.deepEqual(Object.keys(args).sort(), ['text', 'thread'], 'no caller/source override may cross this boundary');
        throw Object.assign(new Error('fixture rejection'), { code });
      };
      const engine = makeEngine({
        orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
        pickDelivery: async ({ delivery, target }) => { assert.equal(delivery, 'steer'); return { mode: 'live', target: await resolveSteerTarget(target) }; },
        deliverLive: makeCodexLiveDelivery({
          queue: () => assert.fail('must not queue'),
          steer,
        }),
        deliverReply: makeCodexReplyDelivery({ steer, queueReply: () => assert.fail('must not queue reply') }),
        watchIdle: () => assert.fail('explicit steer must not become a different watch transport'),
        deliverHeadless: () => assert.fail('must not start headless peer'),
      });
      const args = { delivery: 'steer', peer: id, questionId, workingDirectory: ws, task: 'inspect', body: 'inspect', wait: false, ...(['reply', 'clarify', 'clarify_answer'].includes(kind) ? { taskId: 'return', round: 1 } : {}) };
      const result = await engine[{ request: 'handleRequest', note: 'handleNote', watch: 'handleWatch', reply: 'handleReply', clarify: 'handleClarify', clarify_answer: 'handleClarifyAnswer' }[kind]](args);
      assert.equal(result.isError, true);
      assert.match(textOf(result), new RegExp(code));
      assert.equal(attempted, 1);
    });
  }
}

test('steer preserves a large provenance body and reports acceptance rather than receipt', async () => {
  const body = 'PEER NOTE from=claude via=magi\n' + 'x'.repeat(30000);
  const deliver = makeCodexLiveDelivery({
    queue: () => assert.fail('must not queue'),
    steer: async (args) => { assert.equal(args.thread, id); assert.equal(args.text, body); },
  });
  const result = await deliver({ delivery: 'steer', target: id, text: body, putRequestBody: () => assert.fail('stdio needs no argv spill') });
  assert.equal(result.via, `steer:${id}`);
  assert.equal(result.deliveryStatus, 'accepted');
});

test('steered replies use the recorded origin and never guess from peerTarget', async () => {
  let called = 0;
  const deliver = makeCodexReplyDelivery({
    steer: async (args) => { called++; assert.equal(args.thread, id); },
    queueReply: () => assert.fail('must not queue'),
  });
  await deliver({ delivery: 'steer', text: 'reply', task: { orchestrator: 'codex', orchestratorTarget: { agent: 'codex', id }, peerTarget: other } });
  await assert.rejects(deliver({ delivery: 'steer', text: 'reply', task: { orchestrator: 'codex', peerTarget: other } }), { code: 'NO_REPLY_ROUTE' });
  await assert.rejects(deliver({ delivery: 'steer', text: 'reply', task: { orchestrator: 'codex', orchestratorTarget: { agent: 'claude', id: other }, replyTo: `codex:${id}` } }), { code: 'NO_REPLY_ROUTE' });
  assert.equal(called, 1);
});

test('a queued message without a recoverable clientId remains unconfirmed', async () => {
  const deliver = makeCodexLiveDelivery({
    queue: async (args) => { assert.equal(args.thread, 'Named task'); return { messageId: 'queued' }; },
    steer: () => assert.fail('default path must not use private desktop transport'),
  });
  assert.equal((await deliver({ delivery: 'live', target: 'Named task', text: 'hello' })).deliveryStatus, 'unconfirmed');
});

test('real codex_peer schema accepts steer and the adapter requires an explicit peer', async () => {
  const ws = makeWorkspace('steer schema');
  const server = await startServer('codex', { cwd: ws, env: { MAGI_HOME: join(ws, 'state'), CODEX_BIN: join(ws, 'absent') } });
  try {
    const result = await server.call('codex_peer', { kind: 'note', body: 'test', delivery: 'steer', workingDirectory: ws });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /STEER_NEEDS_PEER/);
  } finally { await server.close(); }
});

// codex 0.155.1 refuses a thread name once its list spans pages, so a live
// queue goes by the id pickSession already resolved; the name stays the label.
test('a live queue addresses the resolved thread by id, not name', async () => {
  const deliver = makeCodexLiveDelivery({
    queue: async ({ thread }) => { assert.equal(thread, id); return { messageId: 'm1', threadId: id }; },
    steer: () => assert.fail('must not steer'),
  });
  const result = await deliver({ target: { name: 'impl', id }, text: 'hello', kind: 'request' });
  assert.equal(result.via, 'live:impl');
  assert.equal(result.target, id);
});
