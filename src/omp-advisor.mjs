// Which model omp's advisor runs on, and how a run is told. An advisor on the
// same model as the worker shares its blind spots, so Magi never starts one:
// it picks a candidate that differs from the worker's model (a different
// vendor when it can), and when none does, the advisor does not run and the
// caller is told why. Everything here is omp's; the engine only asks.
//
// The advisor model is omp's `modelRoles.advisor` unless a run overrides it,
// and omp has no flag for that: a `--config` overlay does (it outranks the
// user's config for that process; checked on omp 18.10.4, docs/transport-recon.md,
// "The advisor").
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, runCli } from './exec.mjs';
import { magiHome } from './state.mjs';
import { getRecord, setRecord } from './store.mjs';
import { redact } from './protocol.mjs';

export const ADVISOR_ENV = 'MAGI_OMP_ADVISOR';
export const ADVISOR_MODELS_ENV = 'MAGI_OMP_ADVISOR_MODELS';

// The server default: only these spellings turn it on.
export const advisorDefaultOn = (env = process.env) => /^(1|true|on|yes)$/i.test(env[ADVISOR_ENV] ?? '');

// --- who a model is -----------------------------------------------------------

const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'inherit']);

// Which maker a model name belongs to, whatever route it is reached by
// (`openrouter/deepseek/...` is DeepSeek's). Heuristic, in order; a name that
// matches nothing falls back to its provider segment, and an unknown vendor is
// never called "different".
const FAMILIES = [
  [/deepseek/, 'deepseek'],
  [/claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b|\bmythos\b/, 'anthropic'],
  [/gemini|gemma|google/, 'google'],
  [/grok|x-ai|\bxai\b/, 'xai'],
  [/qwen|alibaba/, 'alibaba'],
  [/llama|\bmeta\b/, 'meta'],
  [/mistral|mixtral|codestral|devstral/, 'mistral'],
  [/kimi|moonshot/, 'moonshot'],
  [/\bglm\b|zhipu|z-ai/, 'zhipu'],
  [/minimax/, 'minimax'],
  [/gpt|openai|codex|chatgpt|\bo[1-9]\b/, 'openai'],
];
const ROUTERS = new Set(['openrouter', 'github-copilot', 'copilot', 'together', 'fireworks', 'groq', 'cerebras', 'litellm', 'opencode-go', 'opencode-zen', 'kilo', 'synthetic']);

// One selector ("openrouter/deepseek/deepseek-v4.1-flash:high") as what can
// be compared. `alias` is a role reference (`@slow`) that only omp can expand.
export function parseSelector(spec) {
  const raw = String(spec ?? '').split(',')[0].trim();
  if (!raw) return null;
  if (raw.startsWith('@') || raw === '*') return { raw, alias: true, base: raw, vendor: 'unknown' };
  let body = raw;
  const colon = body.lastIndexOf(':');
  if (colon > 0 && THINKING.has(body.slice(colon + 1).toLowerCase())) body = body.slice(0, colon);
  const parts = body.toLowerCase().split('/').filter(Boolean);
  const base = (parts.at(-1) ?? '').replace(/-\d{8}$/, '');
  if (!base) return null;
  const family = FAMILIES.find(([re]) => re.test(body.toLowerCase()))?.[1];
  const route = parts.length > 1 ? (ROUTERS.has(parts[0]) && parts.length > 2 ? parts[1] : parts[0]) : null;
  return { raw, alias: false, base, vendor: family ?? (route ? route.split('-')[0] : 'unknown') };
}

// The same model by another route or thinking level is the same model. A bare
// family word with no digit ("opus") names whatever model it matches, so it
// is the same as any model that contains it; anything else must match exactly.
export function sameModel(a, b) {
  if (!a || !b) return false;
  if (a.base === b.base) return true;
  const [short, long] = a.base.length <= b.base.length ? [a.base, b.base] : [b.base, a.base];
  return short.length >= 3 && !/\d/.test(short) && long.includes(short);
}

// The first candidate that is not the worker's model, a different vendor
// first. `candidates` are selector strings in preference order.
export function chooseAdvisor({ worker, candidates }) {
  if (!worker) {
    return { ok: false, code: 'ADVISOR_WORKER_UNKNOWN', message: "The worker's model is not known (the request names none, omp's modelRoles.default is not set, or the request resumes a session), so an advisor on a different model cannot be guaranteed. Pass model on the request to pin the worker's, or drop advisor." };
  }
  const usable = candidates.map(parseSelector).filter((c) => c && !c.alias && SAFE_SELECTOR.test(c.raw));
  if (!usable.length) {
    return { ok: false, code: 'ADVISOR_NO_MODEL', message: `No advisor model is available: ${ADVISOR_MODELS_ENV} is empty and omp's modelRoles.advisor is unset or a role alias Magi cannot compare. Set one of them (an ordered list; the first that differs from the worker is used) and restart the harness, or drop advisor.` };
  }
  const different = usable.filter((c) => !sameModel(c, worker));
  if (!different.length) {
    return { ok: false, code: 'ADVISOR_SAME_MODEL', message: `Every advisor model available (${usable.map((c) => c.raw).join(', ')}) is the worker's own model (${worker.raw}); an advisor on the same model shares its blind spots, so none was started. Add a different model to ${ADVISOR_MODELS_ENV} or omp's modelRoles.advisor, run the worker on another with model, or drop advisor.` };
  }
  const pick = different.find((c) => worker.vendor !== 'unknown' && c.vendor !== 'unknown' && c.vendor !== worker.vendor) ?? different[0];
  return { ok: true, model: pick.raw, vendor: pick.vendor, differentVendor: worker.vendor !== 'unknown' && pick.vendor !== 'unknown' && pick.vendor !== worker.vendor, worker: worker.raw, workerVendor: worker.vendor };
}

// --- reading omp's configuration ------------------------------------------------

const ROLES_TTL_MS = 5 * 60 * 1000;
let rolesCache = null; // { at, value }

// `omp config get modelRoles` prints the record as one line of JSON. Cached,
// like the approval mode: it changes about as often as a thread is renamed.
export async function ompModelRoles(query = async () => (await runCli('omp', ['config', 'get', 'modelRoles'], { timeoutMs: 20000 })).stdout) {
  if (rolesCache && Date.now() - rolesCache.at < ROLES_TTL_MS) return rolesCache.value;
  let value = null;
  try {
    const parsed = JSON.parse(String(await query()).trim().split(/\r?\n/)[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch {
    /* unknown stays unknown */
  }
  rolesCache = { at: Date.now(), value };
  return value;
}

// For tests: the next read asks omp again.
export const forgetModelRoles = () => { rolesCache = null; };

// Overlays replace arrays (omp v18.10.4, config/settings.ts:3900-3953).
// Query in the worker's cwd on every run: another project's disabled list,
// or a stale cached list, could re-enable an extension the operator disabled.
async function ompDisabledExtensions(cwd, query) {
  try {
    let raw;
    if (query) raw = await query(cwd);
    else {
      const result = await runCli('omp', ['config', 'get', 'disabledExtensions'], { cwd, timeoutMs: 20000 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `omp config get exited ${result.exitCode}`);
      raw = result.stdout;
    }
    const value = JSON.parse(String(raw).trim());
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('expected a list of extension ids');
    return value;
  } catch (cause) {
    if (cause?.code === 'CLI_NOT_FOUND') {
      throw new BridgeError('CLI_NOT_FOUND', `${cause.message} Install omp on this machine or fix OMP_BIN / bins.json, then retry.`, { cause });
    }
    const home = process.env.PI_CODING_AGENT_DIR || join(homedir(), process.env.PI_CONFIG_DIR || '.omp', 'agent');
    const files = [join(home, 'config.yml'), join(cwd, process.env.PI_CONFIG_DIR || '.omp', 'config.yml'),
      ...(process.env.PI_CONFIG_FILES ?? '').split(delimiter).filter(Boolean).map((file) => resolve(cwd, file))];
    const detail = redact(String(cause.message)).text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 2000);
    throw new BridgeError('OMP_CONFIG_READ_FAILED', `OMP_CONFIG_READ_FAILED: Cannot read omp's disabledExtensions in ${cwd}; no worker was started. Inspect ${files.join(', ')} (also config.yaml, or the config file named by omp below). \`omp config path\` locates the active user/profile file. Run \`omp config get disabledExtensions\` there and fix the YAML or CLI failure before retrying. omp: ${detail}`, { cause });
  }
}

const list = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The plan for one request: the model the advisor will run on, or why none.
// The worker is the request's `model`, else omp's default role; a resumed
// session keeps its own model, which is not known here.
export async function planAdvisor({ model, resuming = false, roles, env = process.env } = {}) {
  const known = roles === undefined ? await ompModelRoles() : roles;
  const workerSpec = model ?? (resuming ? null : known?.default ?? null);
  const candidates = [...new Set([...list(env[ADVISOR_MODELS_ENV]), ...list(known?.advisor)])];
  return chooseAdvisor({ worker: parseSelector(workerSpec), candidates });
}

// --- telling omp ----------------------------------------------------------------

// A selector is written into YAML, so only the characters model names use are
// allowed; anything else is not a candidate.
const SAFE_SELECTOR = /^[A-Za-z0-9@._:/+-]{1,200}$/;

const SYNC_BACKLOG = new Set(['off', '1', '3', '5', 'strict']);
const SYNC_SETTING = 'omp-advisor-sync';
function checkSyncBacklog(value) {
  if (value !== null && (typeof value !== 'string' || !SYNC_BACKLOG.has(value))) {
    throw new BridgeError('BAD_REQUEST', 'advisor.syncBacklog takes off, 1, 3, 5, or strict as strings. Run `magi advisor-sync <value>`, or `magi advisor-sync default` to leave omp configuration unchanged.');
  }
  return value;
}

export function advisorSyncBacklog() {
  const home = magiHome();
  // A remote with no operator setting must not create a ledger just to read it.
  if (!existsSync(join(home, 'magi.db'))) return null;
  return checkSyncBacklog(getRecord(home, 'settings', SYNC_SETTING)?.value ?? null);
}
export function setAdvisorSyncBacklog(value) {
  setRecord(magiHome(), 'settings', SYNC_SETTING, { value: checkSyncBacklog(value), at: Date.now() });
}

// The overlay every headless omp run gets, in a temp file the run deletes;
// `magi sweep` removes any a killed process left (state.mjs). It says
// whether the advisor runs, always: rpc mode's advisor default gives way to a
// configured `advisor.enabled`, so a user who keeps it on would otherwise
// get a second model on every worker, unasked (omp 18.10.4,
// config/settings.ts:1010-1014). With a model
// it also names the advisor's model, which omp has no flag for. It pins
// `continueSeverity` to `blocker`: from omp 18.14.0 the default is `concern`,
// and a note of that severity after the final answer wakes the worker for
// another turn, which Magi's single-request run never asked for.
export async function writeAdvisorOverlay(model = null, { cwd = process.cwd(), query } = {}) {
  if (model != null && !SAFE_SELECTOR.test(model)) throw new BridgeError('BAD_REQUEST', 'The advisor model holds characters a model name does not. Name it as omp lists it (omp models ls).');
  const syncBacklog = advisorSyncBacklog();
  const disabled = await ompDisabledExtensions(cwd, query);
  const config = {
    advisor: { enabled: model != null, continueSeverity: 'blocker', ...(syncBacklog === null ? {} : { syncBacklog }) },
    disabledExtensions: [...new Set([...disabled, 'mcp:magi', 'mcp:magi-codex', 'mcp:magi-omp'])],
    ...(model == null ? {} : { modelRoles: { advisor: model } }),
  };
  const path = join(tmpdir(), `magi-advisor-${randomUUID().slice(0, 8)}.yml`);
  // JSON is YAML: one serializer quotes both the model and operator strings,
  // and treats extension ids containing quotes/newlines as data, never keys.
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { path, cleanup: () => rmSync(path, { force: true }) };
}

// What the orchestrator reads about the advisor's model, whenever it ran. The
// worker's actual model comes from omp's own get_state, so a config that
// drifted from what was compared still shows.
export function advisorLine(plan, workerActual) {
  if (!plan) return '';
  const actual = workerActual ? parseSelector(workerActual) : null;
  if (actual && sameModel(actual, parseSelector(plan.model))) {
    return `\n[magi] omp's advisor ran on ${plan.model}, which is the model the worker actually ran on (${workerActual}); its notes are less independent. Pass model to pin the worker to another.`;
  }
  const vendorsKnown = plan.vendor !== 'unknown' && plan.workerVendor !== 'unknown';
  const how = !vendorsKnown ? `a different model from the worker's ${plan.worker}`
    : plan.differentVendor ? `a different vendor from the worker's ${plan.worker}`
      : `the same vendor as the worker's ${plan.worker}, but a different model`;
  return `\n[magi] omp's advisor ran on ${plan.model} (${how}).`;
}
