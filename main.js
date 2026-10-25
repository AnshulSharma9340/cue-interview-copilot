const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, dialog, screen, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const store = require('./src/store');
const ai = require('./src/ai');
const prompts = require('./src/prompts');
const docs = require('./src/docs');
const sttLocal = require('./src/stt-local');
const claudeDirect = require('./src/claude-direct');
const meetings = require('./src/meetings');
const { LANGUAGES } = require('./src/languages');

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); } });

let mainWin = null;
let overlay = null;
const inflight = new Map(); // requestId -> AbortController

const preload = path.join(__dirname, 'preload.js');
const icon = path.join(__dirname, 'assets', 'icon.png');

function createMain() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Cue',
    icon,
    backgroundColor: '#f6f8f6',
    autoHideMenuBar: true,
    webPreferences: { preload },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; if (!overlay) app.quit(); });
}

// App pages never navigate: any link (including ones inside AI answers) opens in the system browser,
// so remote pages can never load inside a window that has the preload API.
function lockNavigation(contents) {
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  contents.on('will-navigate', (e, url) => { e.preventDefault(); external(url); });
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
}

let overlaySessionId = null;

function openOverlay(sessionId) {
  if (overlay) {
    overlay.show();
    overlay.focus();
    return overlaySessionId === sessionId ? { ok: true } : { ok: false, error: 'Another session is already live. End it before starting a new one.' };
  }
  overlaySessionId = sessionId;
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 760;
  const height = 560;
  overlay = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - 24,
    y: wa.y + 24,
    minWidth: 520,
    minHeight: 300,
    frame: false,
    alwaysOnTop: true,
    icon,
    backgroundColor: '#101614',
    title: 'Cue – Live session',
    webPreferences: { preload },
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'), { query: { id: sessionId } });
  registerHotkeys();
  overlay.on('closed', () => {
    overlay = null;
    overlaySessionId = null;
    globalShortcut.unregisterAll();
    if (mainWin) { mainWin.show(); mainWin.webContents.send('sessions:changed'); } else app.quit();
  });
  mainWin?.minimize();
  return { ok: true };
}

function registerHotkeys() {
  const send = (action) => overlay?.webContents.send('hotkey', action);
  globalShortcut.register('CommandOrControl+Shift+A', () => send('answer'));
  globalShortcut.register('CommandOrControl+Shift+S', () => send('screenshot'));
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!overlay) return;
    if (overlay.isVisible()) overlay.hide(); else overlay.showInactive();
  });
}

// getDisplayMedia() in the renderer gets the primary screen plus system ("loopback") audio, without a picker.
function setupDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });
}

async function captureScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = overlay?.isVisible();
  const prevOpacity = overlay?.getOpacity() ?? 1;
  overlay?.setOpacity(0);
  await new Promise((r) => setTimeout(r, 180));
  try {
    const { width, height } = display.size;
    const sf = display.scaleFactor;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) } });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    let img = src.thumbnail;
    // Vision models downscale past ~1568 px anyway; sending less makes the upload and the answer faster.
    if (img.getSize().width > 1568) img = img.resize({ width: 1568, quality: 'best' });
    return 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64');
  } finally {
    overlay?.setOpacity(prevOpacity);
    if (wasVisible === false) overlay?.hide();
  }
}

// Groq's free Whisper tier allows 20 requests/minute; keep under it.
const sttTimes = [];
async function sttSlot(cfg) {
  if (!/groq\.com/.test(cfg.baseUrl)) return;
  for (;;) {
    const now = Date.now();
    while (sttTimes.length && now - sttTimes[0] > 60000) sttTimes.shift();
    if (sttTimes.length < 19) { sttTimes.push(now); return; }
    await new Promise((r) => setTimeout(r, 60000 - (now - sttTimes[0]) + 50));
  }
}

async function streamTo(sender, requestId, cfg, messages, opts) {
  const ctrl = new AbortController();
  inflight.set(requestId, ctrl);
  try {
    const text = await ai.chatStream(cfg, messages, (delta) => {
      if (!sender.isDestroyed()) sender.send('ai:delta', { requestId, delta });
    }, ctrl.signal, opts);
    return { ok: true, text };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, aborted: true };
    return { ok: false, error: e.message };
  } finally {
    inflight.delete(requestId);
  }
}

// Starts the local claude-bridge in the background when a slot uses it and it isn't already up.
// Detached, so it keeps serving other local apps (e.g. HRMS) after Cue closes.
async function ensureBridge() {
  const s = store.getSettings();
  const slot = ['chat', 'vision'].map((k) => s[k]).find((c) => c.preset === 'bridge');
  if (!slot || !s.bridge.autoStart) return;
  try {
    const r = await fetch(slot.baseUrl.replace(/\/v1\/?$/, '') + '/healthz', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return;
  } catch {}
  const { serverPath, envFile } = s.bridge;
  if (!fs.existsSync(serverPath) || !fs.existsSync(envFile)) return;
  spawn('node', [`--env-file=${envFile}`, serverPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Pre-starts what live sessions need so the first answer is fast: Claude processes and the local Whisper server.
function warmEngines(extraModel) {
  const s = store.getSettings();
  for (const slot of ['chat', 'vision']) if (s[slot].preset === 'claude') claudeDirect.warm(s[slot].model);
  if (extraModel && s.chat.preset === 'claude') claudeDirect.warm(extraModel);
  if (s.stt.preset === 'local') sttLocal.start(s.stt.model).catch(() => {});
  else sttLocal.stop();
}

function startMeetingWatch() {
  if (!store.getSettings().meetingDetect) return meetings.stop();
  meetings.start((m) => {
    if (overlay) return; // already in a session
    mainWin?.webContents.send('meeting:detected', m);
    if (Notification.isSupported()) {
      const n = new Notification({ title: `${m.app} meeting detected`, body: 'Click to start a Cue session for this call.', icon });
      n.on('click', () => { if (mainWin) { mainWin.restore(); mainWin.show(); mainWin.focus(); mainWin.webContents.send('meeting:start', m); } });
      n.show();
    }
  });
}

// Renders Markdown to a PDF through a hidden window.
async function markdownToPdf(markdown, title, file) {
  const { marked } = require('marked');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>
    body{font-family:'Segoe UI',system-ui,sans-serif;font-size:12.5px;line-height:1.55;color:#18201c;margin:36px 44px}
    h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;border-bottom:1px solid #e3e8e4;padding-bottom:3px;margin-top:20px}
    pre{background:#f3f6f4;padding:10px;border-radius:6px;white-space:pre-wrap}code{font-family:Consolas,monospace}
    ul{padding-left:20px}</style></head><body>${marked.parse(markdown)}</body></html>`;
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  win.destroy();
  fs.writeFileSync(file, pdf);
}

function sessionMarkdown(s) {
  const lines = (s.transcript || []).map((l) => `**${l.who}:** ${l.text}`).join('\n\n');
  const answers = (s.answers || []).map((a) => `### ${a.label || 'Answer'}\n\n${a.text}`).join('\n\n');
  return `# ${s.title}\n\n${new Date(s.createdAt).toLocaleString()} · ${s.mode}\n\n## AI Notes\n\n${s.notes || '_No notes._'}\n\n## Answers\n\n${answers || '_None._'}\n\n## Transcript\n\n${lines || '_Empty._'}\n`;
}

const NO_KEY_PRESETS = new Set(['claude', 'local', 'ollama']);

function needKey(cfg, what) {
  if (NO_KEY_PRESETS.has(cfg.preset)) return null;
  if (cfg.preset === 'bridge' && !cfg.apiKey) {
    return { ok: false, error: `Claude bridge token not found. Check that ${store.getSettings().bridge.envFile} exists.` };
  }
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    return { ok: false, error: `No API key set for ${what}. Open Settings in the main window and paste a free key.` };
  }
  return null;
}

function registerIpc() {
  ipcMain.handle('meta:get', () => ({ languages: LANGUAGES, presets: store.PRESETS, version: app.getVersion() }));
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, s) => {
    const r = store.saveSettings(s);
    ensureBridge();
    warmEngines();
    startMeetingWatch();
    return r;
  });
  // The renderer never holds the bridge token; fill it in here.
  const withBridgeKey = (cfg) => (cfg.preset === 'bridge' && !cfg.apiKey ? store.resolveSlot({ ...store.getSettings(), x: cfg }, 'x') : cfg);
  ipcMain.handle('models:list', async (_e, cfg) => {
    try { return { ok: true, models: await ai.listModels(withBridgeKey(cfg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('provider:test', async (_e, { slot, cfg }) => {
    cfg = withBridgeKey(cfg);
    if (cfg.preset === 'bridge') await ensureBridge();
    try {
      if (slot === 'stt' && cfg.preset === 'local') {
        const t0 = Date.now();
        const info = await sttLocal.start(cfg.model);
        return { ok: true, text: `Local Whisper ${info.model} running on ${info.device.toUpperCase()}${Date.now() - t0 > 2000 ? ` (started in ${Math.round((Date.now() - t0) / 1000)} s)` : ''}.` };
      }
      if (slot === 'stt') { await ai.listModels(cfg); return { ok: true, text: 'Connected.' }; }
      const t0 = Date.now();
      let first = 0;
      const text = await ai.chatStream(cfg, [{ role: 'user', content: 'Reply with just: OK' }], () => { first ||= Date.now(); }, undefined, { maxTokens: 10 });
      return { ok: true, text: `Model replied "${text.trim().slice(0, 40)}" – first words after ${((first - t0) / 1000).toFixed(1)} s.` };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('stt:local', async () => {
    const s = store.getSettings();
    if (s.stt.preset !== 'local') return { ok: false, error: 'Local Whisper is not selected.' };
    try { return { ok: true, ...(await sttLocal.start(s.stt.model)) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('stt:status', () => sttLocal.status());

  ipcMain.handle('sessions:list', () => store.listSessions());
  ipcMain.handle('sessions:get', (_e, id) => store.getSession(id));
  ipcMain.handle('sessions:save', (_e, s, { quiet } = {}) => {
    // Periodic saves from a live overlay must not resurrect a session deleted in the meantime.
    if (quiet && !store.getSession(s.id)) return null;
    const r = store.saveSession(s);
    if (!quiet) mainWin?.webContents.send('sessions:changed');
    return r;
  });
  ipcMain.handle('sessions:delete', (_e, id) => {
    if (id === overlaySessionId) return { ok: false, error: 'This session is live. End it first.' };
    store.deleteSession(id);
    return { ok: true };
  });

  ipcMain.handle('docs:pick', async (e, { multi } = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: docs.FILTERS });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      try { out.push(await docs.loadDocument(f)); } catch (err) { out.push({ name: path.basename(f), error: err.message }); }
    }
    return out;
  });

  ipcMain.handle('live:start', (_e, id) => {
    warmEngines(store.getSession(id)?.model);
    return openOverlay(id);
  });

  ipcMain.handle('export:session', async (e, { id, format }) => {
    const s = store.getSession(id);
    if (!s) return { ok: false, error: 'Session not found' };
    const safe = (s.title || 'session').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: `${safe}.${format}`,
      filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled) return { ok: false, canceled: true };
    const md = sessionMarkdown(s);
    if (format === 'pdf') await markdownToPdf(md, s.title, r.filePath); else fs.writeFileSync(r.filePath, md);
    shell.showItemInFolder(r.filePath);
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('export:markdown', async (e, { markdown, title, format }) => {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: `${title}.${format}`,
      filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled) return { ok: false, canceled: true };
    if (format === 'pdf') await markdownToPdf(markdown, title, r.filePath); else fs.writeFileSync(r.filePath, markdown);
    shell.showItemInFolder(r.filePath);
    return { ok: true, path: r.filePath };
  });

  // Tailored resume and question practice stream like answers, but without a session.
  ipcMain.handle('ai:tailor', async (e, { requestId, jobDescription }) => {
    const settings = store.getSettings();
    const cfg = store.resolveSlot(settings, 'chat');
    if (!settings.resume.trim()) return { ok: false, error: 'Add your resume on the Resume page first.' };
    return needKey(cfg, 'resume tailoring') || streamTo(e.sender, requestId, cfg, prompts.tailorMessages(settings.resume, jobDescription), { maxTokens: 3000 });
  });

  ipcMain.handle('ai:prep', async (e, { requestId, sessionId, question }) => {
    const settings = store.getSettings();
    const cfg = store.resolveSlot(settings, 'chat');
    const sess = store.getSession(sessionId) || { mode: 'interview', language: 'en', documents: [] };
    return needKey(cfg, 'practice answers') || streamTo(e.sender, requestId, cfg, prompts.questionPrepMessages(sess, settings, question));
  });
  ipcMain.handle('overlay:close', () => { overlay?.close(); return true; });
  ipcMain.handle('overlay:minimize', () => { overlay?.minimize(); return true; });
  ipcMain.handle('overlay:opacity', (_e, v) => { overlay?.setOpacity(Math.min(1, Math.max(0.35, v))); return true; });
  ipcMain.handle('overlay:opacity:get', () => overlay?.getOpacity() ?? 1);

  ipcMain.handle('stt:transcribe', async (_e, { audio, mime, language, prompt }) => {
    const settings = store.getSettings();
    const cfg = store.resolveSlot(settings, 'stt');
    const missing = needKey(cfg, 'transcription');
    if (missing) return missing;
    try {
      await sttSlot(cfg);
      return { ok: true, text: await ai.transcribe(cfg, Buffer.from(audio), mime, language, prompt) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Shared setup for AI requests: settings, provider config (with the session's model override) and the session itself.
  const prepare = (sessionId, slot, what) => {
    const settings = store.getSettings();
    const cfg = store.resolveSlot(settings, slot);
    const sess = store.getSession(sessionId);
    if (!sess) return { error: { ok: false, error: 'This session no longer exists (it may have been deleted).' } };
    if (slot === 'chat' && sess.model) cfg.model = sess.model;
    return { settings, cfg, sess, error: needKey(cfg, what) };
  };

  ipcMain.handle('ai:answer', async (e, { requestId, sessionId, lines, question }) => {
    const { settings, cfg, sess, error } = prepare(sessionId, 'chat', 'answers');
    return error || streamTo(e.sender, requestId, cfg, prompts.answerMessages(sess, settings, lines, question));
  });

  ipcMain.handle('ai:chat', async (e, { requestId, sessionId, lines, history, message }) => {
    const { settings, cfg, sess, error } = prepare(sessionId, 'chat', 'chat');
    return error || streamTo(e.sender, requestId, cfg, prompts.chatMessages(sess, settings, lines, history || [], message));
  });

  ipcMain.handle('ai:screenshot', async (e, { requestId, sessionId, lines }) => {
    const { settings, cfg, sess, error } = prepare(sessionId, 'vision', 'screenshots (vision)');
    if (error) return error;
    let image;
    try { image = await captureScreen(); } catch (err) { return { ok: false, error: 'Screen capture failed: ' + err.message }; }
    e.sender.send('ai:screenshot-taken', { requestId, image });
    return streamTo(e.sender, requestId, cfg, prompts.screenshotMessages(sess, settings, lines, image), { maxTokens: 2500 });
  });

  ipcMain.handle('ai:notes', async (_e, { sessionId, lines }) => {
    const { cfg, sess, error } = prepare(sessionId, 'chat', 'notes');
    if (error) return error;
    try { return { ok: true, text: await ai.chat(cfg, prompts.notesMessages(sess, lines), { maxTokens: 1500, temperature: 0.2 }) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('ai:mock', async (e, { requestId, sessionId, history, answer }) => {
    const { settings, cfg, sess, error } = prepare(sessionId, 'chat', 'mock interviews');
    return error || streamTo(e.sender, requestId, cfg, prompts.mockMessages(sess, settings, history || [], answer), { maxTokens: 400, temperature: 0.7 });
  });

  ipcMain.handle('ai:cancel', (_e, requestId) => { inflight.get(requestId)?.abort(); return true; });
}

app.on('web-contents-created', (_e, contents) => lockNavigation(contents));

app.whenReady().then(() => {
  setupDisplayCapture();
  registerIpc();
  createMain();
  ensureBridge();
  warmEngines();
  startMeetingWatch();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  sttLocal.stop();
  claudeDirect.shutdown();
  meetings.stop();
});
app.on('window-all-closed', () => app.quit());
