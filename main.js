const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_DESKTOP_BIN || '/usr/bin/claude-desktop';
const PROFILES_ROOT = path.join(app.getPath('home'), '.claude-fleet-profiles');
const ACCOUNTS_FILE = path.join(app.getPath('userData'), 'accounts.json');
const TOP_BAR_HEIGHT = 44;
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

// No fixed slot count — the board starts empty and accounts are added on demand.
function defaultAccounts() {
  return [];
}

function newAccount(label) {
  const id = crypto.randomUUID();
  return {
    id,
    label: label || 'New account',
    profileDir: path.join(PROFILES_ROOT, id),
    usagePercent: null,
    resetTime: '',
    usageDetectedAt: null,
    hasLoggedInApp: false,
    hasLaunchedDesktop: false,
    updatedAt: new Date().toISOString(),
  };
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    const accounts = defaultAccounts();
    saveAccounts(accounts);
    return accounts;
  }
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read accounts.json, recreating from defaults:', err);
    const accounts = defaultAccounts();
    saveAccounts(accounts);
    return accounts;
  }
}

function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function updateAccountField(accountId, fields) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx === -1) throw new Error(`Unknown account id: ${accountId}`);
  accounts[idx] = { ...accounts[idx], ...fields, updatedAt: new Date().toISOString() };
  saveAccounts(accounts);
  return accounts[idx];
}

function addAccount(label) {
  const accounts = loadAccounts();
  const account = newAccount(label);
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

async function removeAccount(accountId) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return accounts;

  if (inlineAccountId === accountId) closeInlineLogin();
  killDesktopAccount(accountId);
  try {
    const s = session.fromPartition(`persist:${accountId}`);
    await s.clearStorageData();
    await s.clearAuthCache();
  } catch (err) {
    console.error(`Failed to clear session for ${accountId}:`, err);
  }
  try {
    fs.rmSync(account.profileDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove profile dir for ${accountId}:`, err);
  }

  const remaining = accounts.filter((a) => a.id !== accountId);
  saveAccounts(remaining);
  return remaining;
}

// --- Best-effort usage/reset-time detection ---------------------------------------------
// There is no public API for a Team-plan seat's live usage/reset-time (see README). This
// injects a passive scanner into the page itself (claude.ai) that looks for that info in
// whatever text is on screen. It only finds anything when claude.ai actually surfaces it
// (typically when you're close to or at the limit) — most of the time it will find nothing,
// which is expected, not a bug.
const USAGE_SCAN_SCRIPT = `
(function() {
  if (window.__claudeFleetScanInstalled) return;
  window.__claudeFleetScanInstalled = true;
  function scan() {
    try {
      const text = document.body ? document.body.innerText : '';
      const pctMatch = text.match(/(\\d{1,3})\\s?%\\s*(?:of (?:your )?(?:usage|limit)|used)/i)
        || text.match(/(?:usage|limit)[^\\d]{0,20}(\\d{1,3})\\s?%/i);
      const resetMatch = text.match(/reset[s]?\\s*(?:at|in)?\\s*([^.\\n,]{1,40})/i);
      const usagePercent = pctMatch ? Number(pctMatch[1]) : null;
      const resetTime = resetMatch ? resetMatch[1].trim() : null;
      if (usagePercent !== null || resetTime) {
        document.dispatchEvent(new CustomEvent('claude-fleet-usage-detected', { detail: { usagePercent, resetTime } }));
      }
    } catch (e) {}
  }
  scan();
  setInterval(scan, 10000);
})();
`;

const accountIdByWebContentsId = new Map();

function attachUsageScanner(webContents, accountId) {
  accountIdByWebContentsId.set(webContents.id, accountId);
  webContents.on('did-finish-load', () => {
    webContents.executeJavaScript(USAGE_SCAN_SCRIPT).catch(() => {});
  });
  webContents.on('destroyed', () => accountIdByWebContentsId.delete(webContents.id));
}

ipcMain.on('usage-scan-result', (event, detail) => {
  const accountId = accountIdByWebContentsId.get(event.sender.id);
  if (!accountId) return;
  updateAccountField(accountId, {
    usagePercent: detail.usagePercent,
    resetTime: detail.resetTime,
    usageDetectedAt: new Date().toISOString(),
  });
});

const ACCOUNT_PRELOAD = path.join(__dirname, 'renderer', 'account-preload.js');

// --- Step 1: log in via an embedded claude.ai view docked inside the main window (no
// extra top-level window). Backed by its own persist:account-N session partition, which
// Electron guarantees persists across restarts.
//
// NOTE: this session is NOT shared with the real Claude Desktop app below — confirmed by
// reading Claude Desktop's own bundled source. The "device-code" flow in there is for
// enterprise Entra ID / third-party model provider SSO, unrelated to normal claude.ai
// sign-in. There is no supported bridge between a browser-authenticated session and a
// Claude Desktop profile, so each needs its own one-time login; this tool just makes each
// one persist independently afterward.
let inlineView = null;
let inlineAccountId = null;

function closeInlineLogin() {
  if (inlineView) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(inlineView);
    }
    // Detaching from the view tree alone leaves the WebContents (and its persist: partition
    // session) alive in memory, so a later clearStorageData() wouldn't durably log the account
    // out. Tear it down so the session is actually released.
    const wc = inlineView.webContents;
    if (wc && !wc.isDestroyed()) wc.close();
  }
  inlineView = null;
  inlineAccountId = null;
}

function resizeInlineView() {
  if (!inlineView || !mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  inlineView.setBounds({ x: 0, y: TOP_BAR_HEIGHT, width, height: Math.max(0, height - TOP_BAR_HEIGHT) });
}

function openInlineLogin(account) {
  closeInlineLogin();
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${account.id}`,
      preload: ACCOUNT_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachUsageScanner(view.webContents, account.id);
  view.webContents.loadURL('https://claude.ai');
  mainWindow.contentView.addChildView(view);
  inlineView = view;
  inlineAccountId = account.id;
  resizeInlineView();
}

// --- Step 2 (once step 1 has been done at least once): open the real, separately
// installed Claude Desktop app. It reads CLAUDE_USER_DATA_DIR (not the generic Electron
// --user-data-dir CLI switch) to decide where to store its own profile — setting that env
// var per spawn is what isolates and persists each account's Desktop-app login across
// launches. First time, it'll show its own sign-in screen (see note above); after that,
// it's remembered.
const desktopPidByAccount = new Map();

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Process-level isolation (CLAUDE_USER_DATA_DIR) is confirmed working correctly — verified by
// running two instances with different profile dirs simultaneously and checking each got its
// own independent Chromium profile (including its own SingletonLock). What actually happens
// when a launch "shows the wrong account": the OS/window-manager doesn't hand focus to a
// window opened by a background-spawned process, especially when another Claude window is
// already on screen — so you keep seeing whatever was already in front. wmctrl explicitly
// asks the window manager to raise+focus the new window rather than relying on it to steal
// focus on its own. Best-effort only: requires wmctrl and a WM that honors _NET_ACTIVE_WINDOW
// (works on X11; not available under most Wayland compositors, where this quietly no-ops).
function findWindowIdByPid(pid) {
  return new Promise((resolve) => {
    execFile('wmctrl', ['-lp'], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split('\n').find((l) => l.trim().split(/\s+/)[2] === String(pid));
      resolve(line ? line.trim().split(/\s+/)[0] : null);
    });
  });
}

async function focusWindowByPid(pid) {
  for (let i = 0; i < 20; i++) {
    const id = await findWindowIdByPid(pid);
    if (id) {
      execFile('wmctrl', ['-ia', id], () => {});
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function launchDesktopAccount(account) {
  const existingPid = desktopPidByAccount.get(account.id);
  if (existingPid && isPidAlive(existingPid)) {
    focusWindowByPid(existingPid);
    return { alreadyRunning: true, pid: existingPid };
  }

  fs.mkdirSync(account.profileDir, { recursive: true });

  const child = spawn(CLAUDE_BIN, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_USER_DATA_DIR: account.profileDir },
  });
  child.unref();
  desktopPidByAccount.set(account.id, child.pid);
  focusWindowByPid(child.pid);
  return { alreadyRunning: false, pid: child.pid };
}

function killDesktopAccount(accountId) {
  const pid = desktopPidByAccount.get(accountId);
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  desktopPidByAccount.delete(accountId);
}

// --- Destructive: remove EVERY account outright — the same effect as clicking each card's "×"
// on all of them at once. Clears each account's sessions (the embedded partition and the
// external Desktop-app profile dir) and drops it from the board, for everyone sharing it.
async function removeAllSessions() {
  const accounts = loadAccounts();
  closeInlineLogin();
  for (const account of accounts) {
    killDesktopAccount(account.id);
    try {
      const s = session.fromPartition(`persist:${account.id}`);
      await s.clearStorageData();
      await s.clearAuthCache();
    } catch (err) {
      console.error(`Failed to clear session for ${account.id}:`, err);
    }
    try {
      fs.rmSync(account.profileDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to remove profile dir for ${account.id}:`, err);
    }
  }
  // Empty the board entirely, mirroring an individual removal applied to every account.
  saveAccounts([]);
  return [];
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Claude Fleet Manager',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('resize', resizeInlineView);
  mainWindow.on('closed', () => {
    inlineView = null;
    inlineAccountId = null;
  });
}

// On Linux/X11 (esp. GNOME) the desktop shell resolves a window's taskbar/overview icon by
// matching its WM_CLASS against an installed .desktop file's StartupWMClass — it ignores the
// BrowserWindow `icon` option for that. Pin the WM_CLASS to a known value so the bundled
// .desktop file (assets/claude-fleet-manager.desktop) can match it and supply the Claude icon.
app.commandLine.appendSwitch('class', 'claude-fleet-manager');

app.whenReady().then(() => {
  // macOS shows the app icon from the dock, not the BrowserWindow `icon` option; set it here.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(APP_ICON);
    } catch (err) {
      console.error('Failed to set dock icon:', err);
    }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('accounts:list', () => {
  const accounts = loadAccounts();
  return accounts.map((a) => ({
    ...a,
    inlineOpen: inlineAccountId === a.id,
    desktopRunning: desktopPidByAccount.has(a.id) && isPidAlive(desktopPidByAccount.get(a.id)),
  }));
});

ipcMain.handle('accounts:update', (_event, updatedAccount) => {
  return updateAccountField(updatedAccount.id, updatedAccount);
});

ipcMain.handle('accounts:add', (_event, label) => addAccount(label));

ipcMain.handle('accounts:remove', (_event, accountId) => removeAccount(accountId));

ipcMain.handle('accounts:resetStats', () => {
  const accounts = loadAccounts().map((a) => ({
    ...a,
    usagePercent: null,
    resetTime: '',
    usageDetectedAt: null,
    updatedAt: new Date().toISOString(),
  }));
  saveAccounts(accounts);
  return accounts;
});

ipcMain.handle('accounts:removeAllSessions', () => removeAllSessions());

ipcMain.handle('accounts:openInline', (_event, accountId) => {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown account id: ${accountId}`);
  openInlineLogin(account);
  if (!account.hasLoggedInApp) updateAccountField(accountId, { hasLoggedInApp: true });
  return { opened: true };
});

ipcMain.handle('accounts:closeInline', () => {
  closeInlineLogin();
  return { closed: true };
});

ipcMain.handle('accounts:launchDesktop', (_event, accountId) => {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown account id: ${accountId}`);
  const result = launchDesktopAccount(account);
  if (!result.alreadyRunning && !account.hasLaunchedDesktop) {
    updateAccountField(accountId, { hasLaunchedDesktop: true });
  }
  return result;
});
