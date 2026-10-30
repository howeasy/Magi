// Override (steer) delivery failure modes, against a fake app-tools server so no
// desktop app is needed. The real send_message_to_thread was verified live;
// these pin the "never read a failure as success" contract Codex required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appToolSend, deliverToCodexSteer, probeAppToolsPipe } from '../src/transport.mjs';

// A minimal MCP stdio server whose tools/call result we control per scenario.
function fakeServer(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'cx-apptools-'));
  writeFileSync(
    join(dir, 'server.mjs'),
    `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const lines = buf.split(/\\r?\\n/);
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') reply(m.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } });
    else if (m.method === 'tools/call') handleCall(m.id);
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function err(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\\n'); }
function handleCall(id) {
  const s = ${JSON.stringify(scenario)};
  if (s === 'ok') reply(id, { content: [{ type: 'text', text: JSON.stringify({ threadId: 't' }) }] });
  else if (s === 'isError') reply(id, { isError: true, content: [{ type: 'text', text: 'app refused the send' }] });
  else if (s === 'rpcError') err(id, 'boom');
  else if (s === 'earlyExit') process.exit(1);
  else if (s === 'noContent') reply(id, { ok: true });
  else if (s === 'nullResult') reply(id, null);
}
`,
  );
  return { node: process.execPath, cwd: dir, pipe: 'unused-by-fake' };
}

test('a successful tool result resolves', async () => {
  const r = await appToolSend(fakeServer('ok'), { threadId: 't', prompt: 'hi' }, { threadId: 't' });
  assert.ok(r.content);
});

test('an MCP result.isError is a failure, not a success', async () => {
  await assert.rejects(appToolSend(fakeServer('isError'), { threadId: 't', prompt: 'hi' }, { threadId: 't' }), { code: 'STEER_FAILED', dispatchUncertain: true });
});

test('a JSON-RPC error is a failure', async () => {
  await assert.rejects(appToolSend(fakeServer('rpcError'), { threadId: 't', prompt: 'hi' }, { threadId: 't' }), { code: 'STEER_FAILED', dispatchUncertain: true });
});

test('an early exit before replying is a failure', async () => {
  await assert.rejects(appToolSend(fakeServer('earlyExit'), { threadId: 't', prompt: 'hi' }, { threadId: 't' }), { code: 'STEER_FAILED', dispatchUncertain: true });
});

test('a call that never answers times out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-apptools-'));
  writeFileSync(join(dir, 'server.mjs'), 'process.stdin.resume();'); // accepts input, never replies
  await assert.rejects(appToolSend({ node: process.execPath, cwd: dir, pipe: 'x' }, { threadId: 't', prompt: 'hi' }, { threadId: 't' }, { timeoutMs: 400 }), { code: 'STEER_TIMEOUT', dispatchUncertain: false });
});

test('override refuses a name and requires a thread id', async () => {
  await assert.rejects(deliverToCodexSteer({ thread: 'Start Magi audit', text: 'x' }), { code: 'STEER_NEEDS_ID' });
});

test('a result without a content array is a failure, not undefined success', async () => {
  await assert.rejects(appToolSend(fakeServer('noContent'), { threadId: 't', prompt: 'hi' }, { threadId: 't' }), { code: 'STEER_FAILED', dispatchUncertain: true });
});

test('a null result is a failure', async () => {
  await assert.rejects(appToolSend(fakeServer('nullResult'), { threadId: 't', prompt: 'hi' }, { threadId: 't' }), { code: 'STEER_FAILED', dispatchUncertain: true });
});

// Desktop 26.915 hides the pipe in the app-server's env; discovery lists the
// codex-browser-use-* pipes (26.1023 names its own codex-app-tools-*) and keeps
// the one whose tools include the steer tool. Any real desktop pipes on this
// machine are probed too, but only through the fake server.mjs, which never
// connects to anything.
for (const [label, wantPrefix, decoyPrefix] of [
  ['among browser-use pipes (26.915)', 'codex-browser-use-', 'codex-browser-use-'],
  ['under its own codex-app-tools prefix (26.1023), beside a browser-use decoy', 'codex-app-tools-', 'codex-browser-use-'],
]) {
test(`the app-tools pipe is found ${label} by its tool list`, { skip: process.platform !== 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-home-'));
  const want = `${wantPrefix}magi-test-${randomUUID()}`;
  const decoy = `${decoyPrefix}magi-test-${randomUUID()}`;
  for (const [ver, tool] of [['0.1.2', 'stale'], ['0.1.10', 'send_message_to_thread']]) {
    const dir = join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', ver);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'server.mjs'),
      `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  const lines = buf.split(/\\r?\\n/);
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'tools/list') reply(m.id, { tools: process.env.CODEX_APP_TOOLS_PIPE_PATH.endsWith(${JSON.stringify(want)}) ? [{ name: ${JSON.stringify(tool)} }] : [] });
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
`,
    );
  }
  const servers = await Promise.all([want, decoy].map((n) => new Promise((res) => { const s = net.createServer(); s.listen(`\\\\.\\pipe\\${n}`, () => res(s)); })));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const env = await probeAppToolsPipe();
    assert.equal(env?.pipe, `\\\\.\\pipe\\${want}`);
    assert.ok(env.cwd.endsWith('0.1.10'), 'newest plugin version by numeric order');
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    for (const s of servers) s.close();
  }
});
}
