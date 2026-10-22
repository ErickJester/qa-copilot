const { contextBridge, ipcRenderer } = require('electron');

// Solo se exponen funciones concretas, nunca ipcRenderer. La Fase 5 añade la ventana flotante.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  pickTranscriptsDir: () => ipcRenderer.invoke('transcripts:pick'),
  openTranscripts: () => ipcRenderer.invoke('transcripts:open'),
});
