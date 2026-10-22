const { contextBridge } = require('electron');

// Las fases 4 y 5 amplían esta API (config, carpeta de transcripciones, ventana flotante).
contextBridge.exposeInMainWorld('desktop', { isDesktop: true });
