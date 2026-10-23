import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = () => join(app.getPath('userData'), 'config.json');

const defaults = () => ({
  language: 'es',
  model: 'claude-haiku-5-5',
  keyterms: '',
  transcriptsDir: join(app.getPath('documents'), 'Copiloto QA', 'transcripciones'),
});

const readJson = () => {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
};

// En desarrollo, .env aporta los valores iniciales que falten en config.json (no se escribe nada).
function readDevEnv() {
  const envFile = join(root, '.env');
  if (app.isPackaged || !existsSync(envFile)) return {};
  try { return parseEnv(readFileSync(envFile, 'utf8')); } catch { return {}; }
}

const decrypt = (b64) => {
  if (!b64 || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return ''; }
};

// Devuelve la config con las claves en claro: solo para uso interno del proceso principal.
export function loadConfig() {
  const saved = readJson();
  const env = readDevEnv();
  const d = defaults();
  return {
    language: saved.language || env.DG_LANGUAGE || d.language,
    model: saved.model || env.LLM_MODEL || d.model,
    keyterms: saved.keyterms ?? env.DG_KEYTERMS ?? d.keyterms,
    transcriptsDir: saved.transcriptsDir || d.transcriptsDir,
    deepgramKey: decrypt(saved.deepgramKey) || env.DEEPGRAM_API_KEY || '',
    anthropicKey: decrypt(saved.anthropicKey) || env.ANTHROPIC_API_KEY || '',
  };
}

// Una clave vacía o ausente significa "no cambiar".
export function saveConfig(partial = {}) {
  const saved = readJson();
  for (const k of ['deepgramKey', 'anthropicKey']) {
    const v = typeof partial[k] === 'string' ? partial[k].trim() : '';
    if (!v) continue;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('No hay cifrado seguro disponible en este sistema: no se pueden guardar las claves.');
    }
    saved[k] = safeStorage.encryptString(v).toString('base64');
  }
  if (['es', 'en', 'multi'].includes(partial.language)) saved.language = partial.language;
  if (typeof partial.model === 'string' && partial.model.trim()) saved.model = partial.model.trim();
  if (typeof partial.keyterms === 'string') saved.keyterms = partial.keyterms.trim(); // vacío = sin términos
  if (typeof partial.transcriptsDir === 'string' && partial.transcriptsDir.trim()) saved.transcriptsDir = partial.transcriptsDir.trim();
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(saved, null, 2), 'utf8');
}
