# Claude Fleet Manager

A background tray app (macOS, Ubuntu, Windows) that manages shared Claude accounts for both
**Claude Desktop** and the **Claude Code CLI**. It lives in the menu bar / system tray and switches
which account each of them uses, manually or automatically based on usage. Built with Electron.

> **Status:** core library, tray app and installers are written. Usage scanning, portable session
> export/import and Windows/macOS verification are still open (see Limitations).

## How it works

- **Tray app, no main window.** The menu lists accounts; each has *Use in Desktop*, *Use in CLI*
  and *Use in both*. On macOS it is menu-bar only. It starts at login.
- **One active account per target.** Desktop and the CLI each have their own current account, and
  any account can be used in either.
- **Nothing is embedded.** Switching Desktop quits it, swaps the login inside Desktop's own profile
  (claude.ai cookies and OAuth token caches), and relaunches it, so your normal main window comes
  back on the other account. A backup of the previous login is kept in `<profile>/.cfm-login-backup`.
  On Linux only Desktop's main process is asked to quit (signalling its GPU/zygote helpers too makes it
  hang), with a force-kill after 15 s. A login is never saved into a different account's slot, and a
  every switch (menu click or auto mode, which is on by default) hands the running session over: the old session is stopped, a handoff is built from its transcript, and the new account starts with it. Switching the CLI swaps the login in place (`~/.claude/.credentials.json` and `oauthAccount` in
  `~/.claude.json`; the Keychain on macOS) with backup and rollback.
- **Sessions:** CLI and Desktop Code conversations are transcripts in `~/.claude/projects/`; Desktop also keeps
  per-account metadata in `<profile>/claude-code-sessions/<account>/<org>/`. Before each switch they are backed up
  to `<app data>/session-backups/<time>` (last 10 kept), and a Desktop switch copies the old account's session
  list into the new account so the same conversations open there.
- **Adding accounts:** *Add account…* is one sign-in: Desktop signs in once (sign in to claude.ai in the browser as that
  person first) and the CLI login is derived from Desktop's stored token, so the account works in both. Accounts that
  only have a Desktop login get their CLI login automatically at start; a login already saved under another account
  is refused. If Desktop's token cache has an unexpected layout, only its key names are reported.
  Choosing *Use in Desktop* for an account that has no Desktop login starts that one sign-in on the spot. Auto mode
  never prompts: it only switches to accounts already usable in that target. Saved tokens are refreshed every 5 minutes
  from the live Desktop and CLI logins, and a Desktop switch that does not come up as the chosen account is reported.

## Auto mode

Each target is handled independently. When a target's current account passes **80%** of its
5-hour session, that target switches to the **lowest-usage** other account. A reading counts as 0%
after its reset time; signed-out and unread accounts are never picked; an account just switched
away from is not picked again until it drops below the threshold; if no lower account exists you
are notified. A forced switch stops the running session, builds a handoff from its transcript, and
starts a fresh session on the new account with the handoff (CLI: new terminal window; Desktop: the
handoff is put on the clipboard and pasted into the window if automation is available, otherwise
you are told to paste it).

## Install / uninstall

`./build-installer.sh` (run on Ubuntu or macOS) regenerates both installers in `dist/`, each with
its own Electron runtime so target machines need nothing pre-installed:

| File | Platforms | Install | Uninstall |
|---|---|---|---|
| `dist/install.sh` | macOS, Ubuntu | `sh install.sh` | `sh install.sh -u` (add `--purge` to delete accounts) |
| `dist/install.bat` | Windows | run it, press Enter (default is install) | run it, type `u` |

Uninstall keeps your accounts unless you purge. Unsigned installers trigger a one-time Gatekeeper
(macOS) or SmartScreen (Windows) warning. `CFM_PLATFORMS="linux-x64" ./build-installer.sh` builds
a smaller single-platform installer for testing.

## Development

```bash
npm install
npm start
npm test
```

## Limitations

- **Verified so far:** unit tests for the logic, and an install/uninstall run of `install.sh` on
  Ubuntu. The tray UI, macOS and Windows paths, and the `.bat` have not been run.
- **Usage** is read from each account's CLI login (endpoint unverified). Accounts with no usable CLI
  login fall back to their Desktop profile's claude.ai session (`sessionKey` + `lastActiveOrg`
  cookies, decrypted locally); that endpoint is also unverified.
- **Session lifetime:** when you add an account you choose its lifetime in days (0 = never). When it
  passes, the stored CLI login and Desktop profile are wiped, and if the account is active, the live
  CLI login is removed and Desktop is quit. The row stays, marked expired. "Extend expiry" works only
  while the account is still valid.
- **Export / Import** (tray menu) produce an AES-256-GCM bundle with a passphrase. Each account keeps
  its own expiry (the export dialog doesn't ask for one); an import keeps that date, skips expired
  entries and never extends an existing account. Desktop cookies are exported decrypted (inside the
  encrypted bundle) and re-encrypted with the importing machine's key. Linux is covered by tests;
  the macOS (Keychain) and Windows (DPAPI) key handling is written but **unverified** on real machines.
- A forced CLI switch stops only terminal sessions, never ones hosted by Claude Desktop, and the new
  session starts with the previous `--model`. Effort is not carried over.
- Windows process discovery finds `claude` sessions but not their folders, so it falls back to the
  most recent session's folder.
- Desktop model/effort can't be set automatically as far as known; the previous model is shown
  in a notification instead.
- On Ubuntu the tray icon needs AppIndicator support (on by default in Ubuntu's GNOME).
- Stored CLI logins are plain JSON (mode 0600) in the app's data folder. Treat it like a password
  file.
