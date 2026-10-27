const test = require('node:test');
const assert = require('node:assert');
const { shouldSwitch, pickNextAccount } = require('../src/lib/auto-switch');

const acct = (id, usagePercent, extra = {}) => ({ id, usagePercent, loggedIn: true, resetAt: null, ...extra });

test('switches only when strictly above the threshold', () => {
  assert.equal(shouldSwitch(acct('a', 80)), false);
  assert.equal(shouldSwitch(acct('a', 81)), true);
  assert.equal(shouldSwitch(acct('a', null)), false);
  assert.equal(shouldSwitch(acct('a', 71), 70), true);
});

test('a reading whose reset time has passed no longer counts', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(shouldSwitch(acct('a', 95, { resetAt: past })), false);
});

test('picks the lowest-usage account, never the current one', () => {
  const list = [acct('cur', 85), acct('mid', 30), acct('low', 5)];
  assert.equal(pickNextAccount(list, 'cur').id, 'low');
});

test('skips signed-out, unread and recently-switched-from accounts', () => {
  const list = [acct('cur', 85), acct('out', 1, { loggedIn: false }), acct('unk', null), acct('rec', 2), acct('ok', 70)];
  assert.equal(pickNextAccount(list, 'cur', { skipIds: new Set(['rec']) }).id, 'ok');
});

test('skips accounts the target cannot use without a sign-in', () => {
  const list = [acct('cur', 85), acct('low', 5, { noLogin: true }), acct('ok', 40)];
  assert.equal(pickNextAccount(list, 'cur', { eligible: (a) => !a.noLogin }).id, 'ok');
});

test('does not switch to an account that is not lower than the current one', () => {
  assert.equal(pickNextAccount([acct('cur', 90), acct('b', 95)], 'cur'), null);
});

test('returns null when nothing qualifies', () => {
  assert.equal(pickNextAccount([acct('cur', 90)], 'cur'), null);
});
