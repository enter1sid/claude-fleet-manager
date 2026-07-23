const grid = document.getElementById('grid');
const dashboard = document.getElementById('dashboard');
const emptyState = document.getElementById('empty-state');
const inlineTopbar = document.getElementById('inline-topbar');
const inlineTopbarLabel = document.getElementById('inline-topbar-label');
const inlineCloseBtn = document.getElementById('inline-close');
const resetStatsBtn = document.getElementById('reset-stats');
const removeAllSessionsBtn = document.getElementById('remove-all-sessions');
const addAccountEmptyBtn = document.getElementById('add-account-empty');
const addAccountFab = document.getElementById('add-account-fab');

const NEAR_LIMIT_THRESHOLD = 80; // % usage at which a card is flagged "Near limit"

function deriveStatus(account) {
  const pct = Number(account.usagePercent);
  if (account.usagePercent === null || account.usagePercent === '' || Number.isNaN(pct) || pct <= 0) {
    return { label: 'Free', cls: 'free' };
  }
  if (pct >= NEAR_LIMIT_THRESHOLD) {
    return { label: 'Near limit', cls: 'near_limit' };
  }
  return { label: 'In use', cls: 'in_use' };
}

function showInline(account) {
  inlineTopbarLabel.textContent = `${account.label} — logging in / using Claude`;
  inlineTopbar.classList.remove('hidden');
  dashboard.classList.add('hidden');
}

function hideInline() {
  inlineTopbar.classList.add('hidden');
  dashboard.classList.remove('hidden');
}

inlineCloseBtn.addEventListener('click', async () => {
  await window.fleet.closeInline();
  hideInline();
  await refresh();
});

resetStatsBtn.addEventListener('click', async () => {
  if (!confirm('Clear the tracked usage %/reset-time for every account? This does not log anyone out.')) return;
  await window.fleet.resetStats();
  await refresh();
});

removeAllSessionsBtn.addEventListener('click', async () => {
  const confirmed = confirm(
    'This removes EVERY account from the board, everywhere:\n\n' +
    '- Logs out and clears every account\'s in-app Claude login\n' +
    '- Deletes every account\'s Claude Desktop app profile\n' +
    '- Removes every account card, leaving the board empty\n\n' +
    'Everyone sharing this board will need to add and log in their accounts again from scratch. This cannot be undone. Continue?'
  );
  if (!confirmed) return;
  removeAllSessionsBtn.disabled = true;
  removeAllSessionsBtn.textContent = 'Removing...';
  try {
    await window.fleet.removeAllSessions();
    hideInline();
  } finally {
    removeAllSessionsBtn.disabled = false;
    removeAllSessionsBtn.textContent = 'Remove all sessions';
    await refresh();
  }
});

async function addAccount() {
  await window.fleet.addAccount();
  await refresh();
}

addAccountEmptyBtn.addEventListener('click', addAccount);
addAccountFab.addEventListener('click', addAccount);

function renderCard(account) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = account.id;

  const top = document.createElement('div');
  top.className = 'card-top';

  const labelInput = document.createElement('input');
  labelInput.className = 'label-input';
  labelInput.value = account.label;
  labelInput.addEventListener('change', () => {
    window.fleet.updateAccount({ id: account.id, label: labelInput.value });
  });

  const status = deriveStatus(account);
  const isOpenSomewhere = account.inlineOpen || account.desktopRunning;

  const topRight = document.createElement('div');
  topRight.className = 'card-top-right';

  const runningDot = document.createElement('span');
  runningDot.className = `dot ${isOpenSomewhere ? 'running' : 'stopped'}`;
  runningDot.title = isOpenSomewhere ? 'Open right now' : 'Not open';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove this account (logs it out and deletes its session)';
  removeBtn.addEventListener('click', async () => {
    if (!confirm(`Remove "${account.label}"? This logs it out and deletes its saved session. Cannot be undone.`)) return;
    await window.fleet.removeAccount(account.id);
    await refresh();
  });

  topRight.append(runningDot, removeBtn);
  top.append(labelInput, topRight);

  const statusBadge = document.createElement('span');
  statusBadge.className = `badge ${status.cls}`;
  statusBadge.textContent = status.label;

  const readout = document.createElement('div');
  readout.className = 'readout';
  const usageKnown = account.usagePercent !== null && account.usagePercent !== '';
  const resetKnown = !!account.resetTime;
  readout.innerHTML = `
    <div><span class="k">Usage</span><span class="v ${usageKnown ? '' : 'unknown'}">${usageKnown ? account.usagePercent + '%' : 'Not detected yet'}</span></div>
    <div><span class="k">Resets</span><span class="v ${resetKnown ? '' : 'unknown'}">${resetKnown ? account.resetTime : 'Not detected yet'}</span></div>
  `;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = account.usageDetectedAt
    ? `usage detected ${new Date(account.usageDetectedAt).toLocaleString()}`
    : 'usage auto-detected while logged in — nothing seen yet';

  const actions = document.createElement('div');
  actions.className = 'actions';

  // Single consistent CTA: always the embedded claude.ai view. Log in once, and every later
  // click of this SAME button reopens that SAME persistent session — no second, separately
  // authenticated flow hiding behind it.
  const primaryBtn = document.createElement('button');
  primaryBtn.className = 'primary';
  primaryBtn.textContent = account.inlineOpen
    ? 'Open now (below)'
    : account.hasLoggedInApp
      ? 'Open Claude'
      : 'Log in with Claude account';
  primaryBtn.addEventListener('click', async () => {
    primaryBtn.disabled = true;
    primaryBtn.textContent = 'Opening...';
    try {
      // Both first-time login and later opens use the same embedded claude.ai view docked in
      // this window, with the "Back to dashboard" top bar. Same persistent session either way.
      await window.fleet.openInline(account.id);
      showInline(account);
    } finally {
      await refresh();
    }
  });

  const links = document.createElement('div');
  links.className = 'actions-links';

  // Clearly separate, honestly labeled: this is a DIFFERENT, independently-authenticated
  // login (the real, separately-installed Claude Desktop app has no way to share a session
  // with the view above), not a continuation of the button above. Signing in here again is
  // expected, not a bug.
  const desktopLink = document.createElement('button');
  desktopLink.className = 'link-btn';
  desktopLink.textContent = account.desktopRunning
    ? 'Already running in the separate Claude Desktop app'
    : account.hasLaunchedDesktop
      ? 'Open separate Claude Desktop app (own login)'
      : 'Also try the separate Claude Desktop app (needs its own sign-in)';
  desktopLink.addEventListener('click', async () => {
    desktopLink.disabled = true;
    try {
      await window.fleet.launchDesktop(account.id);
    } finally {
      await refresh();
    }
  });
  links.append(desktopLink);

  actions.append(primaryBtn, links);

  card.append(top, statusBadge, readout, meta, actions);
  return card;
}

async function refresh() {
  const accounts = await window.fleet.listAccounts();
  grid.innerHTML = '';

  if (accounts.length === 0) {
    emptyState.classList.remove('hidden');
    grid.classList.add('hidden');
    addAccountFab.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.classList.remove('hidden');
  addAccountFab.classList.remove('hidden');
  accounts.forEach((a) => grid.appendChild(renderCard(a)));
}

(async function init() {
  await refresh();
  setInterval(refresh, 5000);
})();
