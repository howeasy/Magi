// A headless worker on another machine (host:, remotes.json): the config, the
// command line ssh carries, the tree snapshot, and whole cards through a fake
// ssh that runs the real `magi worker` and git transport against a separate
// remote MAGI_HOME, with the fake CLIs as the remote's harnesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, textOf, initGitRepo, ROOT } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { runHeadless } from '../src/serve.mjs';
import { runState, deliverHeadlessNote, stopHeadlessWorker } from '../src/worker-channel.mjs';
import { readRemotes, remoteConfig, remoteCommand, encodePayload, decodePayload, snapshotCommit, remotesPath, REMOTE_PROTOCOL } from '../src/remote.mjs';
import { adapter as ompAdapter } from '../src/omp-adapter.mjs';
import { adapter as claudeAdapter } from '../src/claude-adapter.mjs';
import * as state from '../src/state.mjs';
import { getProviders } from '../src/providers.mjs';

const FAKE_SSH = join(ROOT, 'test', 'helpers', 'fake-ssh.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function isolated(fn, { env: extra = {}, remotes } = {}) {
  const ws = makeWorkspace('remote worker');
  const repo = join(ws, 'repo');
  mkdirSync(repo);
  initGitRepo(repo);
  const saved = { ...process.env };
  const { paths } = makeFakeBins(ws, ['omp', 'claude', 'codex']);
  const { env, logFile } = fakeEnv(ws);
  const remoteHome = join(ws, 'remote-home');
  Object.assign(env, {
    MAGI_TEST_HOME: env.MAGI_HOME, HOME: ws, USERPROFILE: ws, OMP_AGENT_DIR: join(ws, 'omp-agent'),
    OMP_BIN: paths.omp, CLAUDE_BIN: paths.claude, CODEX_BIN: paths.codex, PEER_DEPTH: '0',
    SSH_BIN: FAKE_SSH, FAKE_SSH_MAGI_HOME: remoteHome, FAKE_SSH_LOG: join(ws, 'ssh.jsonl'), ...extra,
  });
  Object.assign(process.env, env);
  mkdirSync(env.MAGI_HOME, { recursive: true });
  writeFileSync(join(env.MAGI_HOME, 'remotes.json'), JSON.stringify(remotes ?? {
    testhost: { ssh: ['testhost'], node: process.execPath, magi: join(ROOT, 'bin', 'magi.mjs'), path: [] },
  }));
  try { return await fn({ ws, repo, env, logFile, remoteHome, sshLog: env.FAKE_SSH_LOG }); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function eventually(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('condition did not become true before deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function launcher(adapter = ompAdapter, orchestrator = 'claude') {
  let replied;
  const sent = [];
  const reply = new Promise((resolve) => { replied = resolve; });
  const engine = makeEngine({
    orchestrator, peerName: adapter.peer, replyTool: `${orchestrator}_peer`,
    resolveOrigin: async () => ({ target: { agent: orchestrator, id: 'coordinator', name: 'lead' }, replyTo: `${orchestrator}:coordinator` }),
    pickDelivery: async () => { throw new Error('a remote request must not look for a live session here'); },
    deliverHeadless: (options) => runHeadless(adapter, options),
    deliverHeadlessNote,
    stopHeadless: stopHeadlessWorker,
    deliverReply: async ({ text }) => { sent.push(text); replied(text); return { deliveryStatus: 'received' }; },
  });
  return { engine, reply, sent };
}

test('remotes.json entries are validated, and an unknown host names the configured ones', () => isolated(async () => {
  assert.equal(remoteConfig('testhost').shell, 'posix');
  assert.throws(() => remoteConfig('elsewhere'), (e) => e.code === 'UNKNOWN_HOST' && /configured: testhost/.test(e.message));
  const bad = (value, pattern) => {
    writeFileSync(remotesPath(), typeof value === 'string' ? value : JSON.stringify(value));
    assert.throws(() => readRemotes(), (e) => e.code === 'BAD_CONFIG' && pattern.test(e.message));
  };
  bad('{', /not valid JSON/);
  bad([], /JSON object/);
  bad({ 'bad name': {} }, /not a plain name/);
  bad({ h: { ssh: [], node: '/n', magi: '/m' } }, /no ssh argv/);
  bad({ h: { ssh: ['h'], magi: '/m' } }, /no "node" path/);
  bad({ h: { ssh: ['h'], node: '/n', magi: '/m', shell: 'fish' } }, /use "posix" \(Linux, macOS\) or "powershell"/);
  bad({ h: { ssh: ['h'], node: '/n', magi: '/m', shell: 'cmd' } }, /cmd\.exe cannot carry git's transport/);
}));

test('the remote command is quoted for its shell and carries the payload as base64url', () => {
  const payload = { protocol: REMOTE_PROTOCOL, workspace: { work: "/home/o'neil/w" }, note: 'a "quoted" & piped | thing' };
  const posix = remoteCommand({ shell: 'posix', node: "/opt/no'de", magi: '/m/magi.mjs', path: ['/x'] }, 'worker omp', payload);
  assert.match(posix, /^'\/opt\/no'\\''de' '\/m\/magi\.mjs' worker omp [A-Za-z0-9_-]+$/);
  const ps = remoteCommand({ shell: 'powershell', node: "C:\\Program Files\\node's\\node.exe", magi: 'C:\\magi\\bin\\magi.mjs', path: [] }, 'worker claude', payload);
  assert.match(ps, /^& 'C:\\Program Files\\node''s\\node\.exe' 'C:\\magi\\bin\\magi\.mjs' worker claude [A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePayload(ps.split(' ').at(-1)), { path: [], home: null, ...payload });
});

test('the snapshot holds tracked and untracked changes without touching the index, HEAD or the stash', () => isolated(async ({ repo }) => {
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal(snapshotCommit(repo).commit, head, 'a clean tree is HEAD itself');
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(repo, 'ignored.txt'), 'never sent\n');
  const status = git(repo, 'status', '--porcelain');
  const snap = snapshotCommit(repo);
  assert.notEqual(snap.commit, head);
  assert.equal(git(repo, 'rev-parse', `${snap.commit}^`), head);
  assert.equal(git(repo, 'show', `${snap.commit}:a.txt`), 'changed');
  assert.equal(git(repo, 'show', `${snap.commit}:new.txt`), 'untracked');
  assert.throws(() => git(repo, 'show', `${snap.commit}:ignored.txt`));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), status, 'the index and working tree are as they were');
  assert.equal(git(repo, 'stash', 'list'), '');
  assert.throws(() => snapshotCommit(makeWorkspace('not a repo')), (e) => e.code === 'REMOTE_NEEDS_GIT');
}));

test('a remote DELEGATE runs there on a copy of this tree and its edits come back as branch magi/<taskId>', { timeout: 90000 }, () => isolated(async ({ repo, logFile, remoteHome, sshLog }) => {
  writeFileSync(join(repo, 'local-only.txt'), 'uncommitted here\n');
  const before = git(repo, 'status', '--porcelain');
  const head = git(repo, 'rev-parse', 'HEAD');
  const { engine } = launcher();
  const res = await engine.handleRequest({ task: 'Add the file', mode: 'DELEGATE', allowWrites: true, workingDirectory: repo, host: 'testhost', wait: true });
  assert.equal(res.isError, undefined, textOf(res));
  const { taskId } = res.structuredContent;
  assert.match(textOf(res), /Fake peer reply/);
  assert.match(textOf(res), new RegExp(`The worker ran on testhost\\. Its changes \\(1 file: worker\\.txt\\) are on local branch magi/${taskId}`));

  // The worker ran in a worktree under the remote's home, on the snapshot.
  const work = join(remoteHome, 'remote', 'work', taskId);
  assert.ok(existsSync(join(work, 'local-only.txt')), 'the uncommitted file reached the remote copy');
  const call = readCalls(logFile).find((c) => c.args);
  assert.equal(call.name, 'omp');
  assert.match(call.stdin, /worker_host=testhost/);
  assert.match(call.stdin, /You run on testhost, in a git worktree/);

  // Home: a branch, and nothing else changed here.
  const branch = `magi/${taskId}`;
  assert.equal(git(repo, 'show', `${branch}:worker.txt`), 'written by the fake worker');
  assert.equal(git(repo, 'show', `${branch}:local-only.txt`), 'uncommitted here');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), before);
  assert.ok(!existsSync(join(repo, 'worker.txt')));

  // The card is this side's: the route records the host; the worker row is gone.
  const task = state.readTask(taskId);
  assert.equal(task.peerTarget.host, 'testhost');
  assert.equal(task.peerTarget.headless, true);
  assert.equal(state.readWorker(taskId), null);
  assert.ok(readCalls(sshLog).some((c) => /worker omp /.test(c.command)));
  assert.equal(existsSync(join(remoteHome, 'magi.db')), false, 'the remote keeps no card');
}, { env: { FAKE_CLI_WRITE_FILE: 'worker.txt' } }));

test('a continuation goes back to the same host and worktree; moving it is CARD_FIXED', { timeout: 90000 }, () => isolated(async ({ repo, remoteHome }) => {
  const { engine } = launcher();
  const first = await engine.handleRequest({ task: 'Add the file', mode: 'DELEGATE', allowWrites: true, workingDirectory: repo, host: 'testhost', wait: true });
  assert.equal(first.isError, undefined, textOf(first));
  const { taskId } = first.structuredContent;
  // The worker's own edit stays in its worktree for the next turn.
  writeFileSync(join(remoteHome, 'remote', 'work', taskId, 'second.txt'), 'kept\n');
  const moved = await engine.handleRequest({ taskId, task: 'More', host: 'otherhost', wait: true });
  assert.equal(moved.isError, true);
  assert.match(textOf(moved), /CARD_FIXED/);
  const next = await engine.handleRequest({ taskId, task: 'More', wait: true });
  assert.equal(next.isError, undefined, textOf(next));
  assert.match(textOf(next), /2 files: second\.txt, worker\.txt|2 files: worker\.txt, second\.txt/);
  assert.equal(git(repo, 'show', `magi/${taskId}:second.txt`), 'kept');
}, { env: { FAKE_CLI_WRITE_FILE: 'worker.txt' } }));

test('the far end sweeps a card by when it was last used there, never by its commit date, and its objects go with it', { timeout: 120000 }, () => isolated(async ({ repo, remoteHome }) => {
  const { engine } = launcher();
  const run = async () => {
    const res = await engine.handleRequest({ task: 'Add the file', mode: 'DELEGATE', allowWrites: true, workingDirectory: repo, host: 'testhost', wait: true });
    assert.equal(res.isError, undefined, textOf(res));
    return res.structuredContent.taskId;
  };
  // A: a dirty tree, so its snapshot holds a blob only it has.
  writeFileSync(join(repo, 'secret.txt'), 'only card A ever had this\n');
  const blob = git(repo, 'hash-object', 'secret.txt');
  const a = await run();
  rmSync(join(repo, 'secret.txt'));
  // B: a clean tree whose HEAD is years old; its snapshot is that commit.
  writeFileSync(join(repo, 'old.txt'), 'old\n');
  git(repo, 'add', 'old.txt');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old'], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' } });
  const b = await run();
  // A was last used eight days ago; the next prepare sweeps it, and only it.
  const long = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const tasks = join(remoteHome, 'remote', 'tasks');
  const repoKey = readdirSync(tasks)[0];
  utimesSync(join(tasks, repoKey, a), long, long);
  await run();
  const bare = join(remoteHome, 'remote', 'repos', readdirSync(join(remoteHome, 'remote', 'repos'))[0]);
  const refs = git(bare, 'for-each-ref', '--format=%(refname)', 'refs/magi/');
  assert.ok(!existsSync(join(remoteHome, 'remote', 'work', a)), 'A\'s worktree is gone');
  assert.doesNotMatch(refs, new RegExp(`refs/magi/${a}/`));
  assert.throws(() => git(bare, 'cat-file', '-e', blob), 'A\'s blob is gone from the repository, packed or loose');
  assert.ok(existsSync(join(remoteHome, 'remote', 'work', b)), 'B, used just now, is kept whatever its commit date');
  assert.match(refs, new RegExp(`refs/magi/${b}/base`));
}, { env: { FAKE_CLI_WRITE_FILE: 'worker.txt', MAGI_REMOTE_PRUNE_EXPIRE: 'now' } }));

test('a note reaches a remote worker inside its turn, through ssh', { timeout: 90000 }, () => isolated(async ({ repo, logFile }) => {
  const { engine, reply } = launcher();
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: repo, host: 'testhost', wait: false });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  await eventually(() => readCalls(logFile).some((call) => call.args) && runState(taskId) === 'running');
  const note = await engine.handleNote({ taskId, body: 'Also check the empty case.' });
  assert.equal(note.isError, undefined, textOf(note));
  assert.equal(note.structuredContent.deliveryStatus, 'received_mid_turn');
  const text = await reply;
  assert.match(text, /Fake peer reply/);
  assert.match(text, /The worker ran on testhost, read-only, in a copy of this tree/);
  assert.equal(readCalls(logFile).filter((c) => c.note).length, 1);
}, { env: { FAKE_CLI_HOLD_FOR_NOTES: '1' } }));

// A stop kills the local ssh client. What the far end then does with its closed
// stdin is the next two `farEnd` tests; through the fake ssh a tree kill takes
// the far end too, so this one proves the local half: the run ends, the row goes,
// and the stop is not reported back as a failure.
test('stopping a remote worker ends its run, closes the round as STOPPED, and reports no failure', { timeout: 90000 }, () => isolated(async ({ repo, logFile }) => {
  const { engine, sent } = launcher();
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: repo, host: 'testhost', wait: false });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  await eventually(() => readCalls(logFile).some((call) => call.args) && runState(taskId) === 'running' && state.readWorker(taskId)?.childPid);
  assert.equal(state.readWorker(taskId).host, 'testhost');

  const res = await engine.handleClose({ taskId, stop: true });
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(res.structuredContent.stopped, true);
  await eventually(() => runState(taskId) === null && state.readWorker(taskId) === null);
  const round = state.readTask(taskId).rounds.at(-1);
  assert.equal(round.closeCode, 'STOPPED');
  assert.equal(sent.length, 0, 'the orchestrator is not told that its own stop was a failure');
}, { env: { FAKE_CLI_SCENARIO: 'hang' } }));

test('status shows a running remote worker by host, and every configured remote', { timeout: 90000 }, () => isolated(async ({ repo, logFile }) => {
  const { magiStatus } = await import('../src/status.mjs');
  const { engine, reply } = launcher();
  const started = await engine.handleRequest({ task: 'Review the change', mode: 'REVIEW', workingDirectory: repo, host: 'testhost', wait: false });
  assert.equal(started.isError, undefined, textOf(started));
  const { taskId } = started.structuredContent;
  await eventually(() => readCalls(logFile).some((call) => call.args) && runState(taskId) === 'running');
  const status = await magiStatus({ cwd: repo, as: 'claude' });
  const card = status.cards.find((c) => c.taskId === taskId);
  assert.equal(card.worker.host, 'testhost');
  assert.equal(card.worker.name, 'headless omp on testhost');
  assert.equal(card.worker.state, 'working');
  assert.equal(status.units.find((u) => u.harness === 'omp').remoteWorkers, 1);
  assert.deepEqual(status.remotes, [{ name: 'testhost', configured: true, workers: [{ taskId, harness: 'omp' }], live: [], openCards: 1 }]);
  await engine.handleNote({ taskId, body: 'Done, reply now.' });
  await reply;
  const after = await magiStatus({ cwd: repo, as: 'claude' });
  assert.deepEqual(after.remotes, [{ name: 'testhost', configured: true, workers: [], live: [], openCards: 0 }]);
}, { env: { FAKE_CLI_HOLD_FOR_NOTES: '1' } }));

test('a remote Claude worker runs through the same route', { timeout: 90000 }, () => isolated(async ({ repo, logFile }) => {
  const { engine } = launcher(claudeAdapter, 'codex');
  const res = await engine.handleRequest({ task: 'Review', mode: 'REVIEW', workingDirectory: repo, host: 'testhost', wait: true });
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(textOf(res), /Fake peer reply/);
  const call = readCalls(logFile).find((c) => c.args);
  assert.equal(call.name, 'claude');
  assert.ok(call.args.includes('--input-format'), 'the remote built the stream-json launch');
}));

// `magi worker` run directly, as sshd would start it, so its own cleanup is
// what is tested (through the fake ssh, a tree kill here would take it too).
function farEnd(env, payload) {
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'worker', 'omp', encodePayload({ protocol: REMOTE_PROTOCOL, path: [], ...payload })], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const hello = new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, at: Date.now() })));
  return { child, hello, exited };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

test('the far end kills a CLI that ignores its closed stdin, with its descendants, after the grace', { timeout: 60000 }, () => isolated(async ({ ws }) => {
  const pidFile = join(ws, 'descendant.pid');
  const { child, hello, exited } = farEnd({ FAKE_CLI_SCENARIO: 'tree-hang', FAKE_CHILD_PID_FILE: pidFile, MAGI_REMOTE_EXIT_GRACE_MS: '1500' }, { cwd: ws });
  const h = await hello;
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.equal(h.type, 'magi_worker');
  await eventually(() => existsSync(pidFile));
  const descendant = Number(readFileSync(pidFile, 'utf8'));
  const closedAt = Date.now();
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(alive(descendant), 'still inside the grace');
  const { at } = await exited;
  assert.ok(at - closedAt >= 1400, `killed after the grace, not before (${at - closedAt} ms)`);
  await eventually(() => !alive(descendant), 10000);
}));

test('the far end lets a CLI that exits on its own finish, inside the grace, with its exit code', { timeout: 60000 }, () => isolated(async ({ ws }) => {
  const { child, hello, exited } = farEnd({ MAGI_REMOTE_EXIT_GRACE_MS: '20000' }, { cwd: ws });
  assert.equal((await hello).ok, true);
  const closedAt = Date.now();
  child.stdin.end();
  const { code, at } = await exited;
  assert.equal(code, 0);
  assert.ok(at - closedAt < 15000, `exited by itself (${at - closedAt} ms)`);
}));

test('the far end refuses in its handshake when the CLI cannot start there', { timeout: 30000 }, () => isolated(async ({ ws }) => {
  const { hello, exited } = farEnd({ OMP_BIN: join(ws, 'no-such-omp') }, { cwd: ws });
  const h = await hello;
  assert.equal(h.ok, false);
  assert.equal(h.code, 'CLI_NOT_FOUND');
  assert.equal((await exited).code, 1);
  const { hello: wrong } = farEnd({}, { cwd: ws, protocol: 99 });
  assert.equal((await wrong).code, 'REMOTE_VERSION');
}));

test('a CLI off the short ssh PATH is found through the path install recorded in bins.json', () => isolated(async ({ ws, env }) => {
  const { resolveBin } = await import('../src/exec.mjs');
  const bunBin = join(ws, 'bun global', 'bin');
  mkdirSync(bunBin, { recursive: true });
  const omp = join(bunBin, process.platform === 'win32' ? 'omp.exe' : 'omp');
  writeFileSync(omp, '');
  delete process.env.OMP_BIN;
  process.env.PATH = join(ws, 'nothing here');
  assert.throws(() => resolveBin('omp'), (e) => e.code === 'CLI_NOT_FOUND');
  writeFileSync(join(env.MAGI_HOME, 'bins.json'), JSON.stringify({ OMP_BIN: omp }));
  assert.equal(resolveBin('omp'), omp);
}));

test('refusals name what to do: unknown host, live delivery, allowCommands, persist, no repository', () => isolated(async ({ ws, repo }) => {
  const { engine } = launcher();
  const code = (res) => (res.isError ? /\b(UNKNOWN_HOST|BAD_REQUEST|REMOTE_NEEDS_GIT)\b/.exec(textOf(res))?.[1] : null);
  assert.equal(code(await engine.handleRequest({ task: 't', workingDirectory: repo, host: 'nowhere', wait: true })), 'UNKNOWN_HOST');
  assert.equal(code(await engine.handleRequest({ task: 't', workingDirectory: repo, host: 'testhost', delivery: 'live', wait: true })), 'BAD_REQUEST');
  assert.equal(code(await engine.handleRequest({ task: 't', workingDirectory: repo, host: 'testhost', persist: 'p', wait: true })), 'BAD_REQUEST');
  const plain = join(ws, 'plain');
  mkdirSync(plain);
  assert.equal(code(await engine.handleRequest({ task: 't', workingDirectory: plain, host: 'testhost', wait: true })), 'REMOTE_NEEDS_GIT');
}));

test('an unreachable host is REMOTE_UNREACHABLE, and leaves this machine\'s provider health alone', () => isolated(async ({ repo }) => {
  const { engine } = launcher();
  const res = await engine.handleRequest({ task: 't', workingDirectory: repo, host: 'testhost', wait: true });
  const body = textOf(res);
  assert.match(body, /REMOTE_UNREACHABLE/);
  assert.match(body, /Connection refused/);
  assert.notEqual(getProviders().omp?.health?.down, true);
}, { env: { FAKE_SSH_DOWN: '1' } }));
