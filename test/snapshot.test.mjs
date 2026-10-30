// The snapshot's tree id seeds its throwaway index from the real one, git's
// stat cache, so only changed files are re-hashed. Each case checks the id
// against the one an index built from nothing gives (read-tree HEAD, add -A):
// the speed-up must never change the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { makeWorkspace, initGitRepo } from './helpers/harness.mjs';
import { repoSnapshot } from '../src/protocol.mjs';

const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The tree an empty index gives: what the snapshot computed before seeding.
function fromScratch(cwd) {
  const env = { GIT_INDEX_FILE: join(tmpdir(), `magi-index-ref-${randomUUID().slice(0, 8)}`) };
  try {
    git(cwd, ['read-tree', 'HEAD'], env);
    git(cwd, ['add', '-A'], env);
    return git(cwd, ['write-tree'], env);
  } finally { try { unlinkSync(env.GIT_INDEX_FILE); } catch { /* never written */ } }
}

function repo(label) {
  const dir = initGitRepo(makeWorkspace(label));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'b.txt'), 'bee\n');
  writeFileSync(join(dir, 'c.txt'), 'sea\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'third']);
  return dir;
}

test('a clean tree snapshots as HEAD\'s tree, from one rev-parse', () => {
  const dir = repo('snapshot clean');
  const s = repoSnapshot(dir, 'worktree');
  assert.equal(s.treeSha, git(dir, ['rev-parse', 'HEAD^{tree}']));
  assert.equal(s.head, git(dir, ['rev-parse', 'HEAD']));
  assert.equal(s.branch, git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']));
  assert.equal(s.dirty, false);
});

test('edits, deletions, untracked files and staged-then-edited files give the tree an empty index gives', () => {
  const dir = repo('snapshot dirty');
  writeFileSync(join(dir, 'a.txt'), 'edited, unstaged\n');
  unlinkSync(join(dir, 'c.txt'));
  writeFileSync(join(dir, 'src', 'new.txt'), 'untracked\n');
  writeFileSync(join(dir, 'src', 'b.txt'), 'staged\n');
  git(dir, ['add', 'src/b.txt']);
  writeFileSync(join(dir, 'src', 'b.txt'), 'staged, then edited again\n');
  writeFileSync(join(dir, 'gone.txt'), 'added then deleted\n');
  git(dir, ['add', 'gone.txt']);
  unlinkSync(join(dir, 'gone.txt'));
  git(dir, ['rm', '-q', '--cached', 'a.txt']); // untracked again, edited on disk
  const s = repoSnapshot(dir, 'worktree');
  assert.equal(s.treeSha, fromScratch(dir));
  assert.notEqual(s.treeSha, git(dir, ['rev-parse', 'HEAD^{tree}']));
});

test('the snapshot from a subdirectory and from a linked worktree is the whole tree', () => {
  const dir = repo('snapshot sub');
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  assert.equal(repoSnapshot(join(dir, 'src'), 'worktree').treeSha, fromScratch(dir));
  const linked = join(makeWorkspace('snapshot linked'), 'wt');
  git(dir, ['worktree', 'add', '-q', linked]);
  writeFileSync(join(linked, 'c.txt'), 'edited in the linked worktree\n');
  assert.equal(repoSnapshot(linked, 'worktree').treeSha, fromScratch(linked));
});

test('an assume-unchanged or skip-worktree edit is still in the tree', () => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const dir = repo(`snapshot ${flag.slice(2)}`);
    git(dir, ['update-index', flag, 'c.txt']);
    writeFileSync(join(dir, 'c.txt'), 'edited behind the flag\n');
    const s = repoSnapshot(dir, 'worktree');
    assert.equal(s.treeSha, fromScratch(dir), flag);
    assert.notEqual(s.treeSha, git(dir, ['rev-parse', 'HEAD^{tree}']), `${flag} hides nothing from the snapshot`);
  }
});

// Guards the copy's mtime on Linux; Windows' CopyFile keeps it unasked, so
// there this passes either way.
test('a racily clean entry is re-hashed, as git would re-hash it in the real index', () => {
  const dir = repo('snapshot racy');
  const file = join(dir, 'c.txt');
  const index = git(dir, ['rev-parse', '--git-path', 'index']);
  // A whole second, so the cached stat matches exactly (git keeps 100 ns).
  const mtime = new Date('2026-01-01T00:00:00Z');
  utimesSync(file, mtime, mtime);
  git(dir, ['update-index', '--refresh']);
  // Same size, same mtime as the cached entry, and no older than the index
  // file: only the index's own timestamp tells git not to trust the stat.
  writeFileSync(file, 'SEA\n');
  utimesSync(file, mtime, mtime);
  utimesSync(join(dir, index), mtime, mtime);
  // Another git command holds the index, so status cannot rewrite (smudge)
  // it first: the copy is the racy index exactly as git left it.
  writeFileSync(join(dir, `${index}.lock`), '');
  try {
    assert.equal(repoSnapshot(dir, 'worktree').treeSha, fromScratch(dir));
  } finally { unlinkSync(join(dir, `${index}.lock`)); }
});

test('a split index is not copied; its tree is built from HEAD', () => {
  const dir = repo('snapshot split');
  git(dir, ['update-index', '--split-index']);
  const shared = () => readdirSync(join(dir, '.git')).filter((n) => n.startsWith('sharedindex.')).sort();
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  writeFileSync(join(dir, 'd.txt'), 'untracked\n');
  git(dir, ['status', '--porcelain']);
  const before = shared();
  assert.ok(before.length > 0);
  assert.equal(repoSnapshot(dir, 'worktree').treeSha, fromScratch(dir));
  assert.deepEqual(shared(), before, 'the snapshot leaves the repository\'s shared index files alone');
});

test('a repository with no index file yet still snapshots', () => {
  const dir = repo('snapshot no index');
  unlinkSync(join(dir, '.git', 'index'));
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  // git status rebuilds nothing here; every committed file reads as deleted
  // and untracked, but the tree is still the working tree.
  assert.equal(repoSnapshot(dir, 'worktree').treeSha, fromScratch(dir));
});

test('a force-added ignored file is in the tree, as it would be in the next commit', () => {
  const dir = repo('snapshot ignored');
  writeFileSync(join(dir, '.gitignore'), '*.log\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-qm', 'ignore logs']);
  writeFileSync(join(dir, 'kept.log'), 'force-added\n');
  git(dir, ['add', '-f', 'kept.log']);
  writeFileSync(join(dir, 'other.log'), 'ignored\n');
  const tree = repoSnapshot(dir, 'worktree').treeSha;
  const names = git(dir, ['ls-tree', '--name-only', tree]).split(/\r?\n/);
  assert.ok(names.includes('kept.log'));
  assert.ok(!names.includes('other.log'));
});
