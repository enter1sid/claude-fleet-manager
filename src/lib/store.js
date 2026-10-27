const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Accounts live in one 0600 JSON file. Each account keeps its CLI login snapshot (if captured) and
// the path of its own Claude Desktop profile.
function createStore(dir) {
  const file = path.join(dir, 'accounts.json');
  const empty = () => ({ accounts: [], autoMode: true, loginMethod: 'ask', threshold: 80, active: { desktop: null, cli: null }, ignored: [] });

  function load() {
    try {
      return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return empty();
    }
  }

  function save(state) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function addAccount(state, label, extra = {}) {
    const id = crypto.randomUUID();
    state.accounts.push({
      id,
      label,
      desktopProfile: path.join(dir, 'profiles', id),
      cli: null,
      loggedIn: false,
      usagePercent: null,
      resetAt: null,
      ...extra,
    });
    return id;
  }

  // A manual rename sticks: only an auto-generated label (no '@', not renamed) is replaced by the sign-in email.
  function adoptEmail(account, email) {
    if (email && !account.customLabel && !/@/.test(account.label)) account.label = email;
  }

  function renameAccount(account, name) {
    const label = String(name || '').trim().slice(0, 60);
    if (!label) return false;
    account.label = label;
    account.customLabel = true;
    return true;
  }

  return { file, load, save, addAccount, adoptEmail, renameAccount };
}

module.exports = { createStore };
