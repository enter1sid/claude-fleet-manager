// Finds the Claude logins already on this machine (Desktop and CLI) and saves them as accounts. The same
// person signed in to both becomes one account, accounts already saved are completed rather than
// duplicated, and logins the user removed on purpose (`state.ignored`) are skipped. Mutates `state`.
const desktop = require('./desktop');
const desktopToken = require('./desktop-token');
const { captureCurrent } = require('./cli-creds');

const cliUuid = (snap) => snap && snap.oauthAccount && snap.oauthAccount.accountUuid;

// Gives `account` a CLI login derived from its saved Desktop login. Returns an error string or null.
function deriveCli(state, account, store, keys) {
  if (account.cli) return null;
  const { snapshot, email, error } = desktopToken.cliSnapshotFromDesktop(account.desktopProfile, desktop.loginId(account.desktopProfile), keys);
  if (error) return error;
  const holder = state.accounts.find((a) => a.id !== account.id && cliUuid(a.cli) === cliUuid(snapshot));
  if (holder) return `The CLI login would duplicate ${holder.label}.`;
  account.cli = snapshot;
  account.loggedIn = true;
  store.adoptEmail(account, email);
  return null;
}

// Returns the labels of the accounts that were added or completed.
function detectLogins(state, store, { cliAdapter, desktopDir = desktop.defaultDir(), keys } = {}) {
  const touched = [];
  const liveCli = captureCurrent(cliAdapter);
  const cliId = cliUuid(liveCli);
  const deskId = desktop.loginId(desktopDir);
  const ignored = new Set(state.ignored || []);
  const email = ((liveCli && liveCli.oauthAccount && liveCli.oauthAccount.emailAddress) || '').toLowerCase();

  for (const uuid of new Set([cliId, deskId].filter(Boolean))) {
    if (ignored.has(uuid)) continue;
    let account = state.accounts.find((a) => (a.cli && cliUuid(a.cli) === uuid) || desktop.loginId(a.desktopProfile) === uuid || (uuid === cliId && email && String(a.label).toLowerCase() === email));
    if (account && account.expired) continue;
    const created = !account;
    if (created) {
      const id = store.addAccount(state, (uuid === cliId && email) || `Account ${state.accounts.length + 1}`);
      account = state.accounts.find((a) => a.id === id);
    }
    let changed = created;

    if (uuid === cliId && !account.cli) {
      account.cli = liveCli;
      changed = true;
    }
    if (uuid === deskId && desktop.loginId(account.desktopProfile) !== uuid) {
      const others = state.accounts.filter((a) => a.id !== account.id).map((a) => a.desktopProfile);
      if (!desktop.captureBlock(deskId, account.desktopProfile, others)) {
        desktop.captureLogin(account.desktopProfile, desktopDir);
        changed = true;
      }
    }
    if (!account.cli && desktop.loginId(account.desktopProfile) && !deriveCli(state, account, store, keys)) changed = true;

    if (!account.cli && !desktop.hasLogin(account.desktopProfile)) {
      state.accounts.splice(state.accounts.indexOf(account), 1);
      continue;
    }
    account.loggedIn = true;
    if (uuid === cliId && !state.active.cli) state.active.cli = account.id;
    if (uuid === deskId && !state.active.desktop) state.active.desktop = account.id;
    if (changed) touched.push(account.label);
  }
  return touched;
}

module.exports = { detectLogins, deriveCli, cliUuid };
