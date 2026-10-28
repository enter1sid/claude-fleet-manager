#!/bin/sh
# Claude Fleet Manager installer for macOS and Ubuntu.
#   sh install.sh            install (default)
#   sh install.sh -u         uninstall, keeping your accounts
#   sh install.sh -u --purge uninstall and delete accounts too
set -eu

NAME="claude-fleet-manager"
OS="$(uname -s)"
case "$OS" in
  Darwin) APP_DIR="$HOME/Library/Application Support/Claude Fleet Manager"; DATA_DIR="$HOME/Library/Application Support/$NAME"
          PLIST="$HOME/Library/LaunchAgents/com.countrydelight.$NAME.plist"
          case "$(uname -m)" in arm64) PLAT=darwin-arm64 ;; *) PLAT=darwin-x64 ;; esac ;;
  Linux)  APP_DIR="$HOME/.local/share/$NAME"; DATA_DIR="$HOME/.config/$NAME"
          DESKTOP="$HOME/.local/share/applications/$NAME.desktop"; AUTOSTART="$HOME/.config/autostart/$NAME.desktop"
          PLAT=linux-x64 ;;
  *) echo "Unsupported OS: $OS (Windows uses install.bat)"; exit 1 ;;
esac

MODE=install; PURGE=0
for a in "$@"; do case "$a" in -u|--uninstall) MODE=uninstall ;; --purge) PURGE=1 ;; esac; done

if [ "$MODE" = uninstall ]; then
  pkill -f "$APP_DIR" 2>/dev/null || true
  if [ "$OS" = Darwin ]; then launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; else rm -f "$DESKTOP" "$AUTOSTART"; fi
  rm -rf "$APP_DIR"
  if [ "$PURGE" = 1 ]; then rm -rf "$DATA_DIR"; echo "Uninstalled. Accounts deleted."
  else echo "Uninstalled. Accounts kept in: $DATA_DIR"; fi
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SKIP="$(grep -a -n -m1 '^__PAYLOAD__$' "$0" | cut -d: -f1)"
tail -n +"$((SKIP + 1))" "$0" | tar -xzf - -C "$TMP"
[ -f "$TMP/runtimes/$PLAT.zip" ] || { echo "This installer has no runtime for $PLAT."; exit 1; }

pkill -f "$APP_DIR" 2>/dev/null || true
rm -rf "$APP_DIR"; mkdir -p "$APP_DIR/electron"
if [ "$OS" = Darwin ]; then ditto -x -k "$TMP/runtimes/$PLAT.zip" "$APP_DIR/electron"
else command -v unzip >/dev/null || { echo "Please install unzip (sudo apt install unzip) and re-run."; exit 1; }
     unzip -q "$TMP/runtimes/$PLAT.zip" -d "$APP_DIR/electron"; fi
cp -R "$TMP/app" "$APP_DIR/app"

# Save the Claude Desktop / CLI logins already on this machine as accounts (never fails the install).
if [ "$OS" = Darwin ]; then NODE_BIN="$APP_DIR/electron/Electron.app/Contents/MacOS/Electron"; else NODE_BIN="$APP_DIR/electron/electron"; chmod +x "$NODE_BIN"; fi
ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$APP_DIR/app/src/main/detect-cli.js" 2>/dev/null || echo "Could not detect signed-in accounts. Use Add account from the tray menu."

if [ "$OS" = Darwin ]; then
  BIN="$APP_DIR/electron/Electron.app/Contents/MacOS/Electron"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.countrydelight.$NAME</string>
<key>ProgramArguments</key><array><string>$BIN</string><string>$APP_DIR/app</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true; launchctl load "$PLIST"
else
  BIN="$APP_DIR/electron/electron"
  chmod +x "$BIN"
  # chrome-sandbox needs setuid root; run without it for a per-user install.
  ENTRY="[Desktop Entry]
Type=Application
Name=Claude Fleet Manager
Exec=\"$BIN\" --no-sandbox \"$APP_DIR/app\"
Icon=$APP_DIR/app/assets/icon.png
Terminal=false
Categories=Utility;"
  mkdir -p "$(dirname "$DESKTOP")" "$(dirname "$AUTOSTART")"
  printf '%s\n' "$ENTRY" > "$DESKTOP"; printf '%s\n' "$ENTRY" > "$AUTOSTART"
  command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
  nohup "$BIN" --no-sandbox "$APP_DIR/app" >/dev/null 2>&1 &
fi
echo "Installed. The Claude Fleet Manager icon is in your menu bar / system tray."
exit 0
