// The operator's launch wrapper (MAGI_WORKER_WRAPPER) and the allowCommands
// grant it makes possible: validation, the engine flags, the refusals, the
// spawn through the wrapper, the worker record and continuation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, ROOT, textOf } from './helpers/harness.mjs';
import { workerWrapper, workerEnv } from '../src/worker-wrapper.mjs';
import { headlessOmpArgs } from '../src/omp-launch.mjs';
import { headlessClaudeArgs } from '../src/claude-launch.mjs';
import { composeRequest } from '../src/protocol.mjs';
import { makeEngine } from '../src/peer.mjs';
import { readTask, readWorker, taskSummary } from '../src/state.mjs';
import { cardThread } from '../src/status.mjs';

const STUB = join(ROOT, 'test', 'helpers', 'stub-wrapper.mjs');
const isWin = process.platform === 'win32';

let savedEnv;
test.beforeEach(() => { savedEnv = { ...process.env }; });
test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const configError = (fn, pattern) => assert.throws(fn, (e) => e.code === 'BAD_CONFIG' && pattern.test(e.message));

test('the wrapper is a JSON array argv of non-empty strings whose first item is an absolute executable; anything else is BAD_CONFIG', () => {
  assert.equal(workerWrapper(undefined), null, 'unset: no wrapper');
  assert.equal(workerWrapper('  '), null, 'blank: no wrapper');
  assert.deepEqual(workerWrapper(JSON.stringify([process.execPath, STUB, '--profile', 'worker'])), [process.execPath, STUB, '--profile', 'worker']);
  configError(() => workerWrapper('node stub'), /not valid JSON/);
  configError(() => workerWrapper('[]'), /non-empty JSON array/);
  configError(() => workerWrapper('{"argv":["/bin/x"]}'), /non-empty JSON array/);
  configError(() => workerWrapper(JSON.stringify([process.execPath, ''])), /not a non-empty string/);
  configError(() => workerWrapper(JSON.stringify([process.execPath, 3])), /not a non-empty string/);
  configError(() => workerWrapper(JSON.stringify(['bin/sandbox'])), /not an absolute path/);
  configError(() => workerWrapper(JSON.stringify([join(makeWorkspace(), 'missing-sandbox')])), /does not exist/);
  configError(() => workerWrapper(JSON.stringify([makeWorkspace()])), /not a file/);
});

test('on Windows the wrapper must be a file Windows starts: an .exe, .com, .cmd or .bat', () => {
  const dir = makeWorkspace();
  const script = join(dir, 'sandbox.sh');
  writeFileSync(script, '#!/bin/sh\nexec "$@"\n');
  configError(() => workerWrapper(JSON.stringify([script]), { platform: 'win32' }), /Windows cannot start directly/);
  for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
    const file = join(dir, `sandbox${ext}`);
    writeFileSync(file, '');
    assert.deepEqual(workerWrapper(JSON.stringify([file, '--x']), { platform: 'win32' }), [file, '--x']);
  }
});

test('on POSIX the wrapper must be executable by this user', { skip: isWin && 'POSIX permission bits' }, () => {
  const file = join(makeWorkspace(), 'sandbox');
  writeFileSync(file, '#!/bin/sh\nexec "$@"\n', { mode: 0o644 });
  configError(() => workerWrapper(JSON.stringify([file]), { platform: 'linux' }), /not executable/);
});

test('a server with an unusable wrapper refuses to start, naming BAD_CONFIG', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'serve', 'omp', '--as', 'claude'], {
    encoding: 'utf-8', timeout: 30000, input: '',
    env: { ...process.env, PEER_DEPTH: '0', MAGI_WORKER_WRAPPER: '["relative/sandbox"]' },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /BAD_CONFIG: MAGI_WORKER_WRAPPER starts with "relative\/sandbox", which is not an absolute path/);
});

test('each engine\'s flags: commands only with writes; omp yolo, Claude bypassPermissions with no MCP servers of its own', () => {
  const omp = (o) => headlessOmpArgs(o).join(' ');
  assert.match(omp({ allowWrites: true, allowCommands: true }), /--approval-mode yolo/);
  assert.match(omp({ allowWrites: true }), /--approval-mode write/);
  assert.match(omp({ allowCommands: true }), /--approval-mode always-ask/, 'the builder never grants commands without writes');
  assert.ok(!omp({ allowWrites: true, allowCommands: true }).includes('--tools'));

  const claude = headlessClaudeArgs({ allowWrites: true, allowCommands: true });
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.equal(claude[claude.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(claude.slice(-3), ['--disallowedTools', 'mcp__magi', 'mcp__codex']);
  const edits = headlessClaudeArgs({ allowWrites: true });
  assert.equal(edits[edits.indexOf('--permission-mode') + 1], 'acceptEdits');
  const review = headlessClaudeArgs({ allowCommands: true });
  assert.equal(review[review.indexOf('--permission-mode') + 1], 'dontAsk', 'a review stays read-only');
});

test('the request says workspace+commands and what that means; workspace and read-only are unchanged', () => {
  const base = { taskId: 'magi-w', orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', task: 'Format and test', replyVia: 'inline' };
  const full = composeRequest({ ...base, allowWrites: true, allowCommands: true });
  assert.equal(full.writePolicy, 'workspace+commands');
  assert.match(full.text, /write_policy=workspace\+commands/);
  assert.match(full.text, /You may run shell commands; you are inside a sandbox the orchestrator controls; work only inside the stated working directory\./);
  const turn = composeRequest({ ...base, allowWrites: true, allowCommands: true, compact: true, round: 2 });
  assert.match(turn.text, /^PEER TURN magi\/1 .* write_policy=workspace\+commands/);
  assert.match(turn.text, /You may run shell commands; you are inside a sandbox/);
  assert.equal(composeRequest({ ...base, allowWrites: true }).writePolicy, 'workspace');
  assert.equal(composeRequest({ ...base, mode: 'REVIEW', allowWrites: true, allowCommands: true }).writePolicy, 'read-only');
});

test('the wrapper env names the task, round, harness, absolute cwd, whether commands are allowed, and a file the worker must read', () => {
  assert.deepEqual(workerEnv({ taskId: 'magi-1', round: 2, harness: 'omp', cwd: '/w', allowCommands: true, config: '/tmp/magi-advisor-1.yml' }), {
    MAGI_WORKER_TASK_ID: 'magi-1', MAGI_WORKER_ROUND: '2', MAGI_WORKER_HARNESS: 'omp', MAGI_WORKER_CWD: '/w', MAGI_WORKER_COMMANDS: '1', MAGI_WORKER_CONFIG: '/tmp/magi-advisor-1.yml',
  });
  assert.equal(workerEnv({ taskId: 't', harness: 'codex', cwd: '/w' }).MAGI_WORKER_CONFIG, '', 'none for a run without one');
  assert.equal(workerEnv({ taskId: 't', harness: 'codex', cwd: '/w' }).MAGI_WORKER_COMMANDS, '0');
});

// The engine with a recorded headless worker, as headless-channels.test.mjs builds it.
function engineFixture(overrides = {}) {
  const cwd = makeWorkspace('worker wrapper');
  process.env.MAGI_HOME = join(cwd, 'home');
  process.env.PEER_DEPTH = '0';
  delete process.env.MAGI_WORKER_WRAPPER;
  const calls = [];
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: { agent: 'claude', id: 'coordinator', name: 'lead' }, replyTo: 'claude:coordinator' }),
    pickDelivery: async ({ delivery }) => (delivery === 'live' ? { mode: 'live', target: { agent: 'omp', id: 'live-omp' } } : { mode: 'headless' }),
    deliverHeadless: async (options) => {
      calls.push(options);
      return { via: 'headless', threadId: 'worker-session', inlineReply: 'Done.' };
    },
    deliverReply: async () => ({ deliveryStatus: 'received' }),
    ...overrides,
  });
  return { cwd, engine, calls };
}
const wrap = () => { process.env.MAGI_WORKER_WRAPPER = JSON.stringify([process.execPath, STUB]); };
const DELEGATE = (cwd, extra = {}) => ({ task: 'Run cargo fmt and the focused tests', mode: 'DELEGATE', delivery: 'headless', allowWrites: true, allowCommands: true, workingDirectory: cwd, wait: true, ...extra });

test('allowCommands is refused, never quietly dropped: no wrapper, a review mode, no allowWrites, live delivery', async () => {
  const { cwd, engine, calls } = engineFixture();
  const noWrapper = await engine.handleRequest(DELEGATE(cwd));
  assert.equal(noWrapper.isError, true);
  assert.match(textOf(noWrapper), /COMMANDS_REQUIRE_WRAPPER/);

  wrap();
  for (const mode of ['REVIEW', 'ADVERSARIAL_REVIEW', 'FACT_CHECK', 'SECOND_OPINION']) {
    const review = await engine.handleRequest(DELEGATE(cwd, { mode }));
    assert.match(textOf(review), /BAD_REQUEST.*DELEGATE \(or PARALLEL\) only/, mode);
  }
  assert.match(textOf(await engine.handleRequest(DELEGATE(cwd, { allowWrites: false }))), /BAD_REQUEST: allowCommands needs allowWrites: true/);
  assert.match(textOf(await engine.handleRequest(DELEGATE(cwd, { delivery: 'live' }))), /BAD_REQUEST.*delivery "live" names a live session/);
  // Auto delivery that lands on a live session is refused too.
  const { cwd: cwd2, engine: liveEngine } = engineFixture({ pickDelivery: async () => ({ mode: 'live', target: { agent: 'omp', id: 'live-omp' } }) });
  wrap();
  assert.match(textOf(await liveEngine.handleRequest(DELEGATE(cwd2, { delivery: 'auto' }))), /BAD_REQUEST.*would reach a live omp session/);
  assert.equal(calls.length, 0, 'no worker was started for any refusal');
});

test('a granted round runs with commands, is recorded on the card, the round, the request, magi log and exchange --json', async () => {
  const { cwd, engine, calls } = engineFixture();
  wrap();
  const res = await engine.handleRequest(DELEGATE(cwd));
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(calls[0].allowCommands, true);
  assert.equal(calls[0].allowWrites, true);
  assert.match(calls[0].text, /write_policy=workspace\+commands/);
  const { taskId } = res.structuredContent;
  const task = readTask(taskId);
  assert.equal(task.allowCommands, true);
  assert.equal(task.rounds[0].allowCommands, true);
  assert.equal(taskSummary(task).commands, 1);
  const thread = cardThread(taskId);
  assert.equal(thread.allowCommands, true);
  assert.deepEqual(thread.commandRounds, [1]);
  assert.equal(thread.messages.find((m) => m.kind === 'request').allowCommands, true);
});

test('unasked, a new headless DELEGATE with writes gets commands under a wrapper and is told so; elsewhere nothing changes and nothing is refused', async () => {
  const unasked = (cwd, extra) => DELEGATE(cwd, { allowCommands: undefined, ...extra });
  const { cwd, engine, calls } = engineFixture();
  const noWrapper = await engine.handleRequest(unasked(cwd));
  assert.equal(noWrapper.isError, undefined, textOf(noWrapper));
  assert.equal(calls.at(-1).allowCommands, false, 'no wrapper: no commands, and no refusal');

  wrap();
  const res = await engine.handleRequest(unasked(cwd));
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(calls.at(-1).allowCommands, true);
  assert.match(calls.at(-1).text, /write_policy=workspace\+commands/);
  assert.match(textOf(res), /\[magi\] .*shell commands allowed by default .*allowCommands: false to withhold them/);
  assert.equal(readTask(res.structuredContent.taskId).allowCommands, true, 'the card keeps the grant for its continuations');

  const withheld = await engine.handleRequest(unasked(cwd, { allowCommands: false }));
  assert.equal(calls.at(-1).allowCommands, false);
  assert.doesNotMatch(textOf(withheld), /allowed by default/);

  // A fresh ledger: four answered cards with no outcome would hold the next request.
  const { cwd: cwd3, engine: engine3, calls: calls3 } = engineFixture();
  wrap();
  for (const [why, extra] of [['no writes', { allowWrites: false }], ['a review', { mode: 'REVIEW' }]]) {
    const r = await engine3.handleRequest(unasked(cwd3, extra));
    assert.equal(r.isError, undefined, `${why}: ${textOf(r)}`);
    assert.equal(calls3.at(-1).allowCommands, false, why);
  }
  assert.equal(calls3.length, 2);

  // Auto delivery that lands on a live session: the default does not apply,
  // and unlike an explicit ask it is not refused.
  const { cwd: cwd2, engine: liveEngine } = engineFixture({ pickDelivery: async () => ({ mode: 'live', target: { agent: 'omp', id: 'live-omp' } }), deliverLive: async () => ({ via: 'live', deliveryStatus: 'received' }) });
  wrap();
  const live = await liveEngine.handleRequest(unasked(cwd2, { delivery: 'auto', wait: false }));
  assert.equal(live.isError, undefined, textOf(live));
  assert.equal(readTask(live.structuredContent.taskId).allowCommands, false);
});

test('a continuation inherits the grant, may narrow it, and cannot add it to a card opened without', async () => {
  const { cwd, engine, calls } = engineFixture();
  wrap();
  const first = await engine.handleRequest(DELEGATE(cwd, { maxRounds: 4 }));
  const { taskId } = first.structuredContent;
  const inherited = await engine.handleRequest({ taskId, task: 'Now the clippy fixes', wait: true });
  assert.equal(inherited.isError, undefined, textOf(inherited));
  assert.equal(calls[1].allowCommands, true, 'omitted: the card grant');
  const narrowed = await engine.handleRequest({ taskId, task: 'Just edit the doc', allowCommands: false, wait: true });
  assert.equal(narrowed.isError, undefined, textOf(narrowed));
  assert.equal(calls[2].allowCommands, false);
  assert.match(calls[2].text, /write_policy=workspace\b(?!\+)/);
  assert.deepEqual(cardThread(taskId).commandRounds, [1, 2]);

  const plain = await engine.handleRequest(DELEGATE(cwd, { allowCommands: false }));
  const plainId = plain.structuredContent.taskId;
  const widened = await engine.handleRequest({ taskId: plainId, task: 'And run the tests', allowCommands: true, wait: true });
  assert.match(textOf(widened), /BAD_REQUEST: Task .* was opened without allowCommands; a continuation cannot add it/);
  assert.equal(readTask(plainId).rounds.length, 1, 'no round was opened');
});

test('a headless worker starts as <wrapper argv> -- <resolved worker argv>, with the MAGI_WORKER_* env, and its row names the spawned process', async () => {
  const ws = makeWorkspace('wrapped worker');
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const wrapperLog = join(ws, 'wrapper.jsonl');
  Object.assign(process.env, env, {
    OMP_BIN: paths.omp,
    PEER_DEPTH: '0',
    STUB_WRAPPER_LOG: wrapperLog,
    MAGI_WORKER_WRAPPER: JSON.stringify([process.execPath, STUB, '--profile', 'worker']),
    // Hold the worker after its answer, so its row can be read while it runs.
    FAKE_CLI_EXIT_DELAY_MS: '1500',
  });
  mkdirSync(env.MAGI_HOME, { recursive: true });
  const { runHeadless } = await import('../src/serve.mjs');
  const { adapter } = await import('../src/omp-adapter.mjs');
  const run = runHeadless(adapter, { text: 'Run the tests', cwd: ws, allowWrites: true, allowCommands: true, taskId: 'magi-wrap0001', round: 1, timeoutMs: 60000 });

  let row = null;
  for (let i = 0; i < 100 && !row?.childPid; i++) {
    row = readWorker('magi-wrap0001');
    await new Promise((r) => setTimeout(r, 50));
  }
  const reply = await run;
  assert.match(reply.inlineReply, /Fake peer reply/);
  assert.equal(reply.allowCommands, true);

  const [wrapped] = readCalls(wrapperLog);
  assert.deepEqual(wrapped.own, ['--profile', 'worker'], 'the wrapper got its own arguments');
  assert.equal(wrapped.sawSeparator, true, 'then --');
  assert.equal(wrapped.rest[0], paths.omp, 'then the worker resolved to its file');
  assert.deepEqual(wrapped.rest.slice(1, 3), ['--mode', 'rpc']);
  assert.ok(wrapped.rest.includes('yolo'), 'with commands granted');
  const { MAGI_WORKER_CONFIG: config, ...named } = wrapped.env;
  assert.deepEqual(named, {
    MAGI_WORKER_TASK_ID: 'magi-wrap0001', MAGI_WORKER_ROUND: '1', MAGI_WORKER_HARNESS: 'omp', MAGI_WORKER_CWD: resolve(ws), MAGI_WORKER_COMMANDS: '1',
  });
  // A wrapper with a private /tmp binds this in: omp will not start without it.
  assert.equal(wrapped.rest[wrapped.rest.indexOf('--config') + 1], config, 'the wrapper is told the overlay the worker reads');
  assert.equal(readCalls(logFile).find((c) => c.name === 'omp')?.env.PEER_DEPTH, '1', 'the worker under it is still a peer');

  assert.ok(row, 'the worker row was there while it ran');
  assert.equal(row.pid, process.pid, 'the server that owns it');
  assert.equal(row.wrapper, process.execPath, 'the wrapper argv[0]');
  assert.equal(row.allowCommands, true);
  assert.equal(row.childPid, wrapped.pid, 'the process spawned for it');
  assert.equal(readWorker('magi-wrap0001'), null, 'gone once the run ended');
});

test('a CLI that is a node script (codex.js, or npm\'s .cmd shim on Windows) reaches the wrapper as this node plus the script', async () => {
  const { workerArgv } = await import('../src/exec.mjs');
  const dir = makeWorkspace('node script cli');
  const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, '#!/usr/bin/env node\n');
  process.env.CODEX_BIN = script;
  assert.deepEqual(workerArgv('codex', ['app-server', '--listen', 'stdio://']), [process.execPath, script, 'app-server', '--listen', 'stdio://']);
  // npm's Windows shim names the script relative to itself.
  const shim = join(dir, 'codex.cmd');
  writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  process.env.CODEX_BIN = shim;
  assert.deepEqual(workerArgv('codex', ['app-server']), isWin ? [process.execPath, script, 'app-server'] : [shim, 'app-server']);
  // Anything else is handed over as it resolved.
  process.env.CODEX_BIN = process.execPath;
  assert.deepEqual(workerArgv('codex', ['x']), [process.execPath, 'x']);
});

test('a .js CLI whose own #! names another runtime (omp\'s bun cli.js) starts as it resolved, not under node', async () => {
  const { workerArgv } = await import('../src/exec.mjs');
  const dir = makeWorkspace('bun script cli');
  const script = join(dir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist', 'cli.js');
  mkdirSync(join(script, '..'), { recursive: true });
  // 2026-10-23: node ran this file on every wrapped omp run on the Mac, and it died at its first Bun call.
  writeFileSync(script, '#!/usr/bin/env bun\n// @bun\nBun.spawn;\n');
  process.env.OMP_BIN = script;
  assert.deepEqual(workerArgv('omp', ['--mode', 'rpc']), [script, '--mode', 'rpc']);
  for (const line of ['#!/usr/bin/env -S node --no-warnings', '#!/usr/local/bin/node', '#!/usr/bin/env node']) {
    writeFileSync(script, line + '\n');
    assert.deepEqual(workerArgv('omp', ['x']), [process.execPath, script, 'x'], line);
  }
  writeFileSync(script, 'console.log(1)\n');   // no #! line: a node script, as before
  assert.deepEqual(workerArgv('omp', ['x']), [process.execPath, script, 'x']);
});

test('without a wrapper the worker starts as before, and asking runHeadless for commands is refused', async () => {
  const ws = makeWorkspace('unwrapped worker');
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  Object.assign(process.env, env, { OMP_BIN: paths.omp, PEER_DEPTH: '0' });
  delete process.env.MAGI_WORKER_WRAPPER;
  const { runHeadless } = await import('../src/serve.mjs');
  const { adapter } = await import('../src/omp-adapter.mjs');
  await assert.rejects(runHeadless(adapter, { text: 'x', cwd: ws, allowWrites: true, allowCommands: true, timeoutMs: 60000 }), { code: 'COMMANDS_REQUIRE_WRAPPER' });
  const reply = await runHeadless(adapter, { text: 'Edit it', cwd: ws, allowWrites: true, timeoutMs: 60000 });
  assert.match(reply.inlineReply, /Fake peer reply/);
  assert.match(readCalls(logFile).find((c) => c.name === 'omp').args.join(' '), /--approval-mode write/);
});
