// Run by the installers (with the bundled runtime in node mode) before the tray app starts: saves the
// Claude Desktop and CLI logins found on this machine as accounts. Never fails the install.
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');
const { createCliAdapter } = require('../lib/cli-creds');
const { detectLogins } = require('../lib/detect');

function dataDir(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'claude-fleet-manager');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'claude-fleet-manager');
  return path.join(home, '.config', 'claude-fleet-manager');
}

try {
  const store = createStore(dataDir());
  const state = store.load();
  const found = detectLogins(state, store, { cliAdapter: createCliAdapter() });
  if (found.length) store.save(state);
  console.log(found.length ? `Detected ${found.length} signed-in account(s): ${found.join(', ')}.` : 'No new signed-in Claude accounts found.');
} catch (err) {
  console.log(`Could not detect signed-in accounts (${err.message}). Use "Add account" from the tray menu.`);
}
