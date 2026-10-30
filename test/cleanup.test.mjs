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

test('the sweep removes the roots of ended test processes and stale legacy folders, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const ended = join(dir, 'magi-test-run-999999999-abc');
  const running = join(dir, `magi-test-run-${process.pid}-def`);
  const legacyOld = join(dir, 'cx-old123');
  const legacyNew = join(dir, 'cx-new456');
  const other = join(dir, 'someone-else');
  for (const path of [ended, running, legacyOld, legacyNew, other]) mkdirSync(join(path, 'inside'), { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  for (const path of [legacyOld, other]) utimesSync(path, twoDaysAgo, twoDaysAgo);

  assert.equal(sweepTemp(dir), 2);
  assert.deepEqual(readdirSync(dir).sort(), [basename(running), basename(legacyNew), basename(other)].sort());
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
