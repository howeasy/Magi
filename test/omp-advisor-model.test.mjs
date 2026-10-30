// Which model omp's advisor runs on: never the worker's own, a different vendor
// when there is one. Pure functions plus the overlay file; no omp is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setRecord } from '../src/store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseSelector, sameModel, chooseAdvisor, planAdvisor, ompModelRoles, forgetModelRoles,
  writeAdvisorOverlay, advisorLine, advisorDefaultOn, ADVISOR_MODELS_ENV, advisorSyncBacklog, setAdvisorSyncBacklog,
} from '../src/omp-advisor.mjs';
import { headlessOmpArgs } from '../src/omp-launch.mjs';

const GPT = 'openai-codex/gpt-6.1-sol:high';
const DEEPSEEK = 'openrouter/deepseek/deepseek-v4.1-flash:high';
const OPUS = 'anthropic/claude-opus-5';

test('a selector reads as its model and its maker, whatever route and thinking level it names', () => {
  assert.deepEqual(parseSelector(GPT), { raw: GPT, alias: false, base: 'gpt-6.1-sol', vendor: 'openai' });
  assert.equal(parseSelector(DEEPSEEK).vendor, 'deepseek', 'a model reached through a router is its maker\'s');
  assert.equal(parseSelector(DEEPSEEK).base, 'deepseek-v4.1-flash');
  assert.equal(parseSelector('claude-haiku-4-5-20251001').base, 'claude-haiku-4-5', 'a dated name is its undated model');
  assert.equal(parseSelector('claude-fable-5').vendor, 'anthropic');
  assert.equal(parseSelector('google-vertex/gemini-3-pro').vendor, 'google');
  assert.equal(parseSelector('someprovider/unheard-of-1').vendor, 'someprovider', 'an unrecognised name falls back to its provider');
  assert.equal(parseSelector('unheard-of-1').vendor, 'unknown');
  assert.equal(parseSelector('@slow').alias, true, 'a role alias is only omp\'s to expand');
  assert.equal(parseSelector(`${GPT}, ${DEEPSEEK}`).raw, GPT, 'a role list reads as its first choice');
  assert.equal(parseSelector(''), null);
  assert.equal(parseSelector(undefined), null);
});

test('the same model by another route or thinking level is the same model; a family word names what contains it', () => {
  const same = (a, b) => sameModel(parseSelector(a), parseSelector(b));
  assert.equal(same('openai-codex/gpt-6.1-sol:high', 'openrouter/openai/gpt-6.1-sol:low'), true);
  assert.equal(same('claude-haiku-4-5', 'claude-haiku-4-5-20251001'), true);
  assert.equal(same('opus', 'anthropic/claude-opus-5'), true, 'a bare family word with no digit is whatever matches it');
  assert.equal(same('anthropic/claude-opus-5', 'anthropic/claude-opus-5-5'), false, 'two numbered models are two models');
  assert.equal(same('gpt-5', 'gpt-5.6-luna'), false);
  assert.equal(same(GPT, DEEPSEEK), false);
  assert.equal(sameModel(null, parseSelector(GPT)), false);
});

test('chooseAdvisor takes the first candidate that is not the worker, a different vendor first', () => {
  const worker = parseSelector(GPT);
  const crossVendor = chooseAdvisor({ worker, candidates: ['openai-codex/gpt-5.6-luna', DEEPSEEK] });
  assert.deepEqual([crossVendor.ok, crossVendor.model, crossVendor.differentVendor], [true, DEEPSEEK, true], 'a different vendor beats an earlier same-vendor model');
  const sameVendorOnly = chooseAdvisor({ worker, candidates: ['openai-codex/gpt-5.6-luna'] });
  assert.deepEqual([sameVendorOnly.ok, sameVendorOnly.differentVendor], [true, false], 'a different model of the same vendor still qualifies, and says it is not a different vendor');
  assert.equal(chooseAdvisor({ worker, candidates: [GPT, OPUS] }).model, OPUS, 'the worker\'s own model is skipped');
  assert.equal(chooseAdvisor({ worker, candidates: [DEEPSEEK, OPUS] }).model, DEEPSEEK, 'preference order holds among different vendors');
  const unknownVendor = chooseAdvisor({ worker: parseSelector('mystery-1'), candidates: [DEEPSEEK] });
  assert.deepEqual([unknownVendor.ok, unknownVendor.differentVendor], [true, false], 'a vendor nobody can name is never called different');
});

test('chooseAdvisor refuses, with a code and a next step, when no different model is available', () => {
  const worker = parseSelector(GPT);
  const same = chooseAdvisor({ worker, candidates: [GPT, 'openrouter/openai/gpt-6.1-sol'] });
  assert.equal(same.code, 'ADVISOR_SAME_MODEL');
  assert.match(same.message, /shares its blind spots/);
  assert.match(same.message, new RegExp(ADVISOR_MODELS_ENV));
  const none = chooseAdvisor({ worker, candidates: [] });
  assert.equal(none.code, 'ADVISOR_NO_MODEL');
  assert.match(none.message, /restart the harness/);
  assert.equal(chooseAdvisor({ worker, candidates: ['@slow'] }).code, 'ADVISOR_NO_MODEL', 'an alias cannot be compared, so it is not a candidate');
  assert.equal(chooseAdvisor({ worker, candidates: ['has "quotes"'] }).code, 'ADVISOR_NO_MODEL', 'a name that cannot sit in YAML is not a candidate');
  const unknown = chooseAdvisor({ worker: null, candidates: [DEEPSEEK] });
  assert.equal(unknown.code, 'ADVISOR_WORKER_UNKNOWN');
  assert.match(unknown.message, /Pass model/);
});

test('planAdvisor: the worker is the request\'s model, else omp\'s default; candidates are the server list, then omp\'s advisor role', async () => {
  const roles = { default: GPT, advisor: DEEPSEEK };
  assert.equal((await planAdvisor({ roles, env: {} })).model, DEEPSEEK, 'omp\'s own advisor role, against its default worker');
  assert.equal((await planAdvisor({ roles, env: { [ADVISOR_MODELS_ENV]: `${OPUS}, ${DEEPSEEK}` } })).model, OPUS, 'the server list comes first');
  assert.equal((await planAdvisor({ roles: { default: GPT, advisor: GPT }, env: {} })).code, 'ADVISOR_SAME_MODEL', 'omp\'s advisor role equal to its default worker');
  assert.equal((await planAdvisor({ roles, model: 'deepseek-v4.1-flash', env: {} })).code, 'ADVISOR_SAME_MODEL', 'a request that moves the worker onto the advisor\'s model');
  assert.equal((await planAdvisor({ roles: { default: GPT }, model: 'opus', env: { [ADVISOR_MODELS_ENV]: OPUS } })).code, 'ADVISOR_SAME_MODEL', 'a family word on the request matches the only candidate');
  assert.equal((await planAdvisor({ roles, model: 'opus', env: { [ADVISOR_MODELS_ENV]: OPUS } })).model, DEEPSEEK, 'and the next candidate is used when there is one');
  assert.equal((await planAdvisor({ roles, resuming: true, env: {} })).code, 'ADVISOR_WORKER_UNKNOWN', 'a resumed session keeps a model that is not known here');
  assert.equal((await planAdvisor({ roles, resuming: true, model: OPUS, env: {} })).model, DEEPSEEK, 'unless the request pins the worker');
  assert.equal((await planAdvisor({ roles: { advisor: DEEPSEEK }, env: {} })).code, 'ADVISOR_WORKER_UNKNOWN', 'no default role and no model on the request');
  assert.equal((await planAdvisor({ roles: null, env: {} })).code, 'ADVISOR_WORKER_UNKNOWN', 'omp\'s config could not be read');
});

test('omp\'s roles are read from one line of JSON, once, and an unreadable answer is unknown', async () => {
  forgetModelRoles();
  let asked = 0;
  const query = async () => { asked++; return `${JSON.stringify({ advisor: DEEPSEEK, default: GPT })}\n`; };
  assert.deepEqual(await ompModelRoles(query), { advisor: DEEPSEEK, default: GPT });
  assert.deepEqual(await ompModelRoles(query), { advisor: DEEPSEEK, default: GPT });
  assert.equal(asked, 1, 'cached');
  forgetModelRoles();
  assert.equal(await ompModelRoles(async () => 'not json'), null);
  forgetModelRoles();
  assert.equal(await ompModelRoles(async () => { throw new Error('no omp'); }), null);
  forgetModelRoles();
});

// omp 18.14.0 wakes a finished worker for a `concern` note by default; Magi's
// run is one request, so the overlay keeps the pre-18.14 behaviour.
test('the overlay pins advisor.continueSeverity to blocker, with the advisor on or off', async () => {
  for (const model of [null, DEEPSEEK]) {
    const overlay = await writeAdvisorOverlay(model, { query: async () => '[]' });
    try {
      assert.equal(JSON.parse(readFileSync(overlay.path, 'utf-8')).advisor.continueSeverity, 'blocker');
    } finally {
      overlay.cleanup();
    }
  }
});

test('an unset advisor setting and overlay do not create a remote ledger', async () => {
  const previous = process.env.MAGI_HOME;
  const home = join(mkdtempSync(join(tmpdir(), 'magi-unset-advisor-')), 'home');
  process.env.MAGI_HOME = home;
  let overlay;
  try {
    assert.equal(advisorSyncBacklog(), null);
    overlay = await writeAdvisorOverlay(null, { query: async () => '[]' });
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(overlay.path, 'utf-8')).advisor, 'syncBacklog'), false);
    assert.equal(existsSync(home), false, 'reading an unset setting did not create its home or ledger');
  } finally {
    overlay?.cleanup();
    if (previous === undefined) delete process.env.MAGI_HOME;
    else process.env.MAGI_HOME = previous;
  }
});

test('an overlay preserves each project disabled list and treats hostile extension ids as data', async () => {
  const hostile = 'extension"\nadvisor:\n  enabled: true';
  for (const [cwd, disabled] of [['project-a', ['custom:one', hostile, 'mcp:magi']], ['project-b', ['custom:two']]]) {
    const overlay = await writeAdvisorOverlay(null, { cwd, query: async (actual) => {
      assert.equal(actual, cwd);
      return JSON.stringify(disabled);
    } });
    try {
      const parsed = JSON.parse(readFileSync(overlay.path, 'utf-8'));
      for (const extension of disabled) assert.ok(parsed.disabledExtensions.includes(extension), 'operator exclusions survive the overlay');
      assert.deepEqual(parsed.advisor, { enabled: false, continueSeverity: 'blocker' });
      assert.equal('modelRoles' in parsed, false);
    } finally { overlay.cleanup(); }
    assert.equal(existsSync(overlay.path), false);
  }
});

test('advisor model injection is refused before querying omp or writing an overlay', async () => {
  for (const bad of ['x"\nmodelRoles: {}', 'a b', '', 'x\\y']) {
    await assert.rejects(writeAdvisorOverlay(bad, { query: () => assert.fail('invalid model queried omp') }), { code: 'BAD_REQUEST' });
  }
});

test('an unreadable disabled list fails closed with the code, config file and repair command', async () => {
  for (const query of [
    async () => 'not JSON', async () => '{}', async () => '["custom:one", 1]',
    async () => { throw new Error('Failed to read /operator/custom.yml'); },
  ]) {
    await assert.rejects(writeAdvisorOverlay(null, { cwd: process.cwd(), query }), (error) => {
      assert.equal(error.code, 'OMP_CONFIG_READ_FAILED');
      assert.match(error.message, /OMP_CONFIG_READ_FAILED/);
      assert.match(error.message, /config\.yml/);
      assert.match(error.message, /omp config get disabledExtensions/);
      return true;
    });
  }
});

test('only the operator can persist a valid advisor backlog, and reset leaves the key unwritten', async (t) => {
  t.after(() => setAdvisorSyncBacklog(null));
  const query = async () => '[]';
  const read = async () => {
    const overlay = await writeAdvisorOverlay(DEEPSEEK, { query });
    try { return JSON.parse(readFileSync(overlay.path, 'utf-8')); }
    finally { overlay.cleanup(); }
  };
  setAdvisorSyncBacklog(null);
  assert.equal(Object.hasOwn((await read()).advisor, 'syncBacklog'), false);
  for (const value of ['off', '1', '3', '5', 'strict']) {
    setAdvisorSyncBacklog(value);
    assert.equal((await read()).advisor.syncBacklog, value);
  }
  const cli = fileURLToPath(new URL('../bin/magi.mjs', import.meta.url));
  const run = (value, depth = '0') => spawnSync(process.execPath, [cli, 'advisor-sync', value], {
    env: { ...process.env, PEER_DEPTH: depth }, encoding: 'utf-8',
  });
  const hostile = 'strict"\nadvisor:\n  enabled: true';
  const rejected = run(hostile);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /BAD_REQUEST/);
  assert.equal(advisorSyncBacklog(), 'strict');
  const worker = run('off', '1');
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /ADVISOR_SETTING_REFUSED/);
  assert.equal(advisorSyncBacklog(), 'strict');
  assert.equal(run('default').status, 0);
  assert.equal(Object.hasOwn((await read()).advisor, 'syncBacklog'), false);
  // A corrupted persisted setting cannot become YAML or alter enabled/model.
  setRecord(process.env.MAGI_HOME, 'settings', 'omp-advisor-sync', { value: hostile });
  await assert.rejects(writeAdvisorOverlay(DEEPSEEK, { query }), { code: 'BAD_REQUEST' });
});

test('--config is given whenever there is an overlay, with or without --advisor', () => {
  const args = headlessOmpArgs({ advisor: true, advisorConfig: '/tmp/o.yml' });
  assert.deepEqual(args.slice(args.indexOf('--advisor')), ['--advisor', '--config', '/tmp/o.yml', '--tools', 'read,grep,glob,web_search', '--approval-mode', 'always-ask']);
  const off = headlessOmpArgs({ advisorConfig: '/tmp/o.yml' });
  assert.deepEqual(off.slice(off.indexOf('--config'), off.indexOf('--config') + 2), ['--config', '/tmp/o.yml']);
  assert.ok(!off.includes('--advisor'));
  assert.ok(!headlessOmpArgs({ advisor: true }).includes('--config'));
});

test('the line the caller reads says which model reviewed, and warns when omp shows it matched the worker after all', () => {
  const plan = chooseAdvisor({ worker: parseSelector(GPT), candidates: [DEEPSEEK] });
  assert.equal(advisorLine(plan, 'openai-codex/gpt-6.1-sol'), `\n[magi] omp's advisor ran on ${DEEPSEEK} (a different vendor from the worker's ${GPT}).`);
  assert.equal(advisorLine(plan, undefined), advisorLine(plan, 'openai-codex/gpt-6.1-sol'));
  assert.match(advisorLine(plan, 'openrouter/deepseek/deepseek-v4.1-flash'), /is the model the worker actually ran on .* less independent\. Pass model to pin the worker/);
  const sameVendor = chooseAdvisor({ worker: parseSelector(GPT), candidates: ['openai-codex/gpt-5.6-luna'] });
  assert.match(advisorLine(sameVendor), /the same vendor as the worker's .*, but a different model/);
  assert.equal(advisorLine(null), '');
});

test('only 1, true, on or yes turn the server default on', () => {
  for (const v of ['1', 'true', 'ON', 'Yes']) assert.equal(advisorDefaultOn({ MAGI_OMP_ADVISOR: v }), true, v);
  for (const v of ['', '0', 'no', 'false', 'enabled', undefined]) assert.equal(advisorDefaultOn({ MAGI_OMP_ADVISOR: v }), false, String(v));
});
