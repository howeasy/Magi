// Headless workers on another machine, reached over the operator's own ssh.
// This side keeps the card, the channel and every orchestrator feature; the
// remote runs `magi worker` (src/remote-worker.mjs), which builds the launch
// with its own adapter code and binaries. The work travels by git: a commit of
// this tree (untracked files included) is pushed to a Magi-owned bare repo
// there, the worker runs in a worktree of it, and what it changed comes back
// as the local branch magi/<taskId>. Magi opens no port: the listener is the
// operator's sshd. docs/architecture.md, "A headless worker on another machine".
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BridgeError, runCli } from './exec.mjs';
import { magiHome } from './state.mjs';

// A different number is refused before preparing, launching or relaying.
// 2 added every omp run's advisor policy; 3 added remote Codex steer; 4
// binds relay events to the far ledger's recorded worker. Older relays
// cannot safely participate in the new ownership checks.
export const REMOTE_PROTOCOL = 4;
const SETUP_TIMEOUT_MS = 120000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// What PowerShell treats as a quote or an expansion: ASCII and typographic
// single and double quotes, the backtick, and $.
const POWERSHELL_UNSAFE = /['\u2018\u2019\u201A\u201B"\u201C\u201D\u201E`$]/;

export const remotesPath = () => join(magiHome(), 'remotes.json');

const badConfig = (why) => new BridgeError('BAD_CONFIG', `${remotesPath()} ${why}. Each entry is {"ssh": ["<host or ssh args...>"], "node": "<absolute node on the remote>", "magi": "<absolute bin/magi.mjs on the remote>", "path": ["<dirs to put first on the remote PATH>"], "shell": "posix" | "powershell"}; fix it and retry.`);

/** Every configured remote, validated; {} when there is no file. */
export function readRemotes() {
  let text;
  try { text = readFileSync(remotesPath(), 'utf8'); } catch { return {}; }
  let all;
  try { all = JSON.parse(text); } catch { throw badConfig('is not valid JSON'); }
  if (!all || typeof all !== 'object' || Array.isArray(all)) throw badConfig('is not a JSON object of named remotes');
  const out = {};
  for (const [name, r] of Object.entries(all)) {
    if (!NAME.test(name)) throw badConfig(`names a remote "${name}", which is not a plain name`);
    if (!Array.isArray(r?.ssh) || !r.ssh.length || !r.ssh.every((s) => typeof s === 'string' && s)) throw badConfig(`gives "${name}" no ssh argv`);
    for (const key of ['node', 'magi']) if (typeof r[key] !== 'string' || !r[key]) throw badConfig(`gives "${name}" no "${key}" path`);
    if (r.path != null && (!Array.isArray(r.path) || !r.path.every((p) => typeof p === 'string' && p))) throw badConfig(`gives "${name}" a "path" that is not a list of directories`);
    const shell = r.shell ?? 'posix';
    if (!['posix', 'powershell'].includes(shell)) throw badConfig(`gives "${name}" shell "${shell}"; use "posix" (Linux, macOS) or "powershell" (a Windows sshd whose DefaultShell is PowerShell; cmd.exe cannot carry git's transport)`);
    if (r.home != null && (typeof r.home !== 'string' || !r.home)) throw badConfig(`gives "${name}" a "home" that is not a directory path`);
    // `home`: the MAGI_HOME the remote's Magi uses for this machine's work,
    // when it is not that user's default; its sessions must use the same one.
    // PowerShell ends a single-quoted string at a typographic quote too, so a
    // path holding any of them is refused rather than quoted.
    if (shell === 'powershell') for (const key of ['node', 'magi', 'home']) {
      if (r[key] && POWERSHELL_UNSAFE.test(r[key])) throw badConfig(`gives "${name}" a "${key}" holding a quote, backtick or $, which PowerShell would read as code; use a path without them`);
    }
    out[name] = { name, ssh: r.ssh, node: r.node, magi: r.magi, path: r.path ?? [], shell, home: r.home ?? null };
  }
  return out;
}

export function remoteConfig(host) {
  const all = readRemotes();
  if (all[host]) return all[host];
  const names = Object.keys(all);
  throw new BridgeError('UNKNOWN_HOST', `No remote named "${host}" in ${remotesPath()}${names.length ? `; configured: ${names.join(', ')}` : ', which has none'}. Add it there, or drop host to run the worker here.`);
}

// The payload rides as base64url, so the remote shell has nothing in it to quote.
export const encodePayload = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const decodePayload = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

// Both shells take single quotes literally ('' is a quote inside PowerShell's),
// which is also what git's own ssh transport sends: a Windows remote's sshd
// must run PowerShell, since cmd.exe keeps the quotes as part of the path.
const quote = (shell, s) => (shell === 'powershell'
  ? `'${String(s).replace(/'/g, "''")}'`
  : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** The one command line ssh hands the remote's shell. PowerShell runs a quoted path with `&`. */
export function remoteCommand(remote, sub, payload) {
  return [remote.shell === 'powershell' ? '&' : null, quote(remote.shell, remote.node), quote(remote.shell, remote.magi), sub, encodePayload({ path: remote.path, home: remote.home ?? null, ...payload })].filter(Boolean).join(' ');
}

// git's own transport commands, run as `git <cmd>` so only `git` itself need
// be on the remote's ssh PATH (Git for Windows puts git-receive-pack elsewhere).
const PACK = ['--receive-pack=git receive-pack', '--upload-pack=git upload-pack'];

/** ssh's argv: never a password prompt, then the operator's own args, then the command. */
export function sshArgs(remote, command) {
  // A host that never answers costs its connect timeout, not the request's.
  // ServerAlive: a connection gone silent (a dropped network) is ended within
  // about 45 s, so the relay's owner sees it close and reopens it.
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...remote.ssh, command];
}

// git reaches the same host through the same ssh: the last ssh arg is the
// destination, the ones before it are options. git runs GIT_SSH_COMMAND
// through its own sh, so it is sh-quoted; SSH_BIN (as resolveBin honours it)
// names the ssh, and a node script one runs under this node.
const shq = (s) => (/^[\w./:=@-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
function gitSsh(remote) {
  const dest = remote.ssh.at(-1);
  const bin = process.env.SSH_BIN;
  const ssh = !bin ? ['ssh'] : /\.[cm]?js$/i.test(bin) ? [process.execPath, bin] : [bin];
  const command = [...ssh.map((p) => shq(p.replace(/\\/g, '/'))), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...remote.ssh.slice(0, -1).map(shq)].join(' ');
  return { url: (path) => `${dest}:${path}`, env: { GIT_SSH_COMMAND: command } };
}

/** ssh exit 255 is ssh's own failure: the host, not the worker. */
export function unreachable(remote, stderr) {
  return new BridgeError('REMOTE_UNREACHABLE', `ssh could not reach remote "${remote.name}" (${String(stderr ?? '').trim().split('\n').at(-1)?.slice(0, 300) || 'no output'}). Check \`ssh ${remote.ssh.join(' ')}\` works without a prompt, then retry.`);
}

async function remoteJson(remote, sub, payload, { signal } = {}) {
  const res = await runCli('ssh', sshArgs(remote, remoteCommand(remote, sub, payload)), { timeoutMs: SETUP_TIMEOUT_MS, signal });
  if (res.exitCode === 255) throw unreachable(remote, res.stderr);
  const line = res.stdout.trim().split('\n').at(-1) ?? '';
  let out;
  try { out = JSON.parse(line); } catch { out = null; }
  if (res.exitCode !== 0 || !out?.ok) {
    const why = out?.message ?? (res.stderr.trim().slice(0, 400) || `exit ${res.exitCode}`);
    throw new BridgeError(out?.code ?? 'REMOTE_FAILED', `magi ${sub} on remote "${remote.name}" failed: ${why}. Check that ${remote.magi} there is a Magi with \`magi worker\` (same protocol ${REMOTE_PROTOCOL}), then retry.`);
  }
  return out;
}

const git = (cwd, args, env) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

// git over the network: asynchronous, bounded and cancellable, so a remote
// that stops reading cannot hold the server (a synchronous push would block
// every other call, the run's own timeout included).
async function gitRemote(cwd, args, env, { signal, what }) {
  const res = await runCli('git', args, { cwd, env: { ...process.env, ...env }, timeoutMs: SETUP_TIMEOUT_MS, signal });
  if (res.exitCode !== 0) throw Object.assign(new Error(res.stderr.trim().slice(0, 300) || `exit ${res.exitCode}`), { what });
  return res.stdout.trim();
}

// Who commits a snapshot: this box may have no git identity at all.
const IDENTITY = { GIT_AUTHOR_NAME: 'magi', GIT_AUTHOR_EMAIL: 'magi@localhost', GIT_COMMITTER_NAME: 'magi', GIT_COMMITTER_EMAIL: 'magi@localhost' };

/**
 * This tree as one commit, without touching the index, the stash or HEAD:
 * HEAD plus every tracked change and every untracked file .gitignore allows.
 */
export function snapshotCommit(cwd) {
  let top;
  try { top = git(cwd, ['rev-parse', '--show-toplevel']); }
  catch { throw new BridgeError('REMOTE_NEEDS_GIT', `${cwd} is not inside a git repository, and a remote worker gets its copy of the tree by git. Run it from a repository, or drop host.`); }
  const head = git(top, ['rev-parse', 'HEAD']);
  const dir = mkdtempSync(join(tmpdir(), 'magi-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(top, ['read-tree', 'HEAD'], env);
    git(top, ['add', '-A'], env);
    const tree = git(top, ['write-tree'], env);
    const clean = tree === git(top, ['rev-parse', 'HEAD^{tree}']);
    const commit = clean ? head : git(top, ['commit-tree', tree, '-p', head, '-m', 'magi: working tree snapshot'], { ...env, ...IDENTITY });
    // Where in the tree the request was made: the worker starts there too.
    const rel = git(cwd, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
    return { top, head, commit, dirty: !clean, rel };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A worktree on the remote holding this tree: the bare repo for this
 * checkout, the snapshot pushed to refs/magi/<taskId>/snapshot, and the path
 * the worker will run in. `magi worker` makes the worktree from the snapshot
 * only when it is not there yet, so a continuation keeps the worker's own edits.
 */
export async function prepareWorkspace({ remote, taskId, cwd, signal }) {
  if (signal?.aborted) throw new BridgeError('CANCELLED', 'The request was cancelled before its tree was copied; nothing was sent.');
  const snap = snapshotCommit(cwd);
  const repoKey = `${basename(snap.top).replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha256').update(snap.top).digest('hex').slice(0, 8)}`;
  const ws = await remoteJson(remote, 'workspace', { op: 'prepare', protocol: REMOTE_PROTOCOL, repoKey, taskId }, { signal });
  assertGitPath(remote, ws.repo);
  const via = gitSsh(remote);
  try {
    await gitRemote(snap.top, ['push', '--quiet', '--force', PACK[0], via.url(ws.repo), `${snap.commit}:refs/magi/${taskId}/snapshot`], via.env, { signal, what: 'push' });
  } catch (e) {
    if (e.code === 'CANCELLED') throw e;
    throw new BridgeError('REMOTE_FAILED', `git could not push this tree to remote "${remote.name}" (${String(e.message).slice(0, 300)}). Check that git is on the remote's PATH for ssh commands, then retry.`);
  }
  return { repo: ws.repo, work: ws.work, rel: snap.rel, base: snap.commit, head: snap.head, dirty: snap.dirty, top: snap.top };
}

// git's ssh transport quotes the repository path the POSIX way, which a
// PowerShell remote reads differently when the path holds an apostrophe (and
// a crafted one could end the string); such a path is refused, not sent.
export function assertGitPath(remote, repo) {
  if (remote.shell === 'powershell' && POWERSHELL_UNSAFE.test(String(repo))) {
    throw new BridgeError('BAD_CONFIG', `The Magi home on remote "${remote.name}" (${repo}) holds a quote or $, which git's transport cannot carry to PowerShell safely. Set "home" for it in remotes.json to a path without them.`);
  }
}

/**
 * What the worker changed, committed there and fetched here as magi/<taskId>.
 * Nothing touches this checkout's working tree or current branch.
 */
export async function collectWorkspace({ remote, taskId, round, workspace, signal }) {
  const out = await remoteJson(remote, 'workspace', { op: 'collect', protocol: REMOTE_PROTOCOL, repo: workspace.repo, work: workspace.work, taskId, round }, { signal });
  if (!out.changed) return { changed: false, files: [] };
  const via = gitSsh(remote);
  const branch = `magi/${taskId}`;
  try {
    await gitRemote(workspace.top, ['fetch', '--quiet', PACK[1], via.url(workspace.repo), `+refs/magi/${taskId}/result:refs/heads/${branch}`], via.env, { signal, what: 'fetch' });
  } catch (e) {
    if (e.code === 'CANCELLED') throw e;
    throw new BridgeError('REMOTE_FAILED', `The worker's changes are committed on remote "${remote.name}" (${out.commit}) but could not be fetched (${String(e.message).slice(0, 300)}). Fetch refs/magi/${taskId}/result from ${via.url(workspace.repo)} by hand.`);
  }
  return { changed: true, branch, commit: out.commit, base: out.base, files: out.files ?? [] };
}

/** What the orchestrator reads under the reply: where the work is now. */
export function remoteFooter(host, collected) {
  if (!collected) return '';
  if (!collected.changed) return `\n\n[magi] The worker ran on ${host} and changed no files.`;
  const n = collected.files.length;
  return `\n\n[magi] The worker ran on ${host}. Its changes (${n} file${n === 1 ? '' : 's'}: ${collected.files.slice(0, 8).join(', ')}${n > 8 ? ', ...' : ''}) are on local branch ${collected.branch} at ${collected.commit.slice(0, 12)}; nothing was applied to your tree. Review with \`git diff ${collected.base.slice(0, 12)} ${collected.branch}\`, then merge or cherry-pick.`;
}
