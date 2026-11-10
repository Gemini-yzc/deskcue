const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('deskcue', {
  read: () => ipcRenderer.invoke('deskcue:read'),
  command: command => ipcRenderer.invoke('deskcue:command', command),
  onState: callback => ipcRenderer.on('deskcue:state', (_, state) => callback(state)),
  onError: callback => ipcRenderer.on('deskcue:error', (_, error) => callback(error)),
  onNew: callback => ipcRenderer.on('deskcue:new', callback),
});
