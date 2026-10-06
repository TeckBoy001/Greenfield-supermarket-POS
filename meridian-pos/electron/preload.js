'use strict';
// Preload: the ONLY bridge between the web UI and the desktop. Keep this surface minimal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meridian', {
  desktop: true,
  terminal: ipcRenderer.sendSync('terminal:get'),
  setRegister: (id) => ipcRenderer.send('terminal:setRegister', String(id || '')),
  printHtml: (html, opts) => ipcRenderer.invoke('print:html', String(html), opts || {}),
  openCustomerDisplay: (token) => ipcRenderer.invoke('display:open', token || ''),
});
