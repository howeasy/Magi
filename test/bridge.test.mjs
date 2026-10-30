import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf, initGitRepo, isWin, ROOT } from './helpers/harness.mjs';

// One workspace per test keeps the on-disk ledger isolated.
function setup({ scenario = 'ok', git = true } = {}) {
  const ws = makeWorkspace();
  if (git) initGitRepo(ws);
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws, { scenario });
  return { ws, paths, env, logFile };
}

async function withServer(which, opts, fn) {
  const s = await startServer(which, opts);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

const argvOf = (calls) => (calls[0]?.args ?? []).join(' ');

// 1. Claude invokes Codex.
test('claude -> codex request reaches the peer and returns a parsed reply', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', {
      wait: true,
      task: 'Review the change',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
    });
    assert.equal(res.isError, undefined);
    assert.match(textOf(res), /SUMMARY/);
    assert.equal(res.structuredContent.sections.summary, 'Fake peer reply.');
    assert.match(res.structuredContent.taskId, /^magi-[0-9a-f]{8}$/);
  });
  assert.equal(readCalls(logFile).length, 1);
});

// 2. Codex invokes Claude.
test('codex -> claude request reaches the peer and returns a parsed reply', async () => {
  const { ws, paths, env } = setup();
  await withServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } }, async (s) => {
    const res = await s.call('claude_peer', {
      wait: true,
      task: 'Review the change',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
    });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.sections.summary, 'Fake peer reply.');
  });
});

// 3. The peer receives repository context, not the orchestrator's conclusions.
test('peer receives repo context and, by default, no orchestrator conclusion', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', {
      wait: true,
      task: 'Review the change',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      diffRef: 'HEAD~1..HEAD',
    });
  });
  const { stdin } = readCalls(logFile)[0];
  assert.match(stdin, /REPOSITORY STATE/);
  assert.match(stdin, /diff sha256: [0-9a-f]{64}/);
  assert.match(stdin, /working directory: /);
  assert.match(stdin, /Reach your own conclusion first/);
});

// 4 + 18. Review mode is read-only and cannot be talked into writing.
test('review mode is read-only, and allowWrites cannot escalate it', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', {
      wait: true,
      task: 'Review',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      allowWrites: true,
    });
  });
  const calls = readCalls(logFile);
  // The sandbox is set on the thread and again on the turn it runs.
  assert.equal(calls[0].opened.params.sandbox, 'read-only');
  assert.deepEqual(calls[0].turn.sandboxPolicy, { type: 'readOnly' });
  assert.equal(calls[0].turn.approvalPolicy, 'never');
  assert.doesNotMatch(JSON.stringify([calls[0].opened, calls[0].turn, calls[0].args]), /workspace-?write|danger-?full-?access/i);
  assert.match(calls[0].stdin, /READ-ONLY/);
});

test('claude peer review pins the read-only tool set', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } }, async (s) => {
    await s.call('claude_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, allowWrites: true });
  });
  const argv = argvOf(readCalls(logFile));
  assert.match(argv, /--permission-prompts none/);
  assert.match(argv, /--disallowedTools Bash PowerShell Edit Write NotebookEdit/);
  assert.match(argv, /--strict-mcp-config/);
  assert.match(argv, /--safe-mode/);
  assert.match(argv, /--restricted/);
  assert.match(argv, /--permission-mode dontAsk/);
  assert.doesNotMatch(argv, /acceptEdits/);
});

// 5. Implementation mode may write, and only inside the workspace.
test('DELEGATE with allowWrites uses a workspace-scoped sandbox', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', {
      wait: true,
      task: 'Implement the helper',
      mode: 'DELEGATE',
      delivery: 'headless',
      workingDirectory: ws,
      allowWrites: true,
    });
  });
  const [call] = readCalls(logFile);
  assert.equal(call.opened.params.sandbox, 'workspace-write');
  assert.deepEqual(call.turn.sandboxPolicy, { type: 'workspaceWrite' });
  assert.equal(call.opened.params.cwd, ws);
  assert.equal(call.turn.cwd, ws);
  assert.equal(call.cwd, ws);
  assert.doesNotMatch(JSON.stringify([call.opened, call.turn, call.args]), /danger-?full-?access/i);
});

// 6. A peer cannot recursively invoke the orchestrator.
// The server does not even start inside a peer: omp loads it into every
// headless run, where it could only refuse.
test('a peer process does not serve the bridge at all', () => {
  const { ws, paths, env } = setup();
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), 'serve', 'codex'], {
    cwd: ws, env: { ...process.env, ...env, CODEX_BIN: paths.codex, PEER_DEPTH: '1' }, input: '', encoding: 'utf-8', timeout: 10000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /RECURSION_BLOCKED/);
  assert.equal(r.stdout, '');
});

test('the spawned peer has the reverse bridge disabled and is marked as a peer', async () => {
  const { ws, paths, env, logFile } = setup();
  const codexHome = join(ws, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.magi]\ncommand = "node"\n[mcp_servers.magi-omp]\ncommand = "node"\n[mcp_servers.other]\ncommand = "keep"\n');
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex, CODEX_HOME: codexHome } }, async (s) => {
    await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  });
  const calls = readCalls(logFile);
  assert.match(argvOf(calls), /mcp_servers\.magi\.enabled=false/);
  assert.match(argvOf(calls), /mcp_servers\.magi-omp\.enabled=false/);
  assert.doesNotMatch(argvOf(calls), /mcp_servers\.other/);
  assert.equal(calls[0].env.PEER_DEPTH, '1');
  assert.match(calls[0].stdin, /Do not open a new request back to the orchestrator/);
});

// Regression: `-c mcp_servers.<name>.enabled=false` merges, so naming a server
// that is not configured creates a table with no transport and Codex refuses to
// start. The override must only be emitted for sections that exist.
test('no MCP override is emitted when the bridge is not in the Codex config', async () => {
  const { ws, paths, env, logFile } = setup();
  const codexHome = join(ws, 'empty-codex-home');
  mkdirSync(codexHome, { recursive: true });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex, CODEX_HOME: codexHome } }, async (s) => {
    await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  });
  assert.doesNotMatch(argvOf(readCalls(logFile)), /mcp_servers/);
});

test('claude peer is barred from calling the codex bridge back', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } }, async (s) => {
    await s.call('claude_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  });
  assert.match(argvOf(readCalls(logFile)), /mcp__codex/);
});

// Review continuations share the engine loop guard without CLI-only modes.
test('review continuations assign turns automatically and remain bounded', async () => {
  const { ws, paths, env } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const base = { wait: true, task: 'Disputed point', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, taskId: 'fixed-task', maxRounds: 2 };
    const r1 = await s.call('codex_peer', base);
    assert.equal(r1.isError, undefined);

    const r2 = await s.call('codex_peer', base);
    assert.equal(r2.isError, undefined);

    const r3 = await s.call('codex_peer', base);
    assert.equal(r3.isError, true);
    assert.match(textOf(r3), /ROUNDS_EXHAUSTED/);
  });
});

test('maxRounds is capped no matter what the caller asks for', async () => {
  const { ws } = setup({ git: false });
  const { openRound } = await import('../src/state.mjs');
  process.env.MAGI_HOME = join(ws, 'home-cap');
  const rec = openRound({ taskId: 'cap-task', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 1, maxRounds: 99 });
  assert.equal(rec.maxRounds, 12);
  // A later round may raise the cap (the argument still has evidence in it), never lower it.
  const { recordReply } = await import('../src/state.mjs');
  const small = openRound({ taskId: 'raise-task', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 1, maxRounds: 2 });
  assert.equal(small.maxRounds, 2);
  recordReply({ taskId: 'raise-task', from: 'codex', round: 1 });
  assert.equal(openRound({ taskId: 'raise-task', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 2, maxRounds: 1 }).maxRounds, 2, 'not lowered');
  recordReply({ taskId: 'raise-task', from: 'codex', round: 2 });
  assert.throws(() => openRound({ taskId: 'raise-task', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 3, maxRounds: 2 }), (e) => e.code === 'ROUNDS_EXHAUSTED' && /Pass maxRounds up to 12/.test(e.message));
  assert.equal(openRound({ taskId: 'raise-task', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 3, maxRounds: 6 }).maxRounds, 6, 'raised on the round that needed it');
});

// 8. Timeouts are handled cleanly.
test('a hung peer times out instead of hanging the tool call', async () => {
  const { ws, paths, env } = setup({ scenario: 'hang' });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const started = Date.now();
    const res = await s.call('codex_peer', {
      wait: true,
      task: 'Review',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      timeoutMs: 2000,
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /TIMEOUT/);
    assert.ok(Date.now() - started < 30000, 'should give up promptly');
  });
});

// 9. Authentication failures produce actionable errors.
test('an unauthenticated peer produces an actionable error', async () => {
  const { ws, paths, env } = setup({ scenario: 'auth' });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /AUTH_REQUIRED/);
    assert.match(textOf(res), /codex login/);
  });
});

// 10. Missing executables produce actionable errors.
test('a missing executable names the fix', async () => {
  const { ws, env } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: join(ws, 'nope', 'codex.exe') } }, async (s) => {
    const res = await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /CLI_NOT_FOUND/);
    assert.match(textOf(res), /CODEX_BIN/);
  });
});

// 11. Malformed peer output is tolerated.
for (const scenario of ['garbage', 'empty']) {
  test(`malformed peer output (${scenario}) does not throw`, async () => {
    const { ws, paths, env } = setup({ scenario });
    await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
      const res = await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
      assert.ok(typeof textOf(res) === 'string' && textOf(res).length > 0);
    });
  });
}

// 12. Large output is bounded.
test('a very large reply is truncated rather than returned whole', async () => {
  const { ws, paths, env } = setup({ scenario: 'huge' });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
    const t = textOf(res);
    assert.ok(t.length < 120000, `expected truncation, got ${t.length} chars`);
    assert.match(t, /truncated by magi/);
  });
});

test('a flooding peer is stopped at the stdout cap', async () => {
  const { ws, paths, env } = setup({ scenario: 'flood' });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', {
      wait: true,
      task: 'Review',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      timeoutMs: 60000,
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /OUTPUT_TOO_LARGE/);
  });
});

// 13. Paths containing spaces work.
test('workspace and binary paths containing spaces round-trip', async () => {
  const { ws, paths, env, logFile } = setup();
  assert.ok(ws.includes(' '), 'the fixture workspace should contain a space');
  assert.ok(paths.codex.includes(' '), 'the fixture bin dir should contain a space');
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
    assert.equal(res.isError, undefined);
  });
  const call = readCalls(logFile)[0];
  assert.equal(call.cwd, ws);
  assert.match(call.stdin, new RegExp(ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// 14. Platform differences.
test('the platform-specific fake CLI mechanism works here', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  });
  const call = readCalls(logFile)[0];
  assert.equal(call.name, 'codex');
  assert.deepEqual(call.args.slice(0, 3), ['app-server', '--listen', 'stdio://'], `${isWin ? 'windows' : 'posix'} argv should start at the subcommand`);
});

// 15. Fact-check distinguishes verified from unverified.
test('fact-check claims keep their verdicts and default to unverified', async () => {
  const { parseClaims } = await import('../src/protocol.mjs');
  const rows = parseClaims(
    ['- The API shipped in v2, VERIFIED, source: release notes', '- It is the fastest, MISLEADING, source: benchmark', '- Rewritten in Rust, FALSE', '- Ships next year', '- Unknown status, BANANAS'].join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => r.verdict),
    ['VERIFIED', 'MISLEADING', 'FALSE', 'UNVERIFIED', 'UNVERIFIED'],
  );
});

test('fact-check mode asks for a CLAIMS section', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', { wait: true, task: 'Check these claims', mode: 'FACT_CHECK', delivery: 'headless', workingDirectory: ws });
  });
  assert.match(readCalls(logFile)[0].stdin, /CLAIMS/);
  assert.match(readCalls(logFile)[0].stdin, /VERIFIED \/ FALSE \/ MISLEADING \/ UNVERIFIED/);
});

// 16. The independent first pass is preserved.
test('independence=false engages the orchestrator position, round 2 carries counterparty claims', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', {
      wait: true,
      task: 'Disputed point',
      mode: 'SECOND_OPINION',
      delivery: 'headless',
      workingDirectory: ws,
      independence: false,
      counterpartyClaims: 'Claude says the lock is unnecessary because the map is per-thread.',
    });
  });
  const { stdin } = readCalls(logFile)[0];
  assert.match(stdin, /COUNTERPARTY CLAIMS/);
  assert.match(stdin, /per-thread/);
  assert.doesNotMatch(stdin, /Reach your own conclusion first/);
});

// 17. Reconciliation support: the diff hash pins the artifact under review.
test('the diff hash changes when the code changes', async () => {
  const { repoSnapshot } = await import('../src/protocol.mjs');
  const ws = makeWorkspace();
  initGitRepo(ws);
  const before = repoSnapshot(ws, 'HEAD~1..HEAD').diffSha256;
  writeFileSync(join(ws, 'a.txt'), 'three\n');
  const worktree = repoSnapshot(ws, 'worktree').diffSha256;
  assert.ok(before && worktree);
  assert.notEqual(before, worktree, 'a changed working tree must not hash to the reviewed diff');
});

test('secrets are redacted before anything leaves the orchestrator', async () => {
  const { ws, paths, env, logFile } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    await s.call('codex_peer', {
      wait: true,
      task: 'Review the config',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      context: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456 and password=hunter2',
    });
  });
  const { stdin } = readCalls(logFile)[0];
  assert.doesNotMatch(stdin, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(stdin, /hunter2/);
  assert.match(stdin, /REDACTED/);
});

test('a reply cannot be filed against a task that was never opened', async () => {
  const { ws, paths, env } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { kind: 'reply', taskId: 'never-existed', body: 'SUMMARY\nhi' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /UNKNOWN_TASK/);
  });
});

test('a request without a task is rejected', async () => {
  const { ws, paths, env } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /BAD_REQUEST/);
  });
});

test('delegation supports blocking headless calls', async () => {
  const { ws, paths, env } = setup();
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', {
      wait: true,
      task: 'Take the tests',
      mode: 'DELEGATE',
      delivery: 'headless',
      workingDirectory: ws,
      allowWrites: true,
    });
    assert.equal(res.isError, undefined);
  });
});

// `codex exec` refused to run outside a git repository without
// --skip-git-repo-check; the app-server worker has no such check to skip.
test('non-git directories still work', async () => {
  const { ws, paths, env } = setup({ git: false });
  await withServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } }, async (s) => {
    const res = await s.call('codex_peer', { wait: true, task: 'Explain this', mode: 'SECOND_OPINION', delivery: 'headless', workingDirectory: ws });
    assert.equal(res.isError, undefined);
  });
});
