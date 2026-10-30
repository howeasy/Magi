import { readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';

// PID alone is not an identity: a crash can leave a registry row for a later
// process. Read the OS birth marker afresh when validating a remote process.
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(fields[19] ?? '') ? `linux:${boot}:${fields[19]}` : null;
    }
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`;
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      return /^\d+$/.test(value) ? `win32:${value}` : null;
    }
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    return value ? `${process.platform}:${value}` : null;
  } catch {
    return null;
  }
}

// The same marker without blocking: on Windows the read is a PowerShell call
// of about a second, which a server reading it for each worker it starts
// should not spend on its event loop.
export function processStartedAtAsync(pid) {
  if (process.platform !== 'win32') return Promise.resolve(processStartedAt(pid));
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      const value = String(stdout ?? '').trim();
      resolve(!error && /^\d+$/.test(value) ? `win32:${value}` : null);
    });
  });
}
