// The desktop apps: the marker, the three outcomes, recovery. Offline: the
// launcher and the Codex calls are injected, Claude transcripts are real
// files under a scratch CLAUDE_CONFIG_DIR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { spawnPeer, appUrl, bootstrapPrompt, underDir } from '../src/spawn.mjs';
import { firstUserMessage } from '../src/session-tail.mjs';
import { makeWorkspace, makeFakeBins, fakeEnv } from './helpers/harness.mjs';

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// A fake Codex: a thread list the test mutates, a name setter that records
// (or fails), and first-user-message texts by thread id.
function fakeCodex({ threads = [], firsts = {}, nameFails = false } = {}) {
  const named = [];
  const io = {
    list: async () => threads.map((t) => ({ ...t })),
    name: async (id, name) => {
      if (nameFails) throw new Error('nope');
      named.push([id, name]);
      const t = threads.find((x) => x.id === id);
      if (t) t.name = name;
    },
    first: async (id) => firsts[id] ?? { text: null, reason: 'none' },
  };
  return { threads, named, io };
}
// A Claude transcript under CLAUDE_CONFIG_DIR for a registry-shaped row.
function writeTranscript(cfg, row, lines) {
  const slug = row.cwd.replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(join(cfg, 'projects', slug), { recursive: true });
  writeFileSync(join(cfg, 'projects', slug, `${row.sessionId}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const markerOf = (url, key) => new URL(url).searchParams.get(key).split(' ')[0];

test('firstUserMessage reads forwards: the first human text, minus leading system reminders; none / malformed / scan-limit are told apart', () => {
  const ws = makeWorkspace();
  const f = join(ws, 't.jsonl');
  writeFileSync(f, [JSON.stringify({ type: 'attachment' }), JSON.stringify(user('<system-reminder>\nin a worktree\n</system-reminder>\n\nmagi-spawn:abc first words')), ...Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2000) + i } })), JSON.stringify(user('a later message'))].join('\n') + '\n');
  assert.deepEqual(firstUserMessage(f), { text: 'magi-spawn:abc first words' });
  writeFileSync(f, JSON.stringify({ type: 'attachment' }) + '\n' + JSON.stringify(user('half writ')).slice(0, 20));
  assert.deepEqual(firstUserMessage(f), { text: null, reason: 'none' }, 'an incomplete trailing line is not a record yet');
  writeFileSync(f, '{not json}\n' + JSON.stringify(user('magi-spawn:abc later')) + '\n');
  assert.deepEqual(firstUserMessage(f), { text: null, reason: 'malformed' }, 'a complete unparsable line before the first human record is not skipped');
  writeFileSync(f, Array.from({ length: 300 }, () => JSON.stringify({ type: 'assistant', message: { content: 'y'.repeat(1000) } })).join('\n') + '\n' + JSON.stringify(user('magi-spawn:abc too late')) + '\n');
  assert.deepEqual(firstUserMessage(f), { text: null, reason: 'scan-limit' });
  assert.deepEqual(firstUserMessage(join(ws, 'missing.jsonl')), { text: null, reason: 'none' });
});

test('the app URLs carry the folder and the marker prompt intact; underDir accepts the folder and a worktree the app made under it', () => {
  const prompt = bootstrapPrompt('11111111-2222-3333-4444-555555555555', 'gui1');
  assert.ok(prompt.startsWith('magi-spawn:11111111-2222-3333-4444-555555555555 '));
  assert.ok(prompt.length < 300 && !prompt.includes('E:'));
  const c = new URL(appUrl({ harness: 'claude', cwd: 'E:\\my project', prompt: 'A & B, café' }));
  assert.equal(c.protocol, 'claude:');
  assert.equal(c.searchParams.get('folder'), 'E:\\my project');
  assert.equal(c.searchParams.get('q'), 'A & B, café');
  const x = new URL(appUrl({ harness: 'codex', cwd: 'E:\\p', prompt: 'hi' }));
  assert.equal(x.host + x.pathname, 'threads/new');
  assert.deepEqual([x.searchParams.get('path'), x.searchParams.get('prompt')], ['E:\\p', 'hi']);
  assert.throws(() => appUrl({ harness: 'omp', cwd: 'x', prompt: 'y' }), (e) => e.code === 'SPAWN_UNSUPPORTED');
  assert.ok(underDir('c:/work/Magi/.claude/worktrees/magi-peer-1', 'C:\\work\\Magi'));
  assert.ok(underDir('C:\\work\\Magi\\', 'c:/work/magi'));
  assert.ok(!underDir('C:\\work\\Magi2', 'C:\\work\\Magi'));
});

test('a Codex launch claims only the fresh thread that carries its marker, names it, and never the other one; none is pending, two is ambiguous', async () => {
  const ws = makeWorkspace();
  const urls = [];
  const codex = fakeCodex({ threads: [{ id: 'old', name: 'x', cwd: ws }] });
  // Two threads appear after the launch; only t2's first message carries the marker.
  const launch = async (u) => {
    urls.push(u);
    const m = markerOf(u, 'prompt');
    codex.threads.push({ id: 't1', name: null, cwd: ws }, { id: 't2', name: 'Untitled', cwd: ws });
    codex.io.first = async (tid) => (tid === 't2' ? { text: `${m} rest` } : { text: 'something else' });
  };
  const row = await spawnPeer({ harness: 'codex', name: 'gui2', cwd: ws, app: true, sessions: async () => [], deadlineMs: 1500, openUrl: launch, codex: codex.io });
  assert.equal(row.pending, false);
  assert.deepEqual([row.id, row.name, row.requestedName, row.where, row.appLink], ['t2', 'gui2', 'gui2', 'the Codex app', 'codex://threads/t2']);
  assert.deepEqual(codex.named, [['t2', 'gui2']], 't1 was fresh too and untouched');
  assert.match(urls[0], /^codex:\/\/threads\/new\?path=/);

  const none = fakeCodex({ threads: [] });
  const p = await spawnPeer({ harness: 'codex', name: 'gui3', cwd: ws, app: true, sessions: async () => [], deadlineMs: 600, openUrl: async () => { none.threads.push({ id: 't9', name: null, cwd: ws }); }, codex: none.io });
  assert.equal(p.pending, true);
  assert.ok(p.spawnId && p.next.includes(`--resume ${p.spawnId}`) && p.next.includes(`--cwd "${ws}"`) && p.next.includes('Do not launch another session'));
  assert.deepEqual(none.named, [], 'a fresh thread without the marker is not renamed');

  const two = fakeCodex({ threads: [] });
  await assert.rejects(
    spawnPeer({ harness: 'codex', name: 'gui4', cwd: ws, app: true, sessions: async () => [], deadlineMs: 800, openUrl: async (u) => { const m = markerOf(u, 'prompt'); two.threads.push({ id: 'a', cwd: ws }, { id: 'b', cwd: ws }); two.io.first = async () => ({ text: `${m} x` }); }, codex: two.io }),
    (e) => e.code === 'SPAWN_AMBIGUOUS' && /a, b/.test(e.message),
  );
});

test('a Claude app launch is matched by the marker in its own transcript, in the folder or a worktree under it; ready with the observed name, never the requested one; a pre-existing row is never matched', async () => {
  const ws = makeWorkspace();
  const cfg = join(ws, 'claude-cfg');
  const folder = join(ws, 'proj');
  mkdirSync(folder, { recursive: true });
  const rows = [{ name: 'old title', sessionId: 'old', cwd: folder, entrypoint: 'claude-desktop' }];
  const sessions = async () => rows.map((r) => ({ ...r }));
  // The app's record for the new session names its app id; the link comes from there.
  const store = join(cfg, 'app-store', 'a', 'o');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'local_N1.json'), JSON.stringify({ sessionId: 'local_N1', cliSessionId: 'new1' }));
  const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_APP_SESSIONS_DIR: join(cfg, 'app-store') };
  const urls = [];
  const launch = async (u) => {
    urls.push(u);
    const q = new URL(u).searchParams.get('q');
    const row = { name: 'magi-peer-gui1-1-a8', sessionId: 'new1', cwd: join(folder, '.claude', 'worktrees', 'magi-peer-gui1-1'), entrypoint: 'claude-desktop' };
    writeTranscript(cfg, row, [{ type: 'attachment' }, user(`<system-reminder>\nworktree\n</system-reminder>\n\n${q}`)]);
    writeTranscript(cfg, rows[0], [user(q)]); // even carrying the marker, a row that was there before the launch is not a candidate
    rows.push(row);
  };
  const row = await withEnv(env, () => spawnPeer({ harness: 'claude', name: 'gui1', cwd: folder, app: true, sessions, deadlineMs: 1500, openUrl: launch }));
  assert.equal(row.pending, false);
  assert.deepEqual([row.id, row.name, row.requestedName, row.where, row.appLink], ['new1', 'magi-peer-gui1-1-a8', 'gui1', 'the Claude Code app', 'claude://claude.ai/epitaxy/local_N1']);
  assert.match(urls[0], /^claude:\/\/code\/new\?folder=/);
  // A row with no name yet is ready by id.
  rows.length = 0;
  const bare = { name: null, sessionId: 'new2', cwd: folder, entrypoint: 'claude-desktop' };
  const r2 = await withEnv(env, () => spawnPeer({ harness: 'claude', name: 'gui1', cwd: folder, app: true, sessions, deadlineMs: 1500, openUrl: async (u) => { writeTranscript(cfg, bare, [user(new URL(u).searchParams.get('q'))]); rows.push(bare); } }));
  assert.deepEqual([r2.id, r2.name, r2.requestedName, r2.appLink], ['new2', null, 'gui1', null], 'a session the app has not recorded yet gets no link, not a guessed one');
});

test('the three outcomes: settings with app are refused before launch, omp has no app, a launcher failure is SPAWN_FAILED, a deadline is pending (not an error) for the terminal path too', async () => {
  const ws = makeWorkspace();
  let launched = 0;
  const launch = async () => { launched++; };
  await assert.rejects(spawnPeer({ harness: 'omp', name: 'o', cwd: ws, app: true, permissionMode: 'x', sessions: async () => [], openUrl: launch }), (e) => e.code === 'SPAWN_UNSUPPORTED');
  await assert.rejects(spawnPeer({ harness: 'claude', name: 'c', cwd: ws, app: true, permissionMode: 'acceptEdits', sessions: async () => [], openUrl: launch }), (e) => e.code === 'BAD_REQUEST' && /permissionMode and model/.test(e.message));
  await assert.rejects(spawnPeer({ harness: 'codex', name: 'c', cwd: ws, app: true, model: 'o3', sessions: async () => [], openUrl: launch, codex: fakeCodex().io }), (e) => e.code === 'BAD_REQUEST');
  assert.equal(launched, 0);
  await assert.rejects(spawnPeer({ harness: 'claude', name: 'c', cwd: ws, app: true, sessions: async () => [], openUrl: async () => { throw Object.assign(new Error('no handler'), { code: 'SPAWN_FAILED' }); } }), (e) => e.code === 'SPAWN_FAILED');
  // Terminal Claude that never registers: pending, by name, no spawnId.
  const { paths } = makeFakeBins(ws, ['claude']);
  const { env } = fakeEnv(ws);
  const p = await withEnv({ ...env, WT_BIN: join(ws, 'no-wt.exe'), CLAUDE_BIN: paths.claude }, () => spawnPeer({ harness: 'claude', name: 'slow', cwd: ws, sessions: async () => [], deadlineMs: 600 }));
  assert.equal(p.pending, true);
  assert.equal(p.spawnId, null);
  assert.match(p.next, /kind:"peers" lists it by name/);
});

test('recovery by spawnId launches nothing, claims the marked thread, assigns the name (replacing its title), refuses a name held by another thread, is idempotent, and is refused for omp', async () => {
  const ws = makeWorkspace();
  const id = '99999999-1111-2222-3333-444444444444';
  const codex = fakeCodex({ threads: [{ id: 'k1', name: 'App title', cwd: ws }, { id: 'k2', name: 'gui5', cwd: ws }], firsts: { k1: { text: `magi-spawn:${id} hello` }, k2: { text: 'other' } } });
  let launched = 0;
  const launch = async () => { launched++; };
  await assert.rejects(spawnPeer({ harness: 'codex', name: 'gui5', cwd: ws, spawnId: id, sessions: async () => [], openUrl: launch, codex: codex.io }), (e) => e.code === 'NAME_TAKEN' && /k1/.test(e.message));
  const r = await spawnPeer({ harness: 'codex', name: 'gui6', cwd: ws, spawnId: id, app: true, permissionMode: 'ignored', sessions: async () => [], openUrl: launch, codex: codex.io });
  assert.equal(launched, 0);
  assert.deepEqual([r.pending, r.recovered, r.id, r.name, r.requestedName, r.appLink, r.where, r.created], [false, true, 'k1', 'gui6', 'gui6', 'codex://threads/k1', undefined, undefined]);
  const again = await spawnPeer({ harness: 'codex', name: 'gui6', cwd: ws, spawnId: id, sessions: async () => [], openUrl: launch, codex: codex.io });
  assert.deepEqual([again.id, again.name], ['k1', 'gui6']);
  const nothing = await spawnPeer({ harness: 'codex', name: 'gui7', cwd: ws, spawnId: 'unknown-id', sessions: async () => [], openUrl: launch, codex: codex.io });
  assert.equal(nothing.pending, true);
  await assert.rejects(spawnPeer({ harness: 'omp', name: 'o', cwd: ws, spawnId: id, sessions: async () => [] }), (e) => e.code === 'SPAWN_UNSUPPORTED');
  // A rename that fails keeps the observed title; a thread with none is null.
  const failing = fakeCodex({ threads: [{ id: 'k3', name: 'Kept title', cwd: ws }, { id: 'k4', name: null, cwd: ws }], firsts: { k3: { text: `magi-spawn:${id} x` } }, nameFails: true });
  const kept = await spawnPeer({ harness: 'codex', name: 'gui8', cwd: ws, spawnId: id, sessions: async () => [], codex: failing.io });
  assert.deepEqual([kept.name, kept.requestedName], ['Kept title', 'gui8']);
  failing.io.first = async (tid) => (tid === 'k4' ? { text: `magi-spawn:${id} y` } : { text: 'no' });
  const bare = await spawnPeer({ harness: 'codex', name: 'gui8', cwd: ws, spawnId: id, sessions: async () => [], codex: failing.io });
  assert.deepEqual([bare.id, bare.name], ['k4', null]);
});

test('an unreadable candidate is reported, not polled; the engine text advertises a pending launch without a name, and a nameless ready one by id', async () => {
  const ws = makeWorkspace();
  const codex = fakeCodex({ threads: [], firsts: { u1: { text: null, reason: 'scan-limit' } } });
  const p = await spawnPeer({ harness: 'codex', name: 'gui9', cwd: ws, app: true, sessions: async () => [], deadlineMs: 600, openUrl: async () => { codex.threads.push({ id: 'u1', cwd: ws }); }, codex: codex.io });
  assert.equal(p.pending, true);
  assert.match(p.next, /u1 \(scan-limit\).*Retrying will not fix/);
  const { makeEngine } = await import('../src/peer.mjs?' + Math.random());
  const base = { orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer', pickDelivery: async () => ({ mode: 'headless' }), deliverLive: async () => {}, deliverHeadless: async () => ({ inlineReply: 'x', via: 'headless' }) };
  const res = await makeEngine({ ...base, spawn: async () => p }).handleSpawn({ name: 'gui9', workingDirectory: ws, app: true });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^codex "gui9" is not claimed yet \(opened in the Codex app\)\. /);
  assert.equal(res.structuredContent.pending, true);
  const ready = await makeEngine({ ...base, spawn: async () => ({ pending: false, id: 'k1', name: null, requestedName: 'gui9', cwd: ws, where: 'the Codex app' }) }).handleSpawn({ name: 'gui9', workingDirectory: ws });
  assert.match(ready.content[0].text, /Address it with peer:"k1" \(it has no name yet; "gui9" was asked for\)/);
});
