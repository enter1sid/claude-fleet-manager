// Swaps the Claude Code CLI login in place. Linux keeps it in ~/.claude/.credentials.json plus an
// `oauthAccount` entry in ~/.claude.json; macOS keeps the credentials in the Keychain. The previous
// login is backed up so a failed swap rolls back. macOS path is untested.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function fileAdapter(home) {
  const credFile = path.join(home, '.claude', '.credentials.json');
  const configFile = path.join(home, '.claude.json');
  return {
    readCredentials: () => (fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : null),
    writeCredentials(text) {
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      atomicWrite(credFile, text);
    },
    readConfig: () => (fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}),
    writeConfig: (obj) => atomicWrite(configFile, JSON.stringify(obj, null, 2)),
  };
}

function keychainAdapter(home) {
  const user = os.userInfo().username;
  const base = fileAdapter(home);
  return {
    readCredentials() {
      try {
        return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', user, '-w'], { encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    },
    writeCredentials: (text) => execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', user, '-w', text]),
    readConfig: base.readConfig,
    writeConfig: base.writeConfig,
  };
}

function createCliAdapter({ home = os.homedir(), platform = process.platform } = {}) {
  return platform === 'darwin' ? keychainAdapter(home) : fileAdapter(home);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Snapshot of whoever is signed in to the CLI right now. Only the `claudeAiOauth` key is taken:
// the same file also holds MCP server tokens (`mcpOAuth`) that must never be copied or replaced.
function captureCurrent(adapter) {
  const oauth = parse(adapter.readCredentials()).claudeAiOauth;
  if (!oauth) return null;
  return { oauth, oauthAccount: adapter.readConfig().oauthAccount || null };
}

// Makes `snapshot` the active CLI login, leaving every other credential key untouched. The previous
// state is restored if anything fails.
function applySnapshot(adapter, snapshot) {
  if (!snapshot || !snapshot.oauth) throw new Error('account has no CLI login captured');
  const backupText = adapter.readCredentials();
  const backupConfig = adapter.readConfig();
  const restore = () => {
    if (backupText != null) adapter.writeCredentials(backupText);
    adapter.writeConfig(backupConfig);
  };
  try {
    const creds = parse(backupText);
    creds.claudeAiOauth = snapshot.oauth;
    adapter.writeCredentials(JSON.stringify(creds));
    const cfg = adapter.readConfig();
    if (snapshot.oauthAccount) cfg.oauthAccount = snapshot.oauthAccount;
    else delete cfg.oauthAccount;
    adapter.writeConfig(cfg);
  } catch (err) {
    try {
      restore();
    } catch {}
    throw err;
  }
}

// Signs the CLI out of `snapshot`'s account, but only if that account is the one currently logged in
// (matched by oauthAccount uuid or access token). MCP tokens and every other key stay untouched.
function clearIfCurrent(adapter, snapshot) {
  const live = captureCurrent(adapter);
  if (!live || !snapshot) return false;
  const sameUuid = live.oauthAccount && snapshot.oauthAccount && live.oauthAccount.accountUuid && live.oauthAccount.accountUuid === snapshot.oauthAccount.accountUuid;
  const sameToken = snapshot.oauth && live.oauth.accessToken === snapshot.oauth.accessToken;
  if (!sameUuid && !sameToken) return false;
  const creds = parse(adapter.readCredentials());
  delete creds.claudeAiOauth;
  adapter.writeCredentials(JSON.stringify(creds));
  const cfg = adapter.readConfig();
  delete cfg.oauthAccount;
  adapter.writeConfig(cfg);
  return true;
}

module.exports = { createCliAdapter, captureCurrent, applySnapshot, clearIfCurrent };
