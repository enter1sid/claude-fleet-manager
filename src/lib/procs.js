// Finds running `claude` CLI processes and their working directories, and stops them.
const fs = require('fs');
const { execFileSync } = require('child_process');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function cwdOf(pid, platform) {
  if (platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  const out = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

// A session started by Claude Desktop's Code tab has the Desktop app among its ancestors. Those are
// not terminal sessions, so a CLI switch must leave them alone (a Desktop switch restarts them).
function looksDesktopHosted(ancestorNames) {
  // Linux binary is `claude-desktop`; the macOS app binary and its helpers are `Claude` / `Claude Helper*`.
  return ancestorNames.some((n) => /^claude-desktop/i.test(n) || n === 'Claude' || /^Claude Helper/.test(n));
}

function ancestorNames(pid) {
  const names = [];
  let cur = pid;
  for (let i = 0; i < 8 && cur > 1; i++) {
    const out = run('ps', ['-o', 'ppid=,comm=', '-p', String(cur)]).trim();
    if (!out) break;
    const m = out.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    cur = Number(m[1]);
    const parent = run('ps', ['-o', 'comm=', '-p', String(cur)]).trim();
    if (parent) names.push(parent.split('/').pop());
  }
  return names;
}

function findClaudeCli(platform = process.platform) {
  if (platform === 'win32') {
    // Windows exposes no cheap working-directory lookup; callers fall back to the latest session's folder.
    return run('powershell', ['-NoProfile', '-Command', '(Get-Process claude -ErrorAction SilentlyContinue).Id'])
      .split(/\r?\n/).filter(Boolean).map(Number).map((pid) => ({ pid, cwd: null, hosted: false }));
  }
  return run('pgrep', ['-x', 'claude'])
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((pid) => pid !== process.pid)
    .map((pid) => ({ pid, cwd: cwdOf(pid, platform), hosted: looksDesktopHosted(ancestorNames(pid)) }));
}

function stop(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

module.exports = { findClaudeCli, stop, looksDesktopHosted };
