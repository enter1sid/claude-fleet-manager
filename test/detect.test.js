const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/lib/store');
const { createCliAdapter } = require('../src/lib/cli-creds');
const { detectLogins } = require('../src/lib/detect');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-detect-'));
const key = crypto.pbkdf2Sync('pw', 'saltysalt', 1, 16, 'sha1');
const keys = { platform: 'linux', v10: key, v11: key };
const seal = (obj) => {
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v11'), c.update(JSON.stringify(obj)), c.final()]).toString('base64');
};

function machine({ cli, desktop } = {}) {
  const home = tmp();
  const desktopDir = tmp();
  if (cli) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `cli-${cli.id}`, refreshToken: 'R', expiresAt: 1 } }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: cli.id, emailAddress: cli.email } }));
  }
  if (desktop) {
    const cache = { 'c:o:s': { token: `desk-${desktop.id}`, refreshToken: 'R', expiresAt: 1800000000 }, profile: { email: desktop.email } };
    fs.writeFileSync(path.join(desktopDir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: desktop.id, 'oauth:tokenCacheV2': seal(cache) }));
  }
  const store = createStore(tmp());
  return { store, state: store.load(), opts: { cliAdapter: createCliAdapter({ home, platform: 'linux' }), desktopDir, keys } };
}

test('detect: the same person in Desktop and the CLI is one account holding both logins', () => {
  const m = machine({ cli: { id: 'U1', email: 'a@b.co' }, desktop: { id: 'U1', email: 'a@b.co' } });
  assert.deepEqual(detectLogins(m.state, m.store, m.opts), ['a@b.co']);
  assert.equal(m.state.accounts.length, 1);
  const a = m.state.accounts[0];
  assert.equal(a.cli.oauth.accessToken, 'cli-U1');
  assert.ok(fs.existsSync(path.join(a.desktopProfile, 'config.json')));
  assert.deepEqual(m.state.active, { desktop: a.id, cli: a.id });
});

test('detect: a Desktop-only login gets its CLI login derived', () => {
  const m = machine({ desktop: { id: 'U2', email: 'd@b.co' } });
  assert.equal(detectLogins(m.state, m.store, m.opts).length, 1);
  const a = m.state.accounts[0];
  assert.equal(a.cli.oauth.accessToken, 'desk-U2');
  assert.equal(a.label, 'd@b.co');
  assert.equal(m.state.active.desktop, a.id);
});

test('detect: a CLI-only login is saved without a Desktop slot', () => {
  const m = machine({ cli: { id: 'U3', email: 'c@b.co' } });
  assert.deepEqual(detectLogins(m.state, m.store, m.opts), ['c@b.co']);
  assert.equal(m.state.accounts.length, 1);
  assert.equal(m.state.active.cli, m.state.accounts[0].id);
  assert.equal(m.state.active.desktop, null);
});

test('detect: different people in Desktop and the CLI are two accounts', () => {
  const m = machine({ cli: { id: 'U1', email: 'a@b.co' }, desktop: { id: 'U2', email: 'd@b.co' } });
  assert.equal(detectLogins(m.state, m.store, m.opts).length, 2);
  assert.equal(m.state.accounts.length, 2);
  assert.notEqual(m.state.active.cli, m.state.active.desktop);
});

test('detect: running again adds nothing, and saved accounts are kept', () => {
  const m = machine({ cli: { id: 'U1', email: 'a@b.co' }, desktop: { id: 'U1', email: 'a@b.co' } });
  const keep = m.state.accounts.length === 0 && m.store.addAccount(m.state, 'Saved earlier');
  detectLogins(m.state, m.store, m.opts);
  assert.equal(m.state.accounts.length, 2);
  assert.deepEqual(detectLogins(m.state, m.store, m.opts), []);
  assert.equal(m.state.accounts.length, 2);
  assert.ok(m.state.accounts.some((a) => a.id === keep));
});

test('detect: an account the user removed on purpose is not brought back', () => {
  const m = machine({ cli: { id: 'U1', email: 'a@b.co' }, desktop: { id: 'U1', email: 'a@b.co' } });
  m.state.ignored = ['U1'];
  assert.deepEqual(detectLogins(m.state, m.store, m.opts), []);
  assert.equal(m.state.accounts.length, 0);
});

test('detect: nothing signed in means no accounts', () => {
  const m = machine();
  assert.deepEqual(detectLogins(m.state, m.store, m.opts), []);
  assert.equal(m.state.accounts.length, 0);
});
