import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, parseClaudeJson } from '../src/exec.mjs';

const WARN = (s) => `Warning: MCP server "${s}" failed to connect: MCP subprocess closed stdout before responding; its tools are unavailable for this run.`;

test('a Claude failed result with subtype "success" reports the result text, not the word success', () => {
  const r = parseClaudeJson(JSON.stringify({ result: 'API Error: 529 overloaded', is_error: true, subtype: 'success' }));
  assert.deepEqual(r.errors, ['API Error: 529 overloaded']);
});

test('a Claude failed result with no text still falls back to the subtype', () => {
  assert.deepEqual(parseClaudeJson(JSON.stringify({ result: '', is_error: true, subtype: 'error_during_execution' })).errors, ['error_during_execution']);
});

test("omp's MCP warnings no longer hide the error the run reported", () => {
  const e = classifyFailure('omp', { stderr: `${WARN('magi')}\n${WARN('magi-codex')}\n`, exitCode: 1, errors: ['model returned 500'] });
  assert.equal(e.code, 'PEER_FAILED');
  assert.match(e.message, /model returned 500/);
  assert.doesNotMatch(e.message, /failed to connect/);
});

test('only the warnings and no parsed cause says the cause was not captured', () => {
  const e = classifyFailure('omp', { stderr: `${WARN('magi')}\r\n${WARN('magi-codex')}`, exitCode: 1, errors: [] });
  assert.match(e.message, /2 MCP "failed to connect" warning\(s\); the cause was not captured/);
});

test('stderr that is not one of the known warnings is kept', () => {
  const e = classifyFailure('omp', { stderr: `${WARN('magi')}\nReading prompt from piped stdin: EOF never came`, exitCode: 1, errors: [] });
  assert.match(e.message, /EOF never came/);
  assert.doesNotMatch(e.message, /failed to connect/);
});

test('an auth failure in the parsed errors is still classified', () => {
  assert.equal(classifyFailure('claude', { stderr: '', exitCode: 1, errors: ['Not logged in'] }).code, 'AUTH_REQUIRED');
});

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './helpers/harness.mjs';
import { setRecord } from '../src/store.mjs';

test('log --limit trims the listing, not the tally, and says how much is still open', () => {
  const home = join(makeWorkspace(), 'home');
  const task = (id, at, outcome) => ({ taskId: id, orchestrator: 'claude', peer: 'omp', mode: 'DELEGATE', maxRounds: 2, outcome, rounds: [{ round: 1, openedAt: at, replied: true }] });
  setRecord(home, 'tasks', 'cx-aaaa0001', task('cx-aaaa0001', Date.now(), { accepted: 3, rejected: 1, open: 2 }));
  setRecord(home, 'tasks', 'cx-bbbb0002', task('cx-bbbb0002', Date.now() - 60000, { accepted: 1, rejected: 0, open: 0 }));
  const cli = fileURLToPath(new URL('../bin/magi.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli, 'log', '--limit', '1'], { env: { ...process.env, MAGI_HOME: home }, encoding: 'utf-8' });
  assert.match(out, /cx-aaaa0001/);
  assert.doesNotMatch(out, /cx-bbbb0002/);
  assert.match(out, /listing the newest 1 of 2; totals cover all 2/);
  assert.match(out, /4 accepted, 1 rejected, 2 open/);
  assert.match(out, /held 80% of the time/);
  assert.match(out, /2 finding\(s\) \(29%\) still open/);
});

import { makePickDelivery } from '../src/serve.mjs';

test('a named peer that is not live lists what is, the close names first', async () => {
  const mk = (name, pid) => ({ name, pid, sessionId: `s${pid}`, cwd: 'E:/repo', status: 'idle', statusAt: Date.now() });
  const pick = makePickDelivery({ peer: 'omp', sessions: async () => [mk('alpha', 1), mk('web-api-2', 2), mk('beta', 3)] });
  await assert.rejects(pick({ delivery: 'live', target: 'web-api', cwd: 'E:/repo', kind: 'request' }), (e) => {
    assert.equal(e.code, 'NO_LIVE_PEER');
    assert.match(e.message, /Listed omp sessions: "web-api-2" \(close\), "alpha", "beta"/);
    assert.match(e.message, /delivery:"headless"/);
    return true;
  });
  const none = makePickDelivery({ peer: 'omp', sessions: async () => [] });
  await assert.rejects(none({ delivery: 'live', target: 'x', cwd: 'E:/repo', kind: 'request' }), /No omp session is registered at all/);
});

// --- agent-facing text must be usable as written ---

import { composeRequest, composeQuestion, composeClarification, composeReply, composeSpill, composeWatch } from '../src/protocol.mjs';
import { peerInputSchema } from '../src/peer-schema.mjs';
import { parseOmpJsonl } from '../src/omp-launch.mjs';

test('every field a composed instruction tells an agent to pass is a field the tool schema has', () => {
  const fields = new Set(Object.keys(peerInputSchema({ deliveries: ['auto', 'live', 'headless'], peerHint: 'x' })));
  const texts = [
    composeRequest({ taskId: 'cx-1', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', task: 't', replyTool: 'claude_peer', replyVia: 'tool', steerReply: true, round: 2, maxRounds: 6 }).text,
    composeQuestion({ taskId: 'cx-1', round: 2, from: 'codex', body: 'q' }),
    composeClarification({ taskId: 'cx-1', round: 2, body: 'a' }),
    composeReply({ taskId: 'cx-1', round: 2, from: 'codex', body: 'r' }),
    composeSpill({ taskId: 'cx-1', path: 'p', replyTool: 'claude_peer' }),
    composeWatch({ from: 'claude', sender: { id: 'abc' }, replyTool: 'codex_peer' }),
  ];
  for (const text of texts) {
    // `name=` / `name="` tokens in an instruction line that carries a kind=; headers (PEER ... task_id=) are not calls.
    for (const line of text.split('\n').filter((l) => /\bkind="/.test(l))) {
      for (const m of line.matchAll(/\b([A-Za-z_]+)=(?=["\d])/g)) {
        assert.ok(fields.has(m[1]), `"${m[1]}=" in "${line.slice(0, 120)}" is not a schema field`);
      }
    }
  }
});

test('a missing named peer is not told to use headless for a note or a watch, which cannot', async () => {
  const none = makePickDelivery({ peer: 'omp', sessions: async () => [] });
  await assert.rejects(none({ delivery: 'live', target: 'x', cwd: 'E:/repo', kind: 'watch' }), (e) => /ask the user to open one/.test(e.message) && !/headless/.test(e.message));
  const some = makePickDelivery({ peer: 'omp', sessions: async () => [{ name: 'alpha', pid: 1, sessionId: 's1', cwd: 'E:/repo', status: 'idle', statusAt: Date.now() }] });
  await assert.rejects(some({ delivery: 'live', target: 'x', cwd: 'E:/repo', kind: 'note' }), (e) => /"alpha"/.test(e.message) && !/headless/.test(e.message));
  await assert.rejects(some({ delivery: 'live', target: 'x', cwd: 'E:/repo', kind: 'request' }), (e) => /headless/.test(e.message));
});

test('omp usage counts only real numbers', () => {
  const msg = (u) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u } });
  const r = parseOmpJsonl(msg({ input: '10', output: 5, cacheRead: null, cost: { total: 'free' } }));
  assert.deepEqual(r.usage, { costUsd: null, inputTokens: null, outputTokens: 5 });
});

// --- what the first schema test could not see (found by a later review) ---

test('after round 1 a reply instruction names the round, in the tool call and the CLI fallback', () => {
  const r2 = composeRequest({ taskId: 'cx-1', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', task: 't', replyTool: 'claude_peer', replyVia: 'tool', round: 2, maxRounds: 6 }).text;
  assert.match(r2, /kind="reply", taskId="cx-1" and round=2/);
  assert.match(r2, /reply --task cx-1 --round 2 --from codex/);
  assert.match(r2, /kind="clarify" taskId="cx-1" round=2/);
  const inline = composeRequest({ taskId: 'cx-1', orchestrator: 'claude', peer: 'codex', mode: 'REVIEW', task: 't', replyVia: 'inline', round: 1, maxRounds: 2 }).text;
  assert.doesNotMatch(inline, /kind="(reply|clarify)"/, 'a headless peer has no tool to be told about');
  assert.match(composeSpill({ taskId: 'cx-1', round: 2, path: 'p', replyTool: 'claude_peer' }), /taskId="cx-1" round=2\.$/);
  assert.doesNotMatch(composeSpill({ taskId: 'cx-1', path: 'p', replyTool: 'claude_peer' }), /round=/);
});



test('an oversized request spilled to a file still names the round to reply to, through the real Codex delivery', async () => {
  const { makeCodexLiveDelivery } = await import('../src/codex-delivery.mjs');
  const { MAX_QUEUE_INLINE } = await import('../src/transport.mjs');
  let queued;
  const deliver = makeCodexLiveDelivery({ queue: async ({ text }) => { queued = text; return { messageId: 'm1', threadId: 't1' }; }, steer: async () => {}, hygienicQueue: async () => ({}) });
  // The engine hands the round over at the top level, as src/peer.mjs does.
  await deliver({ text: 'x'.repeat(MAX_QUEUE_INLINE + 1), target: 'impl', taskId: 'cx-spill1', round: 2, putRequestBody: () => 'C:/x/cx-spill1.request.md', delivery: 'live', kind: 'request' });
  assert.match(queued, /kind="reply" and taskId="cx-spill1" round=2\.$/);
  await deliver({ text: 'x'.repeat(MAX_QUEUE_INLINE + 1), target: 'impl', taskId: 'cx-spill2', putRequestBody: () => 'C:/x/cx-spill2.request.md', delivery: 'live', kind: 'request' });
  assert.doesNotMatch(queued, /round=/);
});


test('a stale unnamed session is not recommended headless for a note, a watch or a transcript', async () => {
  const stale = { name: 'old', pid: 9, sessionId: 's9', cwd: 'E:/repo', status: 'idle', statusAt: Date.now() - 3 * 3600e3 };
  const pick = makePickDelivery({ peer: 'codex', sessions: async () => [stale] });
  for (const kind of ['note', 'watch', 'transcript']) {
    await assert.rejects(pick({ delivery: 'live', cwd: 'E:/repo', kind }), (e) => e.code === 'NO_LIVE_PEER' && !/headless/.test(e.message), kind);
  }
  await assert.rejects(pick({ delivery: 'live', cwd: 'E:/repo', kind: 'request' }), (e) => /headless/.test(e.message));
});

test('a round-2 request and a round-2 clarification answer reach the real Codex delivery with their round, spilled', async () => {
  const { mkdirSync } = await import('node:fs');
  const { makeCodexLiveDelivery } = await import('../src/codex-delivery.mjs');
  const { MAX_QUEUE_INLINE } = await import('../src/transport.mjs');
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  mkdirSync(join(ws, 'home'), { recursive: true });
  const state = await import('../src/state.mjs?' + Math.random());
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const queued = [];
  const deliverLive = makeCodexLiveDelivery({ queue: async ({ text }) => { queued.push(text); return { messageId: 'm', threadId: 't' }; }, steer: async () => {}, hygienicQueue: async () => ({}) });
  const engine = makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer', listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'live', target: 'impl' }),
    deliverLive: (d) => deliverLive({ ...d, putRequestBody: () => 'C:/x/body.md' }),
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
  });
  const big = 'x'.repeat(MAX_QUEUE_INLINE + 10);

  // round 2 of a debate, opened through the engine
  state.openRound({ taskId: 'cx-eng2', orchestrator: 'claude', peer: 'codex', mode: 'DEBATE', round: 1, maxRounds: 6 });
  state.recordReply({ taskId: 'cx-eng2', from: 'codex', round: 1, payload: { body: 'r1' } });
  await engine.handleRequest({ taskId: 'cx-eng2', round: 2, mode: 'DEBATE', task: big, counterpartyClaims: 'c', workingDirectory: ws, wait: false }, {});
  assert.match(queued.at(-1), /kind="reply" and taskId="cx-eng2" round=2\.$/);

  // a clarification answer on that round 2
  const questionId = state.recordClarify({ taskId: 'cx-eng2', from: 'codex', round: 2 });
  await engine.handleClarifyAnswer({ taskId: 'cx-eng2', questionId, body: big, round: 2, timeoutMs: 50 }, {});
  assert.match(queued.at(-1), /kind="reply" and taskId="cx-eng2" round=2\.$/);
});
