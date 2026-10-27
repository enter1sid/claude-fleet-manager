const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/lib/store');
const { createCliAdapter, captureCurrent, applySnapshot } = require('../src/lib/cli-creds');
const desktop = require('../src/lib/desktop');
const { buildHandoff, projectDir } = require('../src/lib/handoff');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-'));

test('store round-trips and writes 0600', () => {
  const dir = tmp();
  const store = createStore(dir);
  const s = store.load();
  const id = store.addAccount(s, 'one');
  store.save(s);
  assert.equal(store.load().accounts[0].id, id);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('cli swap replaces only claudeAiOauth, keeps MCP tokens, and rolls back on failure', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  const mcp = { 'plugin:x|1': { accessToken: 'mcp-secret' } };
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'A' }, mcpOAuth: mcp }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'A' }, keep: 1 }));
  const ad = createCliAdapter({ home, platform: 'linux' });

  assert.deepEqual(captureCurrent(ad), { oauth: { accessToken: 'A' }, oauthAccount: { id: 'A' } });
  applySnapshot(ad, { oauth: { accessToken: 'B' }, oauthAccount: { id: 'B' } });
  assert.deepEqual(captureCurrent(ad), { oauth: { accessToken: 'B' }, oauthAccount: { id: 'B' } });
  assert.deepEqual(JSON.parse(ad.readCredentials()).mcpOAuth, mcp);
  assert.equal(ad.readConfig().keep, 1);

  let calls = 0;
  const flaky = { ...ad, writeConfig: (o) => (calls++ === 0 ? (() => { throw new Error('boom'); })() : ad.writeConfig(o)) };
  assert.throws(() => applySnapshot(flaky, { oauth: { accessToken: 'C' }, oauthAccount: { id: 'C' } }));
  assert.equal(captureCurrent(ad).oauth.accessToken, 'B');
  assert.deepEqual(JSON.parse(ad.readCredentials()).mcpOAuth, mcp);
});

test('a machine with no CLI login (only MCP tokens) captures nothing', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ mcpOAuth: { a: 1 } }));
  assert.equal(captureCurrent(createCliAdapter({ home, platform: 'linux' })), null);
});

function fakeProfile(uuid, cookie) {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'Cookies'), cookie);
  fs.writeFileSync(path.join(d, 'Cookies-journal'), `j-${cookie}`);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ theme: 'dark', 'oauth:tokenCacheV2': `tok-${uuid}`, lastKnownAccountUuid: uuid }));
  return d;
}
const cfg = (d) => JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));

test('desktop login is captured to a slot and restored without touching other settings', () => {
  const live = fakeProfile('A', 'cookies-A');
  const slotA = path.join(tmp(), 'a');
  assert.equal(desktop.captureLogin(slotA, live), 'A');
  const other = fakeProfile('B', 'cookies-B');
  assert.equal(desktop.restoreLogin(slotA, other), true);
  assert.equal(fs.readFileSync(path.join(other, 'Cookies'), 'utf8'), 'cookies-A');
  assert.equal(fs.readFileSync(path.join(other, 'Cookies-journal'), 'utf8'), 'j-cookies-A');
  assert.deepEqual(cfg(other), { theme: 'dark', 'oauth:tokenCacheV2': 'tok-A', lastKnownAccountUuid: 'A' });
  // a signed-out profile is never captured, and an empty slot is never restored
  const out = tmp();
  assert.equal(desktop.captureLogin(path.join(tmp(), 'x'), out), null);
  assert.equal(desktop.restoreLogin(path.join(tmp(), 'empty'), other), false);
  assert.equal(cfg(other).lastKnownAccountUuid, 'A');
});

test('an imported slot with only a session cookie can be restored, dropping the old token cache', () => {
  const slot = tmp();
  makeCookieDb(path.join(slot, 'Cookies'), cbcKeys('peanuts'), [['.claude.ai', 'sessionKey', 'sk-imp']]);
  assert.equal(desktop.hasLogin(slot), true);
  assert.equal(desktop.hasLogin(tmp()), false);
  const live = fakeProfile('A', 'cookies-A');
  assert.equal(desktop.restoreLogin(slot, live), true);
  assert.equal(desktop.loginId(live), null);
  assert.equal(cfg(live).theme, 'dark');
  assert.ok(cookies.readCookies(live, { keys: cbcKeys('peanuts') }).length === 1);
});

test('clearLogin signs the profile out and backupLogin keeps a copy', () => {
  const live = fakeProfile('A', 'cookies-A');
  desktop.backupLogin(live);
  assert.equal(desktop.loginId(path.join(live, '.cfm-login-backup')), 'A');
  desktop.clearLogin(live);
  assert.equal(desktop.loginId(live), null);
  assert.ok(!fs.existsSync(path.join(live, 'Cookies')));
  assert.equal(cfg(live).theme, 'dark');
});

test('a login is never saved into another account\'s slot or saved twice', () => {
  const rishu = path.join(tmp(), 'rishu');
  desktop.captureLogin(rishu, fakeProfile('RISHU', 'c'));
  const akashEmpty = path.join(tmp(), 'akash');
  assert.match(desktop.captureBlock('RISHU', akashEmpty, [rishu]), /already saved/);
  assert.equal(desktop.captureBlock('AKASH', akashEmpty, [rishu]), null);
  assert.equal(desktop.captureBlock('RISHU', rishu, [akashEmpty]), null);
  assert.match(desktop.captureBlock('AKASH', rishu, []), /different Desktop login/);
  assert.match(desktop.captureBlock(null, rishu, []), /not signed in/);
  // an explicit save may repair a slot holding the wrong person, but still never duplicates a saved login
  assert.equal(desktop.captureBlock('AKASH', rishu, [], { replace: true }), null);
  assert.match(desktop.captureBlock('RISHU', akashEmpty, [rishu], { replace: true }), /already saved/);
});

test('a switch to a slot holding the live login is refused instead of restarting Desktop', () => {
  const live = fakeProfile('RISHU', 'c');
  const dup = path.join(tmp(), 'dup');
  desktop.captureLogin(dup, live);
  assert.match(desktop.switchBlock(dup, live), /already signed in as this account/);
  const other = path.join(tmp(), 'other');
  desktop.captureLogin(other, fakeProfile('AKASH', 'c2'));
  assert.equal(desktop.switchBlock(other, live), null);
  assert.equal(desktop.switchBlock(path.join(tmp(), 'empty'), live), null);
});

test('refreshTokens copies newer tokens into the slot of the same account only', () => {
  const live = fakeProfile('RISHU', 'c');
  const slot = path.join(tmp(), 'slot');
  desktop.captureLogin(slot, live);
  assert.equal(desktop.refreshTokens(slot, live), false);
  const cfg = JSON.parse(fs.readFileSync(path.join(live, 'config.json'), 'utf8'));
  cfg['oauth:tokenCacheV2'] = 'refreshed';
  fs.writeFileSync(path.join(live, 'config.json'), JSON.stringify(cfg));
  assert.equal(desktop.refreshTokens(slot, live), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'config.json'), 'utf8'))['oauth:tokenCacheV2'], 'refreshed');
  const other = path.join(tmp(), 'other');
  desktop.captureLogin(other, fakeProfile('AKASH', 'c2'));
  assert.equal(desktop.refreshTokens(other, live), false);
});

test('only the main Desktop process is signalled; helpers are never targeted', () => {
  const entries = [
    { pid: 1, args: '/usr/lib/claude-desktop/claude-desktop ' },
    { pid: 2, args: '/usr/lib/claude-desktop/claude-desktop --type=zygote --no-zygote-sandbox ' },
    { pid: 3, args: '/usr/lib/claude-desktop/claude-desktop --type=gpu-process --ozone-platform=wayland ' },
  ];
  assert.deepEqual(desktop.mainPids(entries), [1]);
});

function fakeSys(procs, { exitsOnTerm }) {
  const calls = [];
  const live = new Set(procs.map((p) => p.pid));
  return {
    calls,
    list: () => procs.filter((p) => live.has(p.pid)),
    signal(pids, sig) {
      calls.push([sig, pids]);
      if (sig === 'SIGKILL') pids.forEach((p) => live.delete(p));
      if (sig === 'SIGTERM' && exitsOnTerm) procs.forEach((p) => live.delete(p.pid));
    },
  };
}

test('quit sends SIGTERM to main only and does not escalate when it exits', async () => {
  const procs = [{ pid: 1, args: 'claude-desktop ' }, { pid: 2, args: 'claude-desktop --type=gpu-process ' }];
  const sys = fakeSys(procs, { exitsOnTerm: true });
  await desktop.quit('linux', { sys, graceMs: 200, pollMs: 10 });
  assert.deepEqual(sys.calls, [['SIGTERM', [1]]]);
});

test('quit escalates to SIGKILL on every process when main ignores SIGTERM', async () => {
  const procs = [{ pid: 1, args: 'claude-desktop ' }, { pid: 2, args: 'claude-desktop --type=gpu-process ' }];
  const sys = fakeSys(procs, { exitsOnTerm: false });
  await desktop.quit('linux', { sys, graceMs: 50, pollMs: 10 });
  assert.deepEqual(sys.calls, [['SIGTERM', [1]], ['SIGKILL', [1, 2]]]);
  const orphans = fakeSys([{ pid: 9, args: 'claude-desktop --type=zygote ' }], { exitsOnTerm: false });
  await desktop.quit('linux', { sys: orphans, graceMs: 5000, pollMs: 10 });
  assert.deepEqual(orphans.calls, [['SIGKILL', [9]]]);
});

test('launch environment drops the tray app\'s Electron variables', () => {
  const env = desktop.launchEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_PA_APP_NAME: 'Claude', CHROME_DESKTOP: 'x.desktop', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('handoff built from the newest transcript with model', () => {
  const home = tmp();
  const cwd = '/work/proj';
  const dir = projectDir(cwd, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: 'fix the bug' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'm-1', content: [{ type: 'text', text: 'on it' }] } }),
  ].join('\n'));
  const h = buildHandoff({ cwd, home });
  assert.equal(h.model, 'm-1');
  assert.match(h.message, /fix the bug/);
  assert.equal(buildHandoff({ cwd: '/none', home }), null);
});

test('usage parsing: reads 5-hour and weekly, null when missing, null on expired token or HTTP error', async () => {
  const { fetchUsage, parseUsage } = require('../src/lib/usage');
  assert.deepEqual(parseUsage({ five_hour: { utilization: 42.4, resets_at: 'r' }, seven_day: { utilization: 10 } }), {
    usagePercent: 42, resetAt: 'r', weeklyPercent: 10, weeklyResetAt: null,
  });
  assert.equal(parseUsage({}), null);
  const ok = async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 90 } }) });
  assert.equal((await fetchUsage({ accessToken: 't' }, { fetchImpl: ok })).usagePercent, 90);
  assert.equal(await fetchUsage({ accessToken: 't', expiresAt: 1 }, { fetchImpl: ok, now: 5 }), null);
  assert.equal(await fetchUsage({ accessToken: 't' }, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchUsage(null), null);
});

test('generateViaClaude returns the CLI output, and null on failure', async () => {
  const { generateViaClaude } = require('../src/lib/handoff');
  const dir = tmp();
  const good = path.join(dir, 'good.sh');
  const bad = path.join(dir, 'bad.sh');
  fs.writeFileSync(good, '#!/bin/sh\necho "summary text"\n', { mode: 0o700 });
  fs.writeFileSync(bad, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.equal(await generateViaClaude({ cwd: dir, bin: good }), 'summary text');
  assert.equal(await generateViaClaude({ cwd: dir, bin: bad }), null);
  assert.equal(await generateViaClaude({ cwd: dir, bin: path.join(dir, 'missing') }), null);
});

test('desktop handoff URL: inline when it fits, file pointer when too long, folder passed', () => {
  const { buildDesktopUrl, saveHandoff } = require('../src/lib/launch');
  const small = buildDesktopUrl({ message: 'hello world', file: '/f.md', folder: '/work/proj', platform: 'linux' });
  const u = new URL(small.url);
  assert.equal(small.inline, true);
  assert.equal(u.host, 'code');
  assert.equal(u.pathname, '/new');
  assert.equal(u.searchParams.get('q'), 'hello world');
  assert.equal(u.searchParams.get('folder'), '/work/proj');
  assert.equal(u.searchParams.get('file'), '/f.md');
  const big = buildDesktopUrl({ message: 'x'.repeat(9000), file: '/saved/h.md', folder: '/w', platform: 'win32' });
  assert.equal(big.inline, false);
  assert.match(new URL(big.url).searchParams.get('q'), /\/saved\/h\.md/);
  assert.ok(big.url.length < 7000);
  const chat = buildDesktopUrl({ message: 'hi', file: '/f', mode: 'chat', platform: 'darwin' });
  assert.equal(new URL(chat.url).host, 'claude.ai');
  const dir = tmp();
  assert.equal(fs.readFileSync(saveHandoff(dir, 'keep me'), 'utf8'), 'keep me');
});

test('latestSessionCwd returns the cwd recorded in the newest transcript across projects', () => {
  const { latestSessionCwd, projectDir } = require('../src/lib/handoff');
  const home = tmp();
  const old = projectDir('/old/proj', home);
  const recent = projectDir('/work/recent-app', home);
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(recent, { recursive: true });
  fs.writeFileSync(path.join(old, 'a.jsonl'), JSON.stringify({ type: 'user', cwd: '/old/proj', message: { content: 'x' } }));
  fs.utimesSync(path.join(old, 'a.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(recent, 'b.jsonl'), '\n' + JSON.stringify({ type: 'user', cwd: '/work/recent-app', message: { content: 'y' } }));
  assert.equal(latestSessionCwd(home), '/work/recent-app');
  assert.equal(latestSessionCwd(tmp()), null);
});

// ---- cookies, expiry, desktop usage ----
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const cookies = require('../src/lib/cookies');
const expiry = require('../src/lib/expiry');

function makeCookieDb(file, keys, rows, version = 24) {
  const db = new DatabaseSync(file);
  db.exec('create table meta(key text primary key, value text); create table cookies(host_key text, name text, value text, encrypted_value blob)');
  db.prepare('insert into meta values (?, ?)').run('version', String(version));
  for (const [host, name, value] of rows) {
    db.prepare('insert into cookies values (?, ?, ?, ?)').run(host, name, '', cookies.encryptValue(value, host, keys, version >= 24));
  }
  db.close();
}

const cbcKeys = (pw) => ({ platform: 'linux', v10: crypto.pbkdf2Sync(pw, 'saltysalt', 1, 16, 'sha1') });
const gcmKeys = () => ({ platform: 'win32', gcm: crypto.randomBytes(32) });

test('cookie encrypt/decrypt round-trips for CBC and GCM, with and without the host-hash prefix', () => {
  for (const keys of [cbcKeys('peanuts'), gcmKeys()]) {
    for (const hashed of [true, false]) {
      const enc = cookies.encryptValue('s3cret', '.claude.ai', keys, hashed);
      assert.equal(enc.subarray(0, 3).toString(), 'v10');
      assert.equal(cookies.decryptValue(enc, '.claude.ai', keys, hashed), 's3cret');
    }
  }
  assert.equal(cookies.decryptValue(cookies.encryptValue('x', 'h', cbcKeys('a'), false), 'h', cbcKeys('b'), false), null);
});

test('cookies move between machines: exported plaintext, re-encrypted with the importer key', () => {
  const profile = tmp();
  const oldKeys = cbcKeys('machine-A');
  makeCookieDb(path.join(profile, 'Cookies'), oldKeys, [['.claude.ai', 'sessionKey', 'sk-123'], ['.claude.ai', 'lastActiveOrg', 'org-9']]);
  assert.deepEqual(cookies.readCookies(profile, { keys: oldKeys }).map((c) => c.value).sort(), ['org-9', 'sk-123']);

  const plain = path.join(tmp(), 'plain');
  assert.equal(cookies.exportPlainDb(profile, plain, { keys: oldKeys }), 2);
  const raw = new DatabaseSync(plain, { readOnly: true }).prepare('select value, length(encrypted_value) as n from cookies').all();
  assert.deepEqual(raw.map((r) => r.n), [0, 0]);
  assert.ok(raw.some((r) => r.value === 'sk-123'));

  const target = tmp();
  fs.copyFileSync(plain, path.join(target, 'Cookies'));
  const newKeys = gcmKeys();
  assert.equal(cookies.encryptPlainDb(path.join(target, 'Cookies'), { keys: newKeys }), 2);
  assert.deepEqual(cookies.readCookies(target, { keys: newKeys }).map((c) => c.value).sort(), ['org-9', 'sk-123']);
  assert.deepEqual(cookies.readCookies(target, { keys: oldKeys }), []); // old machine key no longer reads them
  assert.deepEqual(cookies.readCookies(tmp()), []); // no cookie file
});

test('bundle export decrypts a profile cookie DB and import re-encrypts it locally', () => {
  const bundle = require('../src/lib/bundle');
  const profile = tmp();
  const keys = cookies.localKeys(profile, 'linux'); // what a Linux profile launched with --password-store=basic uses
  makeCookieDb(path.join(profile, 'Cookies'), keys, [['.claude.ai', 'sessionKey', 'sk-bundle']]);
  const b = bundle.decrypt(bundle.encrypt(bundle.buildBundle([{ id: 'acc', label: 'acc', desktopProfile: profile, cli: null }]), 'pw'), 'pw');
  assert.equal(b.entries[0].cookiesRel, 'Cookies');
  const root = tmp();
  bundle.applyImport(b, { profilesRoot: root, existingAccounts: [] });
  const got = cookies.readCookies(path.join(root, 'acc'), { keys });
  assert.equal(got[0].value, 'sk-bundle');
  assert.equal(fs.existsSync(path.join(root, 'acc', 'cfm-cookies.plain')), false);
});

test('expiry: wipes stored and live logins, keeps the row, never extends past or revives', () => {
  const root = tmp();
  const prof = path.join(root, 'p1');
  fs.mkdirSync(prof);
  fs.writeFileSync(path.join(prof, 'Cookies'), 'x');
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 5 * 86400000).toISOString();
  const state = {
    accounts: [
      { id: 'p1', label: 'one', desktopProfile: prof, cli: { oauth: { accessToken: 'T' } }, loggedIn: true, expiresAt: past, usagePercent: 50 },
      { id: 'p2', label: 'two', desktopProfile: path.join(root, 'p2'), cli: { oauth: {} }, loggedIn: true, expiresAt: future },
      { id: 'p3', label: 'three', desktopProfile: path.join(root, 'p3'), cli: { oauth: {} }, loggedIn: true, expiresAt: null },
    ],
    active: { desktop: 'p1', cli: 'p1' },
  };
  const calls = [];
  const wiped = expiry.sweepExpired(state, { profilesRoot: root, clearCli: (s) => calls.push(s.oauth.accessToken), quitDesktop: () => calls.push('quit') });
  assert.deepEqual(wiped, ['one']);
  assert.deepEqual(calls, ['T', 'quit']);
  assert.equal(fs.existsSync(prof), false);
  assert.deepEqual([state.accounts[0].cli, state.accounts[0].loggedIn, state.accounts[0].expired], [null, false, true]);
  assert.deepEqual(state.active, { desktop: null, cli: null });
  assert.equal(state.accounts[1].loggedIn, true);
  assert.deepEqual(expiry.sweepExpired(state, { profilesRoot: root, clearCli() {}, quitDesktop() {} }), []);
  // A profile path outside profilesRoot is never deleted.
  const outside = tmp();
  expiry.sweepExpired({ accounts: [{ id: 'z', label: 'z', desktopProfile: outside, expiresAt: past }], active: {} }, { profilesRoot: root });
  assert.equal(fs.existsSync(outside), true);
  // Extending: only while valid, only later.
  assert.equal(expiry.extendExpiry(state.accounts[0], 30), false);
  const a = { expiresAt: future };
  assert.equal(expiry.extendExpiry(a, 30), true);
  assert.ok(Date.parse(a.expiresAt) > Date.parse(future));
  const keep = { expiresAt: future };
  expiry.extendExpiry(keep, 1);
  assert.equal(keep.expiresAt, future);
  assert.equal(expiry.expiryFromDays(0), null);
  assert.match(expiry.describeExpiry({ expiresAt: future }), /d left/);
  assert.equal(expiry.describeExpiry(state.accounts[0]), 'expired');
});

test('removeAccounts deletes chosen accounts and their profiles, clears active, never deletes outside the root', () => {
  const root = tmp();
  const outside = tmp();
  const mk = (id, dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'f'), 'x'); return { id, label: id, desktopProfile: dir }; };
  const state = {
    accounts: [mk('a', path.join(root, 'a')), mk('b', path.join(root, 'b')), mk('c', outside)],
    active: { desktop: 'a', cli: 'b' },
  };
  assert.deepEqual(expiry.removeAccounts(state, ['a'], root), ['a']);
  assert.deepEqual(state.accounts.map((x) => x.id), ['b', 'c']);
  assert.deepEqual(state.active, { desktop: null, cli: 'b' });
  assert.ok(!fs.existsSync(path.join(root, 'a')) && fs.existsSync(path.join(root, 'b')));
  expiry.removeAccounts(state, state.accounts.map((x) => x.id), root);
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.active, { desktop: null, cli: null });
  assert.ok(fs.existsSync(path.join(outside, 'f')));
});

test('clearIfCurrent signs the CLI out only for the matching account and keeps MCP tokens', () => {
  const { clearIfCurrent } = require('../src/lib/cli-creds');
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'A' }, mcpOAuth: { k: 1 } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u1' }, keep: 1 }));
  const ad = createCliAdapter({ home, platform: 'linux' });
  assert.equal(clearIfCurrent(ad, { oauth: { accessToken: 'OTHER' }, oauthAccount: { accountUuid: 'u2' } }), false);
  assert.equal(captureCurrent(ad).oauth.accessToken, 'A');
  assert.equal(clearIfCurrent(ad, { oauth: { accessToken: 'old' }, oauthAccount: { accountUuid: 'u1' } }), true);
  assert.equal(captureCurrent(ad), null);
  assert.deepEqual(JSON.parse(ad.readCredentials()).mcpOAuth, { k: 1 });
  assert.equal(ad.readConfig().keep, 1);
});

test('desktop usage reads sessionKey + lastActiveOrg cookies and returns null without them', async () => {
  const { fetchDesktopUsage } = require('../src/lib/usage');
  let seen;
  const ok = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ five_hour: { utilization: 33 } }) }; };
  const list = [{ host_key: '.claude.ai', name: 'sessionKey', value: 'sk' }, { host_key: '.claude.ai', name: 'lastActiveOrg', value: 'org-1' }];
  assert.equal((await fetchDesktopUsage(list, { fetchImpl: ok })).usagePercent, 33);
  assert.equal(seen.url, 'https://claude.ai/api/organizations/org-1/usage');
  assert.match(seen.opts.headers.Cookie, /sessionKey=sk/);
  assert.equal(await fetchDesktopUsage([list[0]], { fetchImpl: ok }), null);
  assert.equal(await fetchDesktopUsage([list[0], { host_key: '.claude.ai', name: 'lastActiveOrg', value: '../x' }], { fetchImpl: ok }), null);
  assert.equal(await fetchDesktopUsage([{ host_key: '.evil.com', name: 'sessionKey', value: 'k' }, list[1]], { fetchImpl: ok }), null);
  assert.equal(await fetchDesktopUsage(list, { fetchImpl: async () => ({ ok: false }) }), null);
});

test('full flow: two accounts swap back and forth in Desktop and in the CLI, each keeping its own login', () => {
  const live = fakeProfile('RISHU', 'cookies-RISHU');
  const slots = { rishu: path.join(tmp(), 'rishu'), akash: path.join(tmp(), 'akash') };
  const swapDesktop = (to, from) => {
    const fromSlot = slots[from];
    if (!desktop.captureBlock(desktop.loginId(live), fromSlot, [slots[to]])) desktop.captureLogin(fromSlot, live);
    assert.equal(desktop.switchBlock(slots[to], live), null);
    assert.equal(desktop.restoreLogin(slots[to], live), true);
  };

  desktop.captureLogin(slots.rishu, live);
  desktop.clearLogin(live);
  fs.writeFileSync(path.join(live, 'Cookies'), 'cookies-AKASH');
  const c = cfg(live);
  fs.writeFileSync(path.join(live, 'config.json'), JSON.stringify({ ...c, 'oauth:tokenCacheV2': 'tok-AKASH', lastKnownAccountUuid: 'AKASH' }));
  assert.equal(desktop.captureBlock('AKASH', slots.akash, [slots.rishu]), null);
  desktop.captureLogin(slots.akash, live);

  for (const [to, from, id] of [['rishu', 'akash', 'RISHU'], ['akash', 'rishu', 'AKASH'], ['rishu', 'akash', 'RISHU']]) {
    swapDesktop(to, from);
    assert.equal(desktop.loginId(live), id);
    assert.equal(fs.readFileSync(path.join(live, 'Cookies'), 'utf8'), `cookies-${id}`);
    assert.equal(cfg(live)['oauth:tokenCacheV2'], `tok-${id}`);
    assert.equal(cfg(live).theme, 'dark');
  }
  assert.equal(desktop.loginId(slots.akash), 'AKASH');
  assert.equal(desktop.loginId(slots.rishu), 'RISHU');

  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'RISHU' }, mcpOAuth: { m: 1 } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'RISHU' } }));
  const ad = createCliAdapter({ home, platform: 'linux' });
  const snaps = { rishu: captureCurrent(ad), akash: { oauth: { accessToken: 'AKASH' }, oauthAccount: { id: 'AKASH' } } };
  for (const who of ['akash', 'rishu', 'akash', 'rishu']) {
    applySnapshot(ad, snaps[who]);
    assert.equal(captureCurrent(ad).oauth.accessToken, who.toUpperCase());
    assert.equal(captureCurrent(ad).oauthAccount.id, who.toUpperCase());
  }
  assert.deepEqual(JSON.parse(ad.readCredentials()).mcpOAuth, { m: 1 });
});

test('session backup copies Desktop metadata and transcripts; carry-over shows them under the other account without overwriting', () => {
  const sessions = require('../src/lib/sessions');
  const home = tmp();
  const dir = tmp();
  const cwd = '/work/proj';
  const proj = path.join(home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'cli-1.jsonl'), 'transcript');
  const orgA = path.join(dir, 'claude-code-sessions', 'A', 'org1');
  fs.mkdirSync(orgA, { recursive: true });
  fs.writeFileSync(path.join(orgA, 'local_1.json'), JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cli-1', cwd }));
  const orgB = path.join(dir, 'claude-code-sessions', 'B', 'org2');
  fs.mkdirSync(orgB, { recursive: true });
  fs.writeFileSync(path.join(orgB, 'local_9.json'), JSON.stringify({ sessionId: 'local_9' }));

  const root = path.join(tmp(), 'bk');
  const r = sessions.backupSessions({ dir, accountId: 'A', backupRoot: root, home, now: 1 });
  assert.deepEqual([r.sessions, r.transcripts], [1, 1]);
  assert.equal(fs.readFileSync(path.join(r.dir, 'transcripts', '-work-proj', 'cli-1.jsonl'), 'utf8'), 'transcript');
  assert.ok(fs.existsSync(path.join(r.dir, 'desktop', 'org1', 'local_1.json')));
  assert.equal(sessions.backupSessions({ dir, accountId: 'NONE', backupRoot: root, home }), null);

  assert.equal(sessions.carrySessions({ dir, fromId: 'A', toId: 'B' }), 1);
  assert.ok(fs.existsSync(path.join(orgB, 'local_1.json')));
  assert.equal(sessions.carrySessions({ dir, fromId: 'A', toId: 'B' }), 0);
  assert.equal(sessions.carrySessions({ dir, fromId: 'A', toId: 'A' }), 0);
});

test('a CLI login is derived from the Desktop token cache, and unknown layouts report key names only', () => {
  const crypto = require('crypto');
  const dt = require('../src/lib/desktop-token');
  const key = crypto.pbkdf2Sync('pw', 'saltysalt', 1, 16, 'sha1');
  const keys = { platform: 'linux', v10: key, v11: key };
  const seal = (obj) => {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from('v11'), c.update(JSON.stringify(obj)), c.final()]).toString('base64');
  };
  const dir = tmp();
  const write = (cache) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ 'oauth:tokenCacheV2': seal(cache), lastKnownAccountUuid: 'U1' }));

  write({ 'client:org:scope': { token: 'AT', refreshToken: 'RT', expiresAt: 1800000000, scopes: ['user:inference'] }, profile: { email: 'a@b.co' } });
  const r = dt.cliSnapshotFromDesktop(dir, 'U1', keys);
  assert.deepEqual(r.snapshot.oauth, { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1800000000000, scopes: ['user:inference'] });
  assert.deepEqual(r.snapshot.oauthAccount, { accountUuid: 'U1', emailAddress: 'a@b.co' });

  write({ weird: { nothing: 'secret-value' } });
  const bad = dt.cliSnapshotFromDesktop(dir, 'U1', keys);
  assert.match(bad.error, /weird\.nothing:string/);
  assert.ok(!bad.error.includes('secret-value'));
  assert.match(dt.cliSnapshotFromDesktop(tmp(), 'U1', keys).error, /could not be read/);
});

test('desktop.isInstalled follows the launch binary', () => {
  const desktopLib = require('../src/lib/desktop');
  const old = process.env.CLAUDE_DESKTOP_BIN;
  process.env.CLAUDE_DESKTOP_BIN = path.join(tmp(), 'missing');
  assert.equal(desktopLib.isInstalled('linux'), false);
  process.env.CLAUDE_DESKTOP_BIN = process.execPath;
  assert.equal(desktopLib.isInstalled('linux'), true);
  if (old === undefined) delete process.env.CLAUDE_DESKTOP_BIN; else process.env.CLAUDE_DESKTOP_BIN = old;
});

test('rename sticks and sign-in email only replaces auto labels', () => {
  const store = createStore(tmp());
  const s = store.load();
  const a = s.accounts[store.addAccount(s, 'Account 1') && 0];
  store.adoptEmail(a, 'x@y.co');
  assert.equal(a.label, 'x@y.co');

  const b = s.accounts[store.addAccount(s, 'Account 2') && 1];
  assert.equal(store.renameAccount(b, '  Rishu  '), true);
  store.adoptEmail(b, 'r@y.co');
  assert.equal(b.label, 'Rishu');
  assert.equal(store.renameAccount(b, '   '), false);
  assert.equal(b.label, 'Rishu');
});

test('expiry options cover 1, 2, 5, 10 days and Never; Never clears an expiry', () => {
  const expiry = require('../src/lib/expiry');
  assert.deepEqual(expiry.EXPIRY_OPTIONS.map((o) => o.days), [1, 2, 5, 10, 0]);
  const acct = { expiresAt: expiry.expiryFromDays(2) };
  assert.equal(expiry.extendExpiry(acct, 0), true);
  assert.equal(acct.expiresAt, null);
  assert.equal(expiry.expiryFromDays(0), null);
});

test('store defaults the login method to ask', () => {
  assert.equal(createStore(tmp()).load().loginMethod, 'ask');
});
