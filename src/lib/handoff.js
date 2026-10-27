// Builds a handoff message from the newest CLI session transcript for a working directory, built
// locally so it costs no usage on the account being left. Transcripts are plain JSONL under
// ~/.claude/projects/<cwd with / replaced by ->/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function projectDir(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

function newestTranscript(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const stat = (f) => fs.statSync(path.join(dir, f)).mtimeMs;
  files.sort((a, b) => stat(b) - stat(a));
  return files.length ? path.join(dir, files[0]) : null;
}

// The folder the most recent session ran in: newest transcript across all projects, read from the
// `cwd` field Claude Code records on each entry (the folder name alone is lossy to decode).
function latestSessionCwd(home = os.homedir()) {
  const root = path.join(home, '.claude', 'projects');
  let best = null;
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = newestTranscript(path.join(root, d));
    if (!file) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  if (!best) return null;
  for (const line of fs.readFileSync(best.file, 'utf8').split('\n')) {
    try {
      const rec = JSON.parse(line);
      if (rec.cwd) return rec.cwd;
    } catch {}
  }
  return null;
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return '';
}

function lastTurns(file, count = 6) {
  const turns = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const text = textOf(rec.message).trim();
    if (text) turns.push({ role: rec.type, text: text.slice(0, 1500), model: rec.message && rec.message.model });
  }
  return turns.slice(-count);
}

function buildHandoff({ cwd, home = os.homedir(), count = 6 }) {
  const file = newestTranscript(projectDir(cwd, home));
  if (!file) return null;
  const turns = lastTurns(file, count);
  const model = [...turns].reverse().find((t) => t.model)?.model || null;
  const body = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n');
  return {
    sessionFile: file,
    model,
    message: `Continuing a session that was interrupted because the previous account hit its usage limit.\nWorking directory: ${cwd}\n\nRecent conversation:\n\n${body}\n\nPick up where this left off.`,
  };
}

// Asks the account currently in use to summarize the latest session in `cwd` (`claude --continue -p`).
// Resolves null on failure or timeout (e.g. the account is already at its limit) so the caller can
// fall back to the local transcript extract.
function generateViaClaude({ cwd, timeoutMs = 90000, bin = 'claude' }) {
  const prompt = 'Write a handoff note for another engineer taking over this session: the goal, what is done, what is in progress, key files and decisions, and the exact next step. Plain text only.';
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const child = spawn(bin, ['--continue', '-p', prompt], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 && out.trim() ? out.trim() : null));
  });
}

module.exports = { latestSessionCwd, generateViaClaude, buildHandoff, projectDir, newestTranscript, lastTurns };
