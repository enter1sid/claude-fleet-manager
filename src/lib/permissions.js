// macOS permissions the tray app depends on. Probing is what makes macOS show its prompt, so this runs
// once at first start and again before a Desktop switch, to catch anything denied or revoked since.
//   keychain    reading "Claude Safe Storage" (Desktop's cookie/token key)
//   automation  telling Claude to quit (only checkable while Claude is running)
const { spawnSync } = require('child_process');

const PANES = {
  keychain: { label: 'Keychain access to "Claude Safe Storage" (choose Always Allow)', app: 'Keychain Access' },
  automation: { label: 'Automation permission to control Claude', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation' },
};

const sh = (cmd, args, timeout) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { status: r.status, stderr: r.stderr || '' };
};

// Returns the permissions that are missing (empty when all is fine or not on macOS).
function probe(platform = process.platform, run = sh) {
  if (platform !== 'darwin') return [];
  const missing = [];
  // 44 = item not found (Desktop never run): not a permission problem.
  const kc = run('security', ['find-generic-password', '-w', '-s', 'Claude Safe Storage', '-a', 'Claude'], 120000);
  if (kc.status !== 0 && kc.status !== 44) missing.push('keychain');
  if (run('pgrep', ['-x', 'Claude'], 5000).status === 0) {
    const ev = run('osascript', ['-e', 'tell application "Claude" to get name'], 60000);
    if (ev.status !== 0 && /-1743|not authori/i.test(ev.stderr)) missing.push('automation');
  }
  return missing;
}

module.exports = { probe, PANES };
