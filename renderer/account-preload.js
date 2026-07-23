const { ipcRenderer } = require('electron');

// Bridges the CustomEvent dispatched by the injected main-world scan script (main.js's
// USAGE_SCAN_SCRIPT) back to the main process. contextIsolation keeps this preload's JS
// context separate from claude.ai's own scripts, but both share the same DOM, so a
// document-level CustomEvent is the standard secure way to cross that boundary.
document.addEventListener('claude-fleet-usage-detected', (e) => {
  ipcRenderer.send('usage-scan-result', e.detail);
});
