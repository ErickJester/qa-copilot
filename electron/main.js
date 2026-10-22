import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';
import { loadConfig, saveConfig } from './config.js';

// Puerto fijo: el origen (y con él el localStorage con el contexto y los documentos) depende del puerto.
const DEFAULT_PORT = 47821;

const root = fileURLToPath(new URL('..', import.meta.url));

let win = null;
let floatWin = null;
let server = null;
let origin = '';
let token = '';
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox('Copiloto QA', `No se pudo iniciar: ${err.message}`);
    app.exit(1);
  });
}

async function listen(opts) {
  try {
    return await startServer({ ...opts, port: DEFAULT_PORT });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.warn(`El puerto ${DEFAULT_PORT} está ocupado: se usa uno aleatorio y el contexto guardado no estará disponible en esta sesión.`);
    return startServer({ ...opts, port: 0 });
  }
}

// Arranca el servidor con la config actual y un token nuevo. Sin claves arranca igual, para poder abrir Ajustes.
async function launchServer() {
  const cfg = loadConfig();
  token = randomUUID();
  server = await listen({
    deepgramKey: cfg.deepgramKey,
    anthropicKey: cfg.anthropicKey,
    language: cfg.language,
    model: cfg.model,
    transcriptsDir: cfg.transcriptsDir,
    token,
    // La flotante recibe la respuesta directamente del servidor, aunque la principal esté minimizada.
    onMessage: (msg) => {
      if (!RELAYED.has(msg.type) || !floatWin || floatWin.isDestroyed()) return;
      floatWin.webContents.send('float:msg', msg);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}

const RELAYED = new Set(['answer_start', 'answer_delta', 'answer_end', 'error']);
const pageUrl = () => `${origin}/?t=${encodeURIComponent(token)}`;
const isLocal = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };

// Solo la página local puede usar el IPC.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isLocal(event.senderFrame?.url)) throw new Error('Origen no autorizado');
    return fn(...args);
  });
}

const webPreferences = () => ({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: join(root, 'electron', 'preload.cjs'),
});

// Enlaces externos al navegador y navegación bloqueada fuera del origen local.
function lockNavigation(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) e.preventDefault();
  });
}

// Los bounds guardados solo valen si la ventana queda dentro de alguna pantalla.
function floatBoundsOrDefault() {
  const b = loadConfig().floatBounds;
  const fits = b && screen.getAllDisplays().some(({ bounds: d }) =>
    b.x >= d.x && b.y >= d.y && b.x + b.width <= d.x + d.width && b.y + b.height <= d.y + d.height);
  return fits ? b : { width: 460, height: 320 };
}

function toggleFloat() {
  if (floatWin && !floatWin.isDestroyed()) {
    if (floatWin.isVisible()) floatWin.hide();
    else floatWin.showInactive();
    return;
  }
  floatWin = new BrowserWindow({
    ...floatBoundsOrDefault(),
    title: 'Copiloto QA',
    skipTaskbar: true,
    resizable: true,
    webPreferences: webPreferences(),
  });
  floatWin.setMenuBarVisibility(false);
  floatWin.setAlwaysOnTop(true, 'screen-saver');
  floatWin.setVisibleOnAllWorkspaces(true);
  lockNavigation(floatWin);
  let timer;
  const saveBounds = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (floatWin && !floatWin.isDestroyed()) saveConfig({ floatBounds: floatWin.getBounds() });
    }, 500);
  };
  floatWin.on('moved', saveBounds);
  floatWin.on('resized', saveBounds);
  floatWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    floatWin.hide();
  });
  floatWin.on('closed', () => { clearTimeout(timer); floatWin = null; });
  floatWin.loadURL(`${origin}/float.html`);
}

function setupIpc() {
  handle('float:toggle', toggleFloat);

  handle('config:get', () => {
    const { language, model, transcriptsDir, deepgramKey, anthropicKey } = loadConfig();
    return { language, model, transcriptsDir, hasDeepgramKey: !!deepgramKey, hasAnthropicKey: !!anthropicKey };
  });

  handle('config:save', async (cfg) => {
    saveConfig(cfg);
    await server.close();
    await launchServer();
    await win.loadURL(pageUrl());
    if (floatWin && !floatWin.isDestroyed()) floatWin.loadURL(`${origin}/float.html`);
  });

  handle('transcripts:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('transcripts:open', async () => {
    const dir = loadConfig().transcriptsDir;
    await mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
}

async function main() {
  await launchServer();
  setupIpc();

  // Audio del sistema (loopback) sin selector. Si falla, cb({}) hace que getDisplayMedia rechace en vez de colgarse.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const [source] = await desktopCapturer.getSources({ types: ['screen'] });
      cb(source ? { video: source, audio: 'loopback' } : {});
    } catch (err) {
      console.error('No se pudo obtener la pantalla para el audio del sistema', err);
      cb({});
    }
  });

  // Solo el origen local puede pedir captura; el resto se deniega.
  const allowed = new Set(['media', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && isLocal(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    allowed.has(permission) && isLocal(requestingOrigin));

  win = new BrowserWindow({ width: 1100, height: 800, webPreferences: webPreferences() });
  win.on('closed', () => {
    win = null;
    // Sin esto la flotante oculta mantendría la app viva (window-all-closed no se dispararía).
    if (floatWin && !floatWin.isDestroyed()) floatWin.destroy();
  });
  lockNavigation(win);

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleFloat)) {
    console.warn('No se pudo registrar el atajo Ctrl+Shift+Espacio (¿en uso por otra aplicación?)');
  }

  await win.loadURL(pageUrl());
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  await server?.close();
  app.quit();
}

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  shutdown();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', shutdown);
