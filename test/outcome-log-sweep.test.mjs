// Outcome recording, the log view, sweep, and the small fixes shipped with them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { makeWorkspace, makeFakeBins, fakeEnv, startServer, textOf, initGitRepo, ROOT } from './helpers/harness.mjs';
import { getRecord, setRecord } from '../src/store.mjs';

const CLI = join(ROOT, 'bin', 'magi.mjs');

test('the orchestrator records an outcome, the peer side cannot, and log reports it', async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const { paths } = makeFakeBins(ws);
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;

  const claude = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  let taskId;
  try {
    const res = await claude.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, diffRef: 'HEAD~1..HEAD' });
    taskId = res.structuredContent.taskId;

    // The schema refuses a negative count before the ledger has to.
    const bad = await claude.call('codex_peer', { kind: 'outcome', taskId, accepted: -1 });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /greater than or equal to 0/);

    const ok = await claude.call('codex_peer', { kind: 'outcome', taskId, accepted: 2, rejected: 1, open: 1, body: 'off-by-one held; token=abc123 the perf claim did not' });
    assert.equal(ok.isError, undefined, textOf(ok));
    assert.match(textOf(ok), /2 accepted, 1 rejected, 1 open/);
  } finally {
    await claude.close();
  }

  const rec = getRecord(home, 'tasks', taskId);
  assert.deepEqual([rec.outcome.accepted, rec.outcome.rejected, rec.outcome.open, rec.outcome.round], [2, 1, 1, 1]);
  assert.match(rec.outcome.notes, /\[REDACTED\]/, 'notes are redacted like everything else on disk');

  // The same task seen from the Codex side is the peer's, and a peer cannot score itself.
  const codex = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } });
  try {
    const res = await codex.call('claude_peer', { kind: 'outcome', taskId, accepted: 9 });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /ROLE_VIOLATION/);
  } finally {
    await codex.close();
  }

  const out = execFileSync(process.execPath, [CLI, 'log'], { env: { ...process.env, MAGI_HOME: home }, encoding: 'utf-8' });
  assert.match(out, /off-by-one held/);
  assert.match(out, /1 with a recorded outcome/);
  assert.match(out, /held 67% of the time/);
});

test('sweep leaves unchecked cards and their pending mailbox replies intact', async () => {
  const home = join(makeWorkspace(), 'home');
  process.env.MAGI_HOME = home;
  const state = await import('../src/state.mjs');
  const task = (taskId, openedAt) => ({ taskId, orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', maxRounds: 2, rounds: [{ round: 1, openedAt, replied: true, brief: 'full request body' }] });
  const old = task('old', 1);
  const fresh = task('new', Date.now());
  setRecord(home, 'tasks', 'old', old);
  setRecord(home, 'tasks', 'new', fresh);
  state.putReply('old', { round: 1, at: 1, body: 'full old reply' });
  state.recordExchange('old', { kind: 'reply', round: 1, from: 'codex', text: 'full exchange body' });
  const exchanges = state.readExchange('old');

  await state.sweep(1);

  assert.deepEqual(state.readTask('old'), old);
  assert.deepEqual(state.readTask('new'), fresh);
  assert.deepEqual(state.listTasks().map((t) => t.taskId).sort(), ['new', 'old']);
  assert.deepEqual(state.readExchange('old'), exchanges);
  assert.equal(state.listMail('old')[0].body, 'full old reply');
  assert.equal(state.takeReply('old', 1).body, 'full old reply');
});

test('a section heading may carry a parenthetical', async () => {
  const { parseReply } = await import('../src/protocol.mjs');
  const p = parseReply(['## Summary', 'fine', '', '**FINDINGS:**', '- one', '', 'TESTS / VERIFICATION (JUnit XML totals, exact commands)', '- npm test'].join('\n'));
  assert.equal(p.summary, 'fine');
  assert.equal(p.findings, '- one');
  assert.equal(p.tests, '- npm test');
});

test('version drift compares numerically, not lexically', async () => {
  const { versionNewer } = await import('../src/install.mjs');
  assert.equal(versionNewer('2.1.264', '2.1.263'), true);
  assert.equal(versionNewer('2.10.0', '2.9.9'), true);
  assert.equal(versionNewer('2.1.263', '2.1.263'), false);
  assert.equal(versionNewer('0.153.4', '0.154.0'), false);
});

test('a delegated Claude peer gets no inherited MCP servers either', async () => {
  const { headlessClaudeArgs } = await import('../src/claude-launch.mjs');
  const args = headlessClaudeArgs({ allowWrites: true });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(!args.includes('--safe-mode'), 'delegation keeps project instructions; only MCP is stripped');
});

test('the orchestrator closes an abandoned round; peers, answered and closed rounds are refused', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws);
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;
  const seed = (taskId, replied) =>
    setRecord(home, 'tasks', taskId, { taskId, orchestrator: 'claude', peer: 'codex', mode: 'DELEGATE', maxRounds: 2, rounds: [{ round: 1, openedAt: Date.now(), replied, clarifies: 0 }] });
  seed('cx-open', false);
  seed('cx-done', true);
  seed('cx-cli', false);

  const claude = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  try {
    const ok = await claude.call('codex_peer', { kind: 'close', taskId: 'cx-open', body: 'peer went quiet' });
    assert.equal(ok.isError, undefined, textOf(ok));
    assert.match(textOf(ok), /closed as abandoned/);
    const again = await claude.call('codex_peer', { kind: 'close', taskId: 'cx-open' });
    assert.match(textOf(again), /ROUND_CLOSED/);
    const done = await claude.call('codex_peer', { kind: 'close', taskId: 'cx-done' });
    assert.match(textOf(done), /ALREADY_REPLIED/);
  } finally {
    await claude.close();
  }
  const rec = getRecord(home, 'tasks', 'cx-open');
  assert.equal(rec.rounds[0].closeReason, 'abandoned');
  assert.equal(rec.rounds[0].closeDetail, 'peer went quiet');

  const codex = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } });
  try {
    const res = await codex.call('claude_peer', { kind: 'close', taskId: 'cx-cli' });
    assert.match(textOf(res), /ROLE_VIOLATION/);
  } finally {
    await codex.close();
  }

  const cliEnv = { ...process.env, MAGI_HOME: home };
  assert.match(execFileSync(process.execPath, [CLI, 'close', '--task', 'cx-cli'], { env: cliEnv, encoding: 'utf-8' }), /closed as abandoned/);
  const log = execFileSync(process.execPath, [CLI, 'log'], { env: cliEnv, encoding: 'utf-8' });
  assert.match(log, /cx-cli  DELEGATE\s+claude->codex  round 1\/2  abandoned/);
  assert.match(log, /cx-done  DELEGATE\s+claude->codex  round 1\/2  replied/);
});
