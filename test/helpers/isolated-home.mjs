import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_PREFIX, sweepTemp, testTempBase } from './temp-sweep.mjs';

// --import runs in each test file's process (NODE_TEST_CONTEXT=child-v8),
// not in the runner.

// Every temporary folder a test makes lands in one root per process: TMP,
// TEMP and TMPDIR point into it, so os.tmpdir() (makeWorkspace, a test's own
// mkdtemp, a spawned fake CLI) writes there. The root is named for this
// process, so any later sweep can tell it is finished once the process is
// gone: at exit it removes itself when nothing holds a file in it (on Windows
// this process's own open magi.db can), and the next test process to start,
// or `npm test`'s posttest step, removes what is left. Before this, each run
// left a few thousand folders in the system temp; 2026-10-12 found 87,000.
const systemTmp = testTempBase();
sweepTemp(systemTmp);
const root = mkdtempSync(join(systemTmp, `${RUN_PREFIX}${process.pid}-`));
for (const name of ['TMP', 'TEMP', 'TMPDIR']) process.env[name] = root;
process.on('exit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* swept once this process is gone */ }
});

const home = mkdtempSync(join(root, 'magi-test-home-'));
const appData = join(home, 'AppData', 'Roaming');
const dirs = {
  MAGI_HOME: home,
  MAGI_TEST_HOME: home,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'),
  OMP_AGENT_DIR: join(home, '.omp', 'agent'),
  CLAUDE_APP_SESSIONS_DIR: join(appData, 'Claude', 'claude-code-sessions'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, dirs);
