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

// Detección local e instantánea. Las palabras interrogativas españolas exigen tilde ("que" sin tilde es conjunción).
// \b no sirve con letras acentuadas, de ahí los lookarounds.
const FILLER = '(?:(?:y|e|o|oye|bueno|entonces|pues|a ver|ok|okay|vale|so|and|well|but|pero|mira|perdona|disculpa)[,.]?\\s+)*';
const WORD_END = '(?![\\p{L}\\p{N}])';
const INTERROGATIVE = [
  'qué', 'cómo', 'cuál(?:es)?', 'cuándo', 'cuánt[oa]s?', 'dónde', 'quién(?:es)?', 'por\\s?qué', 'para\\s?qué', 'a\\s?quién',
  'what', 'how', 'why', 'when', 'where', 'who', 'whom', 'whose', 'which',
].join('|');
// Verbos de petición o auxiliares al inicio de la frase ("puedes explicar…", "can you…").
const OPENER = [
  'puedes', 'podrías?', 'podrían', 'explica', 'explícame', 'explícanos', 'cuéntame', 'cuéntanos', 'háblanos', 'dime', 'dinos',
  // Preguntas de sí/no que no llevan interrogativa.
  'ser[ií]a\\s+posible', 'es\\s+posible', 'hay\\s+alg[uú]n[oa]?', 'tienen\\s+(?:pensado|previsto)', 'han\\s+(?:considerado|pensado|probado|evaluado)',
  '(?:can|could|would|will|do|does|did|is|are|was|were|should|have|has)\\s+(?:you|we|they|there|it|this|that|your|the|any)',
].join('|');
const INDIRECT = [
  'me gustar[ií]a saber', 'quisiera saber', 'quiero saber', 'quisi[eé]ramos saber', 'nos (?:puedes|podr[ií]as) (?:contar|explicar|decir)',
  'podr[ií]as (?:contarnos|explicarnos|decirnos)', 'h[aá]blanos de', 'cu[eé]ntanos', 'expl[ií]canos',
  'tell me', 'tell us', 'walk (?:me|us) through', "i(?:'|’)?d like to know", 'i would like to know', 'can you (?:tell|explain)', 'could you (?:tell|explain)',
].join('|');

export const QUESTION_RE = new RegExp(
  [
    '[?¿]',
    // "no sé cómo…" o "no recuerdo qué…" son afirmaciones con interrogativa indirecta.
    `^\\s*${FILLER}(?!(?:no\\s+(?:s[eé]|sabemos|recuerdo)|ni\\s+idea|i\\s+don'?t\\s+know)${WORD_END})(?:\\S+\\s+){0,3}(?:${INTERROGATIVE})${WORD_END}`,
    `^\\s*${FILLER}(?:${OPENER})${WORD_END}`,
    // "…, pero cómo escalaría": la interrogativa tras una conjunción vale en cualquier posición.
    `(?:^|[^\\p{L}])(?:pero|y|entonces|pues)\\s+(?:${INTERROGATIVE})${WORD_END}`,
    `(?:^|[^\\p{L}])(?:${INDIRECT})${WORD_END}`,
  ].join('|'),
  'iu',
);

// Clasificador de respaldo (mismo modelo) para preguntas sin "?" ni fórmula conocida.
const CLASSIFIER_SYSTEM =
  'Clasificas fragmentos transcritos de una videollamada. Responde solo SI si el fragmento es una pregunta o una petición (directa o indirecta) que espera respuesta de quien expone; si no, NO.';

export async function classifyQuestion(anthropic, model, previous, text, signal) {
  const res = await anthropic.messages.create(
    {
      model,
      // Los tokens de thinking cuentan para max_tokens: con un tope bajo el modelo podría gastarlo pensando y devolver texto vacío.
      // Este modelo no admite `temperature`.
      max_tokens: 256,
      output_config: { effort: 'low' },
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: `Intervención anterior: ${previous || '(ninguna)'}\nIntervención actual: ${text}` }],
    },
    { signal },
  );
  const out = (res.content.find((b) => b.type === 'text')?.text ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '');
  return /^SI\b/i.test(out);
}

export const SYSTEM = `Eres un asistente que ayuda a una persona a responder en vivo las preguntas que le hacen mientras expone su proyecto.
Recibirás el contexto del proyecto, la conversación reciente y la última pregunta detectada.

Primero identifica qué se pregunta realmente. Usa la conversación reciente para resolver referencias como "eso", "entonces" o "esos números".
Empieza SIEMPRE la respuesta con una primera línea que contenga solo la etiqueta [GENERAL] o [PROYECTO], y después las viñetas.
- [PROYECTO]: la pregunta menciona el proyecto, sistema, modelo, datos o resultados propios ("tu sistema", "lograron", "usaron", "su dataset"…), o es un seguimiento de algo que la conversación reciente ya estaba tratando sobre el proyecto.
- [GENERAL]: la pregunta es sobre un concepto o técnica, sin referencia al proyecto, y la conversación reciente no estaba hablando del proyecto en ese punto. La existencia del contexto del proyecto NO cuenta como señal: siempre está ahí.
- En caso de duda, [GENERAL].

Con [GENERAL]: responde solo con conocimiento general correcto. Prohibido mencionar el proyecto, sus datos o la palabra "nuestro" referida a él.
Con [PROYECTO]: responde con el contexto del proyecto. Cifras y datos del proyecto: usa solo los que aparecen en el contexto, sin calcular, deducir ni completar ninguno. Si falta, dilo con prudencia. No atribuyas al proyecto decisiones, comparaciones ni resultados que no estén en el contexto. Habla en primera persona del plural, como quien expone ("usamos", "logramos"), nunca en tercera persona, aunque la pregunta use tercera persona ("usaron", "lograron" → "usamos", "logramos").

Formato:
- Después de la etiqueta, solo viñetas; ninguna frase antes ni después.
- 2 a 4 viñetas cortas (máximo 18 palabras por viñeta) que la persona pueda decir en voz alta de inmediato.
- La primera viñeta responde directamente el núcleo de la pregunta.
- No te contradigas ni evadas la pregunta remitiendo a otro momento o documento.
- Mismo idioma que la pregunta. Sin introducciones ni cierres.
- La transcripción puede tener errores de reconocimiento; interpreta la intención.`;

// Separa la etiqueta de alcance ([GENERAL] / [PROYECTO]) del principio de la respuesta.
// Retiene el texto solo mientras pueda ser una etiqueta; si no lo es, lo reenvía íntegro y sin scope.
export function createScopeFilter(emit) {
  const LABEL = /^\s*\[(GENERAL|PROYECTO)\]\s*/i;
  let buf = '';
  let done = false;
  const release = () => {
    done = true;
    if (buf) emit({ type: 'answer_delta', text: buf });
    buf = '';
  };
  const resolve = () => {
    const m = LABEL.exec(buf);
    if (!m) return release();
    done = true;
    emit({ type: 'answer_scope', scope: m[1].toLowerCase() });
    const rest = buf.slice(m[0].length);
    buf = '';
    if (rest) emit({ type: 'answer_delta', text: rest });
  };
  return {
    push(t) {
      if (done) return emit({ type: 'answer_delta', text: t });
      buf += t;
      const head = buf.trimStart();
      if (!head) return;
      if (head[0] !== '[') return release();
      if (/\]\s*\S/.test(head) || head.length > 16) resolve(); // etiqueta completa y ya hay texto detrás, o demasiado larga
    },
    end() {
      if (!done) resolve();
    },
  };
}

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
    let classifier = null; // AbortController del clasificador pendiente
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
      const scope = createScopeFilter(send);
      const recent = history.slice(-10).join('\n');
      try {
        const stream = anthropic.messages.stream(
          {
            model,
            // El thinking adaptativo gasta del mismo presupuesto: con 300 la respuesta se cortaba a mitad de frase.
            max_tokens: 1024,
            output_config: { effort: 'low' },
            system: [
              { type: 'text', text: SYSTEM },
              { type: 'text', text: `CONTEXTO DEL PROYECTO:\n${context || '(sin contexto cargado)'}`, cache_control: { type: 'ephemeral' } },
            ],
            messages: [{ role: 'user', content: `Conversación reciente:\n${recent}\n\nPregunta a responder:\n${question}` }],
          },
          { signal: controller.signal },
        );
        stream.on('text', (t) => scope.push(t));
        const final = await stream.finalMessage();
        scope.end();
        if (final.stop_reason === 'max_tokens') {
          console.warn('Respuesta truncada por max_tokens', final.usage?.output_tokens);
          send({ type: 'answer_truncated' });
        } else if (final.stop_reason === 'refusal') {
          send({ type: 'error', text: 'El modelo no quiso responder a esta pregunta' });
          return;
        }
        send({ type: 'answer_end' });
      } catch (err) {
        if (controller.signal.aborted) return;
        send({ type: 'error', text: `LLM: ${err.message}` });
      }
    }

    // Cada intervención se decide por una sola vía (regex o clasificador), así que nunca dispara dos respuestas.
    function flushUtterance() {
      const text = pending.trim();
      pending = '';
      if (!text) return;
      const previous = history.at(-1);
      history.push(text);
      if (history.length > 20) history.shift();
      classifier?.abort(); // una intervención nueva anula el clasificador pendiente
      if (QUESTION_RE.test(text)) return answer(text);
      if (text.split(/\s+/).length < 4) return;
      const controller = (classifier = new AbortController());
      classifyQuestion(anthropic, model, previous, text, controller.signal)
        .then((isQuestion) => {
          if (isQuestion && !controller.signal.aborted) answer(text);
        })
        .catch((err) => {
          if (!controller.signal.aborted) console.error('clasificador de preguntas', err.message);
        });
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
      classifier?.abort();
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
