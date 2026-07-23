const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  updateAccount: (account) => ipcRenderer.invoke('accounts:update', account),
  addAccount: (label) => ipcRenderer.invoke('accounts:add', label),
  removeAccount: (accountId) => ipcRenderer.invoke('accounts:remove', accountId),
  resetStats: () => ipcRenderer.invoke('accounts:resetStats'),
  removeAllSessions: () => ipcRenderer.invoke('accounts:removeAllSessions'),
  openInline: (accountId) => ipcRenderer.invoke('accounts:openInline', accountId),
  closeInline: () => ipcRenderer.invoke('accounts:closeInline'),
  launchDesktop: (accountId) => ipcRenderer.invoke('accounts:launchDesktop', accountId),
});
