// Append-only diagnostic log (macOS: ~/Library/Logs/claude-fleet-manager/main.log). Never throws.
const fs = require('fs');
const path = require('path');

let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1e6) fs.renameSync(file, file + '.old');
  } catch {
    file = null;
  }
}

function log(...parts) {
  if (!file) return;
  const text = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

module.exports = { init, log, dir: () => (file ? path.dirname(file) : null) };
