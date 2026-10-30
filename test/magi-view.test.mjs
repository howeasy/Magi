import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRequest, composeNote, composeWatch, composeQuestion, composeClarification, composeReply } from '../src/protocol.mjs';

// The Claude Code mod in claude-mod/ strips Magi's protocol text from what the
// person sees. Its patterns mirror protocol.mjs; composing every kind here keeps
// them from drifting apart. Node strips the mod's TypeScript types itself.
const ts = process.features.typescript;
const { cleanPeerText, peerHead } = ts ? await import('../claude-mod/hooks/clean-peer-text.ts') : {};
const marker = '\n<!-- magi-delivery:0f1e2d3c-0000-4000-8000-000000000001 -->';
const sender = { agent: 'claude', name: 'coordinator' };
const body = 'The body a person should read.\nSecond line.';

const cases = {
  reply: composeReply({ taskId: 'magi-11111111', round: 2, from: 'omp', sender, body }),
  note: composeNote({ taskId: 'magi-11111111', from: 'omp', sender, body }),
  question: composeQuestion({ taskId: 'magi-11111111', round: 1, questionId: 'q-1', from: 'omp', sender, body, waiting: false }),
  clarification: composeClarification({ taskId: 'magi-11111111', questionId: 'q-1', round: 1, body }),
  request: composeRequest({ taskId: 'magi-11111111', task: body, mode: 'REVIEW', orchestrator: 'claude', sender, peer: 'omp', replyTool: 'claude_peer' }).text,
  turn: composeRequest({ taskId: 'magi-11111111', task: body, mode: 'REVIEW', orchestrator: 'claude', sender, peer: 'omp', replyTool: 'claude_peer', compact: true, round: 2 }).text,
};

// The header line each kind reads as: [title, the details after it].
const expected = {
  reply: ['Reply from omp', ['magi-11111111', 'round 2']],
  note: ['Note from omp', ['magi-11111111']],
  question: ['Question from omp', ['magi-11111111', 'round 1']],
  clarification: ['Answer to your question', ['magi-11111111']],
  request: ['Request from claude', ['REVIEW', 'magi-11111111']],
  turn: ['Follow-up request from claude', ['REVIEW', 'magi-11111111', 'turn 2']],
};

for (const [kind, text] of Object.entries(cases)) {
  test(`magi-view shows a ${kind} as a plain header line and its body only`, { skip: !ts && 'this Node cannot load TypeScript' }, () => {
    const shown = cleanPeerText(text + marker);
    const [title] = expected[kind];
    assert.ok(shown.startsWith(`${title} · `), shown);
    assert.match(shown.split('\n')[0], /magi-11111111/);
    assert.ok(shown.endsWith(`\n\n${body}`), shown);
    assert.doesNotMatch(shown, /magi\/1|magi-delivery|kind="|taskId=/);
  });
}

test('magi-view leaves a watch readable and other text untouched', { skip: !ts && 'this Node cannot load TypeScript' }, () => {
  assert.equal(cleanPeerText(composeWatch({ from: 'omp', sender, replyTool: 'claude_peer' })), 'Check-in from omp\n\nasks to hear when you are free');
  assert.equal(cleanPeerText('plain words'), 'plain words');
});

// The rows name the sender from the header; a header that moved its
// from=/orchestrator= field would silently draw every row as "from a peer".
test('magi-view reads the sender, task and round off every composed header', { skip: !ts && 'this Node cannot load TypeScript' }, () => {
  for (const [kind, text] of Object.entries(cases)) {
    const head = peerHead(text + marker);
    const [title, details] = expected[kind];
    assert.equal(head.title, title, kind);
    assert.equal(head.taskId, 'magi-11111111', kind);
    // A request's round depends on the mode's default rounds; its other details are fixed.
    for (const detail of details) assert.ok(head.details.includes(detail), `${kind}: ${head.details.join(' · ')}`);
  }
  const watch = peerHead(composeWatch({ from: 'codex', sender, replyTool: 'claude_peer' }));
  assert.equal(watch.sender, 'codex');
  assert.equal(watch.title, 'Check-in from codex');
});
