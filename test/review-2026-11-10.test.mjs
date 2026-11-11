// Five findings from the 2026-11-10 review: a headless
// fallback's reply comes home, a diffRef is never a git option, an
// omp-orchestrated card names a tool its worker can use, a run that exited is
// not held open by a descendant's pipe, and an unreadable birth time does not
// delete a live session's registry row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

import { makeWorkspace, initGitRepo, textOf } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { repoSnapshot, optionShapedRef } from '../src/protocol.mjs';
import { setEmbedder } from '../src/embeddings.mjs';
import { runCli } from '../src/exec.mjs';
import { getRecord, setRecord } from '../src/store.mjs';
import * as state from '../src/state.mjs';
import { processStartedAt } from '../omp/process-identity.js';

function engineFor(t, overrides = {}) {
  setEmbedder(null);
  const saved = { MAGI_AS: process.env.MAGI_AS, PEER_DEPTH: process.env.PEER_DEPTH };
  Object.assign(process.env, { MAGI_AS: 'claude', PEER_DEPTH: '0' });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const cwd = makeWorkspace('review 1110');
  const owner = { agent: 'claude', id: 'owner', sessionId: 'owner', cwd };
  const worker = { agent: 'codex', id: 'worker', sessionId: 'worker', cwd };
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    resolveOrigin: async () => ({ target: owner, identityVerified: true }),
    pickDelivery: async () => ({ mode: 'live', target: worker }),
    deliverLive: async () => ({ via: 'live', deliveryStatus: 'queued_unread' }),
    deliverReply: async () => ({ via: 'live', deliveryStatus: 'queued_unread' }),
    ...overrides,
  });
  return { cwd, engine };
}

test('a blocking-by-default request that falls back to headless still gets its reply sent home', async (t) => {
  const home = [];
  const { cwd, engine } = engineFor(t, {
    deliverLive: async () => { throw Object.assign(new Error('socket gone'), { code: 'NO_LIVE_PEER', fallback: true, dispatchUncertain: false }); },
    deliverHeadless: async () => { await new Promise((r) => setTimeout(r, 50)); return { inlineReply: 'SUMMARY\nheadless answer', via: 'headless', threadId: 'th-1' }; },
    deliverReply: async (o) => { home.push(o.text); return { via: 'live', deliveryStatus: 'queued_unread' }; },
  });
  // REVIEW waits by default; `wait` is left unset, so the fallback runs in the background.
  const res = await engine.handleRequest({ task: 'Review the thing', mode: 'REVIEW', workingDirectory: cwd });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(res.structuredContent.via, 'headless');
  assert.equal(res.structuredContent.waiting, false);
  const { taskId } = res.structuredContent;
  assert.equal(state.isWaiting(taskId, 1), false, 'the live attempt\'s waiter is released');
  for (let i = 0; i < 100 && !home.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(home.length, 1, 'the background reply is delivered to the orchestrator');
  assert.match(home[0], /^PEER REPLY magi\/1 task_id=/);
  assert.ok(state.listMail(taskId).every((m) => m.delivered), 'and marked delivered in the mailbox');
});

test('a diffRef shaped like a git option is refused and never reaches git as one', async (t) => {
  assert.equal(optionShapedRef('--output=x'), true);
  assert.equal(optionShapedRef('-O'), true);
  for (const ok of ['--staged', '--cached', 'staged', 'worktree', 'HEAD~1..HEAD', '', undefined]) assert.equal(optionShapedRef(ok), false, String(ok));

  const { cwd, engine } = engineFor(t);
  initGitRepo(cwd);
  writeFileSync(join(cwd, 'a.txt'), 'three\n');
  const target = join(cwd, '..', 'written-by-git.txt');
  const res = await engine.handleRequest({ task: 'Review', mode: 'REVIEW', wait: false, workingDirectory: cwd, diffRef: `--output=${target}` });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /BAD_REQUEST: diffRef .* looks like a git option/);
  assert.equal(existsSync(target), false);

  // The second guard, for a caller that reaches the snapshot directly.
  const snap = repoSnapshot(cwd, `--output=${target}`);
  assert.equal(existsSync(target), false, 'git read it as a revision, not as --output');
  assert.equal(snap.diffSha256, null, 'and pinned nothing rather than the hash of an empty diff');
  assert.match(repoSnapshot(cwd, 'HEAD~1..HEAD').diffSha256, /^[0-9a-f]{64}$/, 'a real range still pins');
  assert.match(repoSnapshot(cwd, 'worktree').diffBody, /three/);
});

test('an omp-orchestrated card names omp_peer to a Claude or Codex worker', async () => {
  const { adapter: claude } = await import('../src/claude-adapter.mjs');
  const { adapter: codex } = await import('../src/codex-adapter.mjs');
  // The worker's server refuses a card note on any tool but the orchestrator's (CARD_FIXED).
  assert.equal(claude.replyTool('omp'), 'omp_peer');
  assert.equal(codex.replyTool('omp'), 'omp_peer');
  assert.equal(claude.replyTool('codex'), 'codex_peer');
  assert.equal(codex.replyTool('claude'), 'claude_peer');
});

test('runCli settles on exit even while a descendant keeps the output pipe open', async () => {
  const ws = makeWorkspace('orphan pipe');
  const fake = join(ws, 'fake-orphan.cjs');
  // top prints and exits 0; its grandchild, outside its process tree by then,
  // holds the inherited stdout and stderr for 12 s.
  writeFileSync(fake, [
    "const { spawn } = require('node:child_process');",
    "const role = process.env.FAKE_ROLE || 'top';",
    "const next = (r, o) => spawn(process.execPath, [__filename], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, FAKE_ROLE: r }, ...o });",
    "if (role === 'top') { next('middle', {}); process.stdout.write('Queued message m1 for thread t1.\\n'); setTimeout(() => process.exit(0), 400); }",
    "else if (role === 'middle') { next('holder', { detached: true }).unref(); setTimeout(() => process.exit(0), 200); }",
    'else setTimeout(() => process.exit(0), 12000);',
  ].join('\n'));
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fake;
  try {
    const t0 = Date.now();
    const res = await runCli('codex', ['queue'], { timeoutMs: 8000 });
    assert.equal(res.exitCode, 0, 'a run that exited 0 is not reported as a timeout');
    assert.match(res.stdout, /Queued message m1/);
    assert.ok(Date.now() - t0 < 7000, `settled in ${Date.now() - t0} ms`);
  } finally {
    if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved;
  }
});

// On Linux the birth time is read from /proc and cannot be made to fail from here.
test('a birth time that cannot be read leaves a live session\'s registry row in place', { skip: process.platform === 'linux' }, async () => {
  const { listAgentSessions } = await import('../src/transport.mjs');
  const home = state.magiHome();
  const key = `unreadable-${process.pid}`;
  setRecord(home, 'agents', key, { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'sess-unreadable', name: 'held', cwd: process.cwd(), startedAt: Date.now() });
  assert.ok(listAgentSessions('omp').some((s) => s.sessionId === 'sess-unreadable'), 'listed while its birth time reads');
  const saved = process.env.PATH;
  process.env.PATH = ''; // powershell.exe / ps cannot be found: the read fails, as it does on a timeout
  try {
    assert.equal(listAgentSessions('omp').some((s) => s.sessionId === 'sess-unreadable'), false, 'unverified, so not offered as a route');
  } finally {
    process.env.PATH = saved;
  }
  assert.ok(getRecord(home, 'agents', key), 'but its row is kept');
  assert.ok(listAgentSessions('omp').some((s) => s.sessionId === 'sess-unreadable'), 'and it is listed again once the read works');
  // A row whose process is gone is still removed.
  setRecord(home, 'agents', 'gone', { agent: 'omp', pid: 2 ** 22 + 12345, processStartedAt: 'win32:1', sessionId: 'sess-gone' });
  listAgentSessions('omp');
  assert.equal(getRecord(home, 'agents', 'gone'), null);
});
