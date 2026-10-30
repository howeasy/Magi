import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { makeWorkspace } from './helpers/harness.mjs';
import { makeEngine, sentLine, toolError } from '../src/peer.mjs';
import { redact, composeReply } from '../src/protocol.mjs';
import { openRound, savePersona, listNotices } from '../src/state.mjs';
import { setRecord } from '../src/store.mjs';
import { lastSaid } from '../src/transcript.mjs';

function workspace() {
  const cwd = makeWorkspace();
  process.env.MAGI_HOME = join(cwd, 'home');
  return cwd;
}

const secretForms = [
  'SERVICE_TOKEN=private-value',
  'DATABASE_PASSWORD=private-value',
  'SERVICE_TOKEN="private value with spaces"',
  '"password": "private-value"',
  '"password": "private \\"quoted\\" value"',
  'sk_live_abcdefghijklmnopqrstuv',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
  'AIza' + 'a'.repeat(35),
  'postgres://user:private-value@localhost/db',
  'https://user:private-value@example.com/path',
];

test('secret formats are removed without deleting source expressions', () => {
  for (const secret of secretForms) {
    const result = redact(secret);
    assert.notEqual(result.text, secret, secret);
    assert.doesNotMatch(result.text, /private-value|private value|signature|abcdefghijklmnopqrstuv/);
  }
  for (const code of ['const token = getToken();', 'const token=getToken();', 'const token = accessToken;', '+ const password = config.password;', 'let token = await getToken();']) {
    assert.equal(redact(code).text, code);
  }
  assert.doesNotMatch(redact('const password = "private-value";').text, /private-value/);
  assert.equal(redact('postgres://user:private-value@localhost/db').text, 'postgres://[REDACTED]@localhost/db');
});

test('progress redacts before truncation and sender header values are redacted', () => {
  const key = 'sk_live_' + 'a'.repeat(250);
  const line = sentLine('wire body', 'DATABASE_PASSWORD=private-value', 'note', key);
  assert.doesNotMatch(line, /private-value|sk_live_/);
  const frame = composeReply({ taskId: 'cx-safe', from: 'codex', body: 'done', sender: {
    name: secretForms[0], id: secretForms[5], agentNickname: secretForms[6], agentRole: secretForms[7], cwd: secretForms[8],
  } });
  assert.doesNotMatch(frame, /private-value|sk_live_|signature|AIza/);
});

test('unstructured headless replies retain the raw redacted body and reconciliation debt', async () => {
  const cwd = workspace();
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ via: 'headless', inlineReply: 'Plain answer without section headings. SERVICE_TOKEN=private-value' }),
  });
  const result = await engine.handleRequest({ task: 'inspect', wait: true, workingDirectory: cwd });
  const visible = JSON.parse(JSON.stringify(result.structuredContent));
  assert.equal(visible.body, 'Plain answer without section headings. [REDACTED]');
  assert.deepEqual(visible.unreconciled, [visible.taskId]);
  assert.equal(visible.deliveryStatus, 'received');
  assert.match(visible.next, /kind:"outcome"/);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
  const outcome = await engine.handleOutcome({ taskId: visible.taskId, open: 1, body: 'Not independently checked' });
  assert.deepEqual(outcome.structuredContent.unreconciled, []);
});

test('nonblocking requests explain automatic return without confusing queueing with receipt', async () => {
  const cwd = workspace();
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: 'peer' }),
    deliverLive: async () => ({ via: 'queue', deliveryStatus: 'queued_unread', statusText: 'Queued, receipt unconfirmed.' }),
  });
  const result = await engine.handleRequest({ task: 'inspect', wait: false, workingDirectory: cwd });
  assert.equal(result.structuredContent.deliveryStatus, 'queued_unread');
  assert.match(result.structuredContent.next, /PEER REPLY/);
  assert.match(result.structuredContent.next, /kind:"outcome"/);
  assert.deepEqual(result.structuredContent.unreconciled, []);
});

test('a waiting question is redacted and the worker continues independent work', async () => {
  const cwd = workspace();
  const worker = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer' });
  let workerResult;
  const coordinator = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: 'peer' }),
    deliverLive: async ({ taskId }) => {
      workerResult = await worker.handleClarify({ taskId, body: 'Which branch? SERVICE_TOKEN=private-value' });
      return { via: 'queue', deliveryStatus: 'queued_unread' };
    },
  });
  const result = await coordinator.handleRequest({ task: 'inspect', wait: true, workingDirectory: cwd, timeoutMs: 1000 });
  assert.equal(result.structuredContent.question, 'Which branch? [REDACTED]');
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
  assert.match(workerResult.structuredContent.next, /Continue with what does not depend on the answer/);
  assert.equal(workerResult.structuredContent.deliveryStatus, 'queued_unread');
});

test('an async question does not claim a waiting call exists', async () => {
  const cwd = workspace();
  openRound({ taskId: 'cx-question', orchestrator: 'claude', peer: 'codex', round: 1, cwd });
  let frame;
  const worker = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    deliverReply: async ({ text }) => { frame = text; return { deliveryStatus: 'queued_unread' }; },
  });
  const result = await worker.handleClarify({ taskId: 'cx-question', body: 'Which branch?' });
  assert.doesNotMatch(frame, /resumes.*wait/);
  assert.match(result.structuredContent.next, /Continue with what does not depend on the answer/);
});

test('errors keep a code and recovery step in the visible text', () => {
  const result = toolError(Object.assign(new Error('DATABASE_PASSWORD=private-value'), { code: 'PEER_FAILED' }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /PEER_FAILED:/);
  assert.match(result.content[0].text, /Next: Inspect the peer CLI failure/);
  assert.doesNotMatch(result.content[0].text, /private-value/);
});

test('reply frames and errors redact delimiter-terminated and quoted assignments', () => {
  for (const body of [
    'authentication failed (token=private-value)',
    '[token=private-value]',
    'password=private(value)',
    'token=`private-value`',
    'token=private,value',
    'MY_API_KEY=private-value',
    'SERVICE_SECRET=private-value',
    'service_token=private-value',
    "{'password': 'private-value'}",
  ]) {
    const frame = composeReply({ taskId: 'cx-secrets', from: 'codex', body });
    const error = toolError(Object.assign(new Error(body), { code: 'PEER_FAILED' }));
    assert.doesNotMatch(frame, /private/, body);
    assert.doesNotMatch(error.content[0].text, /private/, body);
  }
});

test('headless replies, progress and stored worker replies redact extended secret forms', async () => {
  const cwd = workspace();
  const body = [
    'MY_API_KEY=private-api',
    'SERVICE_SECRET=private-secret',
    'service_token=private-token',
    "{'password': 'private-password'}",
    'password=private(paren)',
    'token=`private-backtick`',
    'token=private,comma',
  ].join('\n');
  const coordinator = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'headless' }),
    deliverHeadless: async () => ({ via: 'headless', inlineReply: body }),
  });
  const reply = await coordinator.handleRequest({ task: 'inspect', wait: true, workingDirectory: cwd });
  assert.doesNotMatch(JSON.stringify(reply), /private/);
  assert.match(reply.structuredContent.body, /\[REDACTED\]/);
  assert.doesNotMatch(sentLine('wire', 'peer', 'reply', body), /private/);

  openRound({ taskId: 'cx-secret-reply', orchestrator: 'claude', peer: 'codex', round: 1, cwd });
  let delivered;
  const worker = makeEngine({ orchestrator: 'codex', peerName: 'claude', replyTool: 'codex_peer',
    deliverReply: async ({ text }) => { delivered = text; return { via: 'queue', deliveryStatus: 'queued_unread' }; },
  });
  const result = await worker.handleReply({ taskId: 'cx-secret-reply', body, workingDirectory: cwd });
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(delivered, /private/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('transcript, peers and spawn redact nested adapter payloads and explicit guidance', async () => {
  const cwd = workspace();
  savePersona('claude', cwd, 'reviewer', 'token=private-persona', 'codex');
  const peer = { id: 'peer-id', name: 'reviewer', saying: { role: 'assistant', text: 'token=private-saying' } };
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: peer }),
    transcript: async () => [{ role: 'assistant', text: 'password=private-transcript' }],
    listPeers: async () => [peer],
    spawn: async () => ({ pending: true, requestedName: 'worker', next: 'Resolve token=private-spawn' }),
  });
  const transcript = await engine.handleTranscript({ workingDirectory: cwd });
  assert.equal(transcript.structuredContent.lines[0].text, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(transcript), /private-/);
  const peers = await engine.handlePeers({ workingDirectory: cwd });
  assert.equal(peers.structuredContent.peers[0].saying.text, '[REDACTED]');
  assert.equal(peers.structuredContent.personas[0].sessionId, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(peers), /private-/);
  const spawn = await engine.handleSpawn({ name: 'worker', workingDirectory: cwd });
  assert.equal(spawn.structuredContent.next, 'Resolve [REDACTED]');
  assert.doesNotMatch(JSON.stringify(spawn), /private-/);
  assert.equal(peer.saying.text, 'token=private-saying', 'outbound sanitation must not mutate adapter state');
});

test('peer previews redact complete and unterminated quoted secrets before clipping', async () => {
  const cwd = workspace();
  const transcript = join(cwd, 'peer.jsonl');
  const row = { harness: 'claude', id: 'preview-peer', name: 'reviewer', transcript, cwd };
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    listPeers: async () => [{ ...row, saying: await lastSaid(row) }],
    pickDelivery: async () => ({ mode: 'live', target: row }),
  });
  for (const quote of ['"', "'", '`']) {
    for (const closed of [true, false]) {
      const body = 'Status: ' + 'x'.repeat(205) + ` password=${quote}private-preview ` + 's'.repeat(300) + (closed ? quote : '');
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: body } }) + '\n');
      const result = await engine.handlePeers({ workingDirectory: cwd });
      assert.doesNotMatch(JSON.stringify(result), /private-preview|ssss/, `${quote} closed=${closed}`);
      assert.match(result.structuredContent.peers[0].saying.text, /\[REDACTED\]/);
    }
  }
  // A transcript tail may itself end inside a quoted assignment, including
  // an incomplete escape; both transcript renderings must hide the remainder.
  for (const body of ['password="private-tail\nstill-private', "'password': 'private-tail\\", 'token=`private-tail']) {
    const reader = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
      pickDelivery: async () => ({ mode: 'live', target: row }),
      transcript: async () => [{ role: 'assistant', text: body }],
    });
    const result = await reader.handleTranscript({ workingDirectory: cwd });
    assert.equal(result.structuredContent.lines[0].text, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(result), /private-tail|still-private/);
  }
});

test('transcript renderings and reply frames preserve source expressions but redact literals', async () => {
  const cwd = workspace();
  const expressions = [
    'const options = {token: accessToken, retries: 3};',
    'const options = {password: config.password, retries: 3};',
    'function f(token = getToken()) {}',
    'function f(password = accessToken) {}',
    'export const token = getToken();',
    '+ const options = {token: accessToken, retries: 3};',
  ];
  const literals = [
    'const options = {token: "private-literal", retries: 3};',
    "function f(password = 'private-literal') {}",
    'const token = `private-literal`;',
    'const password = 123456789;',
  ];
  const lines = [...expressions, ...literals].map((text) => ({ role: 'assistant', text, at: 1700000000000 }));
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: { id: 'source-peer' } }),
    transcript: async () => lines,
  });
  const result = await engine.handleTranscript({ workingDirectory: cwd });
  for (const [index, expression] of expressions.entries()) {
    assert.equal(result.structuredContent.lines[index].text, expression);
    assert.ok(result.content[0].text.includes(expression), expression);
    assert.ok(composeReply({ taskId: 'cx-source', from: 'codex', body: expression }).includes(expression), expression);
  }
  for (const [index, literal] of literals.entries()) {
    const line = result.structuredContent.lines[expressions.length + index].text;
    assert.match(line, /\[REDACTED\]/);
    assert.ok(result.content[0].text.includes(line), line);
    assert.doesNotMatch(composeReply({ taskId: 'cx-source', from: 'codex', body: literal }), /private-literal|123456789/);
  }
  assert.doesNotMatch(JSON.stringify(result), /private-literal|123456789/);
  assert.deepEqual(lines.map((line) => line.text), [...expressions, ...literals], 'rendering must not mutate the transcript');
});

test('reply frames redact complete, repeated and incomplete private-key blocks', () => {
  for (const body of [
    'before\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\nafter',
    'before -----BEGIN RSA PRIVATE KEY----- private-key-body -----END RSA PRIVATE KEY----- after',
    'before\n-----BEGIN PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\nafter',
    'before\n-----BEGIN PRIVATE KEY-----\nprivate-key-body',
  ]) {
    const frame = composeReply({ taskId: 'cx-key', from: 'codex', body });
    assert.doesNotMatch(frame, /private-key-body|-----BEGIN/);
    assert.match(frame, /before/);
    assert.match(frame, /\[REDACTED\]/);
    if (body.endsWith('after')) assert.match(frame, /after/);
  }
});

test('unmatched private-key headers scale within the reply responsiveness ceiling', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { performance } from 'node:perf_hooks';
    import { composeReply } from ${JSON.stringify(new URL('../src/protocol.mjs', import.meta.url).href)};
    const header = '-----BEGIN PRIVATE KEY-----\\nprivate-key-body\\n';
    const timings = [];
    for (const size of [10000, 100000]) {
      const start = performance.now();
      const frame = composeReply({ taskId: 'cx-key-scale', from: 'codex', body: header.repeat(size) });
      timings.push(performance.now() - start);
      assert.doesNotMatch(frame, /private-key-body|-----BEGIN/);
      assert.match(frame, /\\[REDACTED\\]/);
    }
    assert.ok(timings[1] < Math.max(1000, timings[0] * 25), JSON.stringify(timings));
    process.stdout.write(JSON.stringify(timings));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000, env: process.env,
  });
  assert.equal(result.error, undefined, 'unmatched headers must not stall a reply');
  assert.equal(result.status, 0, result.stderr);
});

test('a persisted notice stays successful when reconciliation debt cannot be read', async () => {
  const cwd = workspace();
  setRecord(process.env.MAGI_HOME, 'tasks', 'unreadable', { taskId: 'unreadable', orchestrator: 'claude', cwd, rounds: [null] });
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer' });
  const result = await engine.handleNotify({ body: 'Need an operator decision', workingDirectory: cwd });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.unreconciled, null);
  assert.equal(result.structuredContent.debtStatus, 'unavailable');
  assert.match(result.structuredContent.debtError, /magi error - .*Next:/s);
  assert.match(result.structuredContent.next, /do not repeat it/);
  assert.deepEqual(listNotices().map((notice) => [notice.id, notice.body]),
    [[result.structuredContent.noticeId, 'Need an operator decision']]);
});

test('large single-line replies finish within the outbound responsiveness ceiling', () => {
  const source = `
    import { composeReply } from ${JSON.stringify(new URL('../src/protocol.mjs', import.meta.url).href)};
    const body = 'token=private-value '.repeat(100000);
    process.stdout.write(composeReply({ taskId: 'cx-long', from: 'codex', body }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: process.env,
  });
  assert.equal(result.error, undefined, 'a long reply must not stall redaction');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private-value/);
  assert.equal(result.stdout.match(/\[REDACTED\]/g).length, 100000);
});

test('progress preserves ordinary const bindings while redacting header secrets', () => {
  for (const body of ['const token = getToken();', 'const token=getToken();', '+ const password = config.password;', 'let token = await getToken();']) {
    const result = sentLine('wire', 'SERVICE_SECRET=private-header', 'reply', body);
    assert.ok(result.endsWith(body), result);
    assert.doesNotMatch(result, /private-header/);
  }
  assert.doesNotMatch(sentLine('wire', 'peer', 'reply', 'const password = `private-literal`;'), /private-literal/);
});

test('a call that delivers nothing reports deliveryStatus not_applicable', async () => {
  const { makeEngine } = await import('../src/peer.mjs');
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer', listPeers: async () => [] });
  const result = await engine.handlePeers({});
  assert.equal(result.structuredContent.deliveryStatus, 'not_applicable');
});

test('a background headless request reports deliveryStatus running', async () => {
  const { makeEngine } = await import('../src/peer.mjs');
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer', pickDelivery: async () => ({ mode: 'headless' }), deliverHeadless: async () => ({ inlineReply: 'done', via: 'headless' }), deliverReply: async () => ({ via: 'test' }) });
  const cwd = workspace();
  const result = await engine.handleRequest({ task: 'inspect', workingDirectory: cwd, mode: 'REVIEW', wait: false });
  assert.equal(result.structuredContent.deliveryStatus, 'running', JSON.stringify(result.content));
});

test('peers listed in other directories are not reported as none reachable', async () => {
  const { makeEngine } = await import('../src/peer.mjs');
  const cwd = workspace();
  const elsewhere = [{ name: 'worker-1', id: 'worker-1', cwd: 'E:\elsewhere', state: 'idle' }];
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'omp', replyTool: 'claude_peer', listPeers: async () => elsewhere, pickDelivery: async () => { throw new Error('no default'); } });
  const result = await engine.handlePeers({ workingDirectory: cwd });
  const text = result.content[0].text;
  assert.match(text, /Reachable omp sessions \(1\)/);
  assert.match(text, /None of these is picked by default/);
  assert.doesNotMatch(text, /With none reachable/);
  // The listing is in `peers`; `next` carries only what to do with it.
  assert.equal(result.structuredContent.peers.length, 1);
  assert.match(result.structuredContent.next, /^None of these is picked by default/);
});
