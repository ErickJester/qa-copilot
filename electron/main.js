import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, session, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseKeyterms, startServer } from '../src/server.js';
import { loadConfig, saveConfig } from './config.js';

// Puerto fijo: el origen (y con él el localStorage con el contexto y los documentos) depende del puerto.
const DEFAULT_PORT = 47821;

const root = fileURLToPath(new URL('..', import.meta.url));

let win = null;
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
    keyterms: parseKeyterms(cfg.keyterms),
    transcriptsDir: cfg.transcriptsDir,
    token,
  });
  origin = `http://127.0.0.1:${server.port}`;
}

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

// Siempre encima: la propia ventana principal pasa a quedar sobre el resto (nivel 'screen-saver' para
// superar apps a pantalla completa). No se guarda: la app arranca siempre normal.
function toggleOnTop() {
  if (!win || win.isDestroyed()) return false;
  const on = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(on, 'screen-saver');
  win.setVisibleOnAllWorkspaces(on);
  win.webContents.send('ontop:changed', on);
  return on;
}

function setupIpc() {
  handle('ontop:toggle', toggleOnTop);
  handle('ontop:get', () => !!win && !win.isDestroyed() && win.isAlwaysOnTop());

  handle('config:get', () => {
    const { language, model, keyterms, transcriptsDir, deepgramKey, anthropicKey } = loadConfig();
    return { language, model, keyterms, transcriptsDir, hasDeepgramKey: !!deepgramKey, hasAnthropicKey: !!anthropicKey };
  });

  handle('config:save', async (cfg) => {
    saveConfig(cfg);
    await server.close();
    await launchServer();
    await win.loadURL(pageUrl());
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
  win.on('closed', () => { win = null; });
  lockNavigation(win);

  if (!globalShortcut.register('CommandOrControl+Shift+Space', toggleOnTop)) {
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
