// Account session lifetime. Each account has `expiresAt` (ISO string, null = never) chosen when it was
// added. When it passes, the stored CLI login and Desktop profile are wiped; if the account is the
// active one for a target, that live login is removed as well (CLI credentials cleared, Desktop quit).
// The account row stays, marked `expired`, so it is visible and can be signed in again.
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

// Choices offered in the expiry dropdown; 0 = never.
const EXPIRY_OPTIONS = [
  { days: 1, label: '1 day' },
  { days: 2, label: '2 days' },
  { days: 5, label: '5 days' },
  { days: 10, label: '10 days' },
  { days: 0, label: 'Never' },
];

// days <= 0 (or not a number) = never expires.
function expiryFromDays(days, now = Date.now()) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? new Date(now + n * DAY_MS).toISOString() : null;
}

const isExpired = (account, now = Date.now()) => !!account.expiresAt && Date.parse(account.expiresAt) <= now;

// Only removes folders inside profilesRoot, whatever the stored path says.
function removeProfile(dir, profilesRoot) {
  if (!dir || !profilesRoot) return;
  const rel = path.relative(path.resolve(profilesRoot), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

// Mutates `state`; returns the labels it wiped. deps: { profilesRoot, clearCli(snapshot), quitDesktop() }.
function sweepExpired(state, deps, now = Date.now()) {
  const wiped = [];
  for (const a of state.accounts) {
    if (a.expired || !isExpired(a, now)) continue;
    if (state.active.cli === a.id) {
      try {
        deps.clearCli(a.cli);
      } catch {}
      state.active.cli = null;
    }
    if (state.active.desktop === a.id) {
      try {
        deps.quitDesktop();
      } catch {}
      state.active.desktop = null;
    }
    removeProfile(a.desktopProfile, deps.profilesRoot);
    a.cli = null;
    a.loggedIn = false;
    a.expired = true;
    a.usagePercent = null;
    a.resetAt = null;
    a.weeklyPercent = null;
    a.weeklyResetAt = null;
    wiped.push(a.label);
  }
  return wiped;
}

// Deletes the given accounts and their stored Desktop profiles; returns their labels. The live Desktop
// and CLI logins are left signed in.
function removeAccounts(state, ids, profilesRoot) {
  const gone = state.accounts.filter((a) => ids.includes(a.id));
  for (const a of gone) removeProfile(a.desktopProfile, profilesRoot);
  state.accounts = state.accounts.filter((a) => !ids.includes(a.id));
  for (const t of ['desktop', 'cli']) if (ids.includes(state.active[t])) state.active[t] = null;
  return gone.map((a) => a.label);
}

// Pushes an unexpired account's expiry later (never earlier, never revives an expired one).
function extendExpiry(account, days, now = Date.now()) {
  if (account.expired || isExpired(account, now)) return false;
  const next = expiryFromDays(days, now);
  if (account.expiresAt && (!next || Date.parse(next) > Date.parse(account.expiresAt))) account.expiresAt = next;
  return true;
}

function describeExpiry(account, now = Date.now()) {
  if (account.expired || isExpired(account, now)) return 'expired';
  if (!account.expiresAt) return null;
  const left = Date.parse(account.expiresAt) - now;
  return left >= DAY_MS ? `${Math.floor(left / DAY_MS)}d left` : `${Math.max(1, Math.ceil(left / 3600000))}h left`;
}

module.exports = { DAY_MS, EXPIRY_OPTIONS, expiryFromDays, isExpired, sweepExpired, removeAccounts, extendExpiry, describeExpiry };
