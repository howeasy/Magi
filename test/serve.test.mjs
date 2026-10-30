// The deep modules behind the three servers, tested through their interfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { makeWorkspace } from './helpers/harness.mjs';
import { pickSession, sameDir } from '../src/serve.mjs';
import { originOf } from '../src/transport.mjs';

test('one "same directory" rule: slashes, case and trailing separators do not matter', () => {
  assert.equal(sameDir('C:\\work\\Repo\\', 'c:/work/repo'), true);
  assert.equal(sameDir('/a/b', '/a/b/c'), false);
  assert.equal(sameDir(null, '/a'), false);
});

test('pickSession: exact id or pid, then a unique name, and never a session elsewhere', () => {
  const sessions = [
    { name: 'main', sessionId: 's1', pid: 11, cwd: 'E:/one' },
    { name: 'main', id: 't2', cwd: 'E:/two' },
    { name: 'other', sessionId: 's3', pid: 33, cwd: 'e:\\one\\' },
  ];
  assert.equal(pickSession(sessions, 's1', 'E:/zzz', 'claude').pid, 11);
  assert.equal(pickSession(sessions, '33', 'E:/zzz', 'claude').name, 'other');
  assert.equal(pickSession(sessions, 'other', 'E:/zzz', 'claude').pid, 33);
  assert.throws(() => pickSession(sessions, 'main', 'E:/one', 'claude'), (e) => e.code === 'AMBIGUOUS_PEER' && /pid 11 in E:\/one; t2 in E:\/two/.test(e.message));
  assert.equal(pickSession(sessions, 'nobody', 'E:/one', 'claude'), null);
  // Unnamed: the first in this directory, whatever the spelling; none elsewhere.
  assert.equal(pickSession(sessions, undefined, 'e:\\ONE', 'claude').pid, 11);
  assert.equal(pickSession(sessions, undefined, 'E:/three', 'claude'), null);
});

test('originOf: the recorded object wins, legacy strings still resolve, a contradiction resolves to nothing', () => {
  const obj = { agent: 'codex', id: 'abc' };
  assert.equal(originOf({ orchestrator: 'codex', orchestratorTarget: obj, replyTo: 'uds:x' }), obj);
  assert.deepEqual(originOf({ orchestrator: 'codex', replyTo: 'codex:abc' }), { agent: 'codex', id: 'abc' });
  assert.deepEqual(originOf({ orchestrator: 'claude', replyTo: 'uds:\\\\.\\pipe\\x' }), { agent: 'claude', socket: '\\\\.\\pipe\\x' });
  assert.deepEqual(originOf({ orchestrator: 'omp', replyTo: 'omp:4242' }), { agent: 'omp', pid: 4242 });
  assert.equal(originOf({ orchestrator: 'codex', orchestratorTarget: { agent: 'claude', id: 'x' }, replyTo: 'codex:abc' }), null, 'a recorded origin for the wrong agent is corrupt, not a licence to guess');
  assert.equal(originOf({ orchestrator: 'claude', replyTo: 'codex:abc' }), null);
  assert.equal(originOf({ orchestrator: 'codex' }), null);
});

test('the engine falls back to headless only on an error the adapter marked, and only on auto', async () => {
  const ws = makeWorkspace();
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const make = (err) => makeEngine({
    orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer',
    pickDelivery: async () => ({ mode: 'live', target: 't1' }),
    deliverLive: async () => { throw err; },
    deliverHeadless: async () => ({ inlineReply: 'SUMMARY\nfrom headless', via: 'headless' }),
  });
  const gone = Object.assign(new Error('gone'), { code: 'WHATEVER', fallback: true, dispatchUncertain: false });
  const fatal = Object.assign(new Error('boom'), { code: 'WHATEVER' });
  assert.match((await make(gone).handleRequest({ wait: true, task: 'x', workingDirectory: ws })).content[0].text, /via=headless/);
  assert.match((await make(fatal).handleRequest({ wait: true, task: 'x', workingDirectory: ws })).content[0].text, /WHATEVER: boom/);
  assert.match((await make(gone).handleRequest({ wait: true, task: 'x', workingDirectory: ws, delivery: 'live' })).content[0].text, /WHATEVER: gone/);
});


test('pickSession accepts the peer\'s own prefix on an id, and a named peer is looked up without the directory filter', async () => {
  const sessions = [{ name: 'web-p2', id: '01a09ae0-ad6f-7b01-8753-5e6b71eb1cfa', cwd: 'E:/webapp' }];
  assert.equal(pickSession(sessions, 'codex:01a09ae0-ad6f-7b01-8753-5e6b71eb1cfa', 'E:/elsewhere', 'codex').name, 'web-p2');
  assert.equal(pickSession(sessions, 'claude:01a09ae0-ad6f-7b01-8753-5e6b71eb1cfa', 'E:/elsewhere', 'codex'), null, 'another agent\'s prefix is not this peer');

  const { makeServerEngine } = await import('../src/serve.mjs');
  const asked = [];
  process.env.MAGI_AS = 'omp';
  try {
    const { engine } = makeServerEngine({
      peer: 'codex', display: 'Codex', tool: 'codex_peer', selfDefault: 'claude', replyTool: () => 'claude_peer',
      schema: { deliveries: ['auto', 'live', 'headless'], peerHint: '' },
      sessions: async ({ cwd }) => { asked.push(cwd); return sessions; },
      headless: { bin: 'codex', args: () => [], parse: () => ({ message: '', sessionId: null, errors: [] }) },
      deliverLive: async () => ({ via: 'live' }),
    });
    const ws = makeWorkspace();
    process.env.MAGI_HOME = join(ws, 'home');
    await engine.handleNote({ body: 'x', peer: 'web-p2', workingDirectory: 'E:/elsewhere' });
    await engine.handleNote({ body: 'y', workingDirectory: 'E:/elsewhere', delivery: 'live' }).catch(() => {});
    assert.deepEqual(asked, [undefined, 'E:/elsewhere'], 'named: no cwd filter; unnamed: this directory');
  } finally {
    delete process.env.MAGI_AS;
  }
});


test('the request header carries no reply route, and the CLI fallback is spelled with its full path', async () => {
  const { composeRequest } = await import('../src/protocol.mjs');
  const r = composeRequest({ taskId: 'cx-1', orchestrator: 'claude', peer: 'omp', mode: 'REVIEW', task: 't', replyVia: 'tool', replyTool: 'claude_peer', replyTo: 'uds:x' });
  assert.ok(!r.text.includes('reply_to='));
  assert.match(r.text, /node "[^"]*bin[\\/]magi\.mjs" reply --task cx-1 --round 1 --from omp --file/);
});
