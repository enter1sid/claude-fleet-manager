# Claude Fleet Manager

A local launcher + status board for a team sharing 10 Claude Team-plan logins.

## What this does

- Lists 10 accounts (edit the label inline).
- **Primary CTA is one consistent action, always the same underlying login:** "Log in with
  Claude account" the first time, then "Open Claude" every time after — both open claude.ai
  docked inside this app's own window (below a small top bar, no extra top-level window),
  backed by an Electron session partition (`persist:account-N`) that Electron guarantees
  persists across restarts. This is the account's real, reliable session — log in once here and
  it stays logged in.
- **A separate small link — "Also try the separate Claude Desktop app"** — spawns the real,
  independently-installed Claude Desktop app pointed at an isolated profile directory
  (`~/.claude-fleet-profiles/account-N`). This is a genuinely different, independently
  authenticated session (see below on why) — it needs its own sign-in the first time, same as
  logging into a second browser profile would, and is NOT a continuation of the primary button.
  Earlier versions of this app made that same button evolve to "open Claude Desktop" once you'd
  logged in via the embedded view, which made it look like one continuous session — it wasn't,
  and that's what caused it to appear "not logged in." Keep the two mentally separate.
- Each card shows a usage %/reset-time readout, auto-detected best-effort (see below), and a
  green/grey dot for whether the account is currently open anywhere.
- Header has two very different actions — don't confuse them:
  - **"Reset usage stats"** — clears the tracked usage %/reset-time for all 10 accounts. Nobody
    gets logged out.
  - **"Remove all sessions"** — logs everyone OUT of everything: wipes every account's in-app
    session partition and deletes every account's Claude Desktop profile directory. Destructive,
    asks for confirmation, cannot be undone.

## Why the in-app login and Claude Desktop need separate sign-ins

I checked whether Claude Desktop has any way to inherit a session you've already authenticated
in a browser — it doesn't, for normal claude.ai accounts. Its bundle does reference a
`device-code` flow, but that's for enterprise Entra ID / third-party model-provider SSO
connections, unrelated to consumer claude.ai sign-in. There's no supported bridge, so this tool
doesn't fake one — each of the two login methods above is genuinely independent, and each just
persists reliably on its own once you've signed in through it the first time.

## Why usage/reset-time is best-effort, not exact

Anthropic does not expose a public API for a Team-plan seat's live usage/reset-time. What this
app does instead: while you're logged in via the in-app view, it passively scans the page text
for phrases like "X% of your usage" or "resets at ...", and reports whatever it finds. claude.ai
mostly only surfaces this information when you're actually close to or at the limit — so seeing
"Not detected yet" most of the time is expected, not a bug. If your org later moves to
Enterprise, the Admin API exposes real per-member spend caps and this could be wired in properly.

## Setup

```bash
cd ~/workspace/claude-fleet-manager
npm install
npm start
```

If Claude Desktop is installed somewhere other than `/usr/bin/claude-desktop`, set:

```bash
CLAUDE_DESKTOP_BIN=/path/to/claude-desktop npm start
```

### "SUID sandbox helper binary" error on Linux

`npm start` runs with `--no-sandbox`, since this app only ever renders the local UI files in
this repo (no remote/untrusted web content), which is the standard low-risk workaround for
npm-installed Electron on Linux. If you'd rather keep Chromium's sandbox on, do the one-time
fix instead and drop `--no-sandbox` from the `start` script in `package.json`:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Current scope / limitations

- **Single machine only.** Account data (labels, usage stats, session state flags) lives in a
  local JSON file in Electron's userData dir. If your 10 people are on different machines, they
  won't see each other's status updates unless this app runs on one shared machine everyone uses,
  or you sync the file another way. Say the word if you want a shared backend instead.
- **Window focus on Linux uses `wmctrl`.** When you launch or re-open an account's Claude Desktop
  window, this app explicitly asks the window manager to raise and focus that specific window
  (matched by process PID) via `wmctrl` — without this, a background-spawned window often doesn't
  steal focus on its own, so you'd keep seeing whatever was already on screen (e.g. a different
  account's already-open window). Needs `wmctrl` installed; works on X11, best-effort no-op on
  most Wayland setups.
- The usage/reset-time scanner only runs while the in-app (step 1) view is open for that
  account — it doesn't watch Claude Desktop's own window.
- **Claude Desktop always needs its own one-time sign-in per account, even after step 1.** I went
  back and specifically checked Claude Desktop's `claude://` deep-link handling code (used for
  things like opening a new chat) for any kind of auth-token handoff from a browser session —
  there isn't one for normal accounts. So the first time you open an account in Claude Desktop,
  it will show its own sign-in screen regardless of already being logged in via step 1; sign in
  there once and — thanks to the `CLAUDE_USER_DATA_DIR` fix above — it'll be remembered for that
  account from then on.
