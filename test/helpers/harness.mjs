// Test harness: fake CLIs plus an in-process MCP client for either server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, linkSync, copyFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const isWin = platform() === 'win32';
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = join(ROOT, 'test', 'helpers', 'fake-cli.cjs');

// Deliberately contains a space: path handling is a documented requirement.
export function makeWorkspace(label = 'magi test') {
  const base = mkdtempSync(join(tmpdir(), 'cx-'));
  const dir = join(base, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Node cannot spawn .cmd shims without a shell, so on Windows we hardlink
// node.exe under the CLI's name and dispatch inside a --require preload.
// A .cmd shim on Windows (the shape npm-installed CLIs actually take) and a
// shell script elsewhere. Both just name themselves and hand off to fake-cli.
export function makeFakeBins(dir, names = ['codex', 'claude']) {
  const bin = join(dir, 'bin dir');
  mkdirSync(bin, { recursive: true });
  const paths = {};
  for (const n of names) {
    if (isWin) {
      const p = join(bin, `${n}.cmd`);
      writeFileSync(p, ['@echo off', `set FAKE_CLI_NAME=${n}`, `"${process.execPath}" "${FAKE}" %*`, ''].join('\r\n'));
      paths[n] = p;
    } else {
      const p = join(bin, n);
      writeFileSync(p, `#!/bin/sh\nFAKE_CLI_NAME=${n} exec "${process.execPath}" "${FAKE}" "$@"\n`);
      chmodSync(p, 0o755);
      paths[n] = p;
    }
  }
  return { bin, paths };
}

export function fakeEnv(dir, { scenario = 'ok', log } = {}) {
  const logFile = log ?? join(dir, 'calls.jsonl');
  const env = {
    FAKE_CLI_SCENARIO: scenario,
    FAKE_CLI_LOG: logFile,
    MAGI_HOME: join(dir, 'magi-home'),
    // No real session is reachable from a test: a background reply routed to
    // a real registry entry lands in someone's live session.
    CLAUDE_CONFIG_DIR: join(dir, 'claude-cfg'),
    CLAUDE_APP_SESSIONS_DIR: join(dir, 'claude-app'),
    CODEX_HOME: join(dir, 'codex-home'),
    // The suite may itself be running inside a Claude session; a server that
    // inherits its inbox socket would route test replies into it.
    CLAUDE_CODE_MESSAGING_SOCKET: '',
    CLAUDE_CODE_MESSAGING_TOKEN: '',
  };
  return { env, logFile };
}

export function readCalls(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// `which` may name several peers ("codex omp"); a combined server needs `as`.
export async function startServer(which, { env = {}, cwd, as } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin', 'magi.mjs'), 'serve', ...which.split(' '), ...(as ? ['--as', as] : [])],
    cwd,
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'magi-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    // The SDK client aborts at 60s by default, which is shorter than a real
    // peer call; progress notifications also push the deadline out.
    async call(name, args, { timeout = 1800000 } = {}) {
      return client.callTool({ name, arguments: args }, undefined, {
        timeout,
        maxTotalTimeout: timeout,
        resetTimeoutOnProgress: true,
      });
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* already down */
      }
    },
  };
}

export function textOf(res) {
  return (res?.content ?? []).map((c) => c.text ?? '').join('\n');
}

export function initGitRepo(dir) {
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Magi Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'first']);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  run(['add', '-A']);
  run(['commit', '-qm', 'second']);
  return dir;
}
