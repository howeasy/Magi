// Magi keeps the system temp folder clean by itself: the suite writes under
// one root per run, and a server start removes Magi's own temp leftovers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sweepTemp } from './helpers/temp-sweep.mjs';

const state = await import('../src/state.mjs');

test('every temporary folder a test makes lands under this process\'s own root, named for its pid', () => {
  // isolated-home.mjs points TMP/TEMP/TMPDIR at magi-test-run-<pid>-*.
  assert.match(basename(tmpdir()), new RegExp(`^magi-test-run-${process.pid}-`), tmpdir());
  assert.ok(process.env.MAGI_HOME.startsWith(tmpdir()), 'the isolated home is inside it too');
});

test('the sweep removes the roots of ended test processes, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const ended = join(dir, 'magi-test-run-999999999-abc');
  const running = join(dir, `magi-test-run-${process.pid}-def`);
  // Names another program may own, however old: a short prefix proves nothing.
  const others = ['cx-old123', 'cx-freeze-build', 'magi-store-backup', 'magi-auto-save', 'magi-test-run-notapid', 'someone-else'].map((name) => join(dir, name));
  for (const path of [ended, running, ...others]) mkdirSync(join(path, 'inside'), { recursive: true });
  writeFileSync(join(dir, 'cx-notes.txt'), 'kept');
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  for (const path of [...others, join(dir, 'cx-notes.txt')]) utimesSync(path, twoDaysAgo, twoDaysAgo);

  assert.equal(sweepTemp(dir), 1);
  assert.deepEqual(readdirSync(dir).sort(), [basename(running), ...others.map((p) => basename(p)), 'cx-notes.txt'].sort());
});

test('a server start removes Magi\'s own temp leftovers older than a day and keeps newer ones and others', async () => {
  const day = 86400000;
  const old = (path) => utimesSync(path, new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day));
  const staleIndex = join(tmpdir(), 'magi-index-0badc0de');
  const staleRegister = join(tmpdir(), 'magi-register-AbC123');
  const freshIndex = join(tmpdir(), 'magi-index-feedface');
  const someoneElse = join(tmpdir(), 'not-magi-index-1234');
  writeFileSync(staleIndex, 'x');
  mkdirSync(join(staleRegister, 'nested'), { recursive: true });
  writeFileSync(join(staleRegister, 'nested', '.claude.json'), '{}');
  writeFileSync(freshIndex, 'x');
  writeFileSync(someoneElse, 'x');
  old(staleIndex);
  old(staleRegister);
  old(someoneElse);

  await state.sweep();

  assert.equal(existsSync(staleIndex), false, 'a stale index file is removed');
  assert.equal(existsSync(staleRegister), false, 'a stale register folder is removed, contents and all');
  assert.equal(existsSync(freshIndex), true, 'a fresh one may belong to a running snapshot');
  assert.equal(existsSync(someoneElse), true, 'only names Magi makes');
});
