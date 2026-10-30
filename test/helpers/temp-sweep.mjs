// Removes what test runs left in the system temp folder. Shared by
// isolated-home.mjs (every test process, at start) and `npm test`'s posttest
// step (after the suite, when no test process holds a file any more).
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A test process's temp root: `magi-test-run-<pid>-<random>`. */
export const RUN_PREFIX = 'magi-test-run-';

/**
 * Where test roots go. On macOS the system temp is under `/var`, a link to
 * `/private/var`: a path a test builds and the same path as git, realpath or
 * a spawned process reports it then differ. It is also long enough that a
 * Unix socket in a test folder passes the 104-byte limit and is cut short,
 * so two tests' sockets collide. `/private/tmp` is resolved already and
 * short. Elsewhere the system temp as it is.
 */
export const testTempBase = () => (process.platform === 'darwin' ? '/private/tmp' : tmpdir());
const RUN = /^magi-test-run-(\d+)-/;
// Names the suite used before it kept to one root per process. No pid to
// ask, so they go once two hours old: no run takes that long.
const LEGACY = /^(cx-|magi-test-home-|magi-confirm-|magi-codex-confirm-|magi-store-|magi-sandbox-profile-|magi-decoy-profile-|magi-identity-state-|magi-auto-|magi-test-run-(?!\d+-))/;
const LEGACY_STALE_MS = 2 * 60 * 60 * 1000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // it exists, it is just not ours to signal
  }
};

/** Removes the roots of test processes that have ended, and stale legacy folders. Never throws. */
export function sweepTemp(dir = testTempBase()) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    const run = RUN.exec(name);
    const path = join(dir, name);
    try {
      if (run ? !alive(Number(run[1])) : LEGACY.test(name) && now - statSync(path).mtimeMs > LEGACY_STALE_MS) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch { /* a file still held open; the next sweep retries */ }
  }
  return removed;
}

// `node test/helpers/temp-sweep.mjs`: the posttest step.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) sweepTemp();
