import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getProviders, setProvider } from '../src/providers.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, startServer, textOf, ROOT } from './helpers/harness.mjs';

async function fixture(fn) {
  const ws = makeWorkspace('providers');
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['claude', 'codex', 'omp']);
  const { env } = fakeEnv(ws);
  const home = join(ws, 'user-home');
  Object.assign(process.env, env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    OMP_AGENT_DIR: join(home, '.omp', 'agent'),
    CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, OMP_BIN: paths.omp,
    PEER_DEPTH: '0', MAGI_AS: '',
  });
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), ...args], {
    cwd: ws, env: { ...process.env }, encoding: 'utf-8', timeout: 20000,
  });
  try { await fn({ ws, paths, cli }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    // The store keeps magi.db open for the process; Windows cannot delete an open file.
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* temp dir, left for the OS */ }
  }
}

function seedClaude(ws) {
  const directory = join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'provider-session', cwd: ws, kind: 'interactive', name: 'visible-claude',
    messagingSocketPath: '\\\\.\\pipe\\LOCAL\\provider-test', status: 'idle', statusUpdatedAt: Date.now(),
  }));
}

test('provider commands persist policy across processes without losing health or other providers', () => fixture(({ cli }) => {
  setProvider('codex', { down: 'AUTH_REQUIRED: Run codex login.' });
  let result = cli('provider', 'disable', 'codex');
  assert.equal(result.status, 0, result.stderr);
  result = cli('provider', 'list', '--json');
  assert.equal(result.status, 0, result.stderr);
  let providers = JSON.parse(result.stdout);
  assert.equal(providers.codex.status, 'disabled');
  assert.equal(providers.claude.enabled, true);
  assert.equal(providers.omp.enabled, true);
  setProvider('omp', false);
  result = cli('provider', 'enable', 'codex');
  assert.equal(result.status, 0, result.stderr);
  providers = getProviders();
  assert.equal(providers.codex.status, 'down');
  assert.match(providers.codex.reason, /codex login/);
  assert.equal(providers.omp.status, 'disabled');
  setProvider('codex', false);
  setProvider('codex', { down: null });
  assert.equal(getProviders().codex.enabled, false, 'a health update must not undo a disable');
}));

test('unknown providers and malformed settings fail without overwriting policy', () => fixture(async ({ cli }) => {
  setProvider('omp', false);
  const store = await import('../src/store.mjs');
  const home = process.env.MAGI_HOME;
  const read = () => JSON.stringify(store.getRecord(home, 'settings', 'providers'));
  const before = read();
  assert.throws(() => setProvider('other', false), { code: 'BAD_REQUEST' });
  const result = cli('provider', 'disable', 'other');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BAD_REQUEST/);
  assert.equal(read(), before);
  for (const malformed of [[1], 'text', { codex: { enabled: 'false' } }]) {
    store.setRecord(home, 'settings', 'providers', malformed);
    assert.throws(() => getProviders(), { code: 'BAD_CONFIG' });
    assert.throws(() => setProvider('codex', true), { code: 'BAD_CONFIG' });
    assert.equal(read(), JSON.stringify(malformed));
  }
}));

test('missing CLI is down and automatically recovers when the executable is restored', () => fixture(({ ws, paths, cli }) => {
  process.env.OMP_BIN = join(ws, 'missing-omp');
  assert.equal(getProviders().omp.status, 'down');
  assert.match(getProviders().omp.reason, /CLI_NOT_FOUND.*OMP_BIN/);
  const listed = cli('provider', 'list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /omp: down/);
  process.env.OMP_BIN = paths.omp;
  assert.equal(getProviders().omp.status, 'up');
}));

test('combined server omits disabled tools and blocks only new admission after a runtime disable', () => fixture(async ({ ws }) => {
  setProvider('omp', false);
  const server = await startServer('codex omp', { cwd: ws, env: { ...process.env }, as: 'claude' });
  try {
    assert.deepEqual((await server.client.listTools()).tools.map((t) => t.name), ['codex_peer']);
    setProvider('codex', false);
    for (const kind of ['request', 'spawn']) {
      const refused = await server.call('codex_peer', { kind, task: 'new work', body: 'new work', workingDirectory: ws });
      assert.equal(refused.isError, true);
      assert.match(textOf(refused), /PROVIDER_DISABLED/);
      assert.match(textOf(refused), /magi provider enable codex/);
    }
    const recalled = await server.call('codex_peer', { kind: 'recall', body: 'provider', workingDirectory: ws });
    assert.notEqual(recalled.isError, true, textOf(recalled));
    setProvider('codex', true);
    const restored = await server.call('codex_peer', { kind: 'recall', body: 'provider', workingDirectory: ws });
    assert.notEqual(restored.isError, true, textOf(restored));
    setProvider('omp', true);
    assert.deepEqual((await server.client.listTools()).tools.map((t) => t.name), ['codex_peer'], 'enabling an omitted tool requires a restart');
  } finally { await server.close(); }
  const restarted = await startServer('codex omp', { cwd: ws, env: { ...process.env }, as: 'claude' });
  try {
    assert.deepEqual((await restarted.client.listTools()).tools.map((t) => t.name).sort(), ['codex_peer', 'omp_peer']);
  } finally { await restarted.close(); }
}));

test('a server can start with every configured provider disabled', () => fixture(async ({ ws }) => {
  setProvider('codex', false);
  setProvider('omp', false);
  const server = await startServer('codex omp', { cwd: ws, env: { ...process.env }, as: 'claude' });
  try { assert.deepEqual((await server.client.listTools()).tools, []); }
  finally { await server.close(); }
}));

test('an enabled down provider keeps its tool registered', () => fixture(async ({ ws }) => {
  process.env.CODEX_BIN = join(ws, 'missing-codex');
  setProvider('omp', { down: 'AUTH_REQUIRED: Run omp login.' });
  const server = await startServer('codex omp', { cwd: ws, env: { ...process.env }, as: 'claude' });
  try {
    assert.deepEqual((await server.client.listTools()).tools.map((t) => t.name).sort(), ['codex_peer', 'omp_peer']);
    assert.equal(getProviders().codex.status, 'down');
    assert.equal(getProviders().omp.status, 'down');
  } finally { await server.close(); }
}));

test('headless authentication failures persist down status and a successful reply clears it', () => fixture(async ({ ws }) => {
  const { runHeadless } = await import('../src/serve.mjs');
  const { adapter } = await import('../src/codex-adapter.mjs');
  process.env.FAKE_CLI_SCENARIO = 'auth';
  const args = { text: 'review this', cwd: ws, allowWrites: false, timeoutMs: 10000 };
  await assert.rejects(runHeadless(adapter, args), { code: 'AUTH_REQUIRED' });
  assert.equal(getProviders().codex.status, 'down');
  assert.match(getProviders().codex.reason, /codex login/);
  process.env.FAKE_CLI_SCENARIO = 'ok';
  const reply = await runHeadless(adapter, args);
  assert.match(reply.inlineReply, /Fake peer reply/);
  assert.equal(getProviders().codex.status, 'up');
  setProvider('codex', false);
  assert.match((await runHeadless(adapter, args)).inlineReply, /Fake peer reply/, 'already-admitted headless work is not gated again');
  assert.equal(getProviders().codex.enabled, false);
}));

test('peers hides disabled sessions and retains down providers with their reason', () => fixture(async ({ ws, cli }) => {
  seedClaude(ws);
  setProvider('codex', false);
  setProvider('omp', false);
  const { listFleet } = await import('../src/fleet.mjs');
  const fleet = await listFleet({ cwd: ws });
  assert.deepEqual(fleet.peers.map((p) => p.name), ['visible-claude']);
  setProvider('claude', false);
  assert.deepEqual((await listFleet({ cwd: ws })).peers, []);
  let result = cli('peers', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).providers, {});
  setProvider('omp', true);
  process.env.OMP_BIN = join(ws, 'missing-omp');
  result = cli('peers');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /omp: down.*CLI_NOT_FOUND/);
  assert.doesNotMatch(result.stdout, /claude sessions|codex sessions/);
}));

test('doctor skips disabled integrations and reports enabled missing providers as down', () => fixture(async ({ ws }) => {
  for (const name of ['claude', 'codex', 'omp']) {
    process.env[`${name.toUpperCase()}_BIN`] = join(ws, `missing-${name}`);
    setProvider(name, false);
  }
  const { doctorReport } = await import('../src/install.mjs');
  let rows = await doctorReport();
  assert.deepEqual(rows.filter((r) => /claude|codex|omp/i.test(r.text)), []);
  assert.ok(rows.some((r) => /shared memory/.test(r.text)));
  setProvider('omp', true);
  rows = await doctorReport();
  assert.ok(rows.some((r) => r.level === 'fail' && /omp: down.*CLI_NOT_FOUND/.test(r.text)));
  assert.deepEqual(rows.filter((r) => /claude|codex/i.test(r.text)), []);
}));

test('busy health storage preserves both a successful reply and the original authentication error', () => fixture(async ({ ws }) => {
  const { runHeadless } = await import('../src/serve.mjs');
  const { adapter } = await import('../src/codex-adapter.mjs');
  setProvider('codex', { down: 'AUTH_REQUIRED: Previous failure.' });
  const directory = join(process.env.MAGI_HOME, 'locks', 'providers');
  mkdirSync(directory, { recursive: true });
  const ticket = join(directory, 'held.json');
  writeFileSync(ticket, JSON.stringify({ id: 'held', pid: process.pid, at: Date.now() }));
  writeFileSync(ticket + '.number', '1');
  const args = { text: 'review this', cwd: ws, allowWrites: false, timeoutMs: 10000 };
  assert.match((await runHeadless(adapter, args)).inlineReply, /Fake peer reply/);
  const original = Object.assign(new Error('Authentication failed: original cause'), { code: 'AUTH_REQUIRED' });
  // The run's own reading of its output throws; the channel is otherwise the real one.
  const failing = { ...adapter, headless: { ...adapter.headless, channel: (io, launch) => Object.assign(Object.create(adapter.headless.channel(io, launch)), { result() { throw original; } }) } };
  await assert.rejects(runHeadless(failing, args), (error) => error === original);
  process.env.FAKE_CLI_SCENARIO = 'auth';
  await assert.rejects(runHeadless(adapter, args), { code: 'AUTH_REQUIRED' });
}));

test('health ignores out-of-order failures and clears while accepting new auth observations', () => fixture(() => {
  const start = Date.now();
  setProvider('codex', { down: 'AUTH_REQUIRED: First failure.', observedAt: start });
  setProvider('codex', { down: null, observedAt: start + 2 });
  setProvider('codex', { down: 'AUTH_REQUIRED: Cached failure.', observedAt: start });
  assert.equal(getProviders().codex.status, 'up');
  setProvider('codex', { down: 'AUTH_REQUIRED: New failure.', observedAt: start + 3 });
  setProvider('codex', { down: null, observedAt: start + 1 });
  assert.equal(getProviders().codex.status, 'down');
  assert.match(getProviders().codex.reason, /New failure/);
}));

test('Codex discovery records auth before falling back and preserves strict discovery errors', () => fixture(async ({ ws }) => {
  const { adapter } = await import('../src/codex-adapter.mjs');
  const { makeServerEngine, makePickDelivery } = await import('../src/serve.mjs');
  process.env.FAKE_CLI_SCENARIO = 'auth';
  const { engine } = makeServerEngine(adapter);
  await engine.handlePeers({ workingDirectory: ws });
  assert.equal(getProviders().codex.status, 'down');
  assert.match(getProviders().codex.reason, /codex login/);
  setProvider('codex', { down: null });
  const delivery = await makePickDelivery(adapter)({ delivery: 'auto', cwd: ws });
  assert.equal(delivery.mode, 'headless');
  assert.equal(getProviders().codex.status, 'down');
  await assert.rejects(adapter.sessions({ cwd: ws, strict: true }), (error) => {
    assert.equal(error.code, 'APPSERVER_ERROR');
    assert.match(error.message, /Not logged in/);
    return true;
  });
}));

test('runtime disable preserves clarification, reply, outcome and close on existing tasks', () => fixture(async ({ ws }) => {
  const state = await import('../src/state.mjs');
  const open = (taskId, orchestrator, peer) => state.openRound({
    taskId, orchestrator, peer, mode: 'REVIEW', round: 1, maxRounds: 2, cwd: ws, task: 'existing work',
  });
  open('cx-disabled-answer', 'codex', 'claude');
  state.markWaiting('cx-disabled-answer');
  open('cx-disabled-outcome', 'claude', 'codex');
  state.recordReply({ taskId: 'cx-disabled-outcome', from: 'codex', round: 1, payload: { body: 'Existing answer', at: Date.now() } });
  open('cx-disabled-close', 'claude', 'codex');
  const server = await startServer('codex', { cwd: ws, env: { ...process.env }, as: 'claude' });
  try {
    setProvider('codex', false);
    const question = await server.call('codex_peer', { kind: 'clarify', taskId: 'cx-disabled-answer', body: 'Which branch?', workingDirectory: ws });
    assert.notEqual(question.isError, true, textOf(question));
    assert.equal(state.listQuestions('cx-disabled-answer').length, 1, 'the question is recorded in its own slot');
    const reply = await server.call('codex_peer', { kind: 'reply', taskId: 'cx-disabled-answer', body: 'Existing answer', workingDirectory: ws });
    assert.notEqual(reply.isError, true, textOf(reply));
    assert.equal(state.takeReply('cx-disabled-answer')?.body, 'Existing answer');
    assert.equal(state.readTask('cx-disabled-answer').rounds[0].replied, true);
    const outcome = await server.call('codex_peer', { kind: 'outcome', taskId: 'cx-disabled-outcome', accepted: 1, body: 'Verified', workingDirectory: ws });
    assert.notEqual(outcome.isError, true, textOf(outcome));
    assert.equal(state.readTask('cx-disabled-outcome').outcome.accepted, 1);
    const closed = await server.call('codex_peer', { kind: 'close', taskId: 'cx-disabled-close', body: 'Stop waiting', workingDirectory: ws });
    assert.notEqual(closed.isError, true, textOf(closed));
    assert.equal(state.readTask('cx-disabled-close').rounds[0].closeReason, 'abandoned');
  } finally { await server.close(); }
}));
