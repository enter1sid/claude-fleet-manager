// Reads, decrypts and re-encrypts the cookies of a Claude Desktop profile (a Chromium `Cookies`
// SQLite file). Chromium encrypts them with a machine-bound key, so for bundles they are exported
// decrypted (the bundle itself is AES-256-GCM encrypted) and re-encrypted with the importing
// machine's key. Formats:
//   Linux   v10 = AES-128-CBC, key from the fixed password "peanuts" (profiles are launched with
//           --password-store=basic); v11 = keyring password (read with secret-tool, if present)
//   macOS   v10 = AES-128-CBC, key from the Keychain item "Claude Safe Storage" (1003 iterations)
//   Windows v10 = AES-256-GCM, key from Local State, wrapped by DPAPI (unwrapped with PowerShell)
// Cookie DB version >= 24 prepends SHA-256(host_key) to the plaintext.
// UNVERIFIED on macOS and Windows; the Linux v10 path is covered by tests.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const COOKIE_FILES = ['Cookies', path.join('Network', 'Cookies')];
const CBC_IV = Buffer.alloc(16, 0x20);

const pbkdf2 = (password, iterations) => crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function findCookiesFile(profileDir) {
  for (const rel of COOKIE_FILES) {
    const f = path.join(profileDir, rel);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const LIBSECRET_LOOKUP = [
  'import gi',
  "gi.require_version('Secret','1')",
  'from gi.repository import Secret as S',
  "sc=S.Schema.new('chrome_libsecret_os_crypt_password_v2',S.SchemaFlags.DONT_MATCH_NAME,{'application':S.SchemaAttributeType.STRING})",
  "p=S.password_lookup_sync(sc,{'application':'Claude'},None)",
  "print(p or '',end='')",
].join('\n');

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 }).trim();
  } catch {
    return null;
  }
}

// Keys for this machine. `v11` and `gcm` are resolved lazily so nothing touches the keyring or
// PowerShell unless a cookie needs it.
function localKeys(profileDir, platform = process.platform) {
  if (platform === 'darwin') {
    const pw = run('security', ['find-generic-password', '-w', '-s', 'Claude Safe Storage', '-a', 'Claude']);
    return { platform, v10: pw ? pbkdf2(pw, 1003) : null };
  }
  if (platform === 'win32') {
    let key;
    return {
      platform,
      get gcm() {
        if (key !== undefined) return key;
        try {
          const state = JSON.parse(fs.readFileSync(path.join(profileDir, 'Local State'), 'utf8'));
          const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64').subarray(5); // strip "DPAPI"
          const out = run('powershell', ['-NoProfile', '-Command',
            `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${wrapped.toString('base64')}'),$null,'CurrentUser'))`]);
          key = out ? Buffer.from(out, 'base64') : null;
        } catch {
          key = null;
        }
        return key;
      },
    };
  }
  let v11;
  return {
    platform,
    v10: pbkdf2('peanuts', 1),
    get v11() {
      if (v11 === undefined) {
        const pw = run('secret-tool', ['lookup', 'application', 'Claude']) || run('python3', ['-c', LIBSECRET_LOOKUP]);
        v11 = pw ? pbkdf2(pw, 1) : null;
      }
      return v11;
    },
  };
}

function decryptValue(buf, host, keys, hashed) {
  if (!buf || buf.length < 4) return null;
  const tag = buf.subarray(0, 3).toString();
  let plain;
  try {
    if (keys.platform === 'win32') {
      if (tag !== 'v10' || !keys.gcm) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', keys.gcm, buf.subarray(3, 15));
      d.setAuthTag(buf.subarray(buf.length - 16));
      plain = Buffer.concat([d.update(buf.subarray(15, buf.length - 16)), d.final()]);
    } else {
      const key = tag === 'v10' ? keys.v10 : tag === 'v11' ? keys.v11 : null;
      if (!key) return null;
      const d = crypto.createDecipheriv('aes-128-cbc', key, CBC_IV);
      plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
    }
  } catch {
    return null;
  }
  if (hashed && plain.length >= 32 && plain.subarray(0, 32).equals(sha256(host))) plain = plain.subarray(32);
  return plain.toString('utf8');
}

function encryptValue(value, host, keys, hashed) {
  const data = Buffer.concat([hashed ? sha256(host) : Buffer.alloc(0), Buffer.from(value, 'utf8')]);
  if (keys.platform === 'win32') {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys.gcm, nonce);
    const enc = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([Buffer.from('v10'), nonce, enc, c.getAuthTag()]);
  }
  const c = crypto.createCipheriv('aes-128-cbc', keys.v10, CBC_IV);
  return Buffer.concat([Buffer.from('v10'), c.update(data), c.final()]);
}

function openDb(file, readOnly) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly });
}

function dbIsHashed(db) {
  try {
    const row = db.prepare("select value from meta where key='version'").get();
    return !!row && Number(row.value) >= 24;
  } catch {
    return false;
  }
}

// Works on a private copy so a running Desktop's lock and journal never matter.
function snapshot(file, dest) {
  fs.copyFileSync(file, dest);
  for (const ext of ['-wal', '-journal']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, dest + ext);
}

function withTempCopy(file, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-ck-'));
  try {
    const copy = path.join(dir, 'Cookies');
    snapshot(file, copy);
    return fn(copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Decrypted cookies of a profile: [{ host_key, name, value }]. Empty when there is no cookie file.
function readCookies(profileDir, { keys = localKeys(profileDir) } = {}) {
  const file = findCookiesFile(profileDir);
  if (!file) return [];
  return withTempCopy(file, (copy) => {
    const db = openDb(copy, true);
    try {
      const hashed = dbIsHashed(db);
      const out = [];
      for (const r of db.prepare('select host_key, name, value, encrypted_value from cookies').all()) {
        const value = r.encrypted_value && r.encrypted_value.length ? decryptValue(Buffer.from(r.encrypted_value), r.host_key, keys, hashed) : r.value;
        if (value != null && value !== '') out.push({ host_key: r.host_key, name: r.name, value });
      }
      return out;
    } finally {
      db.close();
    }
  });
}

// Writes a copy of the profile's cookie DB to `dest` with every value in plaintext. Returns the
// number of cookies, or 0 (and no file) when the profile has none.
function exportPlainDb(profileDir, dest, { keys = localKeys(profileDir) } = {}) {
  const file = findCookiesFile(profileDir);
  if (!file) return 0;
  snapshot(file, dest);
  let db;
  try {
    db = openDb(dest, false);
    db.prepare('select 1 from cookies limit 1').get();
  } catch {
    if (db) db.close();
    for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(dest + ext, { force: true });
    return 0; // unreadable cookie file: export the profile without cookies
  }
  try {
    const hashed = dbIsHashed(db);
    const upd = db.prepare('update cookies set value = ?, encrypted_value = x\'\' where rowid = ?');
    const del = db.prepare('delete from cookies where rowid = ?');
    let n = 0;
    for (const r of db.prepare('select rowid as id, host_key, value, encrypted_value from cookies').all()) {
      if (!r.encrypted_value || !r.encrypted_value.length) {
        n += r.value ? 1 : 0;
        continue;
      }
      const value = decryptValue(Buffer.from(r.encrypted_value), r.host_key, keys, hashed);
      if (value == null) del.run(r.id); // undecryptable here, so useless elsewhere too
      else {
        upd.run(value, r.id);
        n++;
      }
    }
    db.exec('pragma wal_checkpoint(truncate)');
    return n;
  } finally {
    db.close();
    for (const ext of ['-wal', '-shm', '-journal']) fs.rmSync(dest + ext, { force: true });
  }
}

// Encrypts, in place, every plaintext cookie of an imported DB with this machine's key.
function encryptPlainDb(file, { keys = localKeys(path.dirname(file)) } = {}) {
  const db = openDb(file, false);
  try {
    const hashed = dbIsHashed(db);
    const upd = db.prepare("update cookies set value = '', encrypted_value = ? where rowid = ?");
    let n = 0;
    for (const r of db.prepare("select rowid as id, host_key, value from cookies where length(encrypted_value) = 0 and value != ''").all()) {
      upd.run(encryptValue(r.value, r.host_key, keys, hashed), r.id);
      n++;
    }
    return n;
  } finally {
    db.close();
  }
}

module.exports = { findCookiesFile, localKeys, decryptValue, encryptValue, readCookies, exportPlainDb, encryptPlainDb, COOKIE_FILES };
