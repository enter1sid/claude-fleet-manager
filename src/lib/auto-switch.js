// Auto mode: when a target's current account passes SWITCH_ABOVE % of its 5-hour session, move that
// target to the account with the lowest usage. Desktop and the CLI are evaluated independently.
const DEFAULT_SWITCH_ABOVE = 80;

// Last reading, treated as 0 once its reset time has passed (the window has rolled over).
function effectiveUsage(account, now = Date.now()) {
  if (account.usagePercent == null) return null;
  const reset = account.resetAt ? Date.parse(account.resetAt) : NaN;
  return Number.isFinite(reset) && reset <= now ? 0 : account.usagePercent;
}

function shouldSwitch(account, threshold = DEFAULT_SWITCH_ABOVE, now = Date.now()) {
  const u = effectiveUsage(account, now);
  return u != null && u > threshold;
}

// Lowest-usage account other than the current one. Skips signed-out accounts, accounts with no
// reading, accounts in `skipIds` (recently switched away from), accounts `eligible` rejects (no login
// for the target, so switching would need a sign-in) and anything not lower than current.
function pickNextAccount(accounts, currentId, { skipIds = new Set(), eligible = () => true, now = Date.now() } = {}) {
  const current = accounts.find((a) => a.id === currentId);
  const currentUsage = current ? effectiveUsage(current, now) : null;
  const candidates = accounts
    .filter((a) => a.id !== currentId && a.loggedIn && !a.expired && !skipIds.has(a.id) && eligible(a))
    .map((a) => ({ account: a, usage: effectiveUsage(a, now) }))
    .filter((c) => c.usage != null && (currentUsage == null || c.usage < currentUsage));
  candidates.sort((a, b) => a.usage - b.usage);
  return candidates.length ? candidates[0].account : null;
}

module.exports = { DEFAULT_SWITCH_ABOVE, effectiveUsage, shouldSwitch, pickNextAccount };
