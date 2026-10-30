import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codexDaemonSocket, steerLocalDaemon } from '../src/codex-daemon-proxy.mjs';
import { steerCodexThread } from '../src/transport.mjs';
import { makeCodexLiveDelivery } from '../src/codex-delivery.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls } from './helpers/harness.mjs';

// A terminal Codex at 0.163.0 runs its thread on the shared daemon, so a
// local steer goes there by turn/steer before it tries the desktop.
const id = '01a1503c-b705-7e70-b367-9647b6dd4242';
const running = { id, name: 'terminal codex', cwd: '/fake', status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn-1', status: 'inProgress' }] };

function fixture(t, daemon, { socket = true } = {}) {
  const dir = makeWorkspace('daemon steer');
  const { paths } = makeFakeBins(dir, ['codex']);
  const { env, logFile } = fakeEnv(dir);
  const values = { ...env, CODEX_BIN: paths.codex, FAKE_CODEX_DAEMON: daemon === undefined ? undefined : JSON.stringify(daemon), MAGI_CONFIRM_MS: '0' };
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (socket) {
    mkdirSync(dirname(codexDaemonSocket()), { recursive: true });
    writeFileSync(codexDaemonSocket(), '');
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { logFile };
}
const rpcs = (logFile, method) => readCalls(logFile).filter((row) => row.daemon && row.rpc === method);

test('a thread the local daemon runs is steered in its active turn, with the client id the history records', async (t) => {
  const { logFile } = fixture(t, { threads: [running] });
  const steered = await steerLocalDaemon({ thread: id, text: 'PEER NOTE stop and rebase' });
  assert.equal(steered.threadId, id);
  assert.equal(steered.turnId, 'turn-1');
  const [call] = rpcs(logFile, 'turn/steer');
  assert.equal(call.params.threadId, id);
  assert.equal(call.params.expectedTurnId, 'turn-1');
  assert.equal(call.params.clientUserMessageId, steered.clientId);
  assert.equal(call.params.input[0].text, 'PEER NOTE stop and rebase');
});

test('no daemon socket means no proxy is started', async (t) => {
  const { logFile } = fixture(t, { threads: [running] }, { socket: false });
  assert.equal(await steerLocalDaemon({ thread: id, text: 'x' }), null);
  assert.deepEqual(readCalls(logFile).filter((row) => row.daemon), []);
});

test('a thread the daemon does not hold, or an unreachable daemon, leaves the desktop route open', async (t) => {
  fixture(t, { threads: [{ ...running, status: { type: 'notLoaded' } }], loadedIds: [] });
  assert.equal(await steerLocalDaemon({ thread: id, text: 'x' }), null);
  process.env.FAKE_CODEX_DAEMON = JSON.stringify({ threads: [] });
  assert.equal(await steerLocalDaemon({ thread: id, text: 'x' }), null);
  delete process.env.FAKE_CODEX_DAEMON;
  assert.equal(await steerLocalDaemon({ thread: id, text: 'x' }), null);
});

test('an idle daemon thread is refused with what to send instead, and nothing is steered', async (t) => {
  const { logFile } = fixture(t, { threads: [{ ...running, status: { type: 'idle' }, turns: [] }] });
  await assert.rejects(steerLocalDaemon({ thread: id, text: 'x' }), (e) => e.code === 'NO_ACTIVE_TURN' && /delivery:"live"/.test(e.message) && e.dispatchUncertain === false);
  assert.deepEqual(rpcs(logFile, 'turn/steer'), []);
});

test('steer prefers the daemon, falls back to the desktop only when the daemon does not hold the thread', async () => {
  const receipt = await steerCodexThread({ thread: id, text: 'x' }, {
    daemon: async () => ({ threadId: id, turnId: 'turn-1', clientId: 'client-1' }),
    desktop: () => assert.fail('the daemon held the thread'),
  });
  assert.deepEqual([receipt.clientId, receipt.turnId, receipt.target, receipt.deliveryStatus], ['client-1', 'turn-1', id, 'accepted']);
  let desktop = 0;
  await steerCodexThread({ thread: id, text: 'x' }, { daemon: async () => null, desktop: async () => { desktop++; return { marker: 'm', cursor: 1 }; } });
  assert.equal(desktop, 1);
  await assert.rejects(steerCodexThread({ thread: id, text: 'x' }, {
    daemon: async () => null,
    desktop: async () => { throw Object.assign(new Error('No Codex desktop app-tools channel found.'), { code: 'NO_STEER_CHANNEL' }); },
  }), (e) => e.code === 'NO_STEER_CHANNEL' && /daemon does not hold the thread/.test(e.message));
  await assert.rejects(steerCodexThread({ thread: id, text: 'x' }, {
    daemon: async () => { throw Object.assign(new Error('NO_ACTIVE_TURN: idle'), { code: 'NO_ACTIVE_TURN' }); },
    desktop: () => assert.fail('a daemon refusal is the answer'),
  }), { code: 'NO_ACTIVE_TURN' });
  await steerCodexThread({ thread: 'a name', text: 'x' }, { daemon: () => assert.fail('only an id reaches the daemon'), desktop: async () => ({}) });
});

test('a daemon steer receipt is confirmed by its client id in the thread history', async (t) => {
  let sqlite;
  try { sqlite = await import('node:sqlite'); }
  catch { t.skip('node:sqlite unavailable on this Node'); return; }
  fixture(t, undefined, { socket: false });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const db = new sqlite.DatabaseSync(join(process.env.CODEX_HOME, 'thread_history_1.sqlite'));
  db.exec(`create table thread_turns (thread_id text, turn_id text, rollout_ordinal int, status text, started_at int, completed_at int);
    create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal int, created_at_ms int, item_json text, item_type text);`);
  const insert = db.prepare('insert into thread_items values (?, ?, ?, ?, ?, ?, ?)');
  // As codex 0.163.0 recorded a real steer: the steered userMessage inside the running turn.
  insert.run(id, 'turn-1', 'first', 9, 1000, JSON.stringify({ type: 'userMessage', clientId: 'typed' }), 'userMessage');
  insert.run(id, 'turn-1', 'steered', 17, 2000, JSON.stringify({ type: 'userMessage', clientId: 'client-1' }), 'userMessage');
  // Closed now: the fixture removes this folder, which Windows refuses while the file is open.
  db.close();
  const deliver = makeCodexLiveDelivery({
    queue: () => assert.fail('must not queue'),
    steer: async () => ({ threadId: id, turnId: 'turn-1', clientId: 'client-1', messageId: 'client-1' }),
  });
  const result = await deliver({ delivery: 'steer', target: id, text: 'x' });
  assert.equal(result.deliveryStatus, 'received_mid_turn');
  assert.match(result.statusText, /running turn/);
  const unseen = await makeCodexLiveDelivery({ steer: async () => ({ threadId: id, clientId: 'client-2' }) })({ delivery: 'steer', target: id, text: 'x' });
  assert.equal(unseen.deliveryStatus, 'queued_unread');
  assert.match(unseen.statusText, /Do not resend/);
});
