// F2: the public request result keeps the card identity when a relay loses a
// mutating delivery after writing it. A fresh request is never sent implicitly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, fakeEnv, readCalls, textOf } from './helpers/harness.mjs';
import { makeServerEngine } from '../src/serve.mjs';
import { adapter as codexAdapter } from '../src/codex-adapter.mjs';
import { closeRelays, relayCall } from '../src/relay.mjs';
import { closeRound, openRound, readTask, setPeerTarget } from '../src/state.mjs';

const origin = {
  target: { agent: 'claude', id: 'local-claude', sessionId: 'local-claude', identityVerified: true },
  identityVerified: true,
};

// This SSH fixture speaks the relay wire contract directly. Logging the full
// deliver before exit proves the failure is after write, not a failed handshake.
const sshFixture = String.raw`
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const mode = process.env.RELAY_FAILURE_MODE;
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const log = (frame) => appendFileSync(process.env.RELAY_FAILURE_LOG, JSON.stringify(frame) + '\n');
if (mode === 'prewrite') process.exit(255);
emit({ type: 'magi_relay', ok: true });
if (mode === 'write-rejected') {
  const hold = setInterval(() => {}, 1000);
  process.stdin.once('data', (chunk) => {
    log({ bytesRead: chunk.length });
    process.stdin.destroy();
    setTimeout(() => { clearInterval(hold); process.exit(7); }, 10000);
  });
} else {
let refusedNote = false;
const receive = () => createInterface({ input: process.stdin }).on('line', (line) => {
  const call = JSON.parse(line);
  log(mode === 'queued-timeout' ? { ...call, text: undefined } : call);
  if (call.op === 'pick') return emit({ id: call.id, ok: true, result: {
    target: { agent: 'codex', id: 'peer-thread', sessionId: 'peer-thread', identityVerified: true },
  } });
  if (call.op === 'deliver') {
    if (mode === 'exit255' || mode === 'exit7') process.exit(mode === 'exit255' ? 255 : 7);
    if (mode === 'refused') return emit({ id: call.id, ok: false, error: {
      code: 'TURN_MISMATCH', message: 'The expected active turn changed; send a note instead.', dispatchUncertain: false,
    } });
    if (mode === 'note-admission') {
      if (!refusedNote) {
        refusedNote = true;
        return emit({ id: call.id, ok: false, error: { code: 'BAD_ROUND', message: 'The captured round was rolled back before admission.', dispatchUncertain: false } });
      }
      return emit({ id: call.id, ok: true, result: { via: 'live', deliveryStatus: 'queued_unread' } });
    }
    if (mode === 'queued-timeout') return emit({ id: call.id, ok: true, result: { deliveryStatus: 'accepted' } });
    return emit({ id: call.id, ok: false, error: { code: 'REMOTE_FAILED', message: 'Delivery was not confirmed.' } });
  }
  emit({ id: call.id, ok: true, result: {} });
});
if (mode === 'queued-timeout') {
  const waiting = setInterval(() => {
    if (!existsSync(process.env.RELAY_FAILURE_RELEASE)) return;
    clearInterval(waiting);
    receive();
  }, 10);
}
else receive();
}
`;

async function isolated(mode, run) {
  const ws = makeWorkspace('relay uncertainty');
  const saved = { ...process.env };
  const { env } = fakeEnv(ws);
  const ssh = join(ws, 'relay-ssh.cjs');
  const logFile = join(ws, 'relay-calls.jsonl');
  const releaseFile = join(ws, 'release-write');
  writeFileSync(ssh, sshFixture);
  Object.assign(process.env, env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, PEER_DEPTH: '0',
    SSH_BIN: ssh, RELAY_FAILURE_MODE: mode, RELAY_FAILURE_LOG: logFile, RELAY_FAILURE_RELEASE: releaseFile,
  });
  mkdirSync(env.MAGI_HOME, { recursive: true });
  writeFileSync(join(env.MAGI_HOME, 'remotes.json'), JSON.stringify({
    testhost: { ssh: ['testhost'], node: process.execPath, magi: '/remote/magi.mjs' },
  }));
  try { await run({ ws, logFile, releaseFile }); }
  finally {
    closeRelays();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const request = (ws, taskId) => ({
  ...(taskId ? { taskId } : {}), task: 'Inspect the parser boundary.', mode: 'REVIEW',
  host: 'testhost', peer: 'peer-thread', delivery: 'steer', wait: false, workingDirectory: ws,
});
const engine = () => makeServerEngine(codexAdapter, { self: 'claude', resolveOrigin: async () => origin }).engine;

for (const mode of ['exit255', 'exit7', 'unknown']) {
  test(`F2: a steered request ${mode} after write preserves its inspectable round and is never resent`, { timeout: 60000 }, () => isolated(mode, async ({ ws, logFile }) => {
    const result = await engine().handleRequest(request(ws));
    assert.equal(result.isError, true, textOf(result));
    assert.equal(result.structuredContent.dispatchUncertain, true);
    const { taskId, round } = result.structuredContent;
    assert.match(taskId, /^magi-/);
    assert.equal(round, 1);
    const sent = readCalls(logFile).filter((call) => call.op === 'deliver');
    assert.equal(sent.length, 1, 'no automatic resend or alternate delivery');
    assert.equal(sent[0].taskId, taskId);
    assert.equal(sent[0].round, round);
    assert.equal(sent[0].delivery, 'steer');
    assert.equal(readCalls(logFile).length, 2, 'only target resolution and the one deliver');
    const card = readTask(taskId);
    assert.equal(card.peerTarget.host, 'testhost');
    assert.equal(card.peerTarget.sessionId, 'peer-thread');
    assert.equal(card.rounds[0].round, round);
    assert.equal(card.rounds[0].closeReason, 'delivery_failed');
    assert.match(textOf(result), /inspect.*(?:history|exchange|mail|transcript)/i);
    assert.match(textOf(result), /do not (?:resend|retry).*blindly/i);
  }));
}

test('F2: an uncertain continuation returns its actual preserved round, not round one', { timeout: 60000 }, () => isolated('exit255', async ({ ws, logFile }) => {
  const taskId = 'magi-relay-continuation';
  openRound({ taskId, orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, cwd: ws, orchestratorTarget: origin.target });
  setPeerTarget(taskId, { agent: 'codex', id: 'peer-thread', sessionId: 'peer-thread', host: 'testhost' }, 1);
  closeRound({ taskId, round: 1, reason: 'cancelled' });
  const previous = readTask(taskId).rounds[0];
  const result = await engine().handleRequest(request(ws, taskId));
  assert.equal(result.isError, true, textOf(result));
  assert.deepEqual(result.structuredContent, { taskId, round: 2, dispatchUncertain: true });
  const card = readTask(taskId);
  assert.deepEqual(card.rounds[0], previous);
  assert.equal(card.rounds[1].round, 2);
  assert.equal(card.rounds[1].closeReason, 'delivery_failed');
  assert.equal(readCalls(logFile).filter((call) => call.op === 'deliver').length, 1);
}));

test('F2: an explicit server refusal remains definite even though the deliver was written', { timeout: 60000 }, () => isolated('refused', async ({ ws, logFile }) => {
  const taskId = 'magi-relay-refused';
  const result = await engine().handleRequest(request(ws, taskId));
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /TURN_MISMATCH/);
  assert.doesNotMatch(textOf(result), /dispatch is uncertain/i);
  assert.equal(readTask(taskId), null, 'definite refusal rolls back its unsent round');
  assert.equal(readCalls(logFile).filter((call) => call.op === 'deliver').length, 1);
  await assert.rejects(relayCall('testhost', 'deliver', { taskId, round: 1 }), (error) => error.dispatchUncertain === false);
}));

test('F2: disconnect before relay readiness is a definite prewrite failure', { timeout: 60000 }, () => isolated('prewrite', async ({ logFile }) => {
  await assert.rejects(relayCall('testhost', 'deliver', { taskId: 'magi-prewrite', round: 1 }), (error) => {
    assert.equal(error.code, 'REMOTE_UNREACHABLE');
    assert.equal(error.dispatchUncertain, false);
    return true;
  });
  assert.deepEqual(readCalls(logFile), []);
}));

test('F2: failure serializing a deliver before write remains definite and leaves no pending call', { timeout: 60000 }, () => isolated('unknown', async ({ logFile }) => {
  const circular = {};
  circular.self = circular;
  await assert.rejects(relayCall('testhost', 'deliver', { circular }), (error) => error.dispatchUncertain === false);
  assert.deepEqual(await relayCall('testhost', 'peers', {}), {});
  assert.deepEqual(readCalls(logFile).map((call) => call.op), ['peers']);
}));

test('F2: a queued deliver that times out before write is definite and cannot be written later', { timeout: 60000 }, () => isolated('queued-timeout', async ({ logFile, releaseFile }) => {
  const first = relayCall('testhost', 'deliver', { taskId: 'magi-first-write', text: 'x'.repeat(8 * 1024 * 1024) }, 10000);
  const expired = assert.rejects(relayCall('testhost', 'deliver', { taskId: 'magi-expired-write' }, 20), (error) => error.dispatchUncertain === false);
  await Promise.all([first, expired.then(() => writeFileSync(releaseFile, 'resume'))]);
  await relayCall('testhost', 'peers', {});
  assert.deepEqual(readCalls(logFile).filter((call) => call.op === 'deliver').map((call) => call.taskId), ['magi-first-write']);
}));

test('F2: a rejected channel send after its write attempt stays uncertain', { timeout: 60000 }, () => isolated('write-rejected', async ({ logFile }) => {
  await assert.rejects(relayCall('testhost', 'deliver', { text: 'x'.repeat(8 * 1024 * 1024) }), (error) => {
    // Which end reports first is a race: usually the relay's destroyed stdin
    // closes the pipe and the write is refused (WORKER_CLOSED); sometimes, seen
    // only on GitHub's Linux runner (two of three runs, ten seconds each), the
    // pipe stays open until the relay exits and its exit is the failure
    // (REMOTE_FAILED). Either way the write was attempted, so the call must
    // stay uncertain.
    assert.ok(['WORKER_CLOSED', 'REMOTE_FAILED'].includes(error.code), error.code);
    assert.equal(error.dispatchUncertain, true);
    assert.match(error.message, /do not (?:resend|retry).*blindly/i);
    return true;
  });
  assert.ok(readCalls(logFile)[0].bytesRead > 0, 'the relay received part of the attempted write');
}));

test('N3: a definite admission refusal crossing SSH releases the note charge for an immediate same-body retry', () => isolated('note-admission', async ({ ws, logFile }) => {
  const taskId = 'magi-hop-admission';
  openRound({ taskId, orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, cwd: ws, orchestratorTarget: origin.target });
  setPeerTarget(taskId, { agent: 'codex', id: 'peer-thread', sessionId: 'peer-thread', host: 'testhost' }, 1);
  const peer = engine();
  const args = { taskId, body: 'An honest retry after a refused admission.', delivery: 'live' };
  const refused = await peer.handleNote(args, { sender: origin.target });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /BAD_ROUND/);
  const accepted = await peer.handleNote(args, { sender: origin.target });
  assert.equal(accepted.isError, undefined, textOf(accepted));
  assert.equal(accepted.structuredContent.deliveryStatus, 'queued_unread');
  assert.equal(readCalls(logFile).filter((call) => call.op === 'deliver').length, 2, 'only the two explicit attempts crossed the relay');
}));
