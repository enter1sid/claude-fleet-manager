// Pastes the handoff into Claude Desktop's focused window. The caller puts it on the clipboard first.
// Needs xdotool (X11) on Linux or Accessibility permission for osascript on macOS. Returns false
// when it can't, so the caller can tell the user to paste it manually.
const { spawnSync } = require('child_process');

function has(cmd) {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function pasteIntoFocusedWindow(platform = process.platform) {
  if (platform === 'darwin') {
    const r = spawnSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    return r.status === 0;
  }
  if (platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject WScript.Shell).SendKeys('^v')"]);
    return r.status === 0;
  }
  if (process.env.XDG_SESSION_TYPE === 'wayland' || !has('xdotool')) return false;
  return spawnSync('xdotool', ['key', '--clearmodifiers', 'ctrl+v']).status === 0;
}

module.exports = { pasteIntoFocusedWindow };
