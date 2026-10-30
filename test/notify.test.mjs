// A notice is for the human: stored, listed, marked read, never delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { makeWorkspace, ROOT } from './helpers/harness.mjs';
import { getRecord, setRecord } from '../src/store.mjs';

const CLI = join(ROOT, 'bin', 'magi.mjs');

async function fresh(ws) {
  process.env.MAGI_HOME = join(ws, 'home');
  mkdirSync(process.env.MAGI_HOME, { recursive: true });
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const state = await import('../src/state.mjs?' + Math.random());
  const engine = makeEngine({
    orchestrator: 'codex',
    peerName: 'claude',
    replyTool: 'codex_peer',
    resolveOrigin: async () => ({ target: { agent: 'codex', id: 'thread-1', name: 'reviewer' } }),
    pickDelivery: async () => { throw new Error('a notice picks no peer'); },
    deliverLive: async () => { throw new Error('a notice delivers nothing'); },
    deliverHeadless: async () => { throw new Error('a notice delivers nothing'); },
  });
  return { engine, state };
}

test('notify stores a redacted notice with the sender and directory, and refuses an empty body', async () => {
  const ws = makeWorkspace();
  const { engine, state } = await fresh(ws);
  const empty = await engine.handleNotify({ body: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /BAD_REQUEST/);

  const res = await engine.handleNotify({ body: 'Need a decision: ship with token=abc123 or wait?', workingDirectory: 'E:/repo', taskId: 'cx-1' });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /Noted for the operator \(n-[0-9a-f]{8}\)\. Nothing is waiting on it/);
  const id = res.structuredContent.noticeId;
  const rows = state.listNotices();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].from, 'codex');
  assert.equal(rows[0].sender, 'reviewer');
  assert.equal(rows[0].cwd, 'E:/repo');
  assert.equal(rows[0].taskId, 'cx-1');
  assert.match(rows[0].body, /\[REDACTED\]/);
  assert.equal(rows[0].readAt, null);
});

test('notices list unread first, mark read, and sweep drops only read ones that are a week old', async () => {
  const ws = makeWorkspace();
  const { state } = await fresh(ws);
  const a = state.putNotice({ from: 'claude', body: 'first' });
  const b = state.putNotice({ from: 'claude', body: 'second' });
  state.markNoticeRead(a.id);
  assert.deepEqual(state.listNotices().map((n) => n.id), [b.id, a.id]);
  assert.deepEqual(state.listNotices({ unreadOnly: true }).map((n) => n.id), [b.id]);
  assert.throws(() => state.markNoticeRead('n-nope'), (e) => e.code === 'UNKNOWN_NOTICE');

  // Age both by editing the records: a read one goes, an unread one stays.
  for (const { id } of state.listNotices()) {
    const rec = getRecord(process.env.MAGI_HOME, 'notices', id);
    rec.at -= 8 * 24 * 3600 * 1000;
    if (rec.readAt) rec.readAt -= 8 * 24 * 3600 * 1000;
    setRecord(process.env.MAGI_HOME, 'notices', rec.id, rec);
  }
  state.sweep();
  assert.deepEqual(state.listNotices().map((n) => n.id), [b.id]);

  const out = execFileSync(process.execPath, [CLI, 'notices'], { env: { ...process.env }, encoding: 'utf-8' });
  assert.match(out, new RegExp(`\\* .*${b.id}  from claude`));
  assert.match(out, /      second/);
  assert.match(execFileSync(process.execPath, [CLI, 'notices', '--read', b.id], { env: { ...process.env }, encoding: 'utf-8' }), /marked read/);
  assert.match(execFileSync(process.execPath, [CLI, 'notices'], { env: { ...process.env }, encoding: 'utf-8' }), /No unread notices/);
});
