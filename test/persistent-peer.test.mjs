// A named persistent peer: the first request creates a headless session, later
// requests under the same name resume it, so a long project keeps context
// without anyone opening a session for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngine } from '../src/peer.mjs';
import { readPersona, listPersonas } from '../src/state.mjs';
import { setRecord } from '../src/store.mjs';
import { textOf } from './helpers/harness.mjs';

function harness(sessionIds = ['sess-1', 'sess-2', 'sess-3'], peerName = 'codex') {
  const seen = [];
  let i = 0;
  const engine = makeEngine({
    orchestrator: 'claude',
    peerName,
    replyTool: 'claude_peer',
    pickDelivery: async ({ delivery }) => { seen.push({ delivery }); return { mode: 'headless' }; },
    deliverHeadless: async (o) => {
      seen[seen.length - 1].resumeThreadId = o.resumeThreadId;
      return { inlineReply: 'SUMMARY\nok', via: 'headless', threadId: sessionIds[i++] };
    },
  });
  return { engine, seen };
}

test('the first request creates the session and the next one resumes it', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const cwd = process.cwd();
  const { engine, seen } = harness();

  const first = await engine.handleRequest({ wait: true, task: 'start', persist: 'proj-reviewer', workingDirectory: cwd });
  assert.equal(seen[0].resumeThreadId, undefined, 'nothing to resume on the first run');
  assert.equal(readPersona('claude', cwd, 'proj-reviewer', 'codex').sessionId, 'sess-1');
  assert.equal(first.structuredContent.persona.runs, 1);
  assert.match(textOf(first), /persistent_peer="proj-reviewer"/);

  await engine.handleRequest({ wait: true, task: 'continue', persist: 'proj-reviewer', workingDirectory: cwd });
  assert.equal(seen[1].resumeThreadId, 'sess-1', 'second run resumes the first session');
  const rec = readPersona('claude', cwd, 'proj-reviewer', 'codex');
  assert.equal(rec.runs, 2);
  assert.equal(rec.sessionId, 'sess-2');
});

test('persist implies headless, so it never borrows whichever live peer exists', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const { engine, seen } = harness();
  await engine.handleRequest({ wait: true, task: 'x', persist: 'p', delivery: 'live', workingDirectory: process.cwd() });
  assert.equal(seen[0].delivery, 'headless');
});

test('a name is scoped to its working directory and to the sender', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const a = mkdtempSync(join(tmpdir(), 'cx-a-'));
  const b = mkdtempSync(join(tmpdir(), 'cx-b-'));
  const { engine } = harness();
  await engine.handleRequest({ wait: true, task: 'x', persist: 'shared', workingDirectory: a });
  await engine.handleRequest({ wait: true, task: 'x', persist: 'shared', workingDirectory: b });
  assert.equal(readPersona('claude', a, 'shared', 'codex').sessionId, 'sess-1');
  assert.equal(readPersona('claude', b, 'shared', 'codex').sessionId, 'sess-2', 'same name elsewhere is a different peer');
  assert.equal(readPersona('codex', a, 'shared', 'claude'), null, 'the other direction has its own peers');
  assert.equal(listPersonas('claude', a).length, 1);
});

test('an explicit resumeThreadId still wins over the stored session', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const cwd = process.cwd();
  const { engine, seen } = harness();
  await engine.handleRequest({ wait: true, task: 'x', persist: 'p', workingDirectory: cwd });
  await engine.handleRequest({ wait: true, task: 'x', persist: 'p', resumeThreadId: 'chosen', workingDirectory: cwd });
  assert.equal(seen[1].resumeThreadId, 'chosen');
});

test('without persist nothing is stored and no session is resumed', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const cwd = process.cwd();
  const { engine, seen } = harness();
  const res = await engine.handleRequest({ wait: true, task: 'x', delivery: 'headless', workingDirectory: cwd });
  assert.equal(seen[0].resumeThreadId, undefined);
  assert.equal(res.structuredContent.persona, null);
  assert.equal(listPersonas('claude', cwd).length, 0);
});

test('a name aimed at another harness is a different peer, so a session is never resumed across harnesses', async () => {
  process.env.MAGI_HOME = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  const cwd = process.cwd();
  const toCodex = harness(['codex-sess'], 'codex');
  const toOmp = harness(['omp-sess'], 'omp');
  await toCodex.engine.handleRequest({ wait: true, task: 'x', persist: 'reviewer', workingDirectory: cwd });
  await toOmp.engine.handleRequest({ wait: true, task: 'x', persist: 'reviewer', workingDirectory: cwd });
  assert.equal(toOmp.seen[0].resumeThreadId, undefined, "omp must not be handed codex's session id");
  assert.equal(readPersona('claude', cwd, 'reviewer', 'codex').sessionId, 'codex-sess');
  assert.equal(readPersona('claude', cwd, 'reviewer', 'omp').sessionId, 'omp-sess');
  assert.equal(listPersonas('claude', cwd, 'omp').length, 1);
  assert.equal(listPersonas('claude', cwd).length, 2);
});

test('a persona record from before the destination was recorded is listed as legacy and never resumed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cx-pp-'));
  process.env.MAGI_HOME = home;
  const cwd = process.cwd();
  const legacy = { agent: 'claude', cwd, name: 'old', sessionId: 'legacy-sess', runs: 3, updatedAt: Date.now() };
  setRecord(home, 'personas', 'claude|' + cwd.toLowerCase() + '|old', legacy);
  assert.equal(listPersonas('claude', cwd).length, 1, 'the inventory still shows it');
  assert.equal(listPersonas('claude', cwd, 'codex').length, 0, 'but no destination claims it');
  const { engine, seen } = harness();
  await engine.handleRequest({ wait: true, task: 'x', persist: 'old', workingDirectory: cwd });
  assert.equal(seen[0].resumeThreadId, undefined, 'the legacy session is not resumed');
});
