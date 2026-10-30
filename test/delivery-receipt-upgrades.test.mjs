import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, textOf } from './helpers/harness.mjs';
import { adapter as claudeAdapter } from '../src/claude-adapter.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import magi from '../omp/magi-omp-extension.js';
import { deliverReplyToOrigin, listAgentSessions } from '../src/transport.mjs';
import { makeEngine } from '../src/peer.mjs';
import { channelsOf, refreshChannelDeliveries } from '../src/fleet.mjs';
import * as state from '../src/state.mjs';

const jsonl = (record) => JSON.stringify(record) + '\n';
const userRecord = (harness, marker) => harness === 'claude'
  ? { type: 'user', origin: { kind: 'peer' }, message: { content: marker } }
  : { type: 'message', message: { role: 'user', content: marker } };

async function fixture(t, harness) {
  const cwd = makeWorkspace('delivery evidence');
  const values = { MAGI_HOME: join(cwd, 'home'), CLAUDE_CONFIG_DIR: join(cwd, 'claude'), CODEX_HOME: join(cwd, 'codex'), MAGI_CONFIRM_MS: '0', CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '', CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '300000' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const path = join(cwd, 'session.jsonl');
  writeFileSync(path, jsonl(userRecord(harness, 'older-delivery')));
  let target;
  if (harness === 'omp') {
    const handlers = new Map();
    magi({ on: (name, handler) => handlers.set(name, handler), sendUserMessage() {}, logger: { warn() {} } });
    const ctx = { cwd, isIdle: () => true, sessionManager: { getSessionId: () => 'receiver', getSessionFile: () => path }, setInterval: () => () => {} };
    handlers.get('session_start')({}, ctx);
    t.after(() => handlers.get('session_shutdown')({}, ctx));
    target = listAgentSessions('omp', { includeHelpers: true }).find((session) => session.sessionId === 'receiver');
    assert.ok(target, 'receiver extension publishes a route');
  } else {
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\magi-receipt-${randomUUID()}` : join(cwd, 'receiver.sock');
    const server = net.createServer((connection) => { connection.resume(); });
    server.listen(socket);
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const registry = join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
    mkdirSync(registry, { recursive: true });
    target = { agent: 'claude', pid: process.pid, sessionId: 'receiver', name: 'receiver', cwd, socket, transcript: path };
    writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({ ...target, messagingSocketPath: socket }));
    writeFileSync(join(registry, `${process.pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'test-key' }));
    // Replies resolve Claude transcripts from cwd/sessionId, not an adapter object.
    const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    target.transcript = join(project, 'receiver.jsonl');
    writeFileSync(target.transcript, jsonl(userRecord(harness, 'older-delivery')));
  }
  return { cwd, target, path: harness === 'claude' ? target.transcript : path };
}

for (const harness of ['claude', 'omp']) {
  test(`${harness} delayed request receipt upgrades the channel using persisted evidence`, async (t) => {
    const f = await fixture(t, harness);
    const adapter = harness === 'claude' ? claudeAdapter : ompAdapter;
    const engine = makeEngine({ orchestrator: 'codex', peerName: harness, replyTool: 'codex_peer',
      resolveOrigin: async () => ({ target: { agent: 'codex', id: 'coordinator' }, identityVerified: true }),
      pickDelivery: async () => ({ mode: 'live', target: f.target }), deliverLive: adapter.deliverLive });
    const result = await engine.handleRequest({ task: 'inspect delivery', mode: 'REVIEW', wait: false, workingDirectory: f.cwd });
    assert.notEqual(result.isError, true, textOf(result));
    const taskId = result.structuredContent.taskId;
    const channels = channelsOf([state.readTask(taskId)]);
    const receipt = channels[0].currentCard.delivery;
    await refreshChannelDeliveries(channels);
    assert.equal(channels[0].deliveryStatus, harness === 'claude' ? 'unconfirmed' : 'queued_unread');
    appendFileSync(f.path, jsonl(userRecord(harness, receipt.marker)));
    await refreshChannelDeliveries(channels);
    assert.equal(channels[0].deliveryStatus, 'received');
    assert.equal(state.readTask(taskId).rounds[0].deliveries[harness].deliveryStatus, result.structuredContent.deliveryStatus, 'poll changes the view, not the ledger');
  });

  for (const kind of ['reply', 'question']) {
    test(`${harness} ${kind} returns before consumption and its receipt upgrades later`, { timeout: 10000 }, async (t) => {
      const f = await fixture(t, harness);
      const taskId = `magi-${harness}-${kind}`;
      state.openRound({ taskId, orchestrator: harness, peer: 'codex', orchestratorTarget: f.target, mode: 'REVIEW', round: 1, maxRounds: 2, cwd: f.cwd });
      state.setPeerTarget(taskId, { agent: 'codex', id: 'worker' });
      const worker = makeEngine({ orchestrator: 'codex', peerName: harness, replyTool: 'codex_peer', deliverReply: deliverReplyToOrigin });
      // A long request-confirmation deadline must not leak into either route.
      process.env.MAGI_CONFIRM_MS = '60000';
      const result = kind === 'reply'
        ? await worker.handleReply({ taskId, body: 'answer', workingDirectory: f.cwd })
        : await worker.handleClarify({ taskId, body: 'which branch?' });
      assert.notEqual(result.isError, true, textOf(result));
      const channels = channelsOf([state.readTask(taskId)]);
      const receipt = channels[0].currentCard.delivery;
      assert.equal(channels[0].deliveryStatus, harness === 'claude' ? 'unconfirmed' : 'queued_unread');
      appendFileSync(f.path, jsonl(userRecord(harness, receipt.marker)));
      await refreshChannelDeliveries(channels);
      assert.equal(channels[0].deliveryStatus, 'received');
    });
  }

  test(`${harness} fleet confirmation cannot reuse evidence before the stored cursor`, async (t) => {
    const f = await fixture(t, harness);
    const marker = 'magi-delivery:reused';
    const old = jsonl(userRecord(harness, marker));
    writeFileSync(f.path, old);
    const taskId = `magi-${harness}-cursor`;
    state.openRound({ taskId, orchestrator: 'codex', peer: harness, round: 1, maxRounds: 2, cwd: f.cwd });
    state.setPeerTarget(taskId, f.target);
    state.recordCardDelivery(taskId, 1, { to: harness, target: f.target, marker, cursor: Buffer.byteLength(old), transcriptPath: f.path, sessionFile: f.path, messageId: 'independent-frame-id', deliveryStatus: 'unconfirmed' });
    const channels = channelsOf([state.readTask(taskId)]);
    await refreshChannelDeliveries(channels);
    assert.equal(channels[0].deliveryStatus, 'unconfirmed');
    appendFileSync(f.path, jsonl(userRecord(harness, marker)));
    await refreshChannelDeliveries(channels);
    assert.equal(channels[0].deliveryStatus, 'received');
  });
}

for (const { label, status, age, env = '300000', settings, hint = false, via = 'live:receiver' } of [
  { label: 'unconfirmed past expiry', status: 'unconfirmed', age: 600000, hint: true },
  { label: 'queued unread past expiry', status: 'queued_unread', age: 600000, hint: true },
  { label: 'unconfirmed under expiry', status: 'unconfirmed', age: 30000 },
  { label: 'unconfirmed exactly at expiry', status: 'unconfirmed', age: 300000 },
  { label: 'received past expiry', status: 'received', age: 600000 },
  { label: 'never expires', status: 'unconfirmed', age: 600000, env: null, settings: { dialogExpiry: 'never' } },
  { label: 'zero expiry', status: 'queued_unread', age: 600000, env: '0' },
  { label: 'invalid timeout', status: 'unconfirmed', age: 600000, env: 'secret\nOTHER=value' },
  { label: 'headless note', status: 'queued_unread', age: 600000, via: 'headless:worker' },
]) {
  test(`Claude receipt diagnostics: ${label} preserves the receipt and ledger`, async (t) => {
    const f = await fixture(t, 'claude');
    if (env === null) delete process.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS;
    else process.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS = env;
    if (settings) writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(settings));
    const now = Date.now();
    const taskId = 'magi-dialog-hint';
    state.openRound({ taskId, orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1, cwd: f.cwd });
    state.setPeerTarget(taskId, f.target, 1);
    state.recordCardDelivery(taskId, 1, { to: 'claude', via, target: f.target, at: now - age, deliveryStatus: status, marker: 'magi-delivery:hint', cursor: 0, transcriptPath: f.path });
    const channels = channelsOf([state.readTask(taskId)], now);
    await refreshChannelDeliveries(channels, { now });
    const receipt = channels[0].currentCard.delivery;
    assert.equal(receipt.deliveryStatus, status);
    assert.equal(Boolean(receipt.statusText), hint);
    assert.equal(Boolean(channels[0].currentCard.statusText), hint);
    assert.equal(/may have been held/.test(channels[0].statusText), hint);
    const { magiStatus } = await import('../src/status.mjs');
    const { setProvider } = await import('../src/providers.mjs');
    setProvider('codex', false);
    setProvider('omp', false);
    const picture = await magiStatus({ cwd: f.cwd, now });
    const shown = picture.cards.find((c) => c.taskId === taskId).delivery[0];
    assert.equal(shown.status, status);
    assert.equal(Boolean(shown.statusText), hint);
    if (hint) {
      assert.match(shown.statusText, /may have been held.*dropped after 5 min.*check\/approve there or resend/);
      const engine = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
        resolveOrigin: async () => ({ target: { agent: 'codex', id: 'coordinator' } }),
        listPeers: async () => [], pickDelivery: async () => { throw new Error('not listed'); } });
      const listed = await engine.handlePeers({ taskId, workingDirectory: f.cwd });
      assert.equal(listed.structuredContent.deliveryHints[0].taskId, taskId);
      assert.match(listed.structuredContent.next, /may have been held.*check\/approve there or resend/);
    }
    const stored = state.readTask(taskId).rounds[0].deliveries.claude;
    assert.equal(stored.deliveryStatus, status);
    assert.equal(stored.statusText, undefined, 'possible expiry is a view, never a recorded failure');
  });
}

test('Claude consumption evidence removes an expiry hint without downgrading a received receipt later', async (t) => {
  const f = await fixture(t, 'claude');
  const taskId = 'magi-dialog-consumed';
  const now = Date.now();
  const marker = 'magi-delivery:consumed';
  state.openRound({ taskId, orchestrator: 'codex', peer: 'claude', mode: 'REVIEW', round: 1, cwd: f.cwd });
  state.setPeerTarget(taskId, f.target, 1);
  state.recordCardDelivery(taskId, 1, { to: 'claude', via: 'live:receiver', target: f.target, at: now - 600000, deliveryStatus: 'unconfirmed', marker, cursor: 0, transcriptPath: f.path });
  const channels = channelsOf([state.readTask(taskId)], now);
  await refreshChannelDeliveries(channels, { now });
  assert.match(channels[0].statusText, /may have been held/);
  appendFileSync(f.path, jsonl(userRecord('claude', marker)));
  await refreshChannelDeliveries(channels, { now });
  assert.equal(channels[0].deliveryStatus, 'received');
  assert.equal(channels[0].currentCard.delivery.statusText, undefined);
  assert.doesNotMatch(channels[0].statusText, /held/);
  writeFileSync(f.path, '');
  await refreshChannelDeliveries(channels, { now: now + 600000 });
  assert.equal(channels[0].deliveryStatus, 'received');
  assert.equal(channels[0].currentCard.statusText, undefined);
});

test('an initial request uses its generated card id for a late next hint', async (t) => {
  const f = await fixture(t, 'claude');
  process.env.CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS = '1';
  const engine = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    resolveOrigin: async () => ({ target: { agent: 'codex', id: 'coordinator' } }),
    pickDelivery: async () => ({ mode: 'live', target: f.target }),
    deliverLive: async (options) => {
      const used = await claudeAdapter.deliverLive(options);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return used;
    } });
  const result = await engine.handleRequest({ task: 'Check this boundary', mode: 'REVIEW', wait: false, workingDirectory: f.cwd });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.deliveryStatus, 'unconfirmed');
  assert.equal(result.structuredContent.deliveryHints[0].taskId, result.structuredContent.taskId);
  assert.match(result.structuredContent.next, /may have been held.*check\/approve there or resend/);
});
