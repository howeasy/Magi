// A bake-off pins two implementations of one task and asks for a blind verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { makeWorkspace, textOf, initGitRepo } from './helpers/harness.mjs';
import { makeEngine } from '../src/peer.mjs';
import { getRecord } from '../src/store.mjs';

test('a bake-off diffs both worktrees against the base, untracked and committed alike, and labels them without authorship', async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const git = (args, cwd = ws) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  const base = git(['rev-parse', 'HEAD']);
  const a = join(ws, 'bake-a');
  const b = join(ws, 'bake-b');
  git(['worktree', 'add', '-q', a, '-b', 'bake/a']);
  git(['worktree', 'add', '-q', b, '-b', 'bake/b']);
  // A: an uncommitted edit plus a brand-new untracked file.
  writeFileSync(join(a, 'a.txt'), 'three\n');
  writeFileSync(join(a, 'impl.txt'), 'implementation a\n');
  // B: the same task, committed.
  writeFileSync(join(b, 'a.txt'), 'THREE\n');
  git(['add', '-A'], b);
  git(['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'impl b'], b);

  process.env.MAGI_HOME = join(ws, 'isolated-home');
  let stdin;
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async ({ text }) => {
      stdin = text;
      return { inlineReply: 'SUMMARY\nBoth implementations inspected.\n\nVERDICT\nB', via: 'headless' };
    },
  });
  const missing = await engine.handleRequest({ wait: true, task: 'Judge', mode: 'BAKEOFF', delivery: 'headless', workingDirectory: ws });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /BAD_REQUEST.*bakeoff/);
  const res = await engine.handleRequest({ wait: true, task: 'Make a.txt say three', mode: 'BAKEOFF', delivery: 'headless', workingDirectory: ws, bakeoff: { a, b, base } });
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(stdin, /mode=BAKEOFF/);
  assert.match(stdin, /Authorship is deliberately withheld/);
  const A = stdin.slice(stdin.indexOf('IMPLEMENTATION A'), stdin.indexOf('IMPLEMENTATION B'));
  const B = stdin.slice(stdin.indexOf('IMPLEMENTATION B'), stdin.indexOf('INDEPENDENCE'));
  assert.match(A, /\+three/);
  assert.match(A, /impl\.txt/, 'untracked files are part of implementation A');
  assert.match(B, /\+THREE/, 'a committed implementation is diffed against the base, not against its own HEAD');
  const shaA = /diff sha256: ([0-9a-f]{64})/.exec(A)[1];
  const shaB = /diff sha256: ([0-9a-f]{64})/.exec(B)[1];
  assert.notEqual(shaA, shaB);
  assert.match(stdin, /VERDICT - A, B, or a combination/);

  assert.deepEqual(res.structuredContent.bakeoff.map((c) => [c.label, c.diffSha256]), [['A', shaA], ['B', shaB]]);
  assert.match(textOf(res), new RegExp(`bakeoff=A:${shaA.slice(0, 12)},B:${shaB.slice(0, 12)}`));
  const rec = getRecord(process.env.MAGI_HOME, 'tasks', res.structuredContent.taskId);
  assert.deepEqual(rec.rounds[0].snapshot.contestants.map((c) => c.diffSha256), [shaA, shaB]);
});

test('a VERDICT section is parsed like the others', async () => {
  const { parseReply, outputSections } = await import('../src/protocol.mjs');
  const p = parseReply('SUMMARY\nboth work\n\nVERDICT\nB, because A misses the empty case (a.txt:1).\n');
  assert.equal(p.verdict, 'B, because A misses the empty case (a.txt:1).');
  assert.ok(outputSections('BAKEOFF').some((s) => s.startsWith('VERDICT')));
  assert.ok(!outputSections('REVIEW').some((s) => s.startsWith('VERDICT')));
});
