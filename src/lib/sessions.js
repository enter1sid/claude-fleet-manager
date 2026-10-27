// Where sessions live. Claude Code conversations are JSONL transcripts in ~/.claude/projects/<cwd>/<id>.jsonl,
// shared by the CLI and Desktop's Code tab. Desktop also keeps one metadata file per session under
// <Desktop profile>/claude-code-sessions/<account uuid>/<org uuid>/local_*.json (its `cliSessionId` names
// the transcript), so each account only sees its own list. Backing up copies both; carrying sessions
// over copies the metadata into the other account's folder so the same conversations open there.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectDir } = require('./handoff');

const KEEP_BACKUPS = 10;

const sessionsRoot = (dir) => path.join(dir, 'claude-code-sessions');

function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listSessions(dir, accountId) {
  const base = path.join(sessionsRoot(dir), accountId);
  const out = [];
  let orgs = [];
  try {
    orgs = fs.readdirSync(base);
  } catch {}
  for (const org of orgs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, org)).filter((f) => /^local_.*\.json$/.test(f));
    } catch {}
    for (const f of files) {
      const file = path.join(base, org, f);
      const meta = readMeta(file);
      if (meta) out.push({ org, name: f, file, meta });
    }
  }
  return out;
}

const copyInto = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};

// Copies an account's Desktop session metadata and their transcripts, plus the newest transcript of each
// folder in `cwds` (running CLI sessions), into backupRoot/<timestamp>. Returns { dir, sessions } or null.
function backupSessions({ dir, accountId, backupRoot, cwds = [], home = os.homedir(), now = Date.now() }) {
  const sessions = accountId ? listSessions(dir, accountId) : [];
  const transcripts = new Set();
  for (const s of sessions) {
    if (s.meta.cliSessionId && s.meta.cwd) transcripts.add(path.join(projectDir(s.meta.cwd, home), `${s.meta.cliSessionId}.jsonl`));
  }
  for (const cwd of cwds) {
    let newest = null;
    try {
      const d = projectDir(cwd, home);
      newest = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(d, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch {}
    if (newest) transcripts.add(newest);
  }
  const files = [...transcripts].filter((f) => fs.existsSync(f));
  if (!sessions.length && !files.length) return null;
  const out = path.join(backupRoot, new Date(now).toISOString().replace(/[:.]/g, '-'));
  for (const s of sessions) copyInto(s.file, path.join(out, 'desktop', s.org, s.name));
  const projects = path.join(home, '.claude', 'projects');
  for (const f of files) copyInto(f, path.join(out, 'transcripts', path.relative(projects, f)));
  let old = [];
  try {
    old = fs.readdirSync(backupRoot).sort();
  } catch {}
  for (const d of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(backupRoot, d), { recursive: true, force: true });
  return { dir: out, sessions: sessions.length, transcripts: files.length };
}

// Makes the sessions of account `fromId` appear under account `toId` (never overwrites one that exists).
function carrySessions({ dir, fromId, toId }) {
  if (!fromId || !toId || fromId === toId) return 0;
  const base = path.join(sessionsRoot(dir), toId);
  let orgs = [];
  try {
    orgs = fs.readdirSync(base);
  } catch {}
  let copied = 0;
  for (const s of listSessions(dir, fromId)) {
    const dest = path.join(base, orgs.includes(s.org) ? s.org : orgs[0] || s.org, s.name);
    if (fs.existsSync(dest)) continue;
    copyInto(s.file, dest);
    copied++;
  }
  return copied;
}

module.exports = { listSessions, backupSessions, carrySessions };
