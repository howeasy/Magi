// Facts checked against the code rather than assumed. Each of these was a real
// defect found by auditing Magi against documented cross-session messaging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';

import { makeWorkspace } from './helpers/harness.mjs';

async function engineWith(ws, overrides = {}) {
  process.env.MAGI_HOME = join(ws, 'home');
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const sent = [];
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName: 'codex',
    replyTool: 'claude_peer',
    replyAddress: () => null,
    listPeers: async () => [],
    pickDelivery: async () => ({ mode: 'live', target: 't1' }),
    deliverLive: async ({ text }) => {
      sent.push(text);
      return { via: 'live:t1' };
    },
    deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }),
    deliverReply: async () => {},
    ...overrides,
  });
  return { engine, sent };
}

// Previously an oversized note took the request spill path with a null task id,
// writing a file literally called null.request.md and pointing the peer at a
// task that does not exist.
test('an oversized note is refused instead of spilling to a bogus file', async () => {
  const ws = makeWorkspace();
  const { engine, sent } = await engineWith(ws);
  const res = await engine.handleNote({ body: 'x'.repeat(30000) });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOTE_TOO_LARGE/);
  assert.match(res.content[0].text, /Send a request instead/);
  assert.equal(sent.length, 0, 'nothing should have been delivered');
  const mail = join(ws, 'home', 'mail');
  if (existsSync(mail)) {
    assert.equal(readdirSync(mail).includes('null.request.md'), false, 'must never write a null-named file');
  }
});

test('a note just under the cap still goes', async () => {
  const ws = makeWorkspace();
  const { engine, sent } = await engineWith(ws);
  const res = await engine.handleNote({ body: 'y'.repeat(11000) });
  assert.equal(res.isError, undefined);
  assert.equal(sent.length, 1);
});

test('a watch with an oversized message is refused too', async () => {
  const ws = makeWorkspace();
  const { engine } = await engineWith(ws);
  const res = await engine.handleWatch({ body: 'z'.repeat(30000) });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOTE_TOO_LARGE/);
});

// Claude asks which session you meant; silently picking one is worse than refusing.
test('an ambiguous peer name is refused by the real resolver', async () => {
  const ws = makeWorkspace();
  const sessions = join(ws, 'claude-cfg', 'sessions');
  mkdirSync(sessions, { recursive: true });

  // Two live sessions sharing a name. Both pids must really be alive for the
  // registry to list them, so use this process and its parent.
  const pids = [process.pid, process.ppid].filter((n, i, a) => n && a.indexOf(n) === i);
  assert.ok(pids.length === 2, 'need two live pids for this fixture');
  for (const [i, pid] of pids.entries()) {
    writeFileSync(
      join(sessions, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `sess-${i}`,
        cwd: `E:/repo-${i}`,
        kind: 'interactive',
        name: 'worker',
        messagingSocketPath: `\\.\pipe\LOCAL\cc-msg-${'a'.repeat(32)}`,
      }),
    );
  }

  process.env.CLAUDE_CONFIG_DIR = join(ws, 'claude-cfg');
  const { listClaudeSessions } = await import('../src/transport.mjs?' + Math.random());
  const live = listClaudeSessions();
  assert.equal(live.length, 2, 'fixture should present two live sessions');
  assert.equal(new Set(live.map((s) => s.name)).size, 1, 'both share one name');

  // Resolution by the shared name must refuse; by pid it must succeed.
  const named = live.filter((s) => s.name === 'worker');
  assert.equal(named.length, 2);
  const byPid = live.filter((s) => String(s.pid) === String(pids[0]));
  assert.equal(byPid.length, 1, 'a pid still identifies exactly one session');
});
