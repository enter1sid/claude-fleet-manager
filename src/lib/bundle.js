// Encrypted account bundles (AES-256-GCM, scrypt key) for sharing accounts inside the org. Each entry
// carries the account (including its CLI login snapshot and its own expiry) and, if present, its
// Desktop profile as a tarball.
// Portability: Chromium cookies are machine-bound, so on export they are decrypted into the profile
// copy (safe: the bundle is encrypted) and on import they are re-encrypted with the local key.
// Expiry: every account carries the `expiresAt` chosen when it was added (null = never). An import
// keeps that date and never extends it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const cookies = require('./cookies');

const FORMAT = 'claude-fleet-accounts';
const MAX_BUFFER = 1024 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Used when the exporter sets no passphrase: still encrypted, but anyone with the file can import it.
const DEFAULT_PASSPHRASE = 'claude-fleet-manager/no-passphrase/v1';

// Caches and lock files are useless elsewhere; history and shared config are machine-local.
const PLAIN_COOKIES = 'cfm-cookies.plain';
const TAR_EXCLUDES = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'CacheStorage', 'ScriptCache', 'Crashpad', 'Singleton*',
  'claude-code-sessions', 'claude-fleet-shared', 'scratch-workspaces',
  'claude_desktop_config.json', 'claude-code',
  'Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm', // replaced by the decrypted copy below
];

// Profile tarball plus a decrypted copy of its cookie DB. Returns { tar, cookiesRel } or null.
function tarProfile(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-bundle-'));
  try {
    const src = cookies.findCookiesFile(dir);
    const hasCookies = src && cookies.exportPlainDb(dir, path.join(stage, PLAIN_COOKIES)) > 0 && fs.existsSync(path.join(stage, PLAIN_COOKIES));
    const args = ['-czf', '-', ...TAR_EXCLUDES.map((e) => `--exclude=${e}`), '-C', dir, '.'];
    if (hasCookies) args.push('-C', stage, PLAIN_COOKIES);
    const tar = execFileSync('tar', args, { maxBuffer: MAX_BUFFER }).toString('base64');
    return { tar, cookiesRel: hasCookies ? path.relative(dir, src) : null };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Unpacks a profile and re-encrypts its cookies with this machine's key.
function untarProfile(b64, dir, cookiesRel) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', '-', '-C', dir], { input: Buffer.from(b64, 'base64'), maxBuffer: MAX_BUFFER });
  const plain = path.join(dir, PLAIN_COOKIES);
  if (!fs.existsSync(plain)) return;
  const rel = cookies.COOKIE_FILES.includes(cookiesRel) ? cookiesRel : cookies.COOKIE_FILES[0];
  const dest = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(plain, dest);
  cookies.encryptPlainDb(dest, { keys: cookies.localKeys(dir) });
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(obj, passphrase, { expiresAt = obj && obj.expiresAt } = {}) {
  const isProtected = !!passphrase;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase || DEFAULT_PASSPHRASE, salt), iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()]);
  return JSON.stringify({
    format: FORMAT, version: 2, protected: isProtected, expiresAt: expiresAt || null, cipher: 'aes-256-gcm', kdf: 'scrypt',
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decrypt(text, passphrase) {
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error('This file is not a Claude Fleet accounts bundle.');
  }
  if (env.format !== FORMAT) throw new Error('This file is not a Claude Fleet accounts bundle.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase || DEFAULT_PASSPHRASE, Buffer.from(env.salt, 'base64')), Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error(env.protected === false ? 'The bundle is corrupted.' : 'Wrong or missing passphrase, or the bundle is corrupted.');
  }
}

function isProtected(text) {
  try {
    return JSON.parse(text).protected !== false;
  } catch {
    return true;
  }
}

const earliest = (dates) => {
  const ts = dates.filter(Boolean).map(Date.parse).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
};
const isExpired = (iso, now) => !!iso && Date.parse(iso) <= now;

// Each entry keeps its account's own expiresAt; the bundle-level one is the earliest of them.
function buildBundle(accounts, { now = Date.now() } = {}) {
  return {
    version: 3,
    exportedAt: new Date(now).toISOString(),
    expiresAt: earliest(accounts.map((a) => a.expiresAt)),
    entries: accounts.map((a) => {
      const { desktopProfile, usagePercent, resetAt, weeklyPercent, weeklyResetAt, expired, ...account } = a;
      const profile = tarProfile(desktopProfile);
      return { account, desktopProfile: profile && profile.tar, cookiesRel: profile && profile.cookiesRel };
    }),
  };
}

// Entries already past their expiry are skipped; an existing account never gets a later expiry.
function applyImport(bundle, { profilesRoot, existingAccounts, overwrite = false, now = Date.now() }) {
  const entries = bundle.entries || [];
  const expiryOf = (e) => (e.account && e.account.expiresAt !== undefined ? e.account.expiresAt : bundle.expiresAt) || null;
  if (entries.length && entries.every((e) => isExpired(expiryOf(e), now))) {
    throw new Error(`This bundle expired on ${new Date(earliest(entries.map(expiryOf))).toLocaleString()}. Export a fresh one.`);
  }
  const accounts = [...existingAccounts];
  const imported = [];
  const skipped = [];
  for (const entry of entries) {
    const src = entry.account || {};
    const label = src.label || src.id;
    if (!SAFE_ID.test(src.id || '')) {
      skipped.push({ label, reason: 'invalid id' });
      continue;
    }
    const expiresAt = expiryOf(entry);
    if (isExpired(expiresAt, now)) {
      skipped.push({ label, reason: 'expired' });
      continue;
    }
    const idx = accounts.findIndex((a) => a.id === src.id);
    if (idx !== -1 && !overwrite) {
      skipped.push({ label, reason: 'already on this machine' });
      continue;
    }
    const desktopProfile = path.join(profilesRoot, src.id);
    if (entry.desktopProfile) untarProfile(entry.desktopProfile, desktopProfile, entry.cookiesRel);
    const record = {
      ...src,
      desktopProfile,
      expiresAt: idx === -1 ? expiresAt : earliest([expiresAt, accounts[idx].expiresAt]),
      expired: false,
      loggedIn: !!src.cli || !!entry.desktopProfile,
      usagePercent: null,
      resetAt: null,
      importedAt: new Date(now).toISOString(),
    };
    if (idx === -1) accounts.push(record);
    else accounts[idx] = record;
    imported.push(label);
  }
  return { accounts, imported, skipped };
}

// Display-only copy of the expiry from the clear envelope (the encrypted value is what is enforced).
function peekExpiry(text) {
  try {
    return JSON.parse(text).expiresAt || null;
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, isProtected, peekExpiry, buildBundle, applyImport };
