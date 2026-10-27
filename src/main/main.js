const { app, Tray, Menu, Notification, clipboard, nativeImage, dialog } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const { createStore } = require('../lib/store');
const { createCliAdapter, captureCurrent, applySnapshot, clearIfCurrent } = require('../lib/cli-creds');
const desktop = require('../lib/desktop');
const { shouldSwitch, pickNextAccount, effectiveUsage } = require('../lib/auto-switch');
const { buildHandoff, generateViaClaude, latestSessionCwd } = require('../lib/handoff');
const { fetchUsage, fetchDesktopUsage } = require('../lib/usage');
const cookies = require('../lib/cookies');
const expiry = require('../lib/expiry');
const procs = require('../lib/procs');
const { openClaudeWithHandoff, openCliLogin } = require('../lib/terminal');
const { pasteIntoFocusedWindow } = require('../lib/autotype');
const { saveHandoff, buildDesktopUrl } = require('../lib/launch');
const bundle = require('../lib/bundle');
const sessions = require('../lib/sessions');
const desktopToken = require('../lib/desktop-token');
const { askPassphrase, askExpiry, askText, askLoginMethod } = require('./prompt');

if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'darwin' && app.dock) app.dock.hide();

const store = createStore(app.getPath('userData'));
const cliAdapter = createCliAdapter();
const switchedFrom = { desktop: new Set(), cli: new Set() };
let tray;

const clickable = new Set(); // keeps clickable notifications from being garbage collected
function notify(title, body, onClick) {
  const n = new Notification({ title, body });
  if (onClick) {
    clickable.add(n);
    n.on('click', onClick);
    n.on('close', () => clickable.delete(n));
  }
  n.show();
}
const byId = (state, id) => state.accounts.find((a) => a.id === id);

// Stops running CLI sessions, swaps the login, and starts a fresh session with a handoff.
async function switchCli(state, account, { force = false } = {}) {
  if (!account.cli) return notify('Fleet Manager', `${account.label} has no CLI login captured yet.`);
  // Sessions hosted by Claude Desktop are left alone here; a Desktop switch restarts them.
  const running = procs.findClaudeCli().filter((p) => !p.hosted);
  const handoffs = [];
  if (force) {
    for (const p of running.map((r) => ({ ...r, cwd: r.cwd || latestSessionCwd() })).filter((r) => r.cwd)) {
      // Ask the account being left first; fall back to the local transcript extract.
      const local = buildHandoff({ cwd: p.cwd });
      const generated = await generateViaClaude({ cwd: p.cwd });
      handoffs.push({ cwd: p.cwd, handoff: generated ? { ...(local || {}), message: generated } : local });
    }
  }
  sessions.backupSessions({ dir: desktop.defaultDir(), accountId: null, backupRoot: path.join(app.getPath('userData'), 'session-backups'), cwds: running.map((p) => p.cwd || latestSessionCwd()).filter(Boolean) });
  if (force) procs.stop(running.map((p) => p.pid));
  applySnapshot(cliAdapter, account.cli);
  state.active.cli = account.id;
  for (const { cwd, handoff } of handoffs) {
    if (!handoff) continue;
    const file = saveHandoff(app.getPath('userData'), handoff.message);
    // The saved file is also referenced with @, so the CLI attaches it to the new session.
    const started = openClaudeWithHandoff(cwd, `${handoff.message}\n\nFull handoff file: @${file}`, { model: handoff.model });
    // Verify the new session actually came up; otherwise leave the handoff on the clipboard.
    setTimeout(() => {
      if (started && procs.findClaudeCli().some((p) => p.cwd === cwd)) return;
      clipboard.writeText(handoff.message);
      notify('Fleet Manager', `Could not start the next session in ${cwd}. The handoff is on your clipboard and saved at ${file}.`);
    }, 20000);
  }
}

async function switchDesktop(state, account, { force = false } = {}) {
  // The folder in use: a running claude session's folder, else the most recent session's.
  const folder = (procs.findClaudeCli().find((p) => p.cwd) || {}).cwd || latestSessionCwd();
  const handoff = force && folder ? buildHandoff({ cwd: folder }) : null;
  if (force && !handoff) notify('Fleet Manager', 'No recent session found to hand off, so Desktop was just switched.');
  const model = handoff && handoff.model ? ` Previous model: ${handoff.model}; set it manually if it differs.` : '';
  const from = byId(state, state.active.desktop);
  const fromSlot = from && from.id !== account.id ? from.desktopProfile : null;
  const otherSlots = state.accounts.filter((a) => !from || a.id !== from.id).map((a) => a.desktopProfile);
  const fromId = desktop.loginId(desktop.defaultDir());
  const toId = desktop.loginId(account.desktopProfile);
  const dir = desktop.defaultDir();
  const backup = sessions.backupSessions({ dir, accountId: fromId, backupRoot: path.join(app.getPath('userData'), 'session-backups'), cwds: procs.findClaudeCli().map((p) => p.cwd).filter(Boolean) });
  if (backup) notify('Fleet Manager', `Sessions backed up (${backup.sessions} Desktop, ${backup.transcripts} transcripts) at ${backup.dir}.`);
  const beforeLaunch = () => sessions.carrySessions({ dir, fromId, toId });
  if (!handoff) {
    await desktop.switchTo(account.desktopProfile, { fromSlot, otherSlots, beforeLaunch });
  } else {
    const file = saveHandoff(app.getPath('userData'), handoff.message);
    clipboard.writeText(handoff.message); // safety net if the URL launch doesn't take
    const { url } = buildDesktopUrl({ message: handoff.message, file, folder });
    await desktop.switchTo(account.desktopProfile, { fromSlot, otherSlots, url, beforeLaunch });
    notify('Fleet Manager', `Starting a new session with the handoff (also on your clipboard, saved at ${file}).${model}`);
  }
  state.active.desktop = account.id;
  // Desktop rewrites its own login state while starting; tell the user if it did not come up as `account`.
  if (toId) setTimeout(() => {
    if (desktop.loginId(dir) !== toId) notify('Fleet Manager', `Claude Desktop did not come up as ${account.label}. Pick the account again, or sign in to it from Add account.`);
  }, 20000);
}

// Whether a missing login is created through Desktop (true) or the CLI sign-in (false), per the saved setting.
const viaDesktopFor = (method) => (method === 'cli' ? false : desktop.isInstalled());

// A slot saved from cookies alone (e.g. an imported bundle) has no OAuth token cache, so no CLI login can be
// derived from it. Opening Desktop once on that account makes it write the cache, which is then saved back.
async function hydrateDesktop(state, account) {
  await switchDesktop(state, account);
  const dir = desktop.defaultDir();
  for (let i = 0; i < 30 && !desktop.loginId(dir); i++) await new Promise((r) => setTimeout(r, 2000));
  if (!desktop.loginId(dir)) return 'Claude Desktop did not finish signing in as this account. Open it once, then try again.';
  desktop.captureLogin(account.desktopProfile, dir);
  return null;
}

// Makes sure `account` can be used in `targets` with no further prompt. A login that is missing is
// completed here: the CLI one is derived from Desktop's, and a Desktop one needs a single Desktop
// sign-in (which then also serves the CLI). Returns { error, done } where `done` lists targets the
// sign-in already left active.
async function completeLogins(state, account, targets) {
  const done = [];
  if (targets.includes('desktop') && !desktop.hasLogin(account.desktopProfile)) {
    if (!desktop.isInstalled()) return { error: 'Claude Desktop is not installed.', done };
    const err = await signInDesktop(state, account);
    if (err) return { error: err, done };
    done.push('desktop');
  }
  if (targets.includes('cli') && !account.cli) {
    let err = null;
    if (!desktop.hasLogin(account.desktopProfile) && viaDesktopFor(state.loginMethod)) {
      err = await signInDesktop(state, account);
      if (!err) done.push('desktop');
    } else if (desktop.hasLogin(account.desktopProfile) && !desktop.loginId(account.desktopProfile) && desktop.isInstalled()) {
      err = await hydrateDesktop(state, account);
      if (!err) done.push('desktop');
    }
    if (!err) err = desktop.hasLogin(account.desktopProfile) ? deriveCli(state, account) : await signInCli(state, account);
    if (err) return { error: err, done };
    done.push('cli');
  }
  return { error: null, done };
}

async function apply(targets, id, opts = {}) {
  const state = store.load();
  const account = byId(state, id);
  if (!account) return;
  if (account.expired || expiry.isExpired(account)) return notify('Fleet Manager', `${account.label} has expired and was wiped from this machine.`);
  if (!opts.auto) {
    if (signingIn) return notify('Fleet Manager', 'A sign-in is already in progress.');
    signingIn = true;
    try {
      const { error, done } = await completeLogins(state, account, targets);
      store.save(state);
      if (error) {
        refresh();
        return notify('Fleet Manager', `${account.label}: ${error}`);
      }
      // A sign-in that just made this account active in a target has already switched it.
      targets = targets.filter((t) => !(done.includes(t) && state.active[t] === account.id));
    } catch (err) {
      return notify('Fleet Manager', `Sign-in failed: ${err.message}`);
    } finally {
      signingIn = false;
    }
    if (!targets.length) return refresh();
  }
  const same = targets.includes('desktop') && desktop.switchBlock(account.desktopProfile);
  if (same) {
    notify('Fleet Manager', same);
    targets = targets.filter((t) => t !== 'desktop');
    if (!targets.length) return;
  }
  try {
    if (targets.includes('desktop')) await switchDesktop(state, account, opts);
    if (targets.includes('cli')) await switchCli(state, account, opts);
  } catch (err) {
    notify('Fleet Manager', `Switch failed: ${err.message}`);
  }
  store.save(state);
  refresh();
}

// Refreshes each account's usage: from its CLI login when it has one, else from its Desktop
// profile's claude.ai session. The active CLI account's stored login is re-captured first, because
// the CLI itself refreshes that token.
async function pollUsage() {
  const adopted = store.load();
  const fromCli = adoptLiveCli(adopted);
  adoptLiveDesktop(adopted);
  store.save(adopted);
  offerDesktop(fromCli);
  ensureCli();
  const state = store.load();
  syncTokens(state);
  for (const a of state.accounts) {
    if (a.expired) continue;
    let reading = a.cli ? await fetchUsage(a.cli.oauth) : null;
    if (!reading && a.desktopProfile) {
      let list = [];
      try {
        list = cookies.readCookies(a.desktopProfile);
      } catch {}
      if (list.some((c) => c.name === 'sessionKey')) a.loggedIn = true;
      reading = await fetchDesktopUsage(list);
    }
    if (reading) Object.assign(a, reading);
  }
  store.save(state);
  refresh();
}

// Keeps saved logins fresh without any action from the user. Desktop and the CLI refresh their own
// tokens, so the live copy is written back into the account's saved one; an account that is not live
// in the CLI gets its CLI token re-derived from its (refreshed) Desktop token cache when that is newer.
function syncTokens(state) {
  const live = desktop.loginId(desktop.defaultDir());
  const holder = live && state.accounts.find((a) => !a.expired && desktop.loginId(a.desktopProfile) === live);
  if (holder) desktop.refreshTokens(holder.desktopProfile);
  for (const a of state.accounts) {
    if (a.expired || state.active.cli === a.id || !desktop.loginId(a.desktopProfile)) continue;
    const { snapshot } = desktopToken.cliSnapshotFromDesktop(a.desktopProfile, desktop.loginId(a.desktopProfile));
    const have = a.cli && a.cli.oauth ? a.cli.oauth.expiresAt || 0 : 0;
    if (snapshot && cliUuid(a.cli || snapshot) === cliUuid(snapshot) && snapshot.oauth.expiresAt > have) a.cli = snapshot;
  }
}

// Wipes accounts whose expiry has passed (stored logins, profiles, and the live login if active).
function sweep() {
  const state = store.load();
  const wiped = expiry.sweepExpired(state, {
    profilesRoot: path.join(app.getPath('userData'), 'profiles'),
    clearCli: (snapshot) => clearIfCurrent(cliAdapter, snapshot),
    quitDesktop: () => desktop.quit().catch(() => {}).then(() => desktop.clearLogin()),
  });
  if (!wiped.length) return;
  store.save(state);
  refresh();
  notify('Fleet Manager', `Expired and wiped from this machine: ${wiped.join(', ')}.`);
}

function autoTick() {
  const state = store.load();
  if (!state.autoMode) return;
  for (const target of ['desktop', 'cli']) {
    const current = byId(state, state.active[target]);
    if (!current) continue;
    if (!shouldSwitch(current, state.threshold)) {
      switchedFrom[target].delete(current.id);
      continue;
    }
    // Auto mode never prompts: only accounts already usable in this target are candidates.
    const eligible = target === 'desktop' ? (a) => desktop.hasLogin(a.desktopProfile) && !desktop.switchBlock(a.desktopProfile) : (a) => !!a.cli;
    const next = pickNextAccount(state.accounts, current.id, { skipIds: switchedFrom[target], eligible });
    if (!next) {
      notify('Fleet Manager', `${current.label} is at ${effectiveUsage(current)}% and no lower account is available.`);
      continue;
    }
    switchedFrom[target].add(current.id);
    notify('Fleet Manager', `${target}: ${current.label} at ${effectiveUsage(current)}%, switching to ${next.label}.`);
    apply([target], next.id, { force: true, auto: true });
  }
}

let signingIn = false;
const cliUuid = (snap) => snap && snap.oauthAccount && snap.oauthAccount.accountUuid;

// Gives `account` a CLI login derived from its saved Desktop login. Returns an error string or null.
function deriveCli(state, account) {
  if (account.cli) return null;
  const { snapshot, email, error } = desktopToken.cliSnapshotFromDesktop(account.desktopProfile, desktop.loginId(account.desktopProfile));
  if (error) return error;
  const holder = state.accounts.find((a) => a.id !== account.id && cliUuid(a.cli) === cliUuid(snapshot));
  if (holder) return `The CLI login would duplicate ${holder.label}.`;
  account.cli = snapshot;
  account.loggedIn = true;
  store.adoptEmail(account, email);
  return null;
}

// Fills in the CLI side of every account that has a Desktop login but no CLI login yet.
function ensureCli() {
  const state = store.load();
  const done = [];
  for (const a of state.accounts) {
    if (a.expired || a.cli || !desktop.loginId(a.desktopProfile)) continue;
    const err = deriveCli(state, a);
    if (err) notify('Fleet Manager', `${a.label}: could not set up the CLI login. ${err}`);
    else done.push(a.label);
  }
  if (!done.length) return;
  store.save(state);
  refresh();
  notify('Fleet Manager', `CLI login set up from the Desktop login for: ${done.join(', ')}.`);
}

// Signs Desktop out, relaunches it, waits for the sign-in, and saves it into `account`.
async function signInDesktop(state, account) {
  const dir = desktop.defaultDir();
  adoptLiveDesktop(state);
  await desktop.quit();
  // Save the outgoing login's latest tokens into its own slot before the profile is signed out.
  const outgoing = desktop.loginId(dir);
  const holder = outgoing && state.accounts.find((a) => a.id !== account.id && !a.expired && desktop.loginId(a.desktopProfile) === outgoing);
  if (holder) desktop.captureLogin(holder.desktopProfile, dir);
  desktop.backupLogin(dir);
  desktop.clearLogin(dir);
  const { cmd, args } = desktop.launchCommand();
  spawn(cmd, args, { detached: true, stdio: 'ignore', env: desktop.launchEnv() }).unref();
  notify('Fleet Manager', 'Sign in to Claude Desktop now. Waiting up to 5 minutes.');
  let live = null;
  for (let i = 0; i < 150 && !live; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    live = desktop.loginId(dir);
  }
  if (!live) return 'Desktop sign-in did not finish.';
  const others = state.accounts.filter((a) => a.id !== account.id && !a.expired).map((a) => a.desktopProfile);
  const blocked = desktop.captureBlock(live, account.desktopProfile, others, { replace: true });
  if (blocked) return `Desktop login not saved: ${blocked} Sign out of claude.ai in the browser and try again.`;
  desktop.captureLogin(account.desktopProfile, dir);
  account.loggedIn = true;
  state.active.desktop = account.id;
  return null;
}

// Without Desktop: signs in through `claude auth login` and saves the new CLI login into `account`.
async function signInCli(state, account) {
  const prev = captureCurrent(cliAdapter);
  const active = byId(state, state.active.cli);
  if (prev && active && cliUuid(active.cli) && cliUuid(active.cli) === cliUuid(prev)) active.cli = prev;
  if (!openCliLogin()) return 'No terminal found to run `claude auth login`. Run it yourself, then try again.';
  notify('Fleet Manager', 'Complete `claude auth login` in the terminal. Waiting up to 5 minutes.');
  let live = null;
  for (let i = 0; i < 150 && !live; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cur = captureCurrent(cliAdapter);
    if (cur && (!prev || cur.oauth.accessToken !== prev.oauth.accessToken)) live = cur;
  }
  if (!live) return 'CLI sign-in did not finish.';
  const holder = state.accounts.find((a) => a.id !== account.id && cliUuid(a.cli) && cliUuid(a.cli) === cliUuid(live));
  if (holder) return `That login already belongs to ${holder.label}.`;
  account.cli = live;
  account.loggedIn = true;
  store.adoptEmail(account, live.oauthAccount && live.oauthAccount.emailAddress);
  state.active.cli = account.id;
  return null;
}

// The single sign-in. With Desktop installed it is signed in once and the CLI login is derived from it;
// without Desktop the CLI is signed in directly.
async function signInAccount() {
  if (signingIn) return notify('Fleet Manager', 'A sign-in is already in progress.');
  signingIn = true;
  try {
    const state = store.load();
    const installed = desktop.isInstalled();
    let method = state.loginMethod;
    if (method === 'desktop' && !installed) return notify('Fleet Manager', 'Claude Desktop is not installed. Pick another login method from the menu.');
    if (method !== 'desktop' && method !== 'cli') method = await askLoginMethod('Add account', { desktopAvailable: installed });
    if (!method) return;
    const days = await askExpiry('Session lifetime for this account');
    if (days == null) return;
    const account = byId(state, store.addAccount(state, `Account ${state.accounts.length + 1}`, { expiresAt: expiry.expiryFromDays(days) }));
    const viaDesktop = method === 'desktop';
    const err = viaDesktop ? (await signInDesktop(state, account)) || deriveCli(state, account) : await signInCli(state, account);
    // A sign-in that failed leaves no empty account behind.
    if (err && !account.cli && !desktop.hasLogin(account.desktopProfile)) expiry.removeAccounts(state, [account.id], path.join(app.getPath('userData'), 'profiles'));
    store.save(state);
    refresh();
    notify('Fleet Manager', err ? `Sign-in: ${err}` : `${account.label} is ready for ${viaDesktop ? 'both Desktop and the CLI' : 'the CLI'}.`);
  } catch (err) {
    notify('Fleet Manager', `Sign-in failed: ${err.message}`);
  } finally {
    signingIn = false;
  }
}

// Whoever the main Desktop window is signed in as stays the active Desktop account. If that login
// is not saved anywhere yet, it is saved into the account marked active for Desktop.
// A login that is live in Desktop but saved nowhere becomes an account of its own (unless the user
// removed it on purpose), and ensureCli then gives it its CLI login. Mutates `state`; returns whether
// anything changed.
function adoptLiveDesktop(state) {
  const live = desktop.loginId(desktop.defaultDir());
  if (!live) return false;
  const holder = state.accounts.find((a) => desktop.loginId(a.desktopProfile) === live);
  if (holder && holder.expired) return false;
  const active = byId(state, state.active.desktop);
  let target = holder || (active && !active.expired && !desktop.hasLogin(active.desktopProfile) ? active : null);
  if (!holder && !target) {
    if ((state.ignored || []).includes(live)) return false;
    target = byId(state, store.addAccount(state, `Account ${state.accounts.length + 1}`));
  }
  if (!holder && desktop.captureBlock(live, target.desktopProfile, state.accounts.filter((a) => a.id !== target.id).map((a) => a.desktopProfile))) return false;
  if (!holder) desktop.captureLogin(target.desktopProfile);
  target.loggedIn = true;
  state.active.desktop = target.id;
  return true;
}

// The mirror of the above for the CLI: a login that is live in the CLI becomes (or refreshes) an
// account. Returns the account when it was newly created, so Desktop can be offered for it.
function adoptLiveCli(state) {
  const live = captureCurrent(cliAdapter);
  const uuid = cliUuid(live);
  if (!uuid) return null;
  const email = (live.oauthAccount.emailAddress || '').toLowerCase();
  const known = state.accounts.find((a) => (a.cli && cliUuid(a.cli) === uuid) || (email && String(a.label).toLowerCase() === email));
  if (known) {
    if (known.expired) return null;
    if (!known.cli || cliUuid(known.cli) === uuid) known.cli = live;
    known.loggedIn = true;
    state.active.cli = known.id;
    return null;
  }
  if ((state.ignored || []).includes(uuid)) return null;
  const account = byId(state, store.addAccount(state, email || `Account ${state.accounts.length + 1}`));
  account.cli = live;
  account.loggedIn = true;
  state.active.cli = account.id;
  return account;
}

// A CLI-only account cannot get its Desktop login from the CLI token, so Desktop's own one-time
// sign-in is offered right away; one click on the notification runs it.
function offerDesktop(account) {
  if (!account || !desktop.isInstalled() || desktop.hasLogin(account.desktopProfile)) return;
  notify('Fleet Manager', `${account.label} was added from the CLI login. Click here to make it available in Claude Desktop too.`, () => apply(['desktop'], account.id, { force: true }));
}

// Remembers the logins of accounts being removed, so the still-live login is not added back.
function forget(state, ids) {
  const ignored = new Set(state.ignored || []);
  for (const a of state.accounts.filter((x) => ids.includes(x.id))) {
    const d = desktop.loginId(a.desktopProfile);
    if (d) ignored.add(d);
    if (cliUuid(a.cli)) ignored.add(cliUuid(a.cli));
  }
  state.ignored = [...ignored];
}

async function exportAccounts() {
  const state = store.load();
  const exportable = state.accounts.filter((a) => !a.expired && !expiry.isExpired(a));
  if (!exportable.length) return notify('Fleet Manager', 'No accounts to export.');
  const { filePath } = await dialog.showSaveDialog({ title: 'Export accounts', defaultPath: 'claude-fleet-accounts.cfm.json' });
  if (!filePath) return;
  const pass = await askPassphrase('Passphrase for the export (8+ characters)', { confirm: true, allowEmpty: false });
  if (pass == null) return;
  try {
    const data = bundle.buildBundle(exportable);
    fs.writeFileSync(filePath, bundle.encrypt(data, pass), { mode: 0o600 });
    notify('Fleet Manager', `Exported ${exportable.length} account(s), each keeping its own expiry${data.expiresAt ? ` (earliest ${new Date(data.expiresAt).toLocaleString()})` : ''}. Share the passphrase separately.`);
  } catch (err) {
    notify('Fleet Manager', `Export failed: ${err.message}`);
  }
}

async function importAccounts() {
  const { filePaths } = await dialog.showOpenDialog({ title: 'Import accounts', properties: ['openFile'], filters: [{ name: 'Accounts bundle', extensions: ['json'] }] });
  if (!filePaths || !filePaths[0]) return;
  try {
    const text = fs.readFileSync(filePaths[0], 'utf8');
    const until = bundle.peekExpiry(text);
    const pass = bundle.isProtected(text) ? await askPassphrase(`Passphrase for this bundle${until ? ` (expires ${new Date(until).toLocaleString()})` : ''}`) : '';
    if (pass == null) return;
    const state = store.load();
    const result = bundle.applyImport(bundle.decrypt(text, pass), { profilesRoot: path.join(app.getPath('userData'), 'profiles'), existingAccounts: state.accounts });
    state.accounts = result.accounts;
    store.save(state);
    refresh();
    notify('Fleet Manager', `Imported ${result.imported.length}, skipped ${result.skipped.length}${result.skipped.length ? ` (${result.skipped.map((s) => `${s.label}: ${s.reason}`).join('; ')})` : ''}.`);
  } catch (err) {
    notify('Fleet Manager', `Import failed: ${err.message}`);
  }
}

async function confirmRemove(message) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message,
    detail: 'Deletes the saved login from this machine. Your current Desktop and CLI sessions stay signed in.',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

async function removeAccount(id) {
  const account = byId(store.load(), id);
  if (!account || !(await confirmRemove(`Remove ${account.label}?`))) return;
  const state = store.load();
  forget(state, [id]);
  expiry.removeAccounts(state, [id], path.join(app.getPath('userData'), 'profiles'));
  store.save(state);
  refresh();
  notify('Fleet Manager', `Removed ${account.label}.`);
}

async function removeAllAccounts() {
  const count = store.load().accounts.length;
  if (!count || !(await confirmRemove(`Remove all ${count} account(s)?`))) return;
  const state = store.load();
  forget(state, state.accounts.map((a) => a.id));
  expiry.removeAccounts(state, state.accounts.map((a) => a.id), path.join(app.getPath('userData'), 'profiles'));
  store.save(state);
  refresh();
  notify('Fleet Manager', `Removed ${count} account(s).`);
}

async function renameAccountPrompt(id) {
  const state = store.load();
  const a = byId(state, id);
  if (!a) return;
  const name = await askText('Rename account', { value: a.label, placeholder: 'Account name', hint: 'Shown in the tray menu.' });
  if (name == null || !store.renameAccount(a, name)) return;
  store.save(state);
  refresh();
}

async function extendAccount(id) {
  const days = await askExpiry('Extend this account', 10);
  if (days == null) return;
  const state = store.load();
  const a = byId(state, id);
  if (a && expiry.extendExpiry(a, days)) store.save(state);
  refresh();
}

function buildMenu() {
  const state = store.load();
  const usage = (a) => (effectiveUsage(a) == null ? '' : ` — ${effectiveUsage(a)}%`);
  const left = (a) => expiry.describeExpiry(a);
  const tag = (a) => [state.active.desktop === a.id && 'Desktop', state.active.cli === a.id && 'CLI'].filter(Boolean).join(' + ');
  const dot = (a) => (a.expired ? '✕' : tag(a) ? '●' : '○');
  const accounts = state.accounts.map((a) => ({
    label: `${dot(a)}  ${a.label}${usage(a)}${tag(a) ? `  [${tag(a)}]` : ''}${left(a) ? `  ·  ${left(a)}` : ''}`,
    submenu: [
      ...(a.expired
        ? [{ label: 'Expired — wiped from this machine', enabled: false }]
        : [
            { label: '🖥️  Use in Desktop', click: () => apply(['desktop'], a.id, { force: true }) },
            { label: '⌨️  Use in CLI', click: () => apply(['cli'], a.id, { force: true }) },
            { label: 'Use in both', click: () => apply(['desktop', 'cli'], a.id, { force: true }) },
            { type: 'separator' },
            { label: 'Extend expiry…', enabled: !!a.expiresAt, click: () => extendAccount(a.id) },
          ]),
      { label: 'Rename…', click: () => renameAccountPrompt(a.id) },
      { label: 'Remove account…', click: () => removeAccount(a.id) },
    ],
  }));
  const setMethod = (m) => () => {
    const s = store.load();
    s.loginMethod = m;
    store.save(s);
    refresh();
  };
  const method = ['ask', 'desktop', 'cli'].includes(state.loginMethod) ? state.loginMethod : 'ask';
  return Menu.buildFromTemplate([
    { label: 'Fleet Manager', enabled: false },
    { type: 'separator' },
    ...(accounts.length ? accounts : [{ label: 'No accounts yet', enabled: false }]),
    { type: 'separator' },
    { label: '＋  Add account…', click: () => signInAccount() },
    {
      label: 'Login method',
      submenu: [
        { label: 'Ask each time', type: 'radio', checked: method === 'ask', click: setMethod('ask') },
        { label: 'Claude Desktop', type: 'radio', checked: method === 'desktop', click: setMethod('desktop') },
        { label: 'Claude Code CLI', type: 'radio', checked: method === 'cli', click: setMethod('cli') },
      ],
    },
    {
      label: `Auto mode (switch above ${state.threshold}%)`,
      type: 'checkbox',
      checked: state.autoMode,
      click: (item) => {
        const s = store.load();
        s.autoMode = item.checked;
        store.save(s);
      },
    },
    { type: 'separator' },
    { label: 'Export accounts…', click: exportAccounts },
    { label: 'Import accounts…', click: importAccounts },
    { label: 'Remove all accounts…', enabled: state.accounts.length > 0, click: removeAllAccounts },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

const trayIcon = (alert) => nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', alert ? 'tray-alert.png' : 'tray.png')).resize({ width: 22, height: 22 });

function refresh() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  const state = store.load();
  tray.setImage(trayIcon(state.accounts.some((a) => a.expired)));
  const names = ['desktop', 'cli'].map((t) => `${t}: ${(byId(state, state.active[t]) || {}).label || '—'}`);
  tray.setToolTip(`Fleet Manager\n${names.join('\n')}`);
}

app.whenReady().then(() => {
  tray = new Tray(trayIcon(false));
  sweep();
  refresh();
  pollUsage();
  setInterval(sweep, 60 * 1000);
  setInterval(pollUsage, 5 * 60 * 1000);
  setInterval(autoTick, 60 * 1000);
  setInterval(refresh, 60 * 1000);
});

// Background app: stay alive with no windows.
app.on('window-all-closed', (e) => e.preventDefault());
