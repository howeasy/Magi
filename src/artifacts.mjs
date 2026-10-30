// Files sent with card traffic between peers, on one machine or across two.
// A file is copied when it is sent into a content-addressed store,
// <MAGI_HOME>/artifacts/blobs/<sha256>, so what the receiver reads is what
// was sent: a later edit or deletion by the sender changes nothing, and a
// copy that does not match its hash is refused, never delivered. A message
// carries the files' metadata ({sha256, name, size}); each machine adds the
// FILES block naming its own paths when it delivers (src/serve.mjs), and a
// file crosses to another machine over the relay, in chunks, checked by hash
// before the message that names it is delivered there (src/relay.mjs).
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, fstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { BridgeError } from './exec.mjs';
import { magiHome } from './state.mjs';
import { getRecord, setRecord } from './store.mjs';

// ponytail: per-message bounds; a file larger than this belongs in git (a
// fresh worker's tree travels that way) or a link both sides can reach.
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
// One relay line carries this much of a file, base64-encoded.
export const CHUNK_BYTES = 512 * 1024;

const SHA = /^[0-9a-f]{64}$/;

// Off unless the operator turned it on on this machine (`magi files on`): a
// setting in the ledger, never a call's argument, so no tool call switches
// it. A headless worker cannot either: `magi files` refuses under PEER_DEPTH.
// Each machine decides for itself: a sender's files go only when it is on
// there, and a receiver takes them only when it is on there too.
const SETTINGS = 'settings';
export const filesEnabled = () => getRecord(magiHome(), SETTINGS, 'files')?.enabled === true;
export function setFilesEnabled(enabled) {
  setRecord(magiHome(), SETTINGS, 'files', { enabled: Boolean(enabled), at: Date.now() });
}
export const FILES_OFF_HINT = 'The operator turns it on with `magi files on`, on both machines. Until then name a path both can read, or have the peer fetch it over ssh or scp.';
export function assertFilesEnabled() {
  if (!filesEnabled()) throw new BridgeError('FILES_OFF', `Sending files between machines is off on this machine, as it is by default. ${FILES_OFF_HINT}`);
}

const blobs = () => {
  const d = join(magiHome(), 'artifacts', 'blobs');
  mkdirSync(d, { recursive: true });
  return d;
};

/** Where the copy with this hash lives on this machine. */
export function blobPath(sha256) {
  if (!SHA.test(String(sha256))) throw new BridgeError('BAD_REQUEST', `"${sha256}" is not a sha256; name a file by the hash its message gave.`);
  return join(blobs(), sha256);
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

// A copy here that matches its name; one that does not (cut short, edited
// by its reader) is removed, so it is fetched or sent again, never reused.
function intact(path, sha256) {
  if (!existsSync(path)) return false;
  try { if (sha(readFileSync(path)) === sha256) return true; } catch { /* unreadable: replace it */ }
  try { unlinkSync(path); } catch { /* the rename below replaces it */ }
  return false;
}

export const hasBlob = (sha256) => SHA.test(String(sha256)) && intact(join(blobs(), sha256), sha256);

// Written aside and renamed in, so a reader never sees half a file.
function writeBlob(sha256, buffer) {
  const path = blobPath(sha256);
  if (intact(path, sha256)) return path;
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, buffer);
  try { renameSync(tmp, path); }
  // A rename refused because another writer got there first is fine only if
  // what is there now is the file; a corrupt copy that could not be replaced is an error.
  catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } if (!intact(path, sha256)) throw e; }
  return path;
}

/** Stores bytes whose hash must be `sha256`; FILE_CORRUPT otherwise. */
export function putBlob(sha256, buffer) {
  const got = sha(buffer);
  if (got !== sha256) throw new BridgeError('FILE_CORRUPT', `A file arrived with sha256 ${got.slice(0, 12)}, not the ${String(sha256).slice(0, 12)} it was sent as; it was discarded. Send it again.`);
  return writeBlob(sha256, buffer);
}

/** One chunk of a stored file, for the relay. */
export function readChunk(sha256, offset, length = CHUNK_BYTES) {
  const fd = openSync(blobPath(sha256), 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

// A path the sender may send: inside its working directory, resolved through
// links, so a worker cannot be talked into shipping ~/.ssh by a path that
// only looks local.
function inside(dir, path) {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The files a message carries, copied into the store now: [{sha256, name, size}].
 * `cwd` is the sender's working directory; every path must be inside it.
 */
export function attachFiles(paths, { cwd }) {
  if (paths == null || (Array.isArray(paths) && !paths.length)) return [];
  assertFilesEnabled();
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.trim())) throw new BridgeError('BAD_REQUEST', 'files is a list of file paths.');
  if (paths.length > MAX_FILES) throw new BridgeError('FILES_TOO_MANY', `A message carries at most ${MAX_FILES} files; this one names ${paths.length}. Send fewer, or put them in one archive.`);
  let root;
  try { root = realpathSync(resolve(cwd)); } catch { throw new BridgeError('BAD_REQUEST', `The working directory ${cwd} does not exist, so no file can be sent from it.`); }
  const out = [];
  let total = 0;
  for (const p of paths) {
    const full = resolve(root, p);
    let real;
    try { real = realpathSync(full); } catch { throw new BridgeError('FILE_NOT_FOUND', `${p} does not exist (looked at ${full}). Check the path; it is relative to ${root}.`); }
    if (!inside(root, real)) throw new BridgeError('FILE_OUTSIDE_WORKTREE', `${p} is outside the working directory ${root}; only files inside it can be sent. Copy it in first if it should go.`);
    // A FIFO, a device or a folder is refused before it is opened, and the
    // open does not block, so a path swapped for a FIFO cannot hang the server.
    // Then one open, read through its handle with a ceiling: what is checked
    // is what is read. The path is resolved again after, so a link swapped in
    // between is caught. What this bounds is a sender naming paths: a writer
    // on the same machine racing renames around the open (swap, open, swap
    // back) can still win. ponytail: a beneath-root open where the platform
    // has one (openat2 RESOLVE_BENEATH) is the upgrade.
    const tooBig = () => new BridgeError('FILE_TOO_LARGE', `${p} is over ${MAX_FILE_BYTES / 1048576} MB, the most a file may be. Commit it, or share a link both sides can reach.`);
    if (!statSync(real).isFile()) throw new BridgeError('BAD_REQUEST', `${p} is not a file; send the files in it, or an archive of it.`);
    const fd = openSync(real, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK);
    let buffer;
    try {
      if (!fstatSync(fd).isFile()) throw new BridgeError('BAD_REQUEST', `${p} is not a file; send the files in it, or an archive of it.`);
      const chunks = [];
      let got = 0;
      for (;;) {
        const chunk = Buffer.alloc(CHUNK_BYTES);
        const n = readSync(fd, chunk, 0, CHUNK_BYTES, null);
        if (!n) break;
        got += n;
        if (got > MAX_FILE_BYTES) throw tooBig();
        chunks.push(chunk.subarray(0, n));
      }
      buffer = Buffer.concat(chunks);
    } finally { closeSync(fd); }
    let again;
    try { again = realpathSync(full); } catch { again = null; }
    if (again !== real || !inside(root, again)) throw new BridgeError('FILE_OUTSIDE_WORKTREE', `${p} changed where it points while it was read; nothing was sent. Send it again once it is a plain file inside ${root}.`);
    total += buffer.length;
    if (total > MAX_MESSAGE_BYTES) throw new BridgeError('FILE_TOO_LARGE', `The files on this message add up to more than ${MAX_MESSAGE_BYTES / 1048576} MB; send them over several messages.`);
    const sha256 = sha(buffer);
    writeBlob(sha256, buffer);
    out.push({ sha256, name: basename(real), size: buffer.length, path: relative(root, real).replace(/\\/g, '/') });
  }
  return out;
}

const human = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * The FILES block a delivered message ends with, naming this machine's copies.
 * `where(sha256)` gives the path on the receiving machine (blobPath here).
 */
export function filesBlock(files, where = blobPath) {
  if (!files?.length) return '';
  // Each name is a JSON string, so no character in it can add or forge a line.
  return ['', '', `FILES (${files.length}, sent with this message; Magi copied them and checked each by sha256 when it was sent and when it arrived)`,
    ...files.map((f) => `- ${JSON.stringify(String(f.path ?? f.name))} (${human(f.size)}, sha256 ${f.sha256.slice(0, 12)}): ${where(f.sha256).replace(/\\/g, '/')}`)].join('\n');
}

/** Only the metadata that travels: never a path on the sender's machine but its name in its tree. */
export const fileMeta = (files) => (files ?? []).map((f) => ({ sha256: f.sha256, name: f.name, size: f.size, path: f.path ?? f.name }));
