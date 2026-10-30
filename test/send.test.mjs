// `magi send`: a script delivers text into a named live session, the way a
// note reaches one, and learns from the exit code whether it landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { makeWorkspace, fakeEnv, ROOT } from './helpers/harness.mjs';
import { parseClaudeEnvelope } from '../src/transport.mjs';
import { setRecord, statement } from '../src/store.mjs';
import { processStartedAt } from '../omp/process-identity.js';

const CLI = join(ROOT, 'bin', 'magi.mjs');

// Async on purpose: the fake inbox lives in this process's event loop.
function send(env, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'send', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

// A registered Claude session with a socket inbox. With `record`, the inbox
// also writes the transcript line Claude writes for an accepted peer message.
async function claudeSession(ws, env, { name = 'worker-1', pid = process.pid, record = true } = {}) {
  const config = env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(config, 'sessions'), { recursive: true });
  const sessionId = `sess-${randomUUID().slice(0, 8)}`;
  const socket = platform() === 'win32' ? `\\\\.\\pipe\\magi-send-${randomUUID()}` : join(ws, `${sessionId}.sock`);
  writeFileSync(join(config, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, name, cwd: ws, kind: 'interactive', messagingSocketPath: socket }));
  writeFileSync(join(config, 'sessions', `${pid}.${'b'.repeat(64)}.key`), JSON.stringify({ peerToken: 'fixture-token' }));
  const transcript = join(config, 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(transcript, '');
  const frames = [];
  const inbox = net.createServer((connection) => {
    let text = '';
    connection.on('data', (chunk) => text += chunk);
    connection.on('end', () => {
      for (const frame of text.split('\n').filter(Boolean).map(JSON.parse)) {
        frames.push(frame);
        if (record && frame.type === 'user') appendFileSync(transcript, JSON.stringify({ type: 'user', origin: { kind: 'peer' }, message: { content: frame.message.content } }) + '\n');
      }
    });
  });
  await new Promise((resolve) => inbox.listen(socket, resolve));
  return { frames, sessionId, close: () => new Promise((resolve) => inbox.close(resolve)) };
}

test('a script sends to a named Claude session: received, exit 0, and it asserts no permission class', async () => {
  const ws = makeWorkspace('magi send');
  const { env } = fakeEnv(ws);
  const s = await claudeSession(ws, env);
  try {
    const r = await send(env, ['--to', 'worker-1', '--text', 'Pick up issue 42.', '--name', 'loop-orch', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.deliveryStatus, 'received');
    assert.equal(out.to.name, 'worker-1');
    assert.equal(out.to.sessionId, s.sessionId);
    assert.match(out.messageId, /^[0-9a-f-]{36}$/);
    const envelope = parseClaudeEnvelope(s.frames.find((f) => f.type === 'user').message.content);
    assert.ok(envelope, 'a well-formed envelope');
    assert.equal(envelope.fromName, 'script:loop-orch');
    assert.equal(envelope.fromMode, undefined, 'a script has no class to assert');
    assert.match(envelope.body, /^Pick up issue 42\.\n<!-- magi-delivery:/);
  } finally { await s.close(); }
});

test('a write the transcript never records is unconfirmed: exit 3, so the script does not resend', async () => {
  const ws = makeWorkspace('magi send unconfirmed');
  const { env } = fakeEnv(ws);
  const s = await claudeSession(ws, env, { record: false });
  try {
    const r = await send({ ...env, MAGI_CONFIRM_MS: '200' }, ['--to', s.sessionId, '--text', 'hello']);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stdout, /^unconfirmed: live:worker-1 \(message [0-9a-f-]{36}\)/);
    assert.equal(s.frames.length > 0, true, 'the frame was written');
  } finally { await s.close(); }
});

test('no match, two matches and bad usage each fail before anything is written', async () => {
  const ws = makeWorkspace('magi send refusals');
  const { env } = fakeEnv(ws);
  const a = await claudeSession(ws, env, { name: 'twin' });
  const b = await claudeSession(ws, env, { name: 'twin', pid: process.ppid });
  try {
    const none = await send(env, ['--to', 'nobody', '--text', 'x', '--json']);
    assert.equal(none.code, 1);
    const n = JSON.parse(none.stdout);
    assert.equal(n.code, 'NO_LIVE_PEER');
    assert.match(n.error, /"twin"/, 'the listed sessions are named');
    const two = await send(env, ['--to', 'twin', '--text', 'x']);
    assert.equal(two.code, 1);
    assert.match(two.stderr, /^AMBIGUOUS_PEER: 2 live claude sessions answer to "twin"/);
    assert.equal((await send(env, ['--to', 'twin'])).code, 2, 'no text');
    assert.equal((await send(env, ['--to', 'twin', '--text', 'x', '--agent', 'codex'])).code, 2, 'no codex target');
    assert.equal(a.frames.length + b.frames.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('an omp target gets the frame in its inbox, from the script', async () => {
  const ws = makeWorkspace('magi send omp');
  const { env } = fakeEnv(ws);
  const home = env.MAGI_HOME;
  setRecord(home, 'agents', String(process.pid), { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'omp-sess', name: 'omp-worker', sessionFile: null, cwd: ws, startedAt: Date.now() });
  const r = await send({ ...env, MAGI_CONFIRM_MS: '0' }, ['--to', 'omp-worker', '--agent', 'omp', '--text', 'Run the suite.', '--name', 'loop-orch', '--json']);
  assert.notEqual(r.code, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.agent, 'omp');
  const frames = statement(home, 'SELECT body FROM frames WHERE to_pid=?').all(process.pid).map((row) => JSON.parse(row.body));
  assert.equal(frames.length, 1);
  assert.match(frames[0].text, /^Run the suite\./);
  assert.deepEqual(frames[0].from, { agent: 'script', id: null, name: 'loop-orch' });
  assert.equal(frames[0].id, out.messageId);
});
