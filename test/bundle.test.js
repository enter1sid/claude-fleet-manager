const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = require('../src/lib/bundle');
const { looksDesktopHosted } = require('../src/lib/procs');
const { modelArgs } = require('../src/lib/terminal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-'));
const account = (id, dir) => ({ id, label: id, desktopProfile: dir, cli: { oauth: { accessToken: 't-' + id }, oauthAccount: { id } }, loggedIn: true, usagePercent: 50 });

test('encrypt/decrypt round-trips; wrong passphrase fails; unprotected works without one', () => {
  const text = bundle.encrypt({ a: 1 }, 'correct horse');
  assert.deepEqual(bundle.decrypt(text, 'correct horse'), { a: 1 });
  assert.throws(() => bundle.decrypt(text, 'nope'), /Wrong or missing passphrase/);
  assert.equal(bundle.isProtected(text), true);
  const open = bundle.encrypt({ b: 2 }, '');
  assert.equal(bundle.isProtected(open), false);
  assert.deepEqual(bundle.decrypt(open, ''), { b: 2 });
  assert.throws(() => bundle.decrypt('not json', 'x'), /not a Claude Fleet/);
});

test('export then import carries CLI login and Desktop profile, skips duplicates, drops usage', () => {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'Cache'));
  fs.writeFileSync(path.join(src, 'Cookies'), 'cookie-data');
  fs.writeFileSync(path.join(src, 'Cache', 'junk'), 'x');
  const b = bundle.decrypt(bundle.encrypt(bundle.buildBundle([account('acc1', src)]), 'pw'), 'pw');
  const root = tmp();
  const r = bundle.applyImport(b, { profilesRoot: root, existingAccounts: [] });
  assert.deepEqual(r.imported, ['acc1']);
  const got = r.accounts[0];
  assert.equal(got.cli.oauth.accessToken, 't-acc1');
  assert.equal(got.usagePercent, null);
  assert.equal(fs.existsSync(path.join(root, 'acc1', 'Cookies')), false); // unreadable cookie file is not carried raw
  assert.equal(fs.existsSync(path.join(root, 'acc1', 'Cache')), false);
  const again = bundle.applyImport(b, { profilesRoot: root, existingAccounts: r.accounts });
  assert.deepEqual(again.skipped.map((s) => s.reason), ['already on this machine']);
});

test('expired bundles and unsafe ids are rejected', () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const b = bundle.buildBundle([{ ...account('ok', null), expiresAt: past }]);
  assert.throws(() => bundle.applyImport(b, { profilesRoot: tmp(), existingAccounts: [] }), /expired/);
  const evil = bundle.buildBundle([account('../evil', null)]);
  assert.equal(bundle.applyImport(evil, { profilesRoot: tmp(), existingAccounts: [] }).skipped[0].reason, 'invalid id');
});

test('each entry keeps its own expiry; the bundle shows the earliest; expired entries are skipped; import never extends', () => {
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  const later = new Date(Date.now() + 9 * 86400000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  const b = bundle.buildBundle([
    { ...account('a', null), expiresAt: later }, { ...account('b', null), expiresAt: soon },
    { ...account('c', null), expiresAt: null }, { ...account('d', null), expiresAt: past },
  ]);
  assert.equal(b.expiresAt, past);
  assert.equal(bundle.buildBundle([account('x', null)]).expiresAt, null);
  const root = tmp();
  const r = bundle.applyImport(b, { profilesRoot: root, existingAccounts: [] });
  assert.deepEqual(r.imported, ['a', 'b', 'c']);
  assert.deepEqual(r.skipped, [{ label: 'd', reason: 'expired' }]);
  assert.equal(r.accounts.find((x) => x.id === 'a').expiresAt, later);
  assert.equal(r.accounts.find((x) => x.id === 'c').expiresAt, null);
  // Re-importing a later-dated copy over an existing account cannot extend it.
  const longer = bundle.buildBundle([{ ...account('b', null), expiresAt: later }]);
  const again = bundle.applyImport(longer, { profilesRoot: root, existingAccounts: r.accounts, overwrite: true });
  assert.equal(again.accounts.find((x) => x.id === 'b').expiresAt, soon);
  // The clear envelope shows the date for display; the encrypted payload carries the real one.
  assert.equal(bundle.peekExpiry(bundle.encrypt(b, 'pw')), past);
});

test('Desktop-hosted detection and model flag safety', () => {
  assert.equal(looksDesktopHosted(['bash', 'claude-desktop', 'systemd']), true);
  assert.equal(looksDesktopHosted(['Claude Helper (Renderer)']), true);
  assert.equal(looksDesktopHosted(['zsh', 'gnome-terminal-', 'systemd']), false);
  assert.deepEqual(modelArgs('claude-opus-5-5'), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(modelArgs('x; rm -rf /'), []);
  assert.deepEqual(modelArgs(null), []);
});
