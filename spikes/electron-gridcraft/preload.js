const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hostIpc', { nudge: () => ipcRenderer.invoke('nudge'), invalidate: () => ipcRenderer.invoke('invalidate') });
