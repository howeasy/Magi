import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { makeWorkspace } from './helpers/harness.mjs';
import { runHeadless } from '../src/serve.mjs';
import { makeEngine } from '../src/peer.mjs';
import { database } from '../src/store.mjs';
import { listWorkers, readTask, listMail } from '../src/state.mjs';


async function writerLock(home) {
  const source = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(join(home, 'magi.db'))}); db.exec('BEGIN IMMEDIATE'); console.log('locked'); process.stdin.once('data',()=>{db.exec('COMMIT'); db.close();});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await once(child.stdout, 'data');
  return async () => { const closed = once(child, 'close'); child.stdin.end('release'); await closed; };
}

function workspace() {
  const cwd = makeWorkspace('store execution');
  process.env.MAGI_HOME = join(cwd, 'state');
  database(process.env.MAGI_HOME);
  return cwd;
}

const adapter = (args, parse = (text) => ({ message: text.trim(), errors: [] })) => ({ peer: 'omp', headless: { bin: 'node', args: () => args, parse } });

test('headless worker registration retries a competing writer before running the peer', async () => {
  const cwd = workspace();
  const release = await writerLock(process.env.MAGI_HOME);
  const released = new Promise((resolve) => setTimeout(async () => { await release(); resolve(); }, 120));
  try {
    const result = await runHeadless(adapter(['-e', "console.log('completed answer')"]), { cwd, taskId: 'register-busy', round: 1, text: '', timeoutMs: 2000 });
    assert.equal(result.inlineReply, 'completed answer');
    await released;
    assert.deepEqual(listWorkers(), []);
  } finally { await released; }
});

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'expected observable state transition before deadline');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('headless cleanup retries contention without dropping the completed answer', async () => {
  const cwd = workspace();
  const ready = join(cwd, 'peer-ready');
  const proceed = join(cwd, 'peer-proceed');
  const source = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){clearInterval(timer); console.log('completed under contention');}},10);`;
  const pending = runHeadless(adapter(['-e', source]), { cwd, taskId: 'cleanup-busy', round: 1, text: '', timeoutMs: 3000 });
  // Attach before forcing failure so the failing-first run has no unhandled rejection.
  const observed = pending.then((value) => ({ value }), (error) => ({ error }));
  await until(() => existsSync(ready));
  const release = await writerLock(process.env.MAGI_HOME);
  writeFileSync(proceed, 'continue');
  const released = new Promise((resolve) => setTimeout(async () => { await release(); resolve(); }, 200));
  const result = await observed;
  await released;
  assert.equal(result.error, undefined, 'worker cleanup must not discard successful CLI output');
  assert.equal(result.value.inlineReply, 'completed under contention');
  assert.deepEqual(listWorkers(), []);
});

test('a permanent worker cleanup failure preserves the parsed answer and reports repair guidance', async () => {
  const cwd = workspace();
  database(process.env.MAGI_HOME).exec("CREATE TRIGGER reject_worker_cleanup BEFORE DELETE ON records WHEN OLD.namespace='workers' BEGIN SELECT RAISE(ABORT,'worker cleanup rejected'); END;");
  const diagnostics = [];
  const error = console.error;
  console.error = (...args) => diagnostics.push(args.join(' '));
  try {
    const result = await runHeadless(adapter(['-e', "console.log('answer survives cleanup failure')"]), { cwd, taskId: 'cleanup-failed', round: 1, text: '', timeoutMs: 2000 });
    assert.equal(result.inlineReply, 'answer survives cleanup failure');
    assert.match(diagnostics.join('\\n'), /WORKER_CLEANUP_FAILED.*cleanup-failed.*sweep/s);
  } finally {
    console.error = error;
    database(process.env.MAGI_HOME).exec('DROP TRIGGER reject_worker_cleanup');
  }
});

test('a failed background reply commit surfaces the completed answer and ledger failure', async () => {
  const cwd = workspace();
  const delivered = [];
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  database(process.env.MAGI_HOME).exec("CREATE TEMP TRIGGER reject_background_reply BEFORE UPDATE ON records WHEN NEW.namespace='tasks' AND json_extract(NEW.value,'$.rounds[0].replied')=1 BEGIN SELECT RAISE(ABORT,'reply ledger rejected'); END;");
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: (options) => runHeadless(adapter(['-e', "console.log('completed answer remains available')"]), options),
    deliverReply: async ({ text }) => { delivered.push(text); },
  });
  try {
    await engine.handleRequest({ taskId: 'background-commit', task: 'inspect', wait: false, workingDirectory: cwd, timeoutMs: 2000 });
    await until(() => delivered.length === 1);
    assert.match(delivered[0], /reply ledger rejected/);
    assert.match(delivered[0], /completed answer remains available/);
    assert.match(delivered[0], /ERR_SQLITE_ERROR/);
    assert.match(delivered[0], /magi log/);
    assert.equal(readTask('background-commit').rounds[0].replied, false);
    assert.deepEqual(listMail('background-commit'), []);
  } finally {
    console.error = error;
    database(process.env.MAGI_HOME).exec('DROP TRIGGER reject_background_reply');
  }
});

test('a failed background close commit reports both failures without claiming the round closed', async () => {
  const cwd = workspace();
  const delivered = [];
  const error = console.error;
  console.error = () => {};
  database(process.env.MAGI_HOME).exec("CREATE TEMP TRIGGER reject_background_close BEFORE UPDATE ON records WHEN NEW.namespace='tasks' AND json_extract(NEW.value,'$.rounds[0].closedAt') IS NOT NULL BEGIN SELECT RAISE(ABORT,'close ledger rejected'); END;");
  const engine = makeEngine({
    orchestrator: 'codex', peerName: 'claude',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: (options) => runHeadless(adapter(['-e', "console.error('actual peer failed');process.exit(7)"]), options),
    deliverReply: async ({ text }) => { delivered.push(text); },
  });
  try {
    await engine.handleRequest({ taskId: 'background-close', task: 'inspect', wait: false, workingDirectory: cwd, timeoutMs: 2000 });
    await until(() => delivered.length === 1);
    assert.match(delivered[0], /close ledger rejected/);
    assert.match(delivered[0], /actual peer failed/);
    assert.match(delivered[0], /ERR_SQLITE_ERROR/);
    assert.doesNotMatch(delivered[0], /round is closed/i);
    assert.equal(readTask('background-close').rounds[0].closedAt, undefined);
  } finally {
    console.error = error;
    database(process.env.MAGI_HOME).exec('DROP TRIGGER reject_background_close');
  }
});
