const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stopAndGo', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testServer: (settings) => ipcRenderer.invoke('server:test', settings),
  listCatalog: (kind) => ipcRenderer.invoke('catalog:list', kind),
  readMedia: (request) => ipcRenderer.invoke('media:read', request),
  readThumbnail: (url) => ipcRenderer.invoke('thumbnail:read', url),
  readScreenshot: (url) => ipcRenderer.invoke('screenshot:read', url),
  createClip: (request) => ipcRenderer.invoke('export:clip', request),
  uploadScreenshot: (request) => ipcRenderer.invoke('export:screenshot', request),
});
