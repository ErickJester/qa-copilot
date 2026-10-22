import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import Anthropic from '@anthropic-ai/sdk';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Términos clave (nova-3 keyterm prompting): texto separado por comas -> lista limpia, máx. 50.
export const parseKeyterms = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 50);

// PCM crudo con resultados parciales. El endpointing de 400 ms evita cortar las frases a mitad.
export const dgUrl = (language, keyterms = []) => {
  const params = new URLSearchParams({
    model: 'nova-3',
    language,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: '400',
    utterance_end_ms: '1200',
    vad_events: 'true',
    punctuate: 'true',
    smart_format: 'true',
  });
  for (const k of parseKeyterms(keyterms)) params.append('keyterm', k);
  return 'wss://api.deepgram.com/v1/listen?' + params;
};

const QUESTION_RE =
  /\?|^\s*(¿|qu[ée]|c[oó]mo|cu[aá]l(es)?|cu[aá]ndo|cu[aá]nto[sa]?|d[oó]nde|qui[eé]n(es)?|por\s?qu[eé]|para\s?qu[eé]|podr[ií]as?|puedes|explica|expl[ií]came|cu[eé]ntame|what|how|why|when|where|who|which|can you|could you|do you|does|is there|explain)\b/i;

const SYSTEM = `Eres un asistente que ayuda a una persona a responder preguntas en vivo durante la exposición de su proyecto.
Recibirás la última pregunta detectada en la videollamada y, antes, el contexto del proyecto.
Reglas:
- Responde SOLO con 2 a 4 viñetas cortas (máximo ~15 palabras cada una) que la persona pueda decir en voz alta de inmediato.
- Usa el contexto del proyecto; si la respuesta no está ahí, da una respuesta honesta y prudente sin inventar datos.
- Mismo idioma que la pregunta. Sin introducciones ni cierres.
- La transcripción puede tener errores de reconocimiento; interpreta la intención.`;

// Arranca el servidor HTTP/WS. Toda la configuración entra por `opts`; el módulo no lee process.env.
// Sin claves arranca igual (para poder mostrar Ajustes): /ws avisa y cierra, /transcribe responde 400.
// Si se pasa `token`, /ws y /transcribe lo exigen en `?t=`.
// `onMessage` (opcional) recibe cada mensaje que el servidor envía al cliente (answer_*, transcript...).
export async function startServer({
  deepgramKey,
  anthropicKey,
  language = 'es',
  model = 'claude-haiku-5-5',
  keyterms = [],
  transcriptsDir,
  host = '127.0.0.1',
  port = 0,
  token,
  onMessage,
}) {
  const hasKeys = !!(deepgramKey && anthropicKey);
  const NO_KEYS = 'Faltan las claves de API: ábrelas en Ajustes';
  const anthropic = hasKeys ? new Anthropic({ apiKey: anthropicKey }) : null;
  const authorized = (url) => !token || new URL(url, 'http://x').searchParams.get('t') === token;

  // Solo se guarda el texto, nunca el audio.
  async function saveTranscript(name, text) {
    const base = (name || 'audio').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'audio';
    const file = `${base}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
    try {
      await mkdir(transcriptsDir, { recursive: true });
      await writeFile(join(transcriptsDir, file), text, 'utf8');
      return file;
    } catch (err) {
      console.error('No se pudo guardar la transcripción', err);
      return null;
    }
  }

  // Transcripción de archivos: el audio se reenvía a Deepgram en streaming (sin cargarlo en memoria),
  // así un .m4a de 2 horas no satura el servidor.
  async function transcribeFile(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const params = new URLSearchParams({
      model: 'nova-3',
      language: q.get('lang') || language,
      smart_format: 'true',
      paragraphs: 'true',
      punctuate: 'true',
    });
    if (q.get('diarize') === '1') params.set('diarize', 'true');
    // Si Deepgram responde antes de terminar la subida, hay que vaciar el resto del cuerpo
    // o el navegador ve la conexión cortada ("Error de red") en vez del mensaje real.
    const reply = (code, obj) => {
      req.resume();
      res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(obj));
    };
    console.log(`/transcribe ${req.headers['content-type']} ${req.headers['content-length'] ?? '?'} bytes`);
    try {
      const dgRes = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: 'POST',
        headers: { Authorization: `Token ${deepgramKey}`, 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
        body: req,
        duplex: 'half',
      });
      const data = await dgRes.json();
      if (!dgRes.ok) console.error('Deepgram', dgRes.status, JSON.stringify(data));
      if (!dgRes.ok) return reply(dgRes.status, { error: data.err_msg || data.message || 'Error de Deepgram' });
      const alt = data.results?.channels?.[0]?.alternatives?.[0];
      const text = alt?.paragraphs?.transcript?.trim() || alt?.transcript || '';
      const saved = text ? await saveTranscript(q.get('name'), text) : null;
      reply(200, { text, duration: data.metadata?.duration, saved });
    } catch (err) {
      console.error('transcribe', err);
      reply(500, { error: err.cause?.message || err.message });
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/transcribe')) {
      if (!authorized(req.url)) {
        req.resume();
        return res.writeHead(403, { Connection: 'close' }).end();
      }
      if (!hasKeys) {
        req.resume();
        return res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ error: NO_KEYS }));
      }
      return transcribeFile(req, res);
    }
    const pathname = req.url.split('?')[0];
    const path = pathname === '/' ? '/index.html' : pathname;
    const file = normalize(join(publicDir, path));
    if (!file.startsWith(publicDir)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  server.requestTimeout = 0; // subidas largas
  server.headersTimeout = 0;

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }) => authorized(req.url),
  });

  // ws reenvía los errores del servidor HTTP (p. ej. EADDRINUSE en listen) al wss: sin este listener
  // saldrían como excepción no capturada. Quien llama ya los recibe por el reject de startServer.
  wss.on('error', () => {});

  wss.on('connection', (client) => {
    if (!hasKeys) {
      client.send(JSON.stringify({ type: 'error', text: NO_KEYS }));
      client.close();
      return;
    }
    let context = '';
    const history = []; // últimas intervenciones transcritas
    let pending = ''; // segmentos finales de la intervención en curso
    let abort = null;
    let dgReady = false;
    const queue = [];

    const send = (obj) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
      onMessage?.(obj);
    };

    const dg = new WebSocket(dgUrl(language, keyterms), { headers: { Authorization: `Token ${deepgramKey}` } });
    dg.on('open', () => {
      dgReady = true;
      for (const chunk of queue.splice(0)) dg.send(chunk);
      send({ type: 'status', text: 'Deepgram conectado' });
    });
    const keepAlive = setInterval(() => dgReady && dg.send(JSON.stringify({ type: 'KeepAlive' })), 5000);

    async function answer(question) {
      abort?.abort();
      const controller = (abort = new AbortController());
      send({ type: 'answer_start', question });
      const recent = history.slice(-6).join('\n');
      try {
        const stream = anthropic.messages.stream(
          {
            model,
            max_tokens: 300,
            system: [
              { type: 'text', text: SYSTEM },
              { type: 'text', text: `CONTEXTO DEL PROYECTO:\n${context || '(sin contexto cargado)'}`, cache_control: { type: 'ephemeral' } },
            ],
            messages: [{ role: 'user', content: `Conversación reciente:\n${recent}\n\nPregunta a responder:\n${question}` }],
          },
          { signal: controller.signal },
        );
        stream.on('text', (t) => send({ type: 'answer_delta', text: t }));
        await stream.finalMessage();
        send({ type: 'answer_end' });
      } catch (err) {
        if (controller.signal.aborted) return;
        send({ type: 'error', text: `LLM: ${err.message}` });
      }
    }

    function flushUtterance() {
      const text = pending.trim();
      pending = '';
      if (!text) return;
      history.push(text);
      if (history.length > 20) history.shift();
      if (QUESTION_RE.test(text)) answer(text);
    }

    dg.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
        if (!text) return;
        send({ type: 'transcript', text, final: msg.is_final });
        if (msg.is_final) {
          pending += ' ' + text;
          if (msg.speech_final) flushUtterance();
        }
      } else if (msg.type === 'UtteranceEnd') {
        flushUtterance();
      }
    });
    dg.on('error', (e) => send({ type: 'error', text: `Deepgram: ${e.message}` }));
    dg.on('close', (code, reason) => send({ type: 'status', text: `Deepgram cerrado (${code} ${reason})` }));

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        if (dgReady) dg.send(data);
        else queue.push(data);
        return;
      }
      const msg = JSON.parse(data);
      if (msg.type === 'context') context = msg.text;
      else if (msg.type === 'ask') {
        history.push(msg.text);
        answer(msg.text);
      }
    });

    client.on('close', () => {
      clearInterval(keepAlive);
      abort?.abort();
      if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: 'CloseStream' }));
      dg.close();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    port: server.address().port,
    close() {
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
