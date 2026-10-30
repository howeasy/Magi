// A launch wrapper for tests (MAGI_WORKER_WRAPPER = [node, this file, ...]):
// records the argv and MAGI_WORKER_* variables it was given in
// STUB_WRAPPER_LOG, then runs the command after `--` on the same stdio and
// exits with its code, as a real sandbox wrapper would.
import { appendFileSync } from 'node:fs';
import { spawnFile } from '../../src/exec.mjs';

const at = process.argv.indexOf('--');
const own = process.argv.slice(2, at);
const rest = process.argv.slice(at + 1);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MAGI_WORKER_')));
appendFileSync(process.env.STUB_WRAPPER_LOG, `${JSON.stringify({ pid: process.pid, own, sawSeparator: at >= 0, rest, env })}\n`);

const child = spawnFile(rest[0], rest.slice(1), { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`stub wrapper: ${error.message}`);
  process.exit(127);
});
child.on('exit', (code) => process.exit(code ?? 1));
