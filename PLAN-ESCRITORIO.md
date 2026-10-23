# Plan: Copiloto Q&A como app de escritorio

## Qué es el proyecto hoy

Web local (`npm start` → `http://localhost:3000`):

- **`server.js`** (Node, ESM): sirve `public/`, un WebSocket `/ws` y un `POST /transcribe`.
  - `/ws`: recibe audio PCM 16 kHz del navegador y lo reenvía en streaming a Deepgram (nova-3). Con las transcripciones finales detecta preguntas (`QUESTION_RE`) y llama a Claude (`LLM_MODEL`, streaming), que responde con 2 a 4 viñetas usando el "contexto del proyecto" que manda el cliente.
  - `/transcribe`: manda un archivo de audio en streaming a Deepgram (pre-recorded) y guarda el texto en `transcripciones/`.
- **`public/index.html`**: captura el audio de una pestaña con `getDisplayMedia` (y el micrófono si se marca la casilla), lo pasa por `worklet.js` y lo envía por WS. Muestra la transcripción en vivo y la respuesta sugerida. Tiene contexto (textarea y archivos .md/.txt en localStorage), pregunta manual y transcripción de archivos.
- Las claves vienen de `.env`: `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `DG_LANGUAGE`, `LLM_MODEL` y `PORT`.

## Decisiones

| Tema | Decisión | Motivo |
|---|---|---|
| Framework | **Electron** (última estable) + **electron-builder** | El backend ya es Node y la UI ya es web, así que casi todo se reutiliza tal cual. Tauri obligaría a reescribir el servidor en Rust o a llevar Node como sidecar. |
| Arquitectura | El proceso main de Electron arranca el servidor HTTP/WS actual en `127.0.0.1` con puerto libre (0), y la ventana carga esa URL | El cambio en `server.js` e `index.html` es mínimo y el modo web sigue funcionando |
| Audio | **Audio del sistema (loopback)** con `session.setDisplayMediaRequestHandler` → `{ video: screenSource, audio: 'loopback' }` | En escritorio captura cualquier app (Zoom, Meet, Teams nativo), no solo una pestaña de Chrome, y sin selector |
| Siempre encima | La ventana principal alterna `alwaysOnTop` (nivel `'screen-saver'`) en lugar de Document PiP o una ventana aparte | Document PiP no es fiable en Electron. Así además queda encima de apps nativas y no hay que duplicar la UI |
| Claves API | Pantalla de **Ajustes** dentro de la app, cifradas con `safeStorage` en `app.getPath('userData')/config.json` | El `.env` no viaja en un instalador |
| Transcripciones | `Documentos/Copiloto QA/transcripciones` (configurable) + botón "Abrir carpeta" | `transcripciones/` relativo al código no existe en una app instalada |
| Plataforma | **Windows x64** (instalador NSIS) como objetivo principal; no usar nada que impida macOS más adelante | El usuario está en Windows 11 |

## Estructura objetivo

```
deepgram/
  package.json          # main: "electron/main.js", scripts nuevos
  server.js             # wrapper CLI: lee .env y llama a startServer() → `npm start` sigue igual
  src/server.js         # lógica actual refactorizada: export async function startServer(opts)
  electron/
    main.js             # ciclo de vida, ventanas, captura de audio, config, IPC
    preload.cjs         # contextBridge → window.desktop
    config.js           # leer/guardar config con safeStorage
  public/
    index.html          # UI principal (adaptada)
    settings.html       # (o un <dialog> dentro de index.html) Ajustes
    worklet.js
  build/icon.ico
```

## Fases (en orden; cada una debe quedar funcionando antes de pasar a la siguiente)

### Fase 0: preparación
- `git init` + commit inicial del estado actual (respetar `.gitignore`: nada de `.env` ni `transcripciones`). Así hay punto de retorno.
- `npm i -D electron electron-builder`.

### Fase 1: refactor del servidor a módulo (sin cambiar comportamiento)
- Mover la lógica de `server.js` a `src/server.js` como `export async function startServer({ deepgramKey, anthropicKey, language, model, transcriptsDir, host = '127.0.0.1', port = 0, token })`. Debe devolver `{ port, close() }`.
- Nada de `process.env` ni `process.exit` dentro del módulo: todo entra por `opts`.
- **Token de seguridad**: si se pasa `token`, exigirlo en `/ws?t=…` y en `/transcribe?t=…` (si no coincide, 403 o cerrar el socket). Hoy cualquier web abierta en el navegador podría conectarse a `localhost` y gastar los créditos de las API.
- `server.js` queda como wrapper: lee `process.env` igual que ahora y llama a `startServer` (sin token). `npm start` debe seguir funcionando idéntico. **Probar el modo web antes de seguir.**

### Fase 2: shell de Electron
- `electron/main.js` (ESM, porque el package es `"type": "module"`):
  - `app.requestSingleInstanceLock()`.
  - Cargar config (fase 4). Si faltan claves, abrir Ajustes primero.
  - Llamar a `startServer({... , token: crypto.randomUUID()})` y crear `BrowserWindow` (≈1100×800) que cargue `http://127.0.0.1:${port}/?t=${token}`.
  - `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `preload: preload.cjs`.
  - Enlaces externos con `shell.openExternal` (`setWindowOpenHandler`). Bloquear la navegación fuera del origen local.
  - Al cerrar: `server.close()`.
- En `index.html`: leer `t` de `location.search` y añadirlo a la URL del WS (`ws://${location.host}/ws?t=…`) y a la de `/transcribe`.
- Scripts: `"dev": "electron ."`; `start` se queda en modo web.

### Fase 3: captura de audio del sistema
- En main: `session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => { const [screen] = await desktopCapturer.getSources({ types: ['screen'] }); cb({ video: screen, audio: 'loopback' }); })`.
- `setPermissionRequestHandler` / `setPermissionCheckHandler`: permitir `media` solo para el origen local.
- En `index.html`, si `window.desktop` existe:
  - El botón dice **"Escuchar audio del sistema"**.
  - El resto del flujo (`getDisplayMedia` → parar pistas de vídeo → worklet) se queda igual.
  - Cambiar el mensaje de error "Compartir audio de la pestaña" por uno adecuado.
- Ojo con el **eco**: el loopback incluye todo lo que suena en el PC. Si el usuario marca "Incluir mi micrófono" y usa altavoces, su voz entra dos veces. Poner una nota junto a la casilla: "usa auriculares".
- Comprobar que, al detener, se liberan las pistas y el `AudioContext` (hoy `stop()` solo se llama desde `onended`; el botón Pausar no detiene). Añadir un botón **Detener** visible.

### Fase 4: Ajustes y configuración
- `electron/config.js`: `loadConfig()` / `saveConfig()` en `userData/config.json`. Las claves se guardan cifradas con `safeStorage.encryptString` (en base64) y el resto en claro: `language` (es/en/multi), `model` (por defecto `claude-haiku-5-5`) y `transcriptsDir`.
- En desarrollo, si existe `.env`, usarlo como valores iniciales (cómodo para probar).
- `preload.cjs` expone `window.desktop = { getConfig(), saveConfig(cfg), openTranscripts(), onTop: { toggle(), get(), onChange(cb) } }`. `getConfig` **no** devuelve las claves en claro, solo si están puestas (`hasDeepgramKey`, `hasAnthropicKey`).
- UI de Ajustes (botón ⚙ en el header): campos de clave tipo password ("dejar vacío = no cambiar"), idioma, modelo, carpeta de transcripciones (con `dialog.showOpenDialog`) y botón Guardar.
- Al guardar: reiniciar el servidor con la nueva config y recargar la ventana (o reconectar el WS).
- Botón **"Abrir carpeta"** junto al estado de "guardado en …" de transcripción de archivos (`shell.openPath`).

### Fase 5: ventana siempre encima
- En escritorio, el botón "Siempre encima" → `window.desktop.onTop.toggle()` → main alterna `win.setAlwaysOnTop(on, 'screen-saver')` (nivel que queda sobre apps a pantalla completa) y `setVisibleOnAllWorkspaces(on)`, y avisa a la página con `ontop:changed` para que el botón siga el estado real. El estado no se guarda: la app arranca siempre normal. En web el botón queda oculto.
- Atajo global `Ctrl+Shift+Espacio` (`globalShortcut`) con el mismo efecto.

### Fase 6: empaquetado
- `electron-builder` en `package.json` → `build`: `appId: "com.copiloto.qa"`, `productName: "Copiloto QA"`, `files: ["electron/**", "src/**", "public/**", "package.json"]` (excluir `.env`, `transcripciones`, `PLAN-*.md`), `win.target: nsis`, `nsis.oneClick: false`, icono `build/icon.ico`.
- Script `"dist": "electron-builder --win"`.
- Verificar que el `.exe` instalado arranca **sin `.env`**, pide las claves, captura audio y responde.

## Criterios de aceptación (probar a mano al final)
1. `npm start` (modo web) sigue funcionando como antes.
2. `npm run dev`: el primer arranque sin claves abre Ajustes; tras guardarlas, el estado pasa a "Deepgram conectado" al empezar.
3. Suena un vídeo de YouTube o una llamada de Zoom → aparece la transcripción en vivo → una pregunta genera viñetas en menos de ~2 s.
4. "Incluir mi micrófono" funciona a la vez que el audio del sistema.
5. La ventana flotante se queda encima de otra app a pantalla completa y recibe la respuesta en streaming.
6. Transcribir un .m4a largo funciona y lo guarda en la carpeta configurada; "Abrir carpeta" la abre.
7. El contexto y los documentos persisten entre reinicios de la app.
8. Una conexión WS a `127.0.0.1:<puerto>/ws` sin token es rechazada.
9. El instalador de `npm run dist` funciona en una cuenta o carpeta sin el código fuente.

## Fuera de alcance (no hacer sin consultar)
- Cambiar de proveedor de STT o LLM, cambiar los prompts o la detección de preguntas.
- Auto-update, firma de código, macOS/Linux.
- Rediseño visual de la UI (solo los ajustes mínimos para lo nuevo).
