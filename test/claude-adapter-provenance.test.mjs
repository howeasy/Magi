import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { makeWorkspace, startServer, textOf } from './helpers/harness.mjs';
import { openRound } from '../src/state.mjs';
import { parseClaudeEnvelope } from '../src/transport.mjs';

const callerId = '11111111-2222-3333-4444-555555555555';

for (const kind of ['note', 'reply']) {
  test(`the actual Claude MCP adapter preserves sender provenance on a ${kind}`, async () => {
    const ws = makeWorkspace('Claude adapter provenance');
    const config = join(ws, 'claude-config');
    const home = join(ws, 'state');
    mkdirSync(join(config, 'sessions'), { recursive: true });
    const socket = platform() === 'win32'
      ? `\\\\.\\pipe\\magi-adapter-${randomUUID()}` : join(ws, 'inbox.sock');
    const target = { pid: process.pid, sessionId: 'receiver-session', name: 'fake-receiver', cwd: ws, kind: 'interactive', messagingSocketPath: socket };
    writeFileSync(join(config, 'sessions', `${process.pid}.json`), JSON.stringify(target));
    writeFileSync(join(config, 'sessions', `${process.pid}.${'a'.repeat(64)}.key`), JSON.stringify({ peerToken: 'local-fixture-token' }));
    let receive;
    const received = new Promise((resolve) => { receive = resolve; });
    const inbox = net.createServer((connection) => {
      let text = '';
      connection.on('data', (chunk) => text += chunk);
      connection.on('end', () => receive(text.split('\n').filter(Boolean).map(JSON.parse)));
    });
    await new Promise((resolve) => inbox.listen(socket, resolve));
    const previous = process.env.MAGI_HOME;
    process.env.MAGI_HOME = home;
    if (kind === 'reply') openRound({
      taskId: 'adapter-reply', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', round: 1, cwd: ws,
      replyTo: `uds:${socket}`,
      orchestratorTarget: { agent: 'claude', sessionId: target.sessionId, socket, pid: target.pid, cwd: ws },
    });
    const server = await startServer('claude', { cwd: ws, env: {
      MAGI_HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_BIN: join(ws, 'absent-codex'),
    } });
    try {
      const result = await server.client.callTool({
        name: 'claude_peer',
        arguments: { kind, body: 'adapter provenance check', workingDirectory: ws,
          ...(kind === 'note' ? { peer: target.name } : { taskId: 'adapter-reply', round: 1 }) },
        _meta: { threadId: callerId },
      });
      assert.notEqual(result.isError, true, textOf(result));
      let timer;
      const frames = await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No inbox frame')), 2000); })])
        .finally(() => clearTimeout(timer));
      const frame = frames.find((entry) => entry.type === 'user');
      assert.ok(frame);
      const envelope = parseClaudeEnvelope(frame.message.content);
      assert.ok(envelope);
      assert.equal(envelope.fromSession, callerId);
      assert.equal(envelope.fromName, `codex:${callerId}`);
      assert.equal(envelope.fromMode, undefined, 'unknown permission class must remain unasserted');
      assert.match(envelope.body, kind === 'note' ? /^PEER NOTE/ : /^PEER REPLY/);
    } finally {
      await server.close();
      await new Promise((resolve) => inbox.close(resolve));
      if (previous === undefined) delete process.env.MAGI_HOME; else process.env.MAGI_HOME = previous;
    }
  });
}
