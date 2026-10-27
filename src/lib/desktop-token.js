// Derives a Claude Code CLI login from the OAuth token cache Claude Desktop keeps in config.json
// (`oauth:tokenCacheV2`, an Electron safeStorage blob), so one Desktop sign-in serves both apps.
// The cache layout is not documented, so the token is located by field name; when nothing matches,
// only the key paths (never values) are reported.
const fs = require('fs');
const path = require('path');
const cookies = require('./cookies');

const DEFAULT_SCOPES = ['user:inference', 'user:profile'];
const pick = (o, names) => names.map((n) => o[n]).find((v) => typeof v === 'string' && v);
const isObj = (v) => v && typeof v === 'object';

function readCache(dir, keys = cookies.localKeys(dir)) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const blob = cfg['oauth:tokenCacheV2'] || cfg['oauth:tokenCache'];
  if (typeof blob !== 'string') return null;
  const text = cookies.decryptValue(Buffer.from(blob, 'base64'), '', keys, false);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function* walk(v, trail = []) {
  if (!isObj(v)) return;
  yield [v, trail];
  for (const [k, c] of Object.entries(v)) yield* walk(c, [...trail, k]);
}

const toMs = (n) => (n > 0 && n < 1e12 ? n * 1000 : n);

// The most recently expiring entry that holds both an access and a refresh token.
function findOauth(cache) {
  let best = null;
  for (const [o] of walk(cache)) {
    const accessToken = pick(o, ['accessToken', 'access_token', 'token']);
    const refreshToken = pick(o, ['refreshToken', 'refresh_token']);
    if (!accessToken || !refreshToken) continue;
    const exp = toMs(Number(o.expiresAt || o.expires_at || 0)) || 0;
    if (!best || exp > best.expiresAt) {
      const scopes = Array.isArray(o.scopes) ? o.scopes : typeof o.scope === 'string' ? o.scope.split(' ') : DEFAULT_SCOPES;
      best = { accessToken, refreshToken, expiresAt: exp, scopes, ...(o.subscriptionType ? { subscriptionType: o.subscriptionType } : {}), ...(o.rateLimitTier ? { rateLimitTier: o.rateLimitTier } : {}) };
    }
  }
  return best;
}

function findEmail(cache) {
  for (const [o] of walk(cache)) {
    const e = pick(o, ['emailAddress', 'email']);
    if (e && /@/.test(e)) return e;
  }
  return null;
}

// Key paths only, safe to show.
function structureOf(cache, max = 40) {
  const out = [];
  const rec = (v, p) => {
    if (out.length >= max) return;
    if (!isObj(v)) return out.push(`${p}:${typeof v}`);
    for (const k of Object.keys(v)) rec(v[k], p ? `${p}.${/^[\w-]{20,}$/.test(k) ? '<id>' : k}` : k);
  };
  rec(cache, '');
  return [...new Set(out)].join(' ');
}

// { snapshot } for the CLI adapter, or { error } describing why not.
function cliSnapshotFromDesktop(dir, accountId, keys) {
  const cache = readCache(dir, keys);
  if (!cache) return { error: 'Desktop token cache could not be read or decrypted.' };
  const oauth = findOauth(cache);
  if (!oauth) return { error: `No access/refresh token found in the Desktop token cache. Layout: ${structureOf(cache)}` };
  const email = findEmail(cache);
  return { snapshot: { oauth, oauthAccount: { accountUuid: accountId, ...(email ? { emailAddress: email } : {}) } }, email };
}

module.exports = { readCache, findOauth, findEmail, structureOf, cliSnapshotFromDesktop };
