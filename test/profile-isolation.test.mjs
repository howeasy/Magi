import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

test('isolation preload hides inherited profile records from configuration consumers', () => {
  const decoy = mkdtempSync(join(tmpdir(), 'magi-decoy-profile-'));
  const dirs = {
    HOME: decoy,
    USERPROFILE: decoy,
    APPDATA: join(decoy, 'AppData', 'Roaming'),
    MAGI_HOME: join(decoy, '.magi'),
    MAGI_TEST_HOME: join(decoy, '.magi'),
    CLAUDE_CONFIG_DIR: join(decoy, '.claude'),
    CODEX_HOME: join(decoy, '.codex'),
    OMP_AGENT_DIR: join(decoy, '.omp', 'agent'),
    CLAUDE_APP_SESSIONS_DIR: join(decoy, 'explicit-app-sessions'),
  };
  const put = (dir, name, value) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), value);
  };
  try {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    put(join(dirs.CLAUDE_CONFIG_DIR, 'sessions'), `${process.pid}.json`, JSON.stringify({
      pid: process.pid, sessionId: 'decoy-session', messagingSocketPath: 'decoy-socket',
    }));
    put(dirs.CODEX_HOME, 'config.toml', '[mcp_servers.magi]\ncommand = "decoy-command"\n');
    put(join(dirs.CLAUDE_APP_SESSIONS_DIR, 'account', 'org'), 'local_decoy.json', JSON.stringify({
      sessionId: 'decoy-app', cliSessionId: 'decoy-session',
    }));
    put(join(dirs.APPDATA, 'Claude', 'claude-code-sessions', 'account', 'org'), 'local_default.json', JSON.stringify({
      sessionId: 'decoy-default-app', cliSessionId: 'decoy-default-session',
    }));
    const transportUrl = new URL('../src/transport.mjs', import.meta.url).href;
    const stateUrl = new URL('../src/state.mjs', import.meta.url).href;
    const script = `
      import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
      import { homedir } from 'node:os';
      import { join } from 'node:path';
      import { listClaudeSessions, claudeAppSessionIndex, claudeTranscriptPath, codexDisableBridgeFlags } from ${JSON.stringify(transportUrl)};
      import { magiHome } from ${JSON.stringify(stateUrl)};
      const home = magiHome();
      const before = {
        sessions: listClaudeSessions().map(s => s.sessionId),
        bridges: codexDisableBridgeFlags(),
        appSessions: [...claudeAppSessionIndex()],
      };
      const put = (dir, name, value) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), value);
      };
      put(join(process.env.CLAUDE_CONFIG_DIR, 'sessions'), process.pid + '.json', JSON.stringify({
        pid: process.pid, sessionId: 'sandbox-session', messagingSocketPath: 'sandbox-socket',
      }));
      put(process.env.CODEX_HOME, 'config.toml', '[mcp_servers.magi-omp]\\ncommand = "sandbox-command"\\n');
      put(join(process.env.CLAUDE_APP_SESSIONS_DIR, 'account', 'org'), 'local_sandbox.json', JSON.stringify({
        sessionId: 'sandbox-app', cliSessionId: 'sandbox-session',
      }));
      console.log(JSON.stringify({
        home, profile: homedir(), before,
        transcript: claudeTranscriptPath({ sessionId: 'sandbox-session', cwd: home }),
        sessions: listClaudeSessions().map(s => s.sessionId),
        bridges: codexDisableBridgeFlags(),
        appSession: claudeAppSessionIndex(Date.now() + 10001).get('sandbox-session'),
      }));
      if (home !== ${JSON.stringify(dirs.MAGI_HOME)}) rmSync(home, { recursive: true, force: true });
    `;
    const child = spawnSync(process.execPath, [
      '--import', new URL('./helpers/isolated-home.mjs', import.meta.url).href,
      '--input-type=module', '-e', script,
    ], { env: { ...process.env, ...dirs, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.before, { sessions: [], bridges: [], appSessions: [] },
      'configuration consumers must not expose records from the inherited decoy profile');
    const underHome = (path) => {
      const rel = relative(result.home, path);
      return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel);
    };
    assert.notEqual(result.home, dirs.MAGI_HOME);
    assert.ok(underHome(result.profile), 'os.homedir must resolve inside the fresh temporary profile');
    assert.ok(underHome(result.transcript), 'the transport transcript path must stay inside the fresh temporary profile');
    assert.deepEqual(result.sessions, ['sandbox-session']);
    assert.deepEqual(result.bridges, ['-c', 'mcp_servers.magi-omp.enabled=false']);
    assert.equal(result.appSession, 'sandbox-app');
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
});
