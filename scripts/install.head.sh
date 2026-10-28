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
          BUNDLE="$HOME/Applications/Claude Fleet Manager.app"
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
  if [ "$OS" = Darwin ]; then pkill -f "$BUNDLE" 2>/dev/null || true; launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; rm -rf "$BUNDLE"; else rm -f "$DESKTOP" "$AUTOSTART"; fi
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
rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
if [ "$OS" = Darwin ]; then
  # A real app bundle in ~/Applications, so Spotlight and Launchpad find it as "Claude Fleet Manager".
  pkill -f "$BUNDLE" 2>/dev/null || true
  rm -rf "$BUNDLE"; mkdir -p "$HOME/Applications" "$TMP/rt"
  ditto -x -k "$TMP/runtimes/$PLAT.zip" "$TMP/rt"
  mv "$TMP/rt/Electron.app" "$BUNDLE"
  cp -R "$TMP/app" "$BUNDLE/Contents/Resources/app"
  BIN="$BUNDLE/Contents/MacOS/Claude Fleet Manager"
  mv "$BUNDLE/Contents/MacOS/Electron" "$BIN"
  PB=/usr/libexec/PlistBuddy; INFO="$BUNDLE/Contents/Info.plist"
  setkey() { "$PB" -c "Set :$1 $2" "$INFO" 2>/dev/null || "$PB" -c "Add :$1 string $2" "$INFO"; }
  setkey CFBundleExecutable "Claude Fleet Manager"; setkey CFBundleName "Claude Fleet Manager"; setkey CFBundleDisplayName "Claude Fleet Manager"
  setkey CFBundleIdentifier "com.countrydelight.$NAME"
  setkey NSAppleEventsUsageDescription "Claude Fleet Manager quits and restarts Claude Desktop when you switch accounts."
  "$PB" -c "Add :LSUIElement bool true" "$INFO" 2>/dev/null || "$PB" -c "Set :LSUIElement true" "$INFO"
  # Icon: build an .icns from the PNG (best effort; the default icon is used if this fails).
  ICONSET="$TMP/icon.iconset"; mkdir -p "$ICONSET"
  for z in 16 32 64 128 256 512; do sips -z $z $z "$BUNDLE/Contents/Resources/app/assets/icon.png" --out "$ICONSET/icon_${z}x${z}.png" >/dev/null 2>&1 || true; done
  cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png" 2>/dev/null || true; cp "$ICONSET/icon_64x64.png" "$ICONSET/icon_32x32@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png" 2>/dev/null || true; cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png" 2>/dev/null || true
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/electron.icns" 2>/dev/null || true
  # Editing the bundle breaks Electron's signature, and Apple Silicon will not run an invalid one.
  xattr -cr "$BUNDLE" 2>/dev/null || true
  codesign --force --deep --sign - "$BUNDLE" 2>/dev/null || echo "Warning: could not re-sign the app; it may not start on Apple Silicon."
  mdimport "$BUNDLE" 2>/dev/null || true
  NODE_BIN="$BIN"
else
  mkdir -p "$APP_DIR/electron"
  command -v unzip >/dev/null || { echo "Please install unzip (sudo apt install unzip) and re-run."; exit 1; }
  unzip -q "$TMP/runtimes/$PLAT.zip" -d "$APP_DIR/electron"
  cp -R "$TMP/app" "$APP_DIR/app"
  NODE_BIN="$APP_DIR/electron/electron"; chmod +x "$NODE_BIN"
fi

# Save the Claude Desktop / CLI logins already on this machine as accounts (never fails the install).
if [ "$OS" = Darwin ]; then DETECT="$BUNDLE/Contents/Resources/app/src/main/detect-cli.js"; else DETECT="$APP_DIR/app/src/main/detect-cli.js"; fi
ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$DETECT" 2>/dev/null || echo "Could not detect signed-in accounts. Use Add account from the tray menu."

if [ "$OS" = Darwin ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.countrydelight.$NAME</string>
<key>ProgramArguments</key><array><string>$BIN</string></array>
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
