// Real Claude and Codex calls. Opt in with PEER_E2E=1; costs tokens and minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

import { makeWorkspace, startServer, textOf, initGitRepo } from './helpers/harness.mjs';

const enabled = process.env.PEER_E2E === '1';
const opts = { skip: enabled ? false : 'set PEER_E2E=1 to run real model calls' };
const TIMEOUT = 900000;

function env(ws) {
  return { MAGI_HOME: join(ws, 'magi-home') };
}

test('Claude can consult Codex for real', opts, async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const s = await startServer('codex', { cwd: ws, env: env(ws) });
  try {
    const res = await s.call('codex_peer', {
      task: 'The file a.txt in this directory contains one word. Say what that word is, and nothing else of substance.',
      mode: 'SECOND_OPINION',
      delivery: 'headless',
      workingDirectory: ws,
      // A headless request returns at once unless it waits; this reads the reply.
      wait: true,
      timeoutMs: TIMEOUT,
    });
    const t = textOf(res);
    assert.equal(res.isError, undefined, `codex call failed: ${t.slice(0, 400)}`);
    assert.match(t, /two/i, 'the peer should have read the file');
    assert.match(t, /\[magi\] task_id=/);
    assert.match(t, /via=headless/);
  } finally {
    await s.close();
  }
});

test('Codex can consult Claude for real', opts, async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const s = await startServer('claude', { cwd: ws, env: env(ws) });
  try {
    const res = await s.call('claude_peer', {
      task: 'The file a.txt in this directory contains one word. Say what that word is, and nothing else of substance.',
      mode: 'SECOND_OPINION',
      delivery: 'headless',
      workingDirectory: ws,
      wait: true,
      timeoutMs: TIMEOUT,
    });
    const t = textOf(res);
    assert.equal(res.isError, undefined, `claude call failed: ${t.slice(0, 400)}`);
    assert.match(t, /two/i, 'the peer should have read the file');
    assert.match(t, /\[magi\] task_id=/);
  } finally {
    await s.close();
  }
});

test('a real Codex review can resume its prior headless session', opts, async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const server = await startServer('codex', { cwd: ws, env: env(ws) });
  try {
    const first = await server.call('codex_peer', { wait: true, task: 'Read a.txt and state its word briefly.', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws, timeoutMs: TIMEOUT });
    assert.equal(first.isError, undefined, textOf(first));
    const prior = /thread_id=([0-9a-f-]+)/i.exec(textOf(first))?.[1];
    assert.ok(prior, 'the first invocation must return its real session id');
    const second = await server.call('codex_peer', { wait: true, task: 'Using your previous turn, state the word you read in a.txt. Do not use tools or modify files.', mode: 'REVIEW', delivery: 'headless', resumeThreadId: prior, workingDirectory: ws, timeoutMs: TIMEOUT });
    assert.equal(second.isError, undefined, textOf(second));
    assert.match(textOf(second), /two/i);
    assert.match(textOf(second), new RegExp(`thread_id=${prior}`));
  } finally { await server.close(); }
});

// The one that matters: a review must not be able to touch the repository.
test('a real review cannot write, even when asked to', opts, async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const marker = join(ws, 'PEER_SHOULD_NOT_CREATE_THIS.txt');
  const s = await startServer('codex', { cwd: ws, env: env(ws) });
  try {
    const res = await s.call('codex_peer', {
      task:
        'First, create a file named PEER_SHOULD_NOT_CREATE_THIS.txt in the working directory containing the word test. ' +
        'Then review a.txt and report whether it looks correct.',
      mode: 'REVIEW',
      delivery: 'headless',
      workingDirectory: ws,
      allowWrites: true, // ignored: REVIEW is read-only
      // Without wait the call returns before the worker has done anything, and the check below proves nothing.
      wait: true,
      timeoutMs: TIMEOUT,
    });
    assert.equal(existsSync(marker), false, 'a read-only review wrote to the workspace');
    assert.ok(textOf(res).length > 0);
  } finally {
    await s.close();
  }
});

test('a real delegation may write inside the workspace', opts, async () => {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const target = join(ws, 'delegated.txt');
  const s = await startServer('codex', { cwd: ws, env: env(ws) });
  try {
    await s.call('codex_peer', {
      task: 'Create a file named delegated.txt in the working directory containing exactly the word ok. Then stop.',
      mode: 'DELEGATE',
      delivery: 'headless',
      workingDirectory: ws,
      allowWrites: true,
      // The file exists only once the worker has finished, so wait for it.
      wait: true,
      timeoutMs: TIMEOUT,
    });
    assert.equal(existsSync(target), true, 'delegation with allowWrites should have created the file');
  } finally {
    await s.close();
  }
});

// Live delivery into a running Codex session. Needs one open, named by
// PEER_LIVE_CODEX_THREAD, because liveness cannot be read from thread/list.
const liveThread = process.env.PEER_LIVE_CODEX_THREAD;
const liveOpts = {
  skip: enabled && liveThread ? false : 'set PEER_E2E=1 and PEER_LIVE_CODEX_THREAD=<thread name> to test live Codex delivery',
};

test('a live Codex session accepts a delivery and returns a receipt', liveOpts, async () => {
  const { deliverToCodex } = await import('../src/transport.mjs');
  const receipt = await deliverToCodex({
    thread: liveThread,
    text: 'Magi automated live-delivery test. No action needed.',
  });
  assert.ok(receipt.messageId, 'codex queue should report a queued message id');
  assert.ok(receipt.threadId, 'codex queue should report the thread it queued for');
});

test('an unknown Codex thread fails rather than pretending to deliver', liveOpts, async () => {
  const { deliverToCodex } = await import('../src/transport.mjs');
  await assert.rejects(
    () => deliverToCodex({ thread: 'definitely-not-a-real-session-xyz', text: 'should not arrive' }),
    (e) => e.code === 'NO_LIVE_PEER',
  );
});
