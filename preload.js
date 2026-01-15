const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nav', {
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload')
});