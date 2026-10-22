// Wrapper CLI del modo web: lee .env y arranca src/server.js (sin token, como siempre).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseKeyterms, startServer } from './src/server.js';

const { DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, DG_LANGUAGE = 'es', LLM_MODEL = 'claude-haiku-5-5', PORT = 3000, DG_KEYTERMS = '' } = process.env;

if (!DEEPGRAM_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Faltan DEEPGRAM_API_KEY o ANTHROPIC_API_KEY en el archivo .env');
  process.exit(1);
}

const { port } = await startServer({
  deepgramKey: DEEPGRAM_API_KEY,
  anthropicKey: ANTHROPIC_API_KEY,
  language: DG_LANGUAGE,
  model: LLM_MODEL,
  keyterms: parseKeyterms(DG_KEYTERMS),
  transcriptsDir: join(fileURLToPath(new URL('.', import.meta.url)), 'transcripciones'),
  port: Number(PORT),
});
console.log(`Listo en http://localhost:${port}`);
