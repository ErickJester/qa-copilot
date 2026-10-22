import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';

// Puerto fijo: el origen (y con él el localStorage con el contexto y los documentos) depende del puerto.
const DEFAULT_PORT = 47821;

const root = fileURLToPath(new URL('..', import.meta.url));

let win = null;
let server = null;
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

async function main() {
  // Provisional hasta la Fase 4, que sustituye .env por Ajustes.
  try {
    const envFile = join(root, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  } catch (err) {
    console.warn('No se pudo leer .env', err);
  }
  const { DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, DG_LANGUAGE = 'es', LLM_MODEL = 'claude-haiku-5-5' } = process.env;
  if (!DEEPGRAM_API_KEY || !ANTHROPIC_API_KEY) {
    dialog.showErrorBox('Copiloto QA', 'Faltan DEEPGRAM_API_KEY o ANTHROPIC_API_KEY en el archivo .env.');
    app.exit(1);
    return;
  }

  const token = randomUUID();
  server = await listen({
    deepgramKey: DEEPGRAM_API_KEY,
    anthropicKey: ANTHROPIC_API_KEY,
    language: DG_LANGUAGE,
    model: LLM_MODEL,
    transcriptsDir: join(app.getPath('documents'), 'Copiloto QA', 'transcripciones'),
    token,
  });
  const origin = `http://127.0.0.1:${server.port}`;

  win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(root, 'electron', 'preload.cjs'),
    },
  });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) e.preventDefault();
  });

  await win.loadURL(`${origin}/?t=${encodeURIComponent(token)}`);
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
app.on('window-all-closed', shutdown);
