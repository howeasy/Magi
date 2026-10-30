// An operator's launch wrapper for headless workers: MAGI_WORKER_WRAPPER, a
// JSON array argv such as ["/usr/local/bin/phx-sandbox","--profile","worker"].
// Every headless worker then starts as `<wrapper argv...> -- <worker argv...>`
// (exec.mjs spawnWrapped). Magi enforces nothing itself: the wrapper is the
// containment (a sandbox, a job object, a systemd scope), and a request's
// `allowCommands` is honoured only when one is configured.
import { accessSync, constants, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { BridgeError } from './exec.mjs';

export const WRAPPER_ENV = 'MAGI_WORKER_WRAPPER';
// What Windows starts without a shell of the caller's: CreateProcess takes an
// .exe or .com, and spawnFile puts a .cmd or .bat through cmd.exe.
const WINDOWS_RUNNABLE = new Set(['.exe', '.com', '.cmd', '.bat']);

/** The wrapper argv, or null when none is configured; BAD_CONFIG when the value is unusable. */
export function workerWrapper(raw = process.env[WRAPPER_ENV], { platform = process.platform } = {}) {
  if (raw == null || String(raw).trim() === '') return null;
  const bad = (why) => new BridgeError('BAD_CONFIG',
    `${WRAPPER_ENV} ${why}. Set it to a JSON array argv whose first item is the absolute path of an executable ` +
    `(e.g. ["/usr/local/bin/sandbox","--profile","worker"]; on Windows an .exe, .com, .cmd or .bat), or unset it, then restart the server.`);
  let argv;
  try { argv = JSON.parse(raw); } catch { throw bad('is not valid JSON'); }
  if (!Array.isArray(argv) || argv.length === 0) throw bad('is not a non-empty JSON array');
  if (!argv.every((item) => typeof item === 'string' && item.length > 0)) throw bad('holds an item that is not a non-empty string');
  const [file] = argv;
  if (!isAbsolute(file)) throw bad(`starts with "${file}", which is not an absolute path`);
  let stat;
  try { stat = statSync(file); } catch { throw bad(`names ${file}, which does not exist`); }
  if (!stat.isFile()) throw bad(`names ${file}, which is not a file`);
  if (platform === 'win32') {
    if (!WINDOWS_RUNNABLE.has(extname(file).toLowerCase())) throw bad(`names ${file}, which Windows cannot start directly`);
  } else {
    try { accessSync(file, constants.X_OK); } catch { throw bad(`names ${file}, which is not executable by this user`); }
  }
  return argv;
}

/** The variables a wrapper reads to place one worker. */
// `config`: a file the worker must be able to read, outside its working
// directory (the omp overlay in the server's temp folder; omp refuses to
// start without it), so a wrapper with a private /tmp binds it in.
export function workerEnv({ taskId, round, harness, cwd, allowCommands, config = null }) {
  return {
    MAGI_WORKER_TASK_ID: String(taskId ?? ''),
    MAGI_WORKER_ROUND: String(round ?? 1),
    MAGI_WORKER_HARNESS: String(harness),
    MAGI_WORKER_CWD: String(cwd),
    MAGI_WORKER_COMMANDS: allowCommands ? '1' : '0',
    MAGI_WORKER_CONFIG: config ? String(config) : '',
  };
}
