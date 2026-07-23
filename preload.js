'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('frameforge', {
  // Window controls — the window is frameless, so these drive the custom
  // minimize / maximize / close buttons in the title bar.
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximized: (cb) => ipcRenderer.on('window:maximized', (_e, state) => cb(state)),

  getSystemInfo: () => ipcRenderer.invoke('get:systemInfo'),
  getDefaultOutputFolder: () => ipcRenderer.invoke('get:defaultOutputFolder'),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  // Electron 32+ deprecates file.path; webUtils.getPathForFile is the correct API
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveHtmlToTemp: (html, name) => ipcRenderer.invoke('save-html-to-temp', { html, name }),

  startRecording: (jobConfig) => ipcRenderer.send('record:start', jobConfig),
  cancelRecording: () => ipcRenderer.send('record:cancel'),
  showFile: (filePath) => ipcRenderer.send('shell:showFile', filePath),

  onProgress: (cb) => ipcRenderer.on('recording:progress', (_e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('recording:done', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('recording:error', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('recording:log', (_e, data) => cb(data)),

  removeListeners: () => {
    ipcRenderer.removeAllListeners('recording:progress');
    ipcRenderer.removeAllListeners('recording:done');
    ipcRenderer.removeAllListeners('recording:error');
    ipcRenderer.removeAllListeners('recording:log');
  },
});
