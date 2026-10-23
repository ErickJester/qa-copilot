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

// thinking desactivado cuando el modelo lo admite: ahorra segundos de espera. Los modelos que lo rechazan
// (400 por el parámetro thinking) se recuerdan mientras viva el proceso y se reintenta sin él una vez.
const noThinking = new Map(); // modelo -> false si rechazó `thinking: disabled`
export async function withNoThinking(model, run) {
  if (noThinking.get(model) === false) return run({});
  try {
    return await run({ thinking: { type: 'disabled' } });
  } catch (err) {
    if (err.status !== 400 || !/thinking/i.test(err.message)) throw err;
    noThinking.set(model, false);
    return run({});
  }
}

// Clasificador de respaldo (mismo modelo) para preguntas sin "?" ni fórmula conocida.
const CLASSIFIER_SYSTEM =
  'Clasificas fragmentos transcritos de una videollamada. Responde solo SI si el fragmento es una pregunta o una petición (directa o indirecta) que espera respuesta de quien expone; si no, NO.';

export async function classifyQuestion(anthropic, model, previous, text, signal) {
  const res = await withNoThinking(model, (extra) =>
    anthropic.messages.create(
      {
        model,
        // Si el modelo no admite desactivar el thinking, sus tokens cuentan para max_tokens: de ahí el margen.
        // Este modelo no admite `temperature`.
        max_tokens: 256,
        output_config: { effort: 'low' },
        ...extra,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: `Intervención anterior: ${previous || '(ninguna)'}\nIntervención actual: ${text}` }],
      },
      { signal },
    ),
  );
  const out = (res.content.find((b) => b.type === 'text')?.text ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '');
  return /^SI\b/i.test(out);
}

// Paso previo y rápido: ¿la pregunta es general o sobre el proyecto? Ante duda o error, 'general'.
const SCOPE_SYSTEM = `Decides si la última pregunta de una videollamada trata sobre el proyecto de quien expone o es una pregunta general.
Recibirás el contexto del proyecto, la conversación reciente y la pregunta.
- PROYECTO: la pregunta menciona el proyecto, sistema, modelo, datos o resultados propios ("tu sistema", "lograron", "usaron", "su dataset"…), va dirigida a quien expone ("ustedes", "hicieron", "por qué eligieron…"), o es un seguimiento de algo que la conversación reciente ya estaba tratando sobre el proyecto.
- GENERAL: la pregunta es sobre un concepto o técnica, sin referencia al proyecto, y la conversación reciente no estaba hablando del proyecto en ese punto. La existencia del contexto del proyecto NO cuenta como señal: siempre está ahí.
- En caso de duda, GENERAL.
Responde con una sola palabra: GENERAL o PROYECTO.`;

export async function classifyScope(anthropic, model, context, recent, question, signal) {
  const res = await withNoThinking(model, (extra) =>
    anthropic.messages.create(
      {
        model,
        max_tokens: extra.thinking ? 16 : 256, // sin la opción de desactivar el thinking, sus tokens cuentan
        output_config: { effort: 'low' },
        ...extra,
        system: [
          { type: 'text', text: SCOPE_SYSTEM },
          { type: 'text', text: `CONTEXTO DEL PROYECTO:\n${context || '(sin contexto cargado)'}`, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: `Conversación reciente:\n${recent}\n\nPregunta:\n${question}` }],
      },
      { signal },
    ),
  );
  const out = res.content.find((b) => b.type === 'text')?.text ?? '';
  return /^\s*PROYECTO/i.test(out) ? 'proyecto' : 'general';
}

const FORMAT = `Formato: un único párrafo de 3 a 5 frases, entre 50 y 80 palabras, en lenguaje hablado natural para decirlo en voz alta tal cual. La primera frase responde directamente el núcleo de la pregunta; las siguientes la explican o la justifican. Sin viñetas, guiones, listas, saltos de línea, negritas ni markdown. Sin introducciones ("Buena pregunta…") ni cierres ("¿Te quedó claro?"). Mismo idioma que la pregunta. La transcripción puede tener errores de reconocimiento; interpreta la intención.`;

// Pregunta general: no recibe el contexto del proyecto, así que no puede mencionarlo.
export const SYSTEM_GENERAL = `Eres un asistente que ayuda a una persona a responder en vivo una pregunta general o conceptual que le hacen mientras expone. Usa la conversación reciente solo para resolver referencias como "eso" o "entonces".
Explica el concepto con conocimiento general correcto. No hables de ningún proyecto, sistema ni datos propios, y no uses la palabra "nuestro". Aunque la conversación reciente mencione cifras, resultados o datos del proyecto, no los repitas ni los uses como ejemplo.

${FORMAT}`;

export const SYSTEM_PROYECTO = `Eres un asistente que ayuda a una persona a responder en vivo las preguntas que le hacen mientras expone su proyecto.
Recibirás el contexto del proyecto, la conversación reciente y la última pregunta detectada. Usa la conversación reciente para resolver referencias como "eso", "entonces" o "esos números".
Responde con el contexto del proyecto. Quien expone es el programador del sistema: nunca digas que no tienes información, que no lo sabes, que no lo puedes afirmar ni que algo no está documentado o en el contexto.
Si un detalle no aparece en el contexto, responde como lo haría su desarrollador: deduce con lógica técnica a partir de cómo está construido el sistema según el contexto y de cómo funcionan normalmente los sistemas así. Usa un tono seguro, sin dudar, y cierra con lo que recomiendas al usuario si viene al caso.
Afirma el comportamiento como quien lo construyó, sin muletillas de duda ("lo más probable", "probablemente", "creo que", "puede que"). No empieces reconociendo lo que no se sabe ("no tenemos una cifra exacta", "no lo tenemos documentado", "depende de cómo esté configurado") ni remitas a revisar la configuración, la documentación, las políticas o a ningún equipo: responde directamente con el comportamiento que tiene este sistema. No menciones pruebas, documentación, políticas ni equipos que no estén en el contexto.
No empieces ninguna frase con "no tenemos…" ni remitas a confirmar con ningún equipo, ni siquiera el de desarrollo.
No inventes cifras, resultados, nombres de tecnologías ni pruebas concretas que no estén en el contexto: deducir el comportamiento es válido; fabricar datos, no. No atribuyas al proyecto comparaciones ni resultados que no estén en el contexto.
Habla en primera persona del plural, como quien expone ("usamos", "logramos"), nunca en tercera persona, aunque la pregunta use tercera persona ("usaron", "lograron" → "usamos", "logramos").

${FORMAT}`;

// Garantiza el párrafo único aunque el modelo se salte la regla: saltos de línea -> espacio y sin marcadores de lista
// al inicio de línea. Trabaja sobre deltas en streaming: retiene el comienzo de línea mientras pueda ser un marcador.
export function createParagraphFilter(emit) {
  const MARKER = /^\s*(?:[-*•]|\d{1,2}[.)])\s/;
  const MAYBE_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)]?)?$/;
  let head = '';
  let atLineStart = true;
  let spaced = true; // nada emitido aún, o el último carácter fue un espacio
  const run = (text, final) => {
    let out = '';
    const put = (s) => {
      if (!s) return;
      out += s;
      spaced = /\s$/.test(s);
    };
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') {
        put(head);
        head = '';
        if (!spaced) put(' ');
        atLineStart = true;
      } else if (!atLineStart) {
        put(ch);
      } else {
        head += ch;
        if (MARKER.test(head)) {
          head = '';
          atLineStart = false;
        } else if (!MAYBE_MARKER.test(head)) {
          put(head);
          head = '';
          atLineStart = false;
        }
      }
    }
    if (final) {
      put(head);
      head = '';
    }
    if (out) emit(out);
  };
  return { push: (t) => run(t, false), end: () => run('', true) };
}

// Una respuesta completa: primero el alcance (general / proyecto), después el párrafo en streaming.
// `send` recibe answer_scope y answer_delta; el llamador decide el resto. Devuelve el mensaje final.
export async function generateAnswer({ anthropic, model, context, recent, question, send, signal }) {
  let scope = 'general';
  try {
    scope = await classifyScope(anthropic, model, context, recent, question, signal);
  } catch (err) {
    if (signal?.aborted) return null;
    console.error('alcance de la pregunta', err.message);
  }
  if (signal?.aborted) return null;
  send({ type: 'answer_scope', scope });
  const system =
    scope === 'proyecto'
      ? [
          { type: 'text', text: SYSTEM_PROYECTO },
          { type: 'text', text: `CONTEXTO DEL PROYECTO:\n${context || '(sin contexto cargado)'}`, cache_control: { type: 'ephemeral' } },
        ]
      : SYSTEM_GENERAL;
  const filter = createParagraphFilter((text) => send({ type: 'answer_delta', text }));
  const final = await withNoThinking(model, (extra) => {
    const stream = anthropic.messages.stream(
      {
        model,
        // Si el modelo no admite desactivar el thinking, sus tokens cuentan para max_tokens.
        max_tokens: 4096,
        output_config: { effort: 'low' },
        ...extra,
        system,
        messages: [
          {
            role: 'user',
            content: `Conversación reciente:\n${recent}\n\nPregunta a responder:\n${question}\n\nRecuerda: un solo párrafo hablado de 50 a 80 palabras, sin viñetas ni saltos de línea.`,
          },
        ],
      },
      { signal },
    );
    stream.on('text', (t) => filter.push(t));
    return stream.finalMessage();
  });
  filter.end();
  return final;
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
      try {
        const final = await generateAnswer({
          anthropic,
          model,
          context,
          recent: history.slice(-10).join('\n'),
          question,
          send,
          signal: controller.signal,
        });
        if (!final || controller.signal.aborted) return;
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
