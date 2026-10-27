// Switching Claude Desktop = swap the login inside Desktop's own (default) profile, then relaunch it,
// so the usual main window comes back on the other account. Each account keeps its login in a slot
// folder: the claude.ai cookies plus the oauth token caches from config.json. Slots are raw copies,
// valid on this machine only (cookies stay encrypted with this machine's key).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cookiesLib = require('./cookies');

const COOKIE_FILES = [path.join('Network', 'Cookies'), 'Cookies'];
const COOKIE_SUFFIXES = ['', '-journal', '-wal', '-shm'];
const CONFIG_KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2', 'lastKnownAccountUuid'];

function defaultDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(home, '.config', 'Claude');
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
};

function copyCookies(from, to) {
  let copied = false;
  for (const rel of COOKIE_FILES) {
    for (const ext of COOKIE_SUFFIXES) {
      const src = path.join(from, rel + ext);
      const dest = path.join(to, rel + ext);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        copied = copied || ext === '';
      } else fs.rmSync(dest, { force: true }); // never leave a stale journal beside a new database
    }
  }
  return copied;
}

// The id of the account Desktop is signed in to, or null when signed out.
function loginId(dir) {
  const c = readJson(path.join(dir, 'config.json'));
  return c.lastKnownAccountUuid && (c['oauth:tokenCacheV2'] || c['oauth:tokenCache']) ? c.lastKnownAccountUuid : null;
}

// A slot can be restored when it holds a token cache (captured here) or a claude.ai session cookie
// (imported bundles carry only cookies; Desktop signs in from those).
function hasLogin(dir) {
  if (loginId(dir)) return true;
  try {
    return cookiesLib.readCookies(dir).some((c) => c.name === 'sessionKey');
  } catch {
    return false;
  }
}

// Copies the live login (cookies + token caches) of the profile in `from` into the slot `to`.
function captureLogin(to, from = defaultDir()) {
  const id = loginId(from);
  if (!id) return null;
  fs.mkdirSync(to, { recursive: true });
  copyCookies(from, to);
  const live = readJson(path.join(from, 'config.json'));
  const slot = readJson(path.join(to, 'config.json'));
  for (const k of CONFIG_KEYS) slot[k] = live[k];
  fs.writeFileSync(path.join(to, 'config.json'), JSON.stringify(slot, null, 2), { mode: 0o600 });
  return id;
}

// Copies only the refreshed token caches of the live login into the slot holding the same account.
// Safe while Desktop runs (cookies are left alone). Returns whether the slot was updated.
function refreshTokens(slot, from = defaultDir()) {
  const id = loginId(from);
  if (!id || loginId(slot) !== id) return false;
  const live = readJson(path.join(from, 'config.json'));
  const saved = readJson(path.join(slot, 'config.json'));
  if (CONFIG_KEYS.every((k) => saved[k] === live[k])) return false;
  for (const k of CONFIG_KEYS) saved[k] = live[k];
  fs.writeFileSync(path.join(slot, 'config.json'), JSON.stringify(saved, null, 2), { mode: 0o600 });
  return true;
}

// Makes the profile in `to` signed in as the account stored in slot `from`. Desktop must be stopped.
function restoreLogin(from, to = defaultDir()) {
  if (!hasLogin(from)) return false;
  fs.mkdirSync(to, { recursive: true });
  copyCookies(from, to);
  const slot = readJson(path.join(from, 'config.json'));
  const live = readJson(path.join(to, 'config.json'));
  for (const k of CONFIG_KEYS) if (slot[k] === undefined) delete live[k]; else live[k] = slot[k];
  fs.writeFileSync(path.join(to, 'config.json'), JSON.stringify(live, null, 2), { mode: 0o600 });
  return true;
}

// Signs the profile out (expired account): no cookies, no tokens.
function clearLogin(dir = defaultDir()) {
  for (const rel of COOKIE_FILES) for (const ext of COOKIE_SUFFIXES) fs.rmSync(path.join(dir, rel + ext), { force: true });
  const live = readJson(path.join(dir, 'config.json'));
  for (const k of CONFIG_KEYS) delete live[k];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(live, null, 2), { mode: 0o600 });
}

// One-deep safety copy of the live login, taken before every swap.
function backupLogin(dir = defaultDir()) {
  return captureLogin(path.join(dir, '.cfm-login-backup'), dir);
}

function launchCommand(platform = process.platform) {
  if (platform === 'darwin') return { cmd: '/Applications/Claude.app/Contents/MacOS/Claude', args: [] };
  // Windows location is a best guess; set CLAUDE_DESKTOP_BIN if Desktop is installed elsewhere.
  if (platform === 'win32') return { cmd: process.env.CLAUDE_DESKTOP_BIN || path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'), args: [] };
  return { cmd: process.env.CLAUDE_DESKTOP_BIN || '/usr/bin/claude-desktop', args: [] };
}

// Whether Claude Desktop is installed here; sign-ins go through it when it is, else through the CLI.
function isInstalled(platform = process.platform) {
  return fs.existsSync(launchCommand(platform).cmd);
}

// Desktop must not inherit the tray app's own Electron environment.
function launchEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^ELECTRON_/.test(k) || k === 'CHROME_DESKTOP') delete out[k];
  return out;
}

const running = (platform) => {
  if (platform === 'win32') return spawnSync('tasklist', ['/fi', 'imagename eq claude.exe']).stdout.toString().includes('claude.exe');
  if (platform === 'darwin') return spawnSync('pgrep', ['-x', 'Claude']).status === 0;
  return spawnSync('pgrep', ['-x', 'claude-desktop']).status === 0;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On Linux Desktop is many processes that all share the name `claude-desktop`. Only the main one (no
// --type= flag) may be signalled: killing the zygote/GPU helpers as well leaves the main process
// spinning on GPU relaunches, so it never exits and its window freezes.
function mainPids(entries) {
  return entries.filter((e) => !/(^|\s)--type=/.test(e.args)).map((e) => e.pid);
}

const linuxSys = {
  list() {
    const pids = spawnSync('pgrep', ['-x', 'claude-desktop']).stdout.toString().split('\n').filter(Boolean).map(Number);
    return pids
      .filter((pid) => pid !== process.pid)
      .map((pid) => {
        try {
          return { pid, args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  },
  signal(pids, sig) {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {}
    }
  },
};

async function quitLinux({ sys = linuxSys, graceMs = 15000, pollMs = 200 } = {}) {
  const first = sys.list();
  if (!first.length) return;
  const mains = mainPids(first);
  if (mains.length) sys.signal(mains, 'SIGTERM');
  // Helpers left without a main process have nothing to wait for.
  const deadline = Date.now() + (mains.length ? graceMs : 0);
  while (sys.list().length && Date.now() < deadline) await sleep(pollMs);
  const left = sys.list();
  if (left.length) {
    sys.signal(left.map((e) => e.pid), 'SIGKILL');
    for (let i = 0; i < 25 && sys.list().length; i++) await sleep(pollMs);
  }
  if (sys.list().length) throw new Error('Claude Desktop did not quit');
}

// Quits Desktop and waits until it has exited, so it cannot rewrite the cookies we are about to swap.
async function quit(platform = process.platform, opts = {}) {
  if (platform !== 'darwin' && platform !== 'win32') return quitLinux(opts);
  if (platform === 'darwin') spawnSync('osascript', ['-e', 'quit app "Claude"']);
  else spawnSync('taskkill', ['/f', '/im', 'claude.exe']);
  for (let i = 0; i < 50 && running(platform); i++) await sleep(200);
  if (running(platform)) throw new Error('Claude Desktop did not quit');
}

// Why the live login must not be written into `slot` (or null when it may). A slot never takes a
// login that belongs to another account, and a login already saved in another slot is never copied
// again: that is how two accounts end up signed in as the same person.
// `replace` is for an explicit save by the user, which may overwrite a slot holding another login
// (the only way to repair a slot that was filled with the wrong person).
function captureBlock(liveId, slot, otherSlots = [], { replace = false } = {}) {
  if (!liveId) return 'Claude Desktop is not signed in.';
  const held = loginId(slot);
  if (held === liveId) return null;
  if (held && !replace) return 'This account already holds a different Desktop login. Sign in to it in Desktop first.';
  if (otherSlots.some((s) => loginId(s) === liveId)) return 'Desktop is signed in as an account that is already saved. Sign in to this account in Desktop first.';
  return null;
}

// Switching to a slot that holds the login Desktop already has would restart Desktop for nothing.
function switchBlock(toSlot, dir = defaultDir()) {
  const id = loginId(toSlot);
  if (!id || id !== loginId(dir)) return null;
  return 'Claude Desktop is already signed in as this account (the same login it has stored on this machine, open or not), so there is nothing to switch.';
}

// Swaps Desktop to the account in slot `toSlot`. The outgoing login is saved to `fromSlot` first
// (only when Desktop is signed in as that account, so a manual sign-in as someone else is never
// overwritten onto it). `url` (a claude:// link) is passed as a launch argument; macOS delivers URLs
// through LaunchServices, so there it is opened a few seconds after launch.
async function switchTo(toSlot, { fromSlot, otherSlots = [], url, beforeLaunch, platform = process.platform, dir = defaultDir(platform) } = {}) {
  if (!hasLogin(toSlot)) throw new Error('That account has no saved Desktop login yet. Sign in once, then capture it.');
  await quit(platform);
  backupLogin(dir);
  if (fromSlot && !captureBlock(loginId(dir), fromSlot, otherSlots)) captureLogin(fromSlot, dir);
  restoreLogin(toSlot, dir);
  if (beforeLaunch) beforeLaunch();
  const { cmd, args } = launchCommand(platform);
  const child = spawn(cmd, url && platform !== 'darwin' ? [...args, url] : args, { detached: true, stdio: 'ignore', env: launchEnv() });
  child.unref();
  if (url && platform === 'darwin') setTimeout(() => spawn('open', [url], { detached: true, stdio: 'ignore' }).unref(), 6000);
}

module.exports = { defaultDir, loginId, hasLogin, captureLogin, refreshTokens, captureBlock, switchBlock, restoreLogin, clearLogin, backupLogin, launchCommand, isInstalled, launchEnv, mainPids, quit, switchTo };
