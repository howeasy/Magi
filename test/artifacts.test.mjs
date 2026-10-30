// Files sent with card traffic (src/artifacts.mjs): copied when sent and
// named by hash, so the receiver's copy cannot change under it; bounded to
// the sender's tree; and across machines, carried over the relay and checked
// by hash before the message naming them is delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf, initGitRepo, startServer, ROOT } from './helpers/harness.mjs';
import { attachFiles, putBlob, blobPath, filesBlock, MAX_FILE_BYTES } from '../src/artifacts.mjs';
import { makeServerEngine, applyRelayEvent } from '../src/serve.mjs';
import { closeRelays, setRelayEventHandler } from '../src/relay.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { readExchange } from '../src/state.mjs';
import { setRecord, statement } from '../src/store.mjs';
import { processStartedAt } from '../omp/process-identity.js';

const FAKE_SSH = join(ROOT, 'test', 'helpers', 'fake-ssh.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function isolated(fn, { env: extra = {} } = {}) {
  const ws = makeWorkspace('artifacts');
  const repo = join(ws, 'repo');
  mkdirSync(repo);
  initGitRepo(repo);
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['omp', 'claude', 'codex']);
  const { env, logFile } = fakeEnv(ws);
  const remoteHome = join(ws, 'remote-home');
  Object.assign(env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'),
    OMP_BIN: paths.omp, CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, PEER_DEPTH: '0', MAGI_CONFIRM_MS: '200',
    SSH_BIN: FAKE_SSH, FAKE_SSH_MAGI_HOME: remoteHome, ...extra,
  });
  Object.assign(process.env, env);
  mkdirSync(env.MAGI_HOME, { recursive: true });
  mkdirSync(remoteHome, { recursive: true });
  writeFileSync(join(env.MAGI_HOME, 'remotes.json'), JSON.stringify({ testhost: { ssh: ['testhost'], node: process.execPath, magi: join(ROOT, 'bin', 'magi.mjs'), path: [] } }));
  setRecord(remoteHome, 'agents', String(process.pid), { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'remote-omp-1', name: 'devbox-omp', cwd: ws });
  setRelayEventHandler(applyRelayEvent);
  // Files between machines are off by default; these tests are about sending them, so both machines turn it on.
  for (const home of [env.MAGI_HOME, remoteHome]) setRecord(home, 'settings', 'files', { enabled: true });
  const servers = [];
  try { return await fn({ ws, repo, remoteHome, logFile, servers }); }
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

// The FILES block's paths, keyed by the file's path in the sender's tree.
// Each name is a JSON string; the copy's path follows it.
const pathsIn = (text) => Object.fromEntries([...String(text).matchAll(/^- ("(?:[^"\\]|\\.)*") \([^)]*sha256 [0-9a-f]{12}\): (.+)$/gm)].map((m) => [JSON.parse(m[1]), m[2].trim()]));

test('a sent file is a fixed copy named by its hash; the sender changing it afterwards changes nothing', () => isolated(async ({ repo }) => {
  writeFileSync(join(repo, 'report.txt'), 'version one\n');
  const [f] = attachFiles(['report.txt'], { cwd: repo });
  assert.equal(f.sha256, sha('version one\n'));
  assert.equal(f.name, 'report.txt');
  assert.equal(f.size, 12);
  writeFileSync(join(repo, 'report.txt'), 'version two\n');
  assert.equal(readFileSync(blobPath(f.sha256), 'utf8'), 'version one\n');
  const block = filesBlock([f]);
  assert.match(block, /^FILES \(1, sent with this message/m);
  assert.equal(readFileSync(pathsIn(block)['report.txt'], 'utf8'), 'version one\n');
  // A copy that does not match its hash is refused.
  assert.throws(() => putBlob(sha('something else'), Buffer.from('tampered')), (e) => e.code === 'FILE_CORRUPT');
}));

test('only files inside the sender\'s tree go, within the bounds, each refusal saying what to do', () => isolated(async ({ ws, repo }) => {
  writeFileSync(join(ws, 'secret.txt'), 'outside\n');
  const refused = (paths, code) => assert.throws(() => attachFiles(paths, { cwd: repo }), (e) => e.code === code && /\. /.test(e.message));
  refused(['../secret.txt'], 'FILE_OUTSIDE_WORKTREE');
  refused([join(ws, 'secret.txt')], 'FILE_OUTSIDE_WORKTREE');
  refused(['missing.txt'], 'FILE_NOT_FOUND');
  refused(Array.from({ length: 21 }, (_, i) => `f${i}`), 'FILES_TOO_MANY');
  writeFileSync(join(repo, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
  refused(['big.bin'], 'FILE_TOO_LARGE');
  // A link inside the tree that points out of it is outside too.
  try { symlinkSync(join(ws, 'secret.txt'), join(repo, 'link.txt')); refused(['link.txt'], 'FILE_OUTSIDE_WORKTREE'); }
  catch (e) { if (e.code !== 'EPERM') throw e; /* Windows without the symlink right */ }
}));

test('files never travel on one machine: a peer here is told to read the path, and nothing is sent', { timeout: 60000 }, () => isolated(async ({ repo, logFile }) => {
  writeFileSync(join(repo, 'spec.md'), '# The spec\n');
  const engine = makeServerEngine(ompAdapter, { self: 'claude', resolveOrigin: async () => ({ target: { agent: 'claude', id: 'lead' }, replyTo: null }) }).engine;
  const res = await engine.handleRequest({ task: 'Read the spec', mode: 'REVIEW', delivery: 'headless', workingDirectory: repo, files: ['spec.md'], wait: true });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /FILES_SAME_MACHINE/);
  assert.match(textOf(res), /Put their paths in the message instead/);
  assert.equal(readCalls(logFile).filter((c) => c.args).length, 0, 'no worker was started');
}));

test('files are off until the operator turns them on, on each machine: off here nothing is read, off there nothing is taken', { timeout: 90000 }, () => isolated(async ({ repo, remoteHome, logFile }) => {
  writeFileSync(join(repo, 'notes.txt'), 'context\n');
  const engine = makeServerEngine(ompAdapter, { self: 'claude', resolveOrigin: async () => ({ target: { agent: 'claude', id: 'lead' }, replyTo: null }) }).engine;
  const ask = () => engine.handleRequest({ task: 'Use the notes', mode: 'REVIEW', host: 'testhost', workingDirectory: repo, files: ['notes.txt'], wait: true });
  setRecord(process.env.MAGI_HOME, 'settings', 'files', { enabled: false });
  const here = await ask();
  assert.match(textOf(here), /FILES_OFF/);
  assert.match(textOf(here), /magi files on/);
  assert.equal(readCalls(logFile).filter((c) => c.args).length, 0, 'no worker was started');
  // On here, off there: that machine refuses to take the copy, and says so.
  setRecord(process.env.MAGI_HOME, 'settings', 'files', { enabled: true });
  setRecord(remoteHome, 'settings', 'files', { enabled: false });
  const there = await ask();
  assert.match(textOf(there), /FILES_OFF/);
  assert.match(textOf(there), /testhost/);
}));

test('only the operator switches files: magi files refuses inside a peer worker', () => isolated(async () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'files', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(run(['off']).stdout, /off here/);
  const refused = run(['on'], { PEER_DEPTH: '1' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /FILES_SETTING_REFUSED/);
  assert.match(run([]).stdout, /off here/);
  assert.match(run(['on']).stdout, /on here/);
}));

test('a file crosses to a live worker on another machine, and one comes back with its reply, each checked by hash', { timeout: 90000 }, () => isolated(async ({ ws, repo, remoteHome, servers }) => {
  writeFileSync(join(repo, 'fixture.json'), '{"case":"empty"}\n');
  const origin = { target: { agent: 'claude', sessionId: 'local-claude', id: 'local-claude', identityVerified: true }, replyTo: null, identityVerified: true };
  const engine = makeServerEngine(ompAdapter, { self: 'claude', resolveOrigin: async () => origin }).engine;
  const pending = engine.handleRequest({ task: 'Check the fixture', mode: 'REVIEW', host: 'testhost', peer: 'devbox-omp', wait: true, timeoutMs: 60000, workingDirectory: repo, files: ['fixture.json'] });

  // There: the message names that machine's copy, and the copy is the file.
  const frame = await eventually(() => statement(remoteHome, 'SELECT body FROM frames WHERE to_pid=?').all(process.pid).map((r) => JSON.parse(r.body)).at(-1));
  const text = frame.text ?? frame.message ?? JSON.stringify(frame);
  const there = pathsIn(text)['fixture.json'];
  assert.ok(there.replace(/\\/g, '/').startsWith(remoteHome.replace(/\\/g, '/')), `${there} is the remote's copy`);
  assert.equal(readFileSync(there, 'utf8'), '{"case":"empty"}\n');
  const taskId = /task_id=(magi-[0-9a-f]+)/.exec(text)[1];

  // The session there answers with a file of its own, from its own tree.
  writeFileSync(join(ws, 'result.txt'), 'all green\n');
  const remote = await startServer('claude', { env: { MAGI_HOME: remoteHome, MAGI_TEST_HOME: remoteHome }, cwd: ws, as: 'omp' });
  servers.push(remote);
  const sent = await remote.call('claude_peer', { kind: 'reply', taskId, round: 1, body: 'SUMMARY - fixture fine; see result.txt.', files: ['result.txt'] });
  assert.equal(sent.isError, undefined, textOf(sent));

  // Here: the reply names this machine's copy, fetched and checked before it arrived.
  const res = await pending;
  assert.equal(res.isError, undefined, textOf(res));
  const here = pathsIn(textOf(res))['result.txt'];
  assert.ok(here, textOf(res));
  assert.ok(!here.replace(/\\/g, '/').startsWith(remoteHome.replace(/\\/g, '/')), `${here} is this machine's copy`);
  assert.equal(readFileSync(here, 'utf8'), 'all green\n');
}));

test('a fresh worker on another machine gets the files at that machine\'s paths', { timeout: 90000 }, () => isolated(async ({ repo, remoteHome, logFile }) => {
  writeFileSync(join(repo, 'notes.txt'), 'context for the worker\n');
  const server = makeServerEngine(ompAdapter, { self: 'claude', resolveOrigin: async () => ({ target: { agent: 'claude', id: 'lead' }, replyTo: null }) }).engine;
  const res = await server.handleRequest({ task: 'Use the notes', mode: 'REVIEW', host: 'testhost', workingDirectory: repo, files: ['notes.txt'], wait: true });
  assert.equal(res.isError, undefined, textOf(res));
  const prompt = readCalls(logFile).find((c) => c.args).stdin;
  const there = pathsIn(prompt)['notes.txt'];
  assert.ok(there.replace(/\\/g, '/').startsWith(remoteHome.replace(/\\/g, '/')), there);
  assert.equal(readFileSync(there, 'utf8'), 'context for the worker\n');
  // Status and the full thread name a message's files, by their place in the sender's tree.
  assert.deepEqual(readExchange(res.structuredContent.taskId).find((e) => e.kind === 'request').files.map((f) => f.name), ['notes.txt']);
  const { cardThread } = await import('../src/status.mjs');
  assert.deepEqual(cardThread(res.structuredContent.taskId).messages.find((m) => m.kind === 'request').files, ['notes.txt']);
}));
