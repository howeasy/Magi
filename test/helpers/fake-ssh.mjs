// A stand-in for ssh: runs the remote command on this machine, as the remote
// would, with the remote's own MAGI_HOME (FAKE_SSH_MAGI_HOME). The command is
// split as a POSIX shell would split it; git's receive-pack and upload-pack
// run as `git receive-pack <path>`. FAKE_SSH_DOWN=1 fails like an unreachable
// host (exit 255). Every call is logged to FAKE_SSH_LOG as {dest, command}.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const WITH_VALUE = new Set(['-o', '-p', '-i', '-l', '-F', '-J']);
const argv = process.argv.slice(2);
let i = 0;
while (i < argv.length && argv[i].startsWith('-')) i += WITH_VALUE.has(argv[i]) ? 2 : 1;
const dest = argv[i];
const command = argv.slice(i + 1).join(' ');
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ dest, command }) + '\n');
// FAKE_SSH_HANG=1: connected, and then nothing, ever (a far end that never says hello).
if (process.env.FAKE_SSH_HANG === '1') setInterval(() => {}, 1000);
else if (process.env.FAKE_SSH_DOWN === '1') {
  process.stderr.write(`ssh: connect to host ${dest} port 22: Connection refused\n`);
  process.exit(255);
}

// POSIX word splitting: single quotes are literal, double quotes and bare
// words take backslash escapes. Enough for what Magi and git send.
function split(s) {
  const words = [];
  let word = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "'") {
      const end = s.indexOf("'", k + 1);
      word = (word ?? '') + s.slice(k + 1, end);
      k = end;
    } else if (c === '"') {
      word ??= '';
      for (k++; k < s.length && s[k] !== '"'; k++) word += s[k] === '\\' && /["\\$`]/.test(s[k + 1]) ? s[++k] : s[k];
    } else if (c === '\\') {
      word = (word ?? '') + s[++k];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

if (process.env.FAKE_SSH_HANG === '1') { /* stays connected and silent */ } else run();
function run() {
let [file, ...args] = split(command);
if (file === 'git-receive-pack' || file === 'git-upload-pack') {
  args = [file.slice(4), ...args];
  file = 'git';
}
const env = { ...process.env, MAGI_HOME: process.env.FAKE_SSH_MAGI_HOME ?? process.env.MAGI_HOME };
delete env.FAKE_SSH_LOG;
const child = spawn(file, args, { stdio: 'inherit', env, windowsHide: true });
child.on('error', (e) => { process.stderr.write(`fake-ssh: ${e.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
