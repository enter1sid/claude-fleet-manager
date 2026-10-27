const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('prompt_api', { submit: (v) => ipcRenderer.send('prompt-result', v) });
