// The magi-view mod's own tests feed it status fixtures written by hand, and
// one of them described a status the producer cannot print (a failed delivery
// whose card was still listed as open). Here the mod's parser and deck words
// read what `magi status --json` really prints for a seeded ledger, so the
// two cannot drift apart unnoticed. Node strips the mod's TypeScript types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { makeWorkspace, ROOT } from './helpers/harness.mjs';
import { setRecord } from '../src/store.mjs';
import * as state from '../src/state.mjs';

const ts = process.features.typescript;

test('the mod reads the real status: whose question it is, and a failed delivery that closed its card', { skip: !ts }, async () => {
  const { parseStatus, parseThread } = await import('../claude-mod/hooks/status.ts');
  const deck = await import('../claude-mod/hooks/deck.ts');
  const home = state.magiHome();
  const ws = join(makeWorkspace('view contract'), 'ws');
  mkdirSync(ws, { recursive: true });
  const now = Date.now();
  const HERE = 'sess-here';
  const mine = { agent: 'claude', sessionId: HERE, name: 'Here' };
  const card = (taskId, orchestrator, peer, rounds, extra = {}) =>
    setRecord(home, 'tasks', taskId, { taskId, orchestrator, peer, mode: 'REVIEW', maxRounds: 2, cwd: ws, rounds, ...extra });

  // This session's open card on omp.
  card('magi-aaaa0001', 'claude', 'omp', [{ round: 1, openedAt: now - 60000 }], { orchestratorTarget: mine, peerTarget: { agent: 'omp', id: 'omp-1', name: 'worker' } });
  state.recordExchange('magi-aaaa0001', { kind: 'request', round: 1, from: 'claude', to: 'omp', task: 'Review the ledger', text: 'framed' });
  // Codex's card on omp, with a question waiting on codex, not on claude.
  card('magi-bbbb0001', 'codex', 'omp', [{ round: 1, openedAt: now - 50000 }], { orchestratorTarget: { agent: 'codex', id: 'codex-thread-1', name: 'Codex coord' } });
  state.recordExchange('magi-bbbb0001', { kind: 'question', round: 1, questionId: 'q-1', from: 'omp', text: 'Which branch?' });
  // This session's card whose delivery failed, which closed its round.
  card('magi-cccc0001', 'claude', 'codex', [{ round: 1, openedAt: now - 40000, closedAt: now - 39000, closeReason: 'delivery_failed', closeCode: 'NO_LIVE_PEER' }], { orchestratorTarget: mine });
  state.recordExchange('magi-cccc0001', { kind: 'request', round: 1, from: 'claude', to: 'codex', task: 'do the thing', text: 'framed' });

  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'magi.mjs'), ...args], { encoding: 'utf-8', timeout: 60000, env: process.env });
  const printed = cli('status', '--json', '--cwd', ws);
  assert.equal(printed.status, 0, printed.stderr);
  const status = parseStatus(printed.stdout);
  assert.ok(status, 'the mod can read what the CLI printed');
  assert.equal(status.as, 'claude');

  // The question is codex's: the producer lists it, and the mod does not call it claude's.
  assert.ok(status.cards.some((c) => c.taskId === 'magi-bbbb0001' && c.turn === 'orchestrator' && c.from === 'codex'));
  const line = deck.statusLine(status, false, HERE);
  assert.doesNotMatch(line, /question/, line);
  assert.match(line, /1 working here/, line);

  // The failed delivery is an alert for a card the producer does not list as open.
  assert.equal(status.cards.some((c) => c.taskId === 'magi-cccc0001'), false, 'a closed round is not an open card');
  assert.deepEqual(deck.alerts(status, now, HERE).map((a) => [a.taskId, a.text]), [['magi-cccc0001', 'Delivery to codex failed on magi-cccc0001: NO_LIVE_PEER']]);
  assert.ok(deck.yourMove(status, HERE, now).some((row) => row.kind === 'failed' && row.taskId === 'magi-cccc0001'), 'so Your move is where it opens');
  assert.equal(deck.alerts(status, now, 'sess-other').length, 0, 'and only for the session that sent it');

  // What opening that card reads.
  const thread = cli('exchange', 'magi-cccc0001', '--json');
  assert.equal(thread.status, 0, thread.stderr);
  const read = parseThread(thread.stdout);
  assert.equal(read?.taskId, 'magi-cccc0001');
  assert.ok(read.messages.some((m) => m.kind === 'request'));
});
