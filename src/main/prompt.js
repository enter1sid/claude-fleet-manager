// Small modal windows (Electron has no built-in text prompt): passphrase, expiry, rename, login method.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { EXPIRY_OPTIONS } = require('../lib/expiry');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:22px;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;background:#16161a;color:#ececf1;-webkit-user-select:none}
  h1{margin:0 0 4px;font-size:16px;font-weight:600}
  p.sub{margin:0 0 16px;color:#9a9aa8;font-size:12.5px}
  input,select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #2d2d36;background:#1f1f26;color:inherit;font:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus,select:focus{border-color:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.22)}
  select{appearance:none;cursor:pointer;padding-right:34px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none' stroke='%239a9aa8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1.5l5 5 5-5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
  .stack{display:flex;flex-direction:column;gap:8px}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
  button{padding:9px 16px;border-radius:10px;border:1px solid #2d2d36;background:#23232b;color:inherit;font:inherit;cursor:pointer;transition:background .15s}
  button:hover{background:#2c2c36}
  button.primary{background:#e5484d;border-color:#e5484d;color:#fff;font-weight:600}
  button.primary:hover{background:#f05a5f}
  .err{min-height:18px;margin-top:8px;color:#ff8a8f;font-size:12.5px}
  .choice{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:12px;border:1px solid #2d2d36;background:#1f1f26;cursor:pointer;text-align:left;width:100%}
  .choice:hover{border-color:#e5484d;background:#25252d}
  .choice b{display:block;font-weight:600}
  .choice span{color:#9a9aa8;font-size:12.5px}
  .ico{font-size:20px;line-height:1.2}
`;

function openPrompt({ title, height, body, script = '' }) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 400, height, resizable: false, minimizable: false, maximizable: false, title, autoHideMenuBar: true, backgroundColor: '#16161a',
      webPreferences: { preload: path.join(__dirname, 'prompt-preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu();
    const html = `<!doctype html><meta charset=utf-8><style>${STYLE}</style><body>${body}
      <script>const submit=(v)=>window.prompt_api.submit(v),$=(id)=>document.getElementById(id);
      document.addEventListener('keydown',(e)=>{if(e.key==='Escape')submit(null);if(e.key==='Enter'&&window.ok)window.ok()});${script}</script></body>`;
    let done = false;
    const finish = (v) => { if (!done) { done = true; ipcMain.removeListener('prompt-result', onResult); resolve(v); if (!win.isDestroyed()) win.close(); } };
    const onResult = (e, v) => { if (e.sender === win.webContents) finish(v); };
    ipcMain.on('prompt-result', onResult);
    win.on('closed', () => finish(null));
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

const buttons = (ok = 'OK') => `<div class=row><button onclick="submit(null)">Cancel</button><button class=primary onclick="ok()">${ok}</button></div>`;

function askPassphrase(title, { confirm = false, allowEmpty = true } = {}) {
  return openPrompt({
    title,
    height: confirm ? 300 : 230,
    body: `<h1>${esc(title)}</h1><p class=sub>Used to encrypt the exported file.</p>
      <div class=stack><input id=a type=password placeholder="Passphrase" autofocus>
      ${confirm ? '<input id=b type=password placeholder="Repeat passphrase">' : ''}</div>
      <div class=err id=e></div>${buttons()}`,
    script: `window.ok=()=>{const a=$('a').value,b=$('b');
      if(b&&b.value!==a){$('e').textContent='Passphrases differ';return}
      ${allowEmpty ? '' : "if(a.length<8){$('e').textContent='Use at least 8 characters';return}"}
      submit(a)}`,
  });
}

// Resolves to a number of days (0 = never) or null if cancelled.
function askExpiry(title, defaultDays = 10) {
  const options = EXPIRY_OPTIONS.map((o) => `<option value=${o.days}${o.days === defaultDays ? ' selected' : ''}>${o.label}</option>`).join('');
  return openPrompt({
    title,
    height: 250,
    body: `<h1>${esc(title)}</h1><p class=sub>After this the account is wiped from this machine. Choose Never to keep it.</p>
      <select id=a autofocus>${options}</select>${buttons()}`,
    script: `window.ok=()=>submit(Number($('a').value))`,
  });
}

// Resolves to the trimmed text or null if cancelled.
function askText(title, { value = '', placeholder = '', hint = '' } = {}) {
  return openPrompt({
    title,
    height: 230,
    body: `<h1>${esc(title)}</h1><p class=sub>${esc(hint)}</p>
      <input id=a value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength=60 autofocus>
      <div class=err id=e></div>${buttons('Save')}`,
    script: `window.ok=()=>{const v=$('a').value.trim();if(!v){$('e').textContent='Enter a name';return}submit(v)};$('a').select()`,
  });
}

// Resolves to 'desktop', 'cli' or null if cancelled.
function askLoginMethod(title, { desktopAvailable = true } = {}) {
  return openPrompt({
    title,
    height: desktopAvailable ? 300 : 250,
    body: `<h1>${esc(title)}</h1><p class=sub>How should this account sign in?</p>
      <div class=stack>
        ${desktopAvailable ? `<button class=choice onclick="submit('desktop')"><span class=ico>🖥️</span><div><b>Claude Desktop</b><span>Sign in once; the CLI login is derived from it.</span></div></button>` : ''}
        <button class=choice onclick="submit('cli')"><span class=ico>⌨️</span><div><b>Claude Code CLI</b><span>Runs <code>claude auth login</code> in a terminal.</span></div></button>
      </div><div class=row><button onclick="submit(null)">Cancel</button></div>`,
  });
}

module.exports = { askPassphrase, askExpiry, askText, askLoginMethod };
