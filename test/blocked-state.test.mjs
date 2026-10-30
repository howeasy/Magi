// What a session waits on, in its harness's words, reaches `peers` and the
// deck: Claude's registry `waitingFor` and `needs` (REA 2026-10-16), omp's
// approval of a named tool (test/shim-agent.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { peerState, describeState } from '../src/serve.mjs';

test('a Claude session waiting on its user says what it needs, in its own words', () => {
  const st = peerState({ status: 'waiting', waitingFor: 'permission prompt', needs: 'choose: allow or deny the computer-use action' });
  assert.equal(st.state, 'blocked');
  assert.equal(describeState(st), 'blocked: permission prompt (choose: allow or deny the computer-use action)');
  // Without `needs` (an older Claude), the label is as before.
  assert.equal(describeState(peerState({ status: 'waiting', waitingFor: 'dialog open' })), 'blocked: dialog open');
  // `needs` left over on a session that is working again says nothing.
  assert.equal(peerState({ status: 'busy', needs: 'stale' }).needs, undefined);
});
