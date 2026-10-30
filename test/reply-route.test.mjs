// The reply instruction has to match how the request was actually delivered.
// A headless peer has no bridge tool, so telling it to call one produces a
// failed tool call and a confused answer. Found in a real cross-agent run.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, initGitRepo } from './helpers/harness.mjs';
import { composeRequest } from '../src/protocol.mjs';

function setup() {
  const ws = makeWorkspace();
  initGitRepo(ws);
  const { paths } = makeFakeBins(ws);
  const { env, logFile } = fakeEnv(ws);
  return { ws, paths, env, logFile };
}

const base = {
  taskId: 't1',
  orchestrator: 'claude',
  peer: 'codex',
  mode: 'REVIEW',
  task: 'Review it',
  replyTool: 'claude_peer',
};

test('an inline request tells the peer not to call any tool', () => {
  const { text } = composeRequest({ ...base, replyVia: 'inline' });
  assert.match(text, /Respond inline/);
  assert.match(text, /your final message IS the reply/i);
  assert.match(text, /Do not call any tool to deliver it/i);
  assert.doesNotMatch(text, /kind="reply"/);
});

test('a live request tells the peer which tool to reply with', () => {
  const { text } = composeRequest({ ...base, replyVia: 'tool' });
  assert.match(text, /claude_peer/);
  assert.match(text, /kind="reply"/);
  assert.doesNotMatch(text, /Respond inline/);
});

// Both directions, end to end through the server.
test('a headless Codex peer is told to answer inline', async () => {
  const { ws, paths, env, logFile } = setup();
  const s = await startServer('codex', { cwd: ws, env: { ...env, CODEX_BIN: paths.codex } });
  try {
    await s.call('codex_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  } finally {
    await s.close();
  }
  const { stdin } = readCalls(logFile)[0];
  assert.match(stdin, /Respond inline/);
  assert.doesNotMatch(stdin, /kind="reply"/, 'a headless peer has no bridge tool to reply with');
  assert.doesNotMatch(stdin, /claude_peer tool/);
});

test('a headless Claude peer is told to answer inline', async () => {
  const { ws, paths, env, logFile } = setup();
  const s = await startServer('claude', { cwd: ws, env: { ...env, CLAUDE_BIN: paths.claude } });
  try {
    await s.call('claude_peer', { wait: true, task: 'Review', mode: 'REVIEW', delivery: 'headless', workingDirectory: ws });
  } finally {
    await s.close();
  }
  const { stdin } = readCalls(logFile)[0];
  assert.match(stdin, /Respond inline/);
  assert.doesNotMatch(stdin, /kind="reply"/, 'a headless peer has no bridge tool to reply with');
  assert.doesNotMatch(stdin, /codex_peer tool/);
});

test('the role and one-reply rules survive in the inline wording', () => {
  const { text } = composeRequest({ ...base, replyVia: 'inline' });
  assert.match(text, /You are the PEER/);
  assert.match(text, /Do not open a new request back to the orchestrator/);
  assert.match(text, /A further round, if any, will arrive from the orchestrator/);
});

test('a live request offers a fallback for an absent tool, and keeps a denied call denied', () => {
  const { text } = composeRequest({ ...base, replyVia: 'tool' });
  assert.match(text, /node "[^"]*\/bin\/magi\.mjs" reply --task t1 --round 1 --from codex --file/);
  assert.match(text, /not loaded in your session/);
  assert.match(text, /a denied tool call stays denied/);
  assert.doesNotMatch(text, /use is denied in your session, file the reply/);
});

test('the inline request does not offer the fallback', () => {
  const { text } = composeRequest({ ...base, replyVia: 'inline' });
  assert.doesNotMatch(text, /magi\.mjs" reply --task/);
});
