const { contextBridge, ipcRenderer } = require('electron');

// Solo se exponen funciones concretas, nunca ipcRenderer. La Fase 5 añade el modo siempre encima de la ventana principal.
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  pickTranscriptsDir: () => ipcRenderer.invoke('transcripts:pick'),
  openTranscripts: () => ipcRenderer.invoke('transcripts:open'),
  onTop: {
    toggle: () => ipcRenderer.invoke('ontop:toggle'),
    get: () => ipcRenderer.invoke('ontop:get'),
    onChange: (cb) => ipcRenderer.on('ontop:changed', (_e, on) => cb(on)),
  },
});
