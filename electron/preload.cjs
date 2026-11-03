const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  invoke: (method, args) => ipcRenderer.invoke('desktop:invoke', method, args),
  onEvent: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:event', handler);
    return () => ipcRenderer.removeListener('desktop:event', handler);
  }
});
