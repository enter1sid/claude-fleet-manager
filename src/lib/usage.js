// Reads an account's 5-hour / weekly usage using its CLI login (the OAuth access token). Usage is
// per account, so one reading serves both Desktop and the CLI.
// UNVERIFIED: the endpoint and response shape are from memory of how Claude Code reports usage and
// could not be tested on the dev machine (no standalone CLI login there). Treat a null result as
// "no reading", never as 0%.
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

function clean(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

function parseUsage(body) {
  const five = body && body.five_hour;
  const week = body && body.seven_day;
  const usagePercent = clean(five && five.utilization);
  if (usagePercent == null) return null;
  return {
    usagePercent,
    resetAt: (five && five.resets_at) || null,
    weeklyPercent: clean(week && week.utilization),
    weeklyResetAt: (week && week.resets_at) || null,
  };
}

async function fetchUsage(oauth, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!oauth || !oauth.accessToken) return null;
  if (oauth.expiresAt && oauth.expiresAt <= now) return null; // expired; only the CLI itself can refresh it
  try {
    const res = await fetchImpl(ENDPOINT, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!res.ok) return null;
    return parseUsage(await res.json());
  } catch {
    return null;
  }
}

// Fallback for accounts with no (usable) CLI login: the Desktop profile's own claude.ai session.
// UNVERIFIED: the claude.ai usage endpoint and its response shape are assumed to match the OAuth one.
async function fetchDesktopUsage(cookieList, { fetchImpl = fetch } = {}) {
  const claude = (cookieList || []).filter((c) => /(^|\.)claude\.ai$/.test(c.host_key));
  const get = (n) => (claude.find((c) => c.name === n) || {}).value;
  const session = get('sessionKey');
  const org = get('lastActiveOrg');
  if (!session || !org || !/^[A-Za-z0-9-]+$/.test(org)) return null;
  try {
    const res = await fetchImpl(`https://claude.ai/api/organizations/${org}/usage`, {
      headers: { Cookie: `sessionKey=${session}; lastActiveOrg=${org}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return parseUsage(await res.json());
  } catch {
    return null;
  }
}

module.exports = { fetchUsage, fetchDesktopUsage, parseUsage };
