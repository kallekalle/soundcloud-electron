const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  nav: {
    back: () => ipcRenderer.invoke('nav:back'),
    forward: () => ipcRenderer.invoke('nav:forward'),
    reload: () => ipcRenderer.invoke('nav:reload')
  },
  toggleGeniusWindow: () => ipcRenderer.invoke('genius:toggle-window'),
  geniusSearch: (payload) => ipcRenderer.invoke('genius:search', payload)
});