// Opens a new terminal window running `claude` with a handoff as its first prompt (a fresh session).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MODEL_RE = /^[A-Za-z0-9._\-\[\]]{1,80}$/;
const modelArgs = (model) => (model && MODEL_RE.test(model) ? ['--model', model] : []);

function writeScript(cwd, message, model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-handoff-'));
  const promptFile = path.join(dir, 'prompt.txt');
  const script = path.join(dir, 'run.sh');
  fs.writeFileSync(promptFile, message, { mode: 0o600 });
  fs.writeFileSync(script, `#!/bin/sh\ncd ${JSON.stringify(cwd || os.homedir())} || exit 1\nexec claude ${modelArgs(model).join(' ')} "$(cat ${JSON.stringify(promptFile)})"\n`, { mode: 0o700 });
  return script;
}

function openClaudeWithHandoff(cwd, message, { model, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-handoff-'));
    const prompt = path.join(dir, 'prompt.txt');
    fs.writeFileSync(prompt, message);
    const ps = ['powershell', '-NoExit', '-Command', `Set-Location '${cwd || os.homedir()}'; claude ${modelArgs(model).join(' ')} (Get-Content -Raw '${prompt}')`];
    const hasWt = spawnSync('where', ['wt'], { stdio: 'ignore' }).status === 0; // Windows Terminal when present
    spawn('cmd', ['/c', 'start', '', ...(hasWt ? ['wt', ...ps] : ps)], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const script = writeScript(cwd, message, model);
  if (platform === 'darwin') {
    spawnSync('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate']);
    return true;
  }
  return launchScript(script);
}

// Runs `script` in a new terminal window. False when no terminal emulator is found.
function launchScript(script) {
  const candidates = [
    ['x-terminal-emulator', ['-e', script]],
    ['gnome-terminal', ['--', script]],
    ['kgx', ['--', script]],
    ['konsole', ['-e', script]],
    ['xfce4-terminal', ['-x', script]],
    ['kitty', [script]],
    ['alacritty', ['-e', script]],
    ['wezterm', ['start', '--', script]],
    ['xterm', ['-e', script]],
  ];
  for (const [cmd, args] of candidates) {
    if (spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0) {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  }
  return false;
}

// Opens a terminal running `claude auth login`, the CLI sign-in used when Desktop is not installed.
function openCliLogin({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'powershell', '-NoExit', '-Command', 'claude auth login'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-login-'));
  const script = path.join(dir, 'run.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexec claude auth login\n', { mode: 0o700 });
  if (platform === 'darwin') {
    spawnSync('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate']);
    return true;
  }
  return launchScript(script);
}

module.exports = { openClaudeWithHandoff, openCliLogin, modelArgs };
