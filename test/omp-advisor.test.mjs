// omp's own advisor on a headless omp worker: the flag goes on with a model that
// is never the worker's, the advisor's notes come back with the reply, and the
// server default can be set and overridden. Offline: the fake omp answers
// `config get modelRoles`, reports its worker model, and emits an advisor note
// the way omp does (a custom message in the worker's own stream,
// docs/transport-recon.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { makeWorkspace, makeFakeBins, fakeEnv, readCalls, startServer, textOf } from './helpers/harness.mjs';
import { setRecord, statement } from '../src/store.mjs';
import { headlessOmpArgs, advisorNotes, parseOmpJsonl, ompRpcSession } from '../src/omp-launch.mjs';
import { makeEngine, adviceLines } from '../src/peer.mjs';
import { processStartedAt } from '../omp/process-identity.js';

const GPT = 'openai-codex/gpt-6.1-sol:high';
const DEEPSEEK = 'openrouter/deepseek/deepseek-v4.1-flash:high';
const ROLES = JSON.stringify({ default: GPT, advisor: DEEPSEEK });
const advisory = (severity, note) => `<advisory severity="${severity}" guidance="weigh, don't blindly obey">\n${note}\n</advisory>`;
const custom = (content, customType = 'advisor') => ({ type: 'message_end', message: { role: 'custom', customType, content } });

test('--advisor is added only when asked, in review and write launches alike', () => {
  assert.ok(!headlessOmpArgs().includes('--advisor'));
  assert.ok(!headlessOmpArgs({ advisor: false, allowWrites: true }).includes('--advisor'));
  for (const opts of [{}, { allowWrites: true }, { allowWrites: true, allowCommands: true }]) {
    const args = headlessOmpArgs({ ...opts, advisor: true });
    assert.equal(args.filter((a) => a === '--advisor').length, 1);
    assert.ok(args.includes('--no-extensions') && args.includes('--approval-mode'), 'the rest of the launch is unchanged');
  }
});

test('advisorNotes reads severity, unescapes XML, defaults to nit, and keeps every element', () => {
  const content = [
    advisory('concern', 'Line 168 says &lt;7&gt; &amp; not 3.'),
    '<advisory advisor="Fixer" guidance="x">\nTidy the helper.\n</advisory>',
    advisory('blocker', 'Stop: wrong directory.'),
  ].join('\n');
  assert.deepEqual(advisorNotes({ content: [{ type: 'text', text: content }] }), [
    { severity: 'concern', note: 'Line 168 says <7> & not 3.' },
    { severity: 'nit', note: 'Tidy the helper.' },
    { severity: 'blocker', note: 'Stop: wrong directory.' },
  ]);
  assert.deepEqual(advisorNotes({ content }), advisorNotes({ content: [{ type: 'text', text: content }] }), 'a string body reads the same');
  assert.deepEqual(advisorNotes({ content: 'no elements here' }), []);
  assert.equal(advisorNotes({ content: advisory('nit', 'x'.repeat(5000)) })[0].note.length, 2001, 'a long note is cut');
});

test('a run result carries the advisor notes and the worker\'s model, and only advisor messages count', () => {
  const lines = [
    { type: 'session', id: 's1' },
    custom(advisory('concern', 'Re-read lines 166-169.')),
    custom(advisory('nit', 'ignored: not the advisor'), 'ttsr-injection'),
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }], stopReason: 'stop' } },
  ].map((l) => JSON.stringify(l)).join('\n');
  const result = parseOmpJsonl(lines);
  assert.equal(result.message, 'Answer.');
  assert.deepEqual(result.advice, [{ severity: 'concern', note: 'Re-read lines 166-169.' }]);
  assert.equal('advice' in parseOmpJsonl(''), false, 'a run with no notes keeps the result shape it always had');

  // The same through the rpc conversation a headless worker uses.
  const session = ompRpcSession({ send: async () => {}, finish: () => {}, receipt: () => {} });
  session.line(custom(advisory('blocker', 'Wrong file.')));
  assert.deepEqual(session.result().advice, [{ severity: 'blocker', note: 'Wrong file.' }]);
  assert.equal('model' in session.result(), false);
});

test('the notes become lines the orchestrator reads, redacted and cut', () => {
  assert.equal(adviceLines([], 'omp'), '');
  assert.equal(adviceLines(undefined, 'omp'), '');
  const text = adviceLines([{ severity: 'concern', note: 'token=abc123def456ghi789 leaks. ' + 'y'.repeat(600) }, { severity: 'nit', note: 'Rename it.' }], 'omp');
  assert.match(text, /omp's advisor sent the worker 2 notes during this run\./);
  assert.match(text, /They are its view, not verdicts; check what matters against the source\./);
  assert.match(text, /\n {2}- concern: /);
  assert.match(text, /\n {2}- nit: Rename it\./);
  assert.doesNotMatch(text, /abc123def456ghi789/);
  assert.ok(text.split('\n').every((l) => l.length < 560));
  assert.match(adviceLines([{ severity: 'nit', note: 'One.' }], 'omp'), /sent the worker 1 note during/);
});

async function askOmp({ args, env: extra = {}, as = 'claude', roles = ROLES }) {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env, logFile } = fakeEnv(ws);
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: as, FAKE_OMP_ROLES: roles, ...extra } });
  let res;
  try {
    res = await s.call('omp_peer', { task: 'Review the change', mode: 'REVIEW', delivery: 'headless', wait: true, workingDirectory: ws, ...args });
  } finally {
    await s.close();
  }
  return { res, calls: readCalls(logFile), call: readCalls(logFile)[0], home: env.MAGI_HOME };
}

test('advisor: true launches omp with --advisor on a model other than the worker\'s, and returns the notes under the reply', async () => {
  const { res, call, home } = await askOmp({ args: { advisor: true }, env: { FAKE_CLI_ADVISOR_NOTE: 'The read skipped lines 40-170.', FAKE_OMP_WORKER_MODEL: 'openai-codex/gpt-6.1-sol' } });
  assert.equal(res.isError, undefined, textOf(res));
  const at = call.args.indexOf('--advisor');
  assert.ok(at >= 0);
  assert.equal(call.args[at + 1], '--config');
  assert.equal(existsSync(call.configFile), false, 'the overlay is deleted with the run');
  assert.match(textOf(res), new RegExp(`omp's advisor ran on ${DEEPSEEK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(a different vendor from the worker's ${GPT}\\)`));
  assert.match(textOf(res), /omp's advisor sent the worker 1 note during this run/);
  assert.match(textOf(res), /- concern: The read skipped lines 40-170\./);
  assert.deepEqual(res.structuredContent.advice, [{ severity: 'concern', note: 'The read skipped lines 40-170.' }]);
  assert.deepEqual(res.structuredContent.advisor, { model: DEEPSEEK, differentVendor: true, worker: GPT });
  const rows = statement(home, 'SELECT value FROM exchanges WHERE task_id=? ORDER BY sequence').all(res.structuredContent.taskId).map((r) => JSON.parse(r.value));
  assert.deepEqual(rows.map((r) => r.kind), ['request', 'reply', 'advice']);
  assert.equal(rows[2].text, 'concern: The read skipped lines 40-170.');
  assert.doesNotMatch(rows[1].text, /advisor/, 'the stored reply is the worker\'s own words');
});

test('without advisor there is no flag and no advisor lines, and the overlay turns the advisor off', async () => {
  const { res, call } = await askOmp({ args: {} });
  assert.ok(!call.args.includes('--advisor'));
  // A configured advisor.enabled survives rpc's default; the run says off.
  assert.equal(call.args[call.args.indexOf('--config') + 1], call.configFile);
  assert.doesNotMatch(textOf(res), /advisor/);
  assert.equal('advice' in res.structuredContent, false, 'a reply with no notes keeps the result shape it always had');
  assert.equal('advisor' in res.structuredContent, false);
});

test('invalid effective omp configuration is an actionable refusal, never a worker launch', async () => {
  const { res, calls } = await askOmp({ args: {}, env: { FAKE_OMP_DISABLED_EXTENSIONS: 'not JSON' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /OMP_CONFIG_READ_FAILED/);
  assert.match(textOf(res), /config\.yml/);
  assert.match(textOf(res), /omp config get disabledExtensions/);
  assert.deepEqual(calls, []);
});

test('a failing omp config command preserves its file diagnostic and never starts the worker', async () => {
  const { res, calls } = await askOmp({ args: {}, env: { FAKE_OMP_CONFIG_ERROR: 'Cannot read /operator/broken.yml: invalid YAML' } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /OMP_CONFIG_READ_FAILED/);
  assert.match(textOf(res), /\/operator\/broken\.yml/);
  assert.match(textOf(res), /fix the YAML or CLI failure/);
  assert.deepEqual(calls, []);
});

test('an advisor with nothing to say still names the model that watched', async () => {
  const { res, call } = await askOmp({ args: { advisor: true } });
  assert.ok(call.args.includes('--advisor'));
  assert.match(textOf(res), /omp's advisor ran on /);
  assert.doesNotMatch(textOf(res), /advisor sent/);
  assert.equal('advice' in res.structuredContent, false);
  assert.equal(res.structuredContent.advisor.model, DEEPSEEK);
});

test('an explicit ask that cannot get a different model is refused before any worker starts, with a code and a next step', async () => {
  const same = await askOmp({ args: { advisor: true }, roles: JSON.stringify({ default: GPT, advisor: 'openrouter/openai/gpt-6.1-sol' }) });
  assert.equal(same.res.isError, true);
  assert.match(textOf(same.res), /ADVISOR_SAME_MODEL/);
  assert.match(textOf(same.res), /shares its blind spots/);
  assert.equal(same.calls.length, 0, 'no omp worker was launched');
  assert.equal(statement(same.home, "SELECT COUNT(*) AS n FROM records WHERE namespace='tasks'").get().n, 0, 'and no card was opened');

  const none = await askOmp({ args: { advisor: true }, roles: JSON.stringify({ default: GPT }) });
  assert.match(textOf(none.res), /ADVISOR_NO_MODEL/);
  const unknown = await askOmp({ args: { advisor: true }, roles: JSON.stringify({ advisor: DEEPSEEK }) });
  assert.match(textOf(unknown.res), /ADVISOR_WORKER_UNKNOWN/);
  assert.match(textOf(unknown.res), /Pass model/);
});

test('a request\'s model is the worker the advisor is compared with', async () => {
  const onAdvisorsModel = await askOmp({ args: { advisor: true, model: 'deepseek-v4.1-flash' } });
  assert.match(textOf(onAdvisorsModel.res), /ADVISOR_SAME_MODEL/);
  const elsewhere = await askOmp({ args: { advisor: true, model: 'openai/gpt-5.2' }, roles: JSON.stringify({ advisor: DEEPSEEK }) });
  assert.equal(elsewhere.res.isError, undefined, textOf(elsewhere.res));
  assert.ok(elsewhere.call.args.includes('--advisor'));
  assert.equal(elsewhere.call.args[elsewhere.call.args.indexOf('--model') + 1], 'openai/gpt-5.2');
});

test('the server\'s model list comes first, and the first that differs from the worker is used', async () => {
  const { res, call } = await askOmp({ args: { advisor: true }, env: { MAGI_OMP_ADVISOR_MODELS: `${GPT}, anthropic/claude-opus-5` } });
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(call.configText, /anthropic\/claude-opus-5/, 'the worker\'s own model in the list is skipped, and the list outranks omp\'s role');
});

test('after the run, omp\'s own report of the worker\'s model is checked against the advisor\'s', async () => {
  const { res } = await askOmp({ args: { advisor: true }, env: { FAKE_OMP_WORKER_MODEL: 'openrouter/deepseek/deepseek-v4.1-flash' } });
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(textOf(res), /is the model the worker actually ran on \(openrouter\/deepseek\/deepseek-v4\.1-flash\); its notes are less independent/);
});

test('MAGI_OMP_ADVISOR turns it on for every headless omp worker, and advisor: false turns it off again', async () => {
  const on = await askOmp({ args: {}, env: { MAGI_OMP_ADVISOR: '1' } });
  assert.ok(on.call.args.includes('--advisor'));
  const off = await askOmp({ args: { advisor: false }, env: { MAGI_OMP_ADVISOR: 'on' } });
  assert.ok(!off.call.args.includes('--advisor'));
  const unset = await askOmp({ args: {}, env: { MAGI_OMP_ADVISOR: 'no' } });
  assert.ok(!unset.call.args.includes('--advisor'), 'only 1, true, on or yes turn it on');
});

test('the server default that cannot get a different model skips the advisor, runs the worker, and says so', async () => {
  const { res, call } = await askOmp({ args: {}, env: { MAGI_OMP_ADVISOR: '1' }, roles: JSON.stringify({ default: GPT, advisor: GPT }) });
  assert.equal(res.isError, undefined, textOf(res));
  assert.ok(!call.args.includes('--advisor'), 'the worker ran without an advisor');
  assert.match(textOf(res), /advisor skipped \(ADVISOR_SAME_MODEL\): .*shares its blind spots/s);
});

test('advisor: true to a live omp session is not applied, and the caller is told', async () => {
  const ws = makeWorkspace();
  const { paths } = makeFakeBins(ws, ['omp']);
  const { env } = fakeEnv(ws);
  setRecord(env.MAGI_HOME, 'agents', String(process.pid), { agent: 'omp', pid: process.pid, processStartedAt: processStartedAt(process.pid), sessionId: 'omp-sess-1', name: 'omp-main', sessionFile: null, cwd: ws, startedAt: Date.now() });
  const s = await startServer('omp', { cwd: ws, env: { ...env, OMP_BIN: paths.omp, MAGI_AS: 'claude', FAKE_OMP_ROLES: ROLES } });
  let res;
  try {
    res = await s.call('omp_peer', { task: 'Review', mode: 'REVIEW', wait: false, advisor: true, workingDirectory: ws });
  } finally {
    await s.close();
  }
  assert.equal(res.isError, undefined, textOf(res));
  assert.match(res.structuredContent.warning, /advisor not applied: a live omp session keeps its own settings/);
});

test('another peer has no advisor: the engine refuses it by name rather than dropping it', async () => {
  const engine = makeEngine({ orchestrator: 'claude', peerName: 'codex', replyTool: 'claude_peer', pickDelivery: async () => ({ mode: 'headless' }), deliverHeadless: async () => { throw new Error('must not launch'); } });
  const res = await engine.handleRequest({ task: 'Review', advisor: true });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /ADVISOR_UNSUPPORTED/);
  assert.match(textOf(res), /omp_peer/);
});
