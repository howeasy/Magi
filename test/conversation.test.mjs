import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { makeWorkspace, initGitRepo, textOf, fakeEnv } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { makeServerEngine } from '../src/serve.mjs';
import { channelsOf } from '../src/fleet.mjs';
import { peerInputSchema } from '../src/peer-schema.mjs';
import { CHANNEL_WINDOW_MS, readTask, readExchange, listTasks, recordRequestDelivery } from '../src/state.mjs';
import { setRecord } from '../src/store.mjs';
import { remember } from '../src/memory.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import { compactionAt } from '../src/transcript.mjs';

const schema = z.object(peerInputSchema({ deliveries: ['auto', 'live', 'headless', 'steer'], peerHint: 'session id' }));
const session = (agent, id, cwd) => ({ agent, id, sessionId: id, cwd });

function fixture(t, { git = false } = {}) {
  const cwd = makeWorkspace('conversation');
  if (git) initGitRepo(cwd);
  const env = { ...fakeEnv(cwd).env, PEER_DEPTH: '0', MAGI_AS: 'claude', HOME: cwd, USERPROFILE: cwd, OMP_AGENT_DIR: join(cwd, 'omp'), CLAUDE_CODE_SESSION_ID: '' };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  setEmbedder(null);
  const owner = session('claude', 'owner', cwd);
  const workers = [session('omp', 'worker', cwd), session('omp', 'replacement', cwd)];
  const sent = [];
  const picks = [];
  let failure = false;
  let compactedAt = null;
  const coordinator = (caller = owner, peerName = 'omp', overrides = {}) => makeEngine({
    orchestrator: caller.agent, peerName, replyTool: 'peer_tool',
    resolveOrigin: async () => ({ target: caller, identityVerified: true, identitySource: 'test_runtime' }),
    pickDelivery: async (args) => {
      picks.push(args);
      const target = workers.find((s) => s.id === args.target) ?? workers[0];
      return { mode: 'live', target };
    },
    compactionAt: async () => compactedAt,
    deliverLive: async (args) => {
      if (failure) throw Object.assign(new Error('send failed'), { code: 'NO_LIVE_PEER', dispatchUncertain: false });
      sent.push(args);
      return { via: args.delivery === 'steer' ? 'steer' : 'live', target: args.target, deliveryStatus: 'queued_unread' };
    },
    ...overrides,
  });
  const engine = coordinator();
  const call = (kind, args, e = engine) => e[`handle${kind[0].toUpperCase()}${kind.slice(1)}`](schema.parse({ kind, ...args }));
  const request = (args = {}) => call('request', { task: 'Implement auth rotation', mode: 'DELEGATE', workingDirectory: cwd, wait: false, ...args });
  const answer = async (taskId, body = 'Rotation checked', round = readTask(taskId).rounds.at(-1).round, target = readTask(taskId).peerTarget) => {
    const worker = makeEngine({ orchestrator: 'omp', peerName: 'claude', replyTool: 'peer_tool',
      resolveOrigin: async () => ({ target, identityVerified: true }),
      deliverReply: async () => ({ via: 'live', deliveryStatus: 'queued_unread' }),
    });
    const result = await call('reply', { taskId, round, body }, worker);
    assert.equal(result.isError, undefined, textOf(result));
    return result;
  };
  const ok = (result) => { assert.equal(result.isError, undefined, textOf(result)); return result.structuredContent; };
  const adapterEngine = (supportsSteer) => makeServerEngine({
    peer: 'omp', selfDefault: 'claude', replyTool: () => 'peer_tool',
    schema: { deliveries: supportsSteer ? ['auto', 'live', 'steer'] : ['auto', 'live'], peerHint: 'session id' },
    sessions: async () => workers.map((s) => ({ ...s, status: 'busy' })),
    deliverLive: async (args) => {
      sent.push(args);
      return { via: args.delivery, deliveryStatus: 'queued_unread' };
    },
  }).engine;
  return { cwd, owner, workers, sent, picks, engine, coordinator, adapterEngine, call, request, answer, ok,
    fail: (value) => { failure = value; }, compact: (value) => { compactedAt = value; } };
}

test('taskId alone continues the card at the engine-assigned turn and retains the worker, mode and write grant', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request({ allowWrites: true }));
  await f.answer(first.taskId);
  const second = f.ok(await f.call('request', { taskId: first.taskId, task: 'Now handle token expiry', wait: false }));
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.round, 2);
  assert.equal(second.maxRounds, null);
  assert.equal(f.picks.at(-1).target, 'worker');
  assert.equal(f.picks.at(-1).delivery, 'live');
  assert.equal(f.sent.at(-1).allowWrites, true);
  assert.equal(readTask(first.taskId).mode, 'DELEGATE');
  assert.deepEqual(readTask(first.taskId).rounds.map((r) => r.round), [1, 2]);
  assert.equal(listTasks().length, 1);
  assert.match(f.sent.at(-1).text, /^PEER TURN magi\/1 .*turn=2/);
  assert.match(f.sent.at(-1).text, /taskId="[^"]+" and round=2/);
});

test('mode and harness changes refuse a continuation without opening a turn; explicit peer moves only its next turn', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  await f.answer(first.taskId);
  assert.match(textOf(await f.request({ taskId: first.taskId, mode: 'REVIEW' })), /CARD_FIXED/);
  assert.match(textOf(await f.call('request', { taskId: first.taskId, task: 'Switch harness', wait: false }, f.coordinator(f.owner, 'codex'))), /CARD_FIXED/);
  assert.equal(readTask(first.taskId).rounds.length, 1);
  const drifted = f.coordinator(f.owner, 'omp', { pickDelivery: async () => ({ mode: 'live', target: f.workers[1] }) });
  assert.match(textOf(await f.call('request', { taskId: first.taskId, task: 'Implicit worker drift', wait: false }, drifted)), /WORKER_CHANGED/);
  assert.equal(readTask(first.taskId).rounds.length, 1);
  f.ok(await f.request({ taskId: first.taskId, peer: 'replacement' }));
  const card = readTask(first.taskId);
  assert.equal(card.peerTarget.id, 'replacement');
  assert.equal(card.rounds[0].peerTarget.id, 'worker');
  assert.equal(card.rounds[1].peerTarget.id, 'replacement');
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
});

test('pending cards cannot advance and another coordinator session cannot continue one', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  assert.match(textOf(await f.request({ taskId: first.taskId })), /ROUND_PENDING/);
  const stranger = f.coordinator(session('claude', 'stranger', f.cwd));
  assert.match(textOf(await f.call('request', { taskId: first.taskId, task: 'Take ownership', wait: false }, stranger)), /ROLE_VIOLATION/);
  assert.equal(readTask(first.taskId).rounds.length, 1);
});

test('live delegation exceeds twelve turns but the conversation window expires; reviews retain their loop guard', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  for (let turn = 2; turn <= 14; turn++) {
    await f.answer(first.taskId, `Evidence for turn ${turn - 1}`);
    assert.equal(f.ok(await f.request({ taskId: first.taskId })).round, turn);
  }
  await f.answer(first.taskId);
  const card = readTask(first.taskId);
  card.channelExpiresAt = Date.now() - 1;
  setRecord(process.env.MAGI_HOME, 'tasks', first.taskId, card);
  assert.match(textOf(await f.request({ taskId: first.taskId })), /CHANNEL_EXPIRED/);
  assert.equal(readTask(first.taskId).rounds.length, 14);
  const review = f.ok(await f.request({ mode: 'REVIEW' }));
  await f.answer(review.taskId);
  f.ok(await f.request({ taskId: review.taskId, mode: 'REVIEW' }));
  await f.answer(review.taskId);
  assert.match(textOf(await f.request({ taskId: review.taskId, mode: 'REVIEW' })), /ROUNDS_EXHAUSTED/);
});

test('framing and memory are pair-scoped across cards, with repo deltas and protocol receipts', async (t) => {
  const f = fixture(t, { git: true });
  await remember({ body: 'Auth rotation revokes old refresh tokens', tags: ['auth', 'rotation'], cwd: f.cwd, source: 'test' });
  const first = f.ok(await f.request({ diffRef: 'worktree' }));
  const initial = f.sent.at(-1).text;
  assert.match(initial, /^PEER REQUEST/);
  assert.match(initial, /Auth rotation revokes old refresh tokens/);
  await f.answer(first.taskId);
  writeFileSync(join(f.cwd, 'a.txt'), 'three\n');
  const second = f.ok(await f.request({ diffRef: 'worktree' }));
  const compact = f.sent.at(-1).text;
  assert.match(compact, /^PEER TURN/);
  assert.match(compact, /REPOSITORY CHANGES/);
  assert.match(compact, /\+three/);
  assert.doesNotMatch(compact, /Auth rotation revokes old refresh tokens/);
  assert.match(compact, /kind="reply"/);
  assert.equal(readTask(second.taskId).rounds[0].framing.protocol, 'magi/1');
  assert.equal(readTask(second.taskId).rounds[0].framing.full, false);
  assert.equal(channelsOf(listTasks()).find((c) => c.toId === 'worker').protocol, 'magi/1');
  const another = f.coordinator(session('claude', 'another-owner', f.cwd));
  f.ok(await f.call('request', { task: 'Implement auth rotation', mode: 'DELEGATE', workingDirectory: f.cwd, wait: false }, another));
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
});

test('8-hour framing expiry, explicit compaction and protocol version changes each resend full instructions', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  await f.answer(first.taskId);
  const turn = readTask(first.taskId).rounds[0];
  recordRequestDelivery(first.taskId, 1, { ...turn.framing, sentAt: Date.now() - CHANNEL_WINDOW_MS });
  const second = f.ok(await f.request());
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
  await f.answer(second.taskId);
  f.compact(Date.now() + 1);
  const third = f.ok(await f.request());
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
  await f.answer(third.taskId);
  f.compact(null);
  // No compatible full receipt remains for this pair.
  for (const card of listTasks()) for (const r of card.rounds) {
    if (r.framing?.full) recordRequestDelivery(card.taskId, r.round, { ...r.framing, protocol: 'magi/old' });
  }
  f.ok(await f.request());
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
});

test('failed dispatch neither opens a continuation nor establishes compact framing', async (t) => {
  const f = fixture(t);
  f.fail(true);
  const failed = await f.request();
  assert.equal(failed.isError, true);
  assert.deepEqual(listTasks(), []);
  f.fail(false);
  const first = f.ok(await f.request());
  assert.match(f.sent.at(-1).text, /^PEER REQUEST/);
  await f.answer(first.taskId);
  f.fail(true);
  assert.equal((await f.request({ taskId: first.taskId })).isError, true);
  assert.equal(readTask(first.taskId).rounds.length, 1);
  f.fail(false);
  assert.equal(f.ok(await f.request({ taskId: first.taskId })).round, 2);
});

test('one outcome covers all answered turns and debt counts cards across directories only for the caller session', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  await f.answer(first.taskId);
  f.ok(await f.request({ taskId: first.taskId }));
  await f.answer(first.taskId);
  const second = f.ok(await f.request({ workingDirectory: join(f.cwd, 'other') }));
  await f.answer(second.taskId);
  const debt = f.ok(await f.call('note', { body: 'Checking both cards' }));
  assert.deepEqual(new Set(debt.unreconciled), new Set([first.taskId, second.taskId]));
  f.ok(await f.call('outcome', { taskId: first.taskId, accepted: 2, rejected: 0, open: 0, body: 'Both turns checked' }));
  assert.deepEqual(readTask(first.taskId).outcome.seen, [1, 2]);
  assert.deepEqual(readExchange(first.taskId).filter((e) => e.kind === 'outcome').map((e) => e.accepted), [2]);
  const cleared = f.ok(await f.call('note', { body: 'First card reconciled' }));
  assert.deepEqual(cleared.unreconciled, [second.taskId]);
  const stranger = f.coordinator(session('claude', 'stranger', f.cwd));
  assert.deepEqual(f.ok(await f.call('note', { body: 'Independent session' }, stranger)).unreconciled, []);
});

test('reconciliation hold follows coordinator session across directories, not answered-turn count', async (t) => {
  const f = fixture(t);
  const ids = [];
  for (let card = 0; card < 4; card++) {
    const result = f.ok(await f.request());
    ids.push(result.taskId);
    await f.answer(result.taskId);
    f.ok(await f.request({ taskId: result.taskId }));
    await f.answer(result.taskId);
  }
  assert.match(textOf(await f.request({ workingDirectory: join(f.cwd, 'elsewhere') })), /RECONCILE_FIRST/);
  const stranger = f.coordinator(session('claude', 'stranger', f.cwd));
  f.ok(await f.call('request', { task: 'Separate work', wait: false }, stranger));
  f.ok(await f.call('outcome', { taskId: ids[0], accepted: 0, rejected: 0, open: 2 }));
  f.ok(await f.request({ workingDirectory: join(f.cwd, 'elsewhere') }));
});

test('card notes route to the worker despite another peer argument, steer, and stay outside replies and outcomes', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request({ peer: 'replacement' }));
  f.ok(await f.call('note', { taskId: first.taskId, peer: 'worker', body: 'Use the updated interface' }, f.adapterEngine(true)));
  assert.equal(f.sent.at(-1).target.id, 'replacement');
  assert.equal(f.sent.at(-1).delivery, 'steer');
  assert.match(f.sent.at(-1).text, new RegExp(`task_id=${first.taskId}`));
  const card = readTask(first.taskId);
  assert.equal(card.rounds.length, 1);
  assert.equal(card.rounds[0].replied, false);
  assert.equal(card.outcome, undefined);
  assert.deepEqual(readExchange(first.taskId).filter((e) => e.kind === 'note').map((e) => e.text), ['Use the updated interface']);
  const [thread] = channelsOf([readTask(first.taskId)])[0].turns;
  assert.equal(thread.events.find((e) => e.kind === 'note').fromName, thread.fromName);
  const worker = makeEngine({ orchestrator: 'omp', peerName: 'claude', replyTool: 'peer_tool',
    resolveOrigin: async () => ({ target: f.workers[1], identityVerified: true }),
    pickDelivery: async ({ target }) => { assert.equal(target, 'owner'); return { mode: 'live', target: f.owner }; },
    deliverLive: async () => ({ via: 'live' }),
  });
  f.ok(await f.call('note', { taskId: first.taskId, body: 'I have one constraint to add' }, worker));
  assert.equal(readExchange(first.taskId).at(-1).from, 'omp');
  const stranger = f.coordinator(session('claude', 'stranger', f.cwd));
  assert.match(textOf(await f.call('note', { taskId: first.taskId, body: 'Hijack card' }, stranger)), /ROLE_VIOLATION/);
});

test('failed notes do not spend rate or dedupe; successful budget is per sender across recipients', async (t) => {
  const f = fixture(t);
  f.fail(true);
  for (let n = 0; n < 6; n++) assert.equal((await f.call('note', { body: 'Retry this note' })).isError, true);
  f.fail(false);
  f.ok(await f.call('note', { body: 'Retry this note' }));
  assert.match(textOf(await f.call('note', { body: 'Retry this note', peer: 'replacement' })), /NOTE_DUPLICATE/);
  for (let n = 1; n < 5; n++) f.ok(await f.call('note', { body: `Message ${n}`, peer: n % 2 ? 'replacement' : 'worker' }));
  assert.match(textOf(await f.call('note', { body: 'Over budget', peer: 'replacement' })), /NOTE_RATE_LIMIT/);
  const stranger = f.coordinator(session('claude', 'stranger', f.cwd));
  f.ok(await f.call('note', { body: 'Retry this note' }, stranger));
});

test('notes on non-steer harnesses remain live and failed card notes leave no exchange row', async (t) => {
  const f = fixture(t);
  const first = f.ok(await f.request());
  f.ok(await f.call('note', { taskId: first.taskId, body: 'Ordinary delivery' }, f.adapterEngine(false)));
  assert.equal(f.sent.at(-1).delivery, 'live');
  f.fail(true);
  assert.equal((await f.call('note', { taskId: first.taskId, body: 'Failed delivery' })).isError, true);
  assert.deepEqual(readExchange(first.taskId).filter((e) => e.kind === 'note').map((e) => e.text), ['Ordinary delivery']);
  f.fail(false);
  f.ok(await f.call('note', { taskId: first.taskId, body: 'Failed delivery' }));
});

test('explicit transcript lifecycle markers invalidate framing; ordinary prose does not', (t) => {
  const f = fixture(t);
  const file = join(f.cwd, 'worker.jsonl');
  const at = Date.now();
  writeFileSync(file, JSON.stringify({ type: 'compaction', timestamp: at }) + '\n' + JSON.stringify({ type: 'message', timestamp: at + 1, message: { role: 'assistant', content: 'I discussed compaction' } }) + '\n');
  assert.equal(compactionAt({ harness: 'omp', sessionFile: file }), at);
  writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(at).toISOString() }) + '\n');
  assert.equal(compactionAt({ harness: 'claude', transcript: file }), at);
  assert.equal(compactionAt({ harness: 'codex', sessionFile: file }), null);
});

test('in-flight duplicate notes are refused and a failed owner releases the reservation', async (t) => {
  const f = fixture(t);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let sends = 0;
  const e = f.coordinator(f.owner, 'omp', {
    deliverLive: async () => {
      sends++;
      entered();
      await gate;
      throw Object.assign(new Error('send failed'), { code: 'DELIVERY_FAILED', dispatchUncertain: false });
    },
  });
  const inFlight = f.call('note', { body: 'One pending message' }, e);
  await started;
  assert.match(textOf(await f.call('note', { body: 'One pending message' }, e)), /NOTE_DUPLICATE/);
  release();
  assert.equal((await inFlight).isError, true);
  f.ok(await f.call('note', { body: 'One pending message' }));
  assert.equal(sends, 1);
});

test('a headless continuation resumes the recorded worker and its compact frame still answers inline', async (t) => {
  const f = fixture(t);
  const runs = [];
  const headless = f.coordinator(f.owner, 'omp', {
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async (args) => {
      runs.push(args);
      return { via: 'headless', threadId: 'headless-worker', inlineReply: 'Expiry behavior checked against source.' };
    },
  });
  const first = f.ok(await f.call('request', { task: 'Inspect expiry', wait: true, workingDirectory: f.cwd }, headless));
  const second = f.ok(await f.call('request', { taskId: first.taskId, task: 'Inspect token reuse', wait: true }, headless));
  assert.equal(second.round, 2);
  assert.equal(runs[1].resumeThreadId, 'headless-worker');
  assert.match(runs[1].text, /^PEER TURN/);
  assert.match(runs[1].text, /Respond inline: your final message IS the reply/);
  assert.doesNotMatch(runs[1].text, /kind=\"reply\"/);
  assert.equal(readTask(first.taskId).rounds[1].replied, true);
});

test('a verified coordinator does not inherit anonymous cards from the same harness', async (t) => {
  const f = fixture(t);
  const anonymous = makeEngine({
    orchestrator: 'claude', peerName: 'omp', replyTool: 'peer_tool',
    pickDelivery: async () => ({ mode: 'live', target: f.workers[0] }),
    deliverLive: async () => ({ via: 'live', deliveryStatus: 'queued_unread' }),
  });
  for (let card = 0; card < 4; card++) {
    const result = f.ok(await f.call('request', { task: `Legacy card ${card}`, wait: false, workingDirectory: join(f.cwd, 'anonymous') }, anonymous));
    await f.answer(result.taskId);
  }
  const current = f.ok(await f.request());
  assert.deepEqual(current.unreconciled, []);
});
