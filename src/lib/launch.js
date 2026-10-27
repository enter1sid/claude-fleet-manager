// Starts the "next session" with a handoff. Desktop: a claude:// URL (Desktop's own handler accepts
// `q`/`prompt` and `folder` on claude://code/new, and `q` on claude://claude.ai/new; prompt cap
// 14336 chars). The URL goes to Desktop as a launch argument so it reaches the right profile.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_PROMPT_CAP = 14336;
const URL_CAP = { win32: 7000, darwin: 30000, linux: 30000 }; // cmd.exe limits a command line to ~8191

// Persists the handoff before anything is stopped, so it is never lost whatever happens next.
function saveHandoff(dir, message) {
  const d = path.join(dir, 'handoffs');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = path.join(d, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(file, message, { mode: 0o600 });
  return file;
}

function encode(base, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `${base}?${q.toString()}`;
}

// Inline handoff when it fits; otherwise a short prompt that points at the saved file.
function buildDesktopUrl({ message, file, folder, mode = 'code', platform = process.platform }) {
  const base = mode === 'chat' ? 'claude://claude.ai/new' : 'claude://code/new';
  // Code sessions also get the saved handoff attached as a file (the handler takes absolute paths).
  const extra = mode === 'chat' ? { surface: 'chat', source: 'fleet_manager' } : { folder, file, source: 'fleet_manager' };
  const inline = encode(base, { q: message.slice(0, APP_PROMPT_CAP), ...extra });
  if (message.length <= APP_PROMPT_CAP && inline.length <= URL_CAP[platform]) return { url: inline, inline: true };
  const pointer = `Continue the previous session. Read the full handoff saved at ${file} first, then carry on from its next step.`;
  return { url: encode(base, { q: pointer, ...extra }), inline: false };
}

module.exports = { saveHandoff, buildDesktopUrl, APP_PROMPT_CAP };
