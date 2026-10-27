#!/usr/bin/env bash
# Regenerates the installers in dist/ from src/. Run on Ubuntu or macOS.
#   dist/install.sh   macOS + Ubuntu (embeds linux-x64, darwin-x64, darwin-arm64 runtimes)
#   dist/install.bat  Windows       (embeds the win32-x64 runtime)
# Limit the build with CFM_PLATFORMS, e.g. CFM_PLATFORMS=linux-x64 ./build-installer.sh
set -euo pipefail
cd "$(dirname "$0")"

PLATFORMS="${CFM_PLATFORMS:-linux-x64 darwin-x64 darwin-arm64 win32-x64}"
[ -d node_modules/electron ] || npm install --no-audit --no-fund --silent
VER="$(node -p "require('./node_modules/electron/package.json').version")"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p dist

fetch() { # platform -> cached zip path
  local cache="$HOME/.cache/claude-fleet-manager/electron-v$VER-$1.zip"
  if [ ! -f "$cache" ]; then
    mkdir -p "$(dirname "$cache")"
    echo "Downloading Electron $VER ($1)…" >&2
    curl -fsSL --retry 3 -o "$cache.part" "https://github.com/electron/electron/releases/download/v$VER/electron-v$VER-$1.zip"
    mv "$cache.part" "$cache"
  fi
  echo "$cache"
}

# pack <out.tgz> <platform>... : app + the given runtimes
pack() {
  local out="$1"; shift
  local dir; dir="$(mktemp -d -p "$WORK")"
  mkdir -p "$dir/app" "$dir/runtimes"
  cp -R src assets package.json "$dir/app/"
  for p in "$@"; do cp "$(fetch "$p")" "$dir/runtimes/$p.zip"; done
  tar -czf "$out" -C "$dir" .
}

UNIX=(); WIN=()
for p in $PLATFORMS; do case "$p" in win32-*) WIN+=("$p") ;; *) UNIX+=("$p") ;; esac; done

if [ ${#UNIX[@]} -gt 0 ]; then
  pack "$WORK/unix.tgz" "${UNIX[@]}"
  { cat scripts/install.head.sh; echo "__PAYLOAD__"; cat "$WORK/unix.tgz"; } > dist/install.sh
  chmod +x dist/install.sh
  echo "Built dist/install.sh ($(du -h dist/install.sh | cut -f1)): ${UNIX[*]}"
fi

if [ ${#WIN[@]} -gt 0 ]; then
  pack "$WORK/win.tgz" "${WIN[@]}"
  # cmd.exe needs CRLF line endings; the payload follows a CRLF marker line.
  { sed 's/$/\r/' scripts/install.head.bat; printf '__PAYLOAD__\r\n'; cat "$WORK/win.tgz"; } > dist/install.bat
  echo "Built dist/install.bat ($(du -h dist/install.bat | cut -f1)): ${WIN[*]}"
fi
