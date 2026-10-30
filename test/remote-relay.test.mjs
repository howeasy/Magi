// A live session on another machine as this orchestrator's worker
// (src/relay.mjs): through a fake ssh, the real `magi relay` runs against a
// separate remote MAGI_HOME in which a live omp session is registered. The
// test plays that session: it reads the request from its inbox and answers
// through a real Magi server there, as the session's own claude_peer tool would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, textOf, initGitRepo, startServer, ROOT } from './helpers/harness.mjs';
import { makeServerEngine, applyRelayEvent } from '../src/serve.mjs';
import { closeRelays, setRelayEventHandler, localAddress } from '../src/relay.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { readTask, listQuestions, readExchange } from '../src/state.mjs';
import { setRecord, getRecord, listRecords, statement } from '../src/store.mjs';
import { processStartedAt } from '../omp/process-identity.js';

const FAKE_SSH = join(ROOT, 'test', 'helpers', 'fake-ssh.mjs');
const SESSION = 'remote-omp-1';

async function isolated(fn, { env: extra = {} } = {}) {
  const ws = makeWorkspace('remote relay');
  const repo = join(ws, 'repo');
  mkdirSync(repo);
  initGitRepo(repo);
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['omp', 'claude', 'codex']);
  const { env } = fakeEnv(ws);
  const remoteHome = join(ws, 'remote-home');
  Object.assign(env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'),
    OMP_BIN: paths.omp, CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, PEER_DEPTH: '0', MAGI_CONFIRM_MS: '200',
    SSH_BIN: FAKE_SSH, FAKE_SSH_MAGI_HOME: remoteHome, ...extra,
  });
  Object.assign(process.env, env);
  mkdirSync(env.MAGI_HOME, { recursive: true });
  mkdirSync(remoteHome, { recursive: true });
  writeFileSync(join(env.MAGI_HOME, 'remotes.json'), JSON.stringify({
    testhost: { ssh: ['testhost'], node: process.execPath, magi: join(ROOT, 'bin', 'magi.mjs'), path: [] },
  }));
  // The live omp session on the remote: this test process, as its extension registers it there.
  setRecord(remoteHome, 'agents', String(process.pid), { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: SESSION, name: 'devbox-omp', cwd: ws });
  setRelayEventHandler(applyRelayEvent);
  const servers = [];
  try { return await fn({ ws, repo, remoteHome, servers }); }
  finally {
    for (const s of servers) await s.close();
    closeRelays();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function eventually(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (!(value = await check())) {
    if (Date.now() >= deadline) assert.fail('condition did not become true before deadline');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return value;
}

// The orchestrator here: a Claude session's omp_peer engine with a known origin.
function orchestrator() {
  const origin = { target: { agent: 'claude', sessionId: 'local-claude', id: 'local-claude', name: 'lead', identityVerified: true, identitySource: 'test' }, replyTo: null, identityVerified: true, identitySource: 'test' };
  return makeServerEngine(ompAdapter, { self: 'claude', resolveOrigin: async () => origin }).engine;
}

// What reached the remote session's inbox, newest last.
const inbox = (remoteHome) => statement(remoteHome, 'SELECT body FROM frames WHERE to_pid=? ORDER BY created_at').all(process.pid).map((r) => JSON.parse(r.body));
const textOfFrame = (f) => f.text ?? f.message ?? JSON.stringify(f);

// The remote session's own Magi server, which its claude_peer tool calls.
async function sessionServer(remoteHome, ws, servers) {
  const s = await startServer('claude', { env: { MAGI_HOME: remoteHome, MAGI_TEST_HOME: remoteHome }, cwd: ws, as: 'omp' });
  servers.push(s);
  return s;
}

test('peers with host lists that machine\'s sessions, named with their host', { timeout: 60000 }, () => isolated(async () => {
  const res = await orchestrator().handlePeers({ kind: 'peers', host: 'testhost' });
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(textOf(res), /devbox-omp/);
  assert.match(textOf(res), /on testhost/);
}));

test('a blocking review by a live session on another machine returns its reply inline, and the card is this side\'s', { timeout: 90000 }, () => isolated(async ({ ws, repo, remoteHome, servers }) => {
  const engine = orchestrator();
  const pending = engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', host: 'testhost', peer: 'devbox-omp', wait: true, timeoutMs: 60000, workingDirectory: repo });
  const frame = await eventually(() => inbox(remoteHome).at(-1));
  const prompt = textOfFrame(frame);
  assert.match(prompt, /PEER REQUEST magi\/1/);
  assert.match(prompt, /orchestrator_host=/);
  assert.match(prompt, /The orchestrator runs on another machine/);
  const taskId = /task_id=(magi-[0-9a-f]+)/.exec(prompt)[1];

  // The remote keeps a mirror naming the session, with an origin that is this machine.
  const mirror = getRecord(remoteHome, 'tasks', taskId);
  assert.equal(mirror.mirror, true);
  assert.equal(mirror.peerTarget.sessionId, SESSION);
  assert.equal(mirror.orchestratorTarget.remote, localAddress());

  const remote = await sessionServer(remoteHome, ws, servers);
  const sent = await remote.call('claude_peer', { kind: 'reply', taskId, round: 1, body: 'SUMMARY - the change holds; checked src/a.mjs:1.' });
  assert.equal(sent.isError, undefined, textOf(sent));

  const res = await pending;
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(textOf(res), /the change holds/);
  const card = readTask(taskId);
  assert.equal(card.rounds[0].replied, true);
  assert.equal(card.peerTarget.host, 'testhost');
  assert.equal(card.peerTarget.sessionId, SESSION);
  assert.equal(card.orchestratorTarget.sessionId, 'local-claude');
  // Applied here, the event leaves the remote's outbox.
  await eventually(() => listRecords(remoteHome, 'relay-outbox').length === 0);
}));

test('a note and an answer cross to the remote worker; its question and reply come back to this card', { timeout: 90000 }, () => isolated(async ({ ws, repo, remoteHome, servers }) => {
  const engine = orchestrator();
  const started = await engine.handleRequest({ task: 'Delegate the fix', mode: 'DELEGATE', host: 'testhost', peer: 'devbox-omp', wait: false, workingDirectory: repo });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  assert.match(started.structuredContent.via ?? '', /live|relay/);
  await eventually(() => inbox(remoteHome).length >= 1);

  const note = await engine.handleNote({ taskId, body: 'Also check the empty case.' });
  assert.equal(note.isError, undefined, textOf(note));
  assert.match(note.structuredContent.via, /^relay:testhost/);
  await eventually(() => inbox(remoteHome).some((f) => /PEER NOTE magi\/1/.test(textOfFrame(f)) && /empty case/.test(textOfFrame(f))));

  // Status shows the worker by its name there and its machine, never a session here.
  const { magiStatus } = await import('../src/status.mjs');
  const card = (await magiStatus({ cwd: repo, as: 'claude' })).cards.find((c) => c.taskId === taskId);
  assert.equal(card.worker.name, 'devbox-omp on testhost');
  assert.equal(card.worker.host, 'testhost');
  assert.equal(card.worker.via, 'live');
  // The machine's entry names the live session working this card.
  const status = await magiStatus({ cwd: repo, as: 'claude' });
  assert.deepEqual(status.remotes.find((r) => r.name === 'testhost').live, [{ taskId, harness: 'omp', name: 'devbox-omp' }]);

  const remote = await sessionServer(remoteHome, ws, servers);
  const asked = await remote.call('claude_peer', { kind: 'clarify', taskId, round: 1, body: 'Which branch should I read?' });
  assert.equal(asked.isError, undefined, textOf(asked));
  const question = await eventually(() => listQuestions(taskId).find((q) => q.body === 'Which branch should I read?'));

  const answered = await engine.handleClarifyAnswer({ taskId, questionId: question.id, body: 'main' });
  assert.equal(answered.isError, undefined, textOf(answered));
  await eventually(() => inbox(remoteHome).some((f) => /main/.test(textOfFrame(f)) && /PEER CLARIFICATION|clarif/i.test(textOfFrame(f))));

  const replied = await remote.call('claude_peer', { kind: 'reply', taskId, round: 1, body: 'Fixed on branch fix/empty; commit abc123.' });
  assert.equal(replied.isError, undefined, textOf(replied));
  await eventually(() => readTask(taskId).rounds[0].replied);
  assert.ok(readExchange(taskId).some((e) => e.kind === 'reply' && /fix\/empty/.test(e.text)));
}));

test('a live worker on another machine is named with peer; steer does not cross; an unreachable host says so', { timeout: 60000 }, () => isolated(async ({ repo }) => {
  const engine = orchestrator();
  const code = (res) => (res.isError ? /\b([A-Z][A-Z_]{3,})\b/.exec(textOf(res))?.[1] : null);
  assert.equal(code(await engine.handleRequest({ task: 't', host: 'testhost', delivery: 'live', workingDirectory: repo })), 'BAD_REQUEST');
  assert.equal(code(await engine.handleRequest({ task: 't', host: 'testhost', peer: 'devbox-omp', delivery: 'steer', workingDirectory: repo })), 'BAD_REQUEST');
  assert.equal(code(await engine.handleRequest({ task: 't', host: 'testhost', peer: 'nobody-there', wait: true, workingDirectory: repo })), 'NO_LIVE_PEER');
  process.env.FAKE_SSH_DOWN = '1';
  closeRelays();
  const down = await engine.handlePeers({ kind: 'peers', host: 'testhost' });
  assert.match(textOf(down), /REMOTE_UNREACHABLE/);
}));
