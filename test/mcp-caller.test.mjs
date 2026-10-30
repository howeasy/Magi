import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { codexCaller } from '../src/mcp-caller.mjs';
import { runCli } from '../src/exec.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv, startServer, ROOT } from './helpers/harness.mjs';
import { getRecord } from '../src/store.mjs';

const callerId = '11111111-2222-3333-4444-555555555555';
const otherId = '99999999-2222-3333-4444-555555555555';

test('Codex caller metadata accepts known aliases and rejects conflicts', () => {
  for (const key of ['threadId', 'thread_id', 'openai/threadId', 'codexThreadId', 'codex_thread_id']) {
    assert.equal(codexCaller({ [key]: callerId }).threadId, callerId);
  }
  assert.equal(codexCaller({ 'X-Codex-Turn-Metadata': JSON.stringify({ thread_id: callerId, turn_id: 'turn' }) }).threadId, callerId);
  assert.equal(codexCaller({ 'x-codex-turn-metadata': { thread_id: callerId } }).threadId, callerId);
  assert.equal(codexCaller({ progressToken: 1 }).threadId, null);
  assert.throws(() => codexCaller({ threadId: callerId, 'X-Codex-Turn-Metadata': { thread_id: otherId } }), { code: 'ORIGIN_MISMATCH' });
});

test('real MCP handler refuses a conflicting claim and records the runtime caller when from is omitted', async () => {
  const ws = makeWorkspace('caller metadata');
  const { paths } = makeFakeBins(ws);
  const { env } = fakeEnv(ws);
  const trace = join(ws, 'identity.jsonl');
  const server = await startServer('claude', { cwd: ws, env: {
    ...env, CLAUDE_BIN: paths.claude, CODEX_BIN: join(ws, 'absent-codex'),
    CODEX_THREAD_ID: otherId, MAGI_IDENTITY_TRACE_FILE: trace,
  } });
  try {
    const mismatch = await server.client.callTool({
      name: 'claude_peer', arguments: { task: 'inspect', delivery: 'headless', workingDirectory: ws, from: otherId },
      _meta: { threadId: callerId, 'X-Codex-Turn-Metadata': JSON.stringify({ thread_id: callerId }), secret: 'must-not-be-traced' },
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0].text, /ORIGIN_MISMATCH/);
    const result = await server.client.callTool({
      name: 'claude_peer', arguments: { task: 'inspect', wait: true, delivery: 'headless', workingDirectory: ws },
      _meta: { threadId: callerId, sessionId: otherId, 'X-Codex-Turn-Metadata': JSON.stringify({ thread_id: callerId }), secret: 'must-not-be-traced' },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const record = getRecord(env.MAGI_HOME, 'tasks', result.structuredContent.taskId);
    assert.equal(record.orchestratorTarget.id, callerId);
    assert.equal(record.orchestratorTarget.rootSessionId, otherId);
    assert.equal(record.replyTo, `codex:${callerId}`);
    const captured = readFileSync(trace, 'utf8');
    assert.equal(JSON.parse(captured.trim().split('\n').at(-1)).threadId, callerId);
    assert.doesNotMatch(captured, /must-not-be-traced|secret|99999999/);
    const taskId = result.structuredContent.taskId;
    for (const kind of ['outcome', 'close']) {
      const refused = await server.client.callTool({
        name: 'claude_peer', arguments: { kind, taskId },
        _meta: { threadId: otherId },
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /ROLE_VIOLATION/);
    }
    const outcome = await server.client.callTool({
      name: 'claude_peer', arguments: { kind: 'outcome', taskId, accepted: 1 },
      _meta: { threadId: callerId, sessionId: otherId },
    });
    assert.equal(outcome.isError, undefined);
    assert.equal(getRecord(env.MAGI_HOME, 'tasks', taskId).outcome.accepted, 1);
  } finally { await server.close(); }
});

test('native Codex tool call supplies its real per-request caller metadata', {
  skip: process.env.PEER_E2E === '1' ? false : 'set PEER_E2E=1 for real Codex MCP metadata proof',
}, async (t) => {
  const ws = makeWorkspace('native MCP identity');
  const trace = join(ws, 'identity.jsonl');
  const args = [
    'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', ws,
    '--sandbox', 'read-only', '-c', 'approval_policy="never"',
    '-c', `mcp_servers.magi.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.magi.args=${JSON.stringify([join(ROOT, 'bin', 'magi.mjs'), 'serve', 'claude'])}`,
    '-c', `mcp_servers.magi.env.MAGI_IDENTITY_TRACE_FILE=${JSON.stringify(trace)}`,
    '-',
  ];
  const result = await runCli('codex', args, {
    cwd: ws, timeoutMs: 120000,
    env: { CODEX_THREAD_ID: otherId },
    stdin: `Call the magi claude_peer MCP tool exactly once with kind="peers" and workingDirectory=${JSON.stringify(ws)}. This is a read-only metadata test. Do not send notes, create peers, call other tools, or edit files. Then say done.`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const id = events.find((event) => event.type === 'thread.started')?.thread_id;
  assert.ok(id, 'native CLI must identify the session it created');
  if (!existsSync(trace) && events.some((event) => event.item?.type === 'mcp_tool_call'
    && event.item.tool === 'claude_peer'
    && /MCP tool call requires approval/.test(event.item.error?.message ?? ''))) {
    t.skip('Native caller metadata is unverified: the harness requires MCP approval. Do not weaken policy to make this probe pass.');
    return;
  }
  assert.ok(existsSync(trace), `the real tool handler must receive the call: ${JSON.stringify({ output: result.stdout.slice(-4000), stderr: result.stderr.slice(-2000) })}`);
  const records = readFileSync(trace, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.kind, 'peers');
    assert.equal(record.source, 'mcp_request_meta');
    assert.equal(record.threadId, id);
    assert.notEqual(record.threadId, otherId);
  }
  console.log(JSON.stringify({ nativeThreadId: id, metadataThreadId: records[0].threadId, keys: records[0].keys }));
});
