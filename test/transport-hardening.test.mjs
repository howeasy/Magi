import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runCli } from '../src/exec.mjs';
import { deliverToCodex, deliverReplyToOrigin, MAX_QUEUE_INLINE } from '../src/transport.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, readCalls } from './helpers/harness.mjs';

async function withCli(fn) {
  const ws = makeWorkspace('delivery hardening');
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws, { scenario: 'queue-ok' });
  const values = { ...env, CODEX_BIN: paths.codex, MAGI_LITERAL: 'EXPANDED_SECRET' };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await fn({ ws, logFile }); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function receivedBody(call) {
  const message = call.args[call.args.indexOf('--message') + 1];
  const prefix = 'Read the complete peer message from this file: ';
  return message.startsWith(prefix) ? readFileSync(message.slice(prefix.length), 'utf8') : message;
}

test('Windows shims refuse shell-sensitive arguments and keep bodies on stdin intact', { skip: process.platform !== 'win32' }, async () => {
  await withCli(async ({ ws, logFile }) => {
    const marker = join(ws, 'executed');
    const value = `%MAGI_LITERAL% !MAGI_LITERAL! " & echo injected > "${marker}"`;
    await assert.rejects(runCli('codex', ['--name', value], { cwd: ws }), { code: 'CMD_UNSAFE_ARGUMENT' });
    const body = 'literal body\n%MAGI_LITERAL% & "quoted"';
    const quoted = `" & echo injected > "${marker}"`;
    await runCli('codex', ['--name', quoted], { cwd: ws, stdin: body });
    const call = readCalls(logFile)[0];
    assert.equal(call.args[1], quoted);
    assert.equal(call.stdin, body);
    assert.equal(existsSync(marker), false);
  });
});

test('Windows queue delivery carries multiline shell-sensitive text without expansion or execution', { skip: process.platform !== 'win32' }, async () => {
  await withCli(async ({ ws, logFile }) => {
    const marker = join(ws, 'executed');
    const text = `SUMMARY\n%MAGI_LITERAL% !MAGI_LITERAL!\n" & echo injected > "${marker}"\nlast line`;
    await deliverToCodex({ thread: 'task-audit', text });
    assert.equal(receivedBody(readCalls(logFile)[0]), text);
    assert.equal(existsSync(marker), false);
  });
});

test('oversized Codex replies return home intact through the queue file spill', async () => {
  await withCli(async ({ logFile }) => {
    const text = 'SUMMARY\n' + 'reply evidence\n'.repeat(Math.ceil(MAX_QUEUE_INLINE / 15) + 100);
    await deliverReplyToOrigin({ text, task: { orchestrator: 'codex', orchestratorTarget: { agent: 'codex', id: 'task-audit' } } });
    const call = readCalls(logFile)[0];
    const message = call.args[call.args.indexOf('--message') + 1];
    assert.ok(message.length < MAX_QUEUE_INLINE);
    const path = message.slice('Read the complete peer message from this file: '.length);
    assert.equal(dirname(path), join(process.env.MAGI_HOME, 'spill'));
    assert.equal(receivedBody(call), text);
  });
});

test('native Windows queue spills quote-expanded argv below the raw text limit', { skip: process.platform !== 'win32' }, async () => {
  await withCli(async ({ ws, logFile }) => {
    const preload = join(ws, 'native-queue.cjs');
    writeFileSync(preload, `const fs=require('node:fs');const args=process.argv.slice(1);fs.appendFileSync(process.env.FAKE_CLI_LOG,JSON.stringify({args})+'\\n');const thread=args[args.indexOf('--thread')+1];console.log('Queued message native-receipt for thread '+thread+'.');process.exit(0);`);
    const options = process.env.NODE_OPTIONS;
    process.env.CODEX_BIN = process.execPath;
    process.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload);
    try {
      const text = '"'.repeat(17000);
      assert.ok(text.length < MAX_QUEUE_INLINE);
      const receipt = await deliverToCodex({ thread: 'task-native', text });
      assert.equal(receipt.messageId, 'native-receipt');
      const call = readCalls(logFile)[0];
      assert.match(call.args[call.args.indexOf('--message') + 1], /^Read the complete peer message from this file: /);
      assert.equal(receivedBody(call), text);
    } finally {
      if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options;
    }
  });
});
