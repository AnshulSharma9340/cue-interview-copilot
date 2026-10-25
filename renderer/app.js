// Main window: session list, session create/edit, session detail, resume and settings.
const $view = document.getElementById('view');
let meta = { languages: [], presets: {} };
let settings = null;
let current = 'sessions';
let filter = 'all';

const MODES = { interview: 'Interview', call: 'Regular call', mock: 'Mock interview' };

async function init() {
  meta = await api.invoke('meta:get');
  settings = await api.invoke('settings:get');
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  api.on('sessions:changed', () => { if (current === 'sessions') renderSessions(); });
  api.on('meeting:detected', (m) => { detectedMeeting = m; if (current === 'sessions') renderSessions(); });
  api.on('meeting:start', (m) => { detectedMeeting = null; go('sessions'); editSession(null, { title: `${m.app} – ${new Date().toLocaleDateString()}` }); });
  go('sessions');
}

let detectedMeeting = null; // {app, title} from the meeting watcher

function go(view, arg) {
  current = view;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view || (view === 'detail' && b.dataset.view === 'sessions')));
  if (view === 'sessions') renderSessions();
  if (view === 'detail') renderDetail(arg);
  if (view === 'resume') renderResume();
  if (view === 'settings') renderSettings();
  if (view === 'questions') renderQuestions();
  if (view === 'check') renderCheck();
}

// Mirrors needKey() in main.js: built-in local engines, the bridge (token from its config) and local servers need no key.
const NO_KEY = new Set(['claude', 'local', 'bridge', 'ollama']);
const needsKey = (c) => !NO_KEY.has(c.preset) && !c.apiKey && !/localhost|127\.0\.0\.1/.test(c.baseUrl);

// Streams an AI reply (ai:delta events) into an element; resolves with the final text or null on error.
async function streamInto(channel, payload, el) {
  const requestId = uid();
  let text = '';
  let raf = 0;
  el.classList.add('prose', 'cursor');
  el.innerHTML = '<span class="hint">Thinking…</span>';
  const off = api.on('ai:delta', (d) => {
    if (d.requestId !== requestId) return;
    text += d.delta;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.innerHTML = md(text); });
  });
  const r = await api.invoke(channel, { requestId, ...payload }).catch((e) => ({ ok: false, error: e.message }));
  off();
  el.classList.remove('cursor');
  if (!r.ok) { el.innerHTML = `<span style="color:var(--danger)">${esc(r.error)}</span>`; return null; }
  el.innerHTML = md(r.text);
  return r.text;
}

function keyMissing() {
  return needsKey(settings.chat);
}

// Transcription borrows the answers key when both use the same host.
function sttKeyMissing() {
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  return needsKey(settings.stt) && !(settings.chat.apiKey && host(settings.chat.baseUrl) === host(settings.stt.baseUrl));
}

// ---------- Sessions ----------
async function renderSessions() {
  const all = await api.invoke('sessions:list');
  const shown = all.filter((s) => filter === 'all' || (filter === 'ended' ? s.endedAt : !s.endedAt));
  $view.innerHTML = `
    ${keyMissing() ? `<div class="banner"><div class="grow"><b>One-time setup:</b> add a free API key so Cue can transcribe and answer.</div><button class="btn primary" id="toSettings">Open Settings</button></div>`
      : sttKeyMissing() ? `<div class="banner"><div class="grow"><b>Live transcription is off:</b> add a free Groq key under Transcription in Settings. Chat, screenshots and notes already work.</div><button class="btn primary" id="toSettings">Open Settings</button></div>` : ''}
    ${detectedMeeting ? `<div class="banner" style="background:var(--accent-soft);border-color:#bfe3cd"><div class="grow">📞 <b>${esc(detectedMeeting.app)} meeting detected</b> <span class="hint">${esc(detectedMeeting.title)}</span></div>
      <button class="btn primary" data-quick="interview">Start interview session</button><button class="btn" data-quick="call">Start call session</button><button class="btn" id="dismissMeeting">✕</button></div>` : ''}
    <div class="head">
      <div><h1>Call Sessions</h1><p>Prepare for calls and review past sessions.</p></div>
      <button class="btn primary" id="create">＋ Create Session</button>
    </div>
    <div class="tabs">
      ${['all', 'active', 'ended'].map((f) => `<button data-f="${f}" class="${filter === f ? 'active' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
      <span style="margin-left:auto;align-self:center;color:var(--muted);font-size:13px">${all.length} Sessions</span>
    </div>
    <div class="list">
      ${shown.length ? shown.map(row).join('') : `<div class="empty">No sessions yet.<br/><br/><button class="btn primary" id="create2">Create your first session</button></div>`}
    </div>`;
  $view.querySelector('#toSettings')?.addEventListener('click', () => go('settings'));
  $view.querySelector('#dismissMeeting')?.addEventListener('click', () => { detectedMeeting = null; renderSessions(); });
  $view.querySelectorAll('[data-quick]').forEach((b) => (b.onclick = async () => {
    const m = detectedMeeting;
    detectedMeeting = null;
    const s = await api.invoke('sessions:save', { title: `${m.app} – ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, mode: b.dataset.quick, language: 'en', model: '', instructions: '', documents: [] });
    startSession(s.id);
  }));
  $view.querySelector('#create').onclick = () => editSession();
  $view.querySelector('#create2')?.addEventListener('click', () => editSession());
  $view.querySelectorAll('.tabs button[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; renderSessions(); }));
  $view.querySelectorAll('.row').forEach((r) => (r.onclick = (e) => {
    if (e.target.closest('[data-start]')) return startSession(r.dataset.id);
    go('detail', r.dataset.id);
  }));
}

function row(s) {
  const lines = (s.transcript || []).length;
  return `<div class="row" data-id="${s.id}">
    <div class="grow">
      <div class="title">${esc(s.title || 'Untitled session')}</div>
      <div class="meta">${fmtDate(s.updatedAt)}${s.durationMs ? ` · ${fmtDuration(s.durationMs)}` : ''}${lines ? ` · ${lines} lines` : ''}</div>
    </div>
    <span class="pill mode">${MODES[s.mode] || s.mode}</span>
    ${s.endedAt ? '<span class="pill">Ended</span>' : '<span class="pill">Ready</span>'}
    <button class="btn small primary" data-start>${s.endedAt ? 'Restart' : 'Start'}</button>
  </div>`;
}

async function startSession(id) {
  if (keyMissing()) { toast('Add your API key in Settings first.', 'error'); return go('settings'); }
  const r = await api.invoke('live:start', id);
  if (!r.ok) toast(r.error, 'error');
}

function editSession(existing, prefill = {}) {
  const s = existing || { title: '', mode: 'interview', language: 'en', model: '', instructions: '', documents: [], ...prefill };
  let docs = [...(s.documents || [])];
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">
    <h2>${existing ? 'Edit session' : 'Create session'}</h2>
    <label class="field"><span>Title</span><input type="text" id="f-title" placeholder="e.g. Google – Frontend Engineer round 2" value="${esc(s.title)}" /></label>
    <label class="field"><span>Mode</span>
      <div class="seg" id="f-mode">${Object.entries(MODES).map(([k, v]) => `<button type="button" data-m="${k}" class="${s.mode === k ? 'active' : ''}">${v}</button>`).join('')}</div>
      <div class="hint" id="mode-hint"></div>
    </label>
    <div class="grid2">
      <label class="field"><span>Language</span><select id="f-lang">${meta.languages.map(([c, n]) => `<option value="${c}" ${s.language === c ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>AI model</span><input type="text" id="f-model" list="models" placeholder="Default: ${esc(settings.chat.model)}" value="${esc(s.model || '')}" /><datalist id="models"></datalist></label>
    </div>
    <label class="field"><span>Instructions <span style="font-weight:400;color:var(--muted)" id="count"></span></span>
      <textarea id="f-ins" maxlength="20000" rows="6" placeholder="Paste the job description, company info, the role you're interviewing for, or how you want answers phrased.">${esc(s.instructions)}</textarea></label>
    <label class="field"><span>Documents</span>
      <div id="docs"></div>
      <button type="button" class="btn small" id="addDoc">＋ Upload PDF / DOCX / TXT</button>
      <div class="hint">Briefs, notes or playbooks the AI can reference live.</div>
    </label>
    <div class="actions">
      ${existing ? '<button class="btn danger" id="del" style="margin-right:auto">Delete</button>' : ''}
      <button class="btn" id="cancel">Cancel</button>
      <button class="btn" id="save">Save</button>
      <button class="btn primary" id="saveStart">Save &amp; Start</button>
    </div>
  </div>`;
  document.body.appendChild(back);
  const q = (sel) => back.querySelector(sel);
  let mode = s.mode;
  const hints = {
    interview: 'Listens to the call and suggests answers using your resume, instructions and documents.',
    call: 'For meetings, sales and client calls. Uses instructions and documents, not your resume.',
    mock: 'Practice out loud: an AI interviewer asks questions by voice and gives feedback.',
  };
  const setMode = (m) => { mode = m; q('#f-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.m === m)); q('#mode-hint').textContent = hints[m]; };
  setMode(mode);
  q('#f-mode').querySelectorAll('button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  const count = () => (q('#count').textContent = `${q('#f-ins').value.length.toLocaleString()} / 20,000`);
  q('#f-ins').oninput = count; count();
  const drawDocs = () => {
    q('#docs').innerHTML = docs.map((d, i) => `<div class="doc"><span>📎</span><span class="grow">${esc(d.name)} <span class="hint">${(d.text || '').length.toLocaleString()} chars</span></span><button class="btn small" data-rm="${i}">Remove</button></div>`).join('');
    q('#docs').querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { docs.splice(+b.dataset.rm, 1); drawDocs(); }));
  };
  drawDocs();
  q('#addDoc').onclick = async () => {
    const picked = await api.invoke('docs:pick', { multi: true });
    for (const d of picked) d.error ? toast(`${d.name}: ${d.error}`, 'error') : docs.push(d);
    drawDocs();
  };
  api.invoke('models:list', settings.chat).then((r) => { if (r.ok) q('#models').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); });
  const close = () => back.remove();
  q('#cancel').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  const save = async () => {
    const out = await api.invoke('sessions:save', {
      ...s,
      title: q('#f-title').value.trim() || `${MODES[mode]} – ${new Date().toLocaleDateString()}`,
      mode, language: q('#f-lang').value, model: q('#f-model').value.trim(), instructions: q('#f-ins').value, documents: docs,
    });
    close();
    return out;
  };
  q('#save').onclick = async () => { const out = await save(); existing ? go('detail', out.id) : renderSessions(); };
  q('#saveStart').onclick = async () => { const out = await save(); go('detail', out.id); startSession(out.id); };
  q('#del')?.addEventListener('click', async () => {
    if (!confirm('Delete this session and its transcript?')) return;
    const r = await api.invoke('sessions:delete', s.id);
    if (!r.ok) return toast(r.error, 'error');
    close(); go('sessions');
  });
}

async function renderDetail(id) {
  const s = await api.invoke('sessions:get', id);
  if (!s) return go('sessions');
  const lines = s.transcript || [];
  const answers = s.answers || [];
  $view.innerHTML = `
    <div class="head">
      <div><h1>${esc(s.title)}</h1><p>${MODES[s.mode]} · ${esc(meta.languages.find(([c]) => c === s.language)?.[1] || s.language)} · ${fmtDate(s.createdAt)}${s.durationMs ? ' · ' + fmtDuration(s.durationMs) : ''}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end"><button class="btn" id="back">← Back</button><button class="btn" id="edit">Edit</button>
        <button class="btn" id="exMd">⬇ Markdown</button><button class="btn" id="exPdf">⬇ PDF</button>
        ${lines.some((l) => l.who === 'Them') && s.mode !== 'mock' ? '<button class="btn" id="practice">🎯 Practise these questions</button>' : ''}
        <button class="btn primary" id="start">▶ ${s.endedAt ? 'Start again' : 'Start session'}</button></div>
    </div>
    <div class="card"><h3>AI Notes</h3><div class="prose">${s.notes ? md(s.notes) : '<span class="hint">Notes are generated automatically when a session ends.</span>'}</div>
      ${lines.length ? '<button class="btn small" id="regen" style="margin-top:10px">↻ Regenerate notes</button>' : ''}</div>
    <div class="grid2">
      <div class="card"><h3>Transcript (${lines.length})</h3><div style="max-height:420px;overflow:auto">${lines.map((l) => `<div class="transcript-line ${l.who === 'Me' ? 'me' : ''}"><b>${esc(l.who)}:</b> ${esc(l.text)}</div>`).join('') || '<span class="hint">Nothing yet.</span>'}</div></div>
      <div class="card"><h3>Answers (${answers.length})</h3><div style="max-height:420px;overflow:auto" class="prose">${answers.map((a) => `<div style="border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:10px"><div class="hint">${esc(a.label || '')}</div>${md(a.text)}</div>`).join('') || '<span class="hint">Nothing yet.</span>'}</div></div>
    </div>`;
  $view.querySelector('#back').onclick = () => go('sessions');
  $view.querySelector('#edit').onclick = () => editSession(s);
  $view.querySelector('#start').onclick = () => startSession(s.id);
  const exportAs = async (format) => {
    const r = await api.invoke('export:session', { id: s.id, format });
    if (r.ok) toast('Saved ' + r.path, 'ok'); else if (!r.canceled) toast(r.error, 'error');
  };
  $view.querySelector('#exMd').onclick = () => exportAs('md');
  $view.querySelector('#exPdf').onclick = () => exportAs('pdf');
  $view.querySelector('#practice')?.addEventListener('click', () => {
    const qs = lines.filter((l) => l.who === 'Them' && looksLikeQuestion(l.text)).map((l) => l.text);
    startMockWith(qs, `Practice – ${s.title}`, s);
  });
  $view.querySelector('#regen')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Generating…';
    const r = await api.invoke('ai:notes', { sessionId: s.id, lines });
    if (!r.ok) { toast(r.error, 'error'); e.target.disabled = false; return; }
    await api.invoke('sessions:save', { id: s.id, notes: r.text });
    renderDetail(s.id);
  });
}

// ---------- Resume ----------
function renderResume() {
  $view.innerHTML = `
    <div class="head"><div><h1>Resume</h1><p>Used in Interview and Mock sessions so answers match your real experience.</p></div>
      <div style="display:flex;gap:8px"><button class="btn" id="up">Upload PDF / DOCX</button><button class="btn primary" id="save">Save</button></div></div>
    <div class="card">
      <div class="hint" style="margin-bottom:8px">${settings.resumeName ? `Loaded from <b>${esc(settings.resumeName)}</b>. ` : ''}You can edit the text below.</div>
      <textarea id="txt" rows="18" placeholder="Paste your resume here, or upload a file.">${esc(settings.resume)}</textarea>
    </div>
    <div class="card"><h3>Tailor my resume to a job</h3>
      <textarea id="jd" rows="7" placeholder="Paste the job description here."></textarea>
      <div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary" id="tailor">✨ Tailor resume</button>
        <span id="tailorActions" style="display:none;gap:8px"><button class="btn" id="useIt">Use as my resume</button><button class="btn" id="tPdf">⬇ PDF</button><button class="btn" id="tMd">⬇ Markdown</button></span></div>
      <div id="tailored" style="margin-top:14px"></div>
    </div>`;
  let tailored = '';
  $view.querySelector('#tailor').onclick = async (e) => {
    const jd = $view.querySelector('#jd').value.trim();
    if (!jd) return toast('Paste a job description first.', 'error');
    e.target.disabled = true;
    tailored = (await streamInto('ai:tailor', { jobDescription: jd }, $view.querySelector('#tailored'))) || '';
    e.target.disabled = false;
    $view.querySelector('#tailorActions').style.display = tailored ? 'inline-flex' : 'none';
  };
  const resumeOnly = () => tailored.split(/\n---\n/)[0].trim();
  $view.querySelector('#useIt').onclick = () => { $view.querySelector('#txt').value = resumeOnly(); toast('Copied into your resume – press Save to keep it.'); };
  $view.querySelector('#tPdf').onclick = () => api.invoke('export:markdown', { markdown: resumeOnly(), title: 'Resume', format: 'pdf' });
  $view.querySelector('#tMd').onclick = () => api.invoke('export:markdown', { markdown: tailored, title: 'Resume', format: 'md' });
  $view.querySelector('#up').onclick = async () => {
    const [d] = await api.invoke('docs:pick', { multi: false });
    if (!d) return;
    if (d.error) return toast(d.error, 'error');
    $view.querySelector('#txt').value = d.text;
    settings.resumeName = d.name;
  };
  $view.querySelector('#save').onclick = async () => {
    settings = await api.invoke('settings:save', { ...settings, resume: $view.querySelector('#txt').value });
    toast('Resume saved', 'ok');
  };
}

// ---------- Settings ----------
const SLOT_INFO = {
  chat: { title: 'Answers & chat (LLM)', presets: ['claude', 'bridge', 'groq', 'gemini', 'openai', 'ollama', 'custom'], field: 'chat' },
  stt: { title: 'Transcription (speech-to-text)', presets: ['local', 'groq', 'openai', 'custom'], field: 'stt' },
  vision: { title: 'Screenshot reading (vision model)', presets: ['claude', 'bridge', 'gemini', 'openai', 'ollama', 'custom'], field: 'vision' },
};

function renderSettings() {
  $view.innerHTML = `
    <div class="head"><div><h1>Settings</h1><p>Defaults need no API keys: Claude through your Claude plan, and Whisper on your own GPU.</p></div>
      <button class="btn primary" id="save">Save settings</button></div>
    <div class="card prose" style="font-size:13.5px">
      <b>Fastest setup (default):</b> Answers and screenshots use <b>Claude</b> through the Claude Code app already signed in on this PC; transcription runs <b>Whisper on your GPU</b> – offline, unlimited, no key.<br/>
      <b>Optional:</b> a free <a href="https://console.groq.com/keys" target="_blank">Groq key</a> or <a href="https://aistudio.google.com/apikey" target="_blank">Gemini key</a> works too – pick the provider and paste it.
    </div>
    ${Object.keys(SLOT_INFO).map(slotCard).join('')}
    <div class="card"><h3>Behaviour</h3>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="auto" ${settings.autoAnswer ? 'checked' : ''}/> Auto Answer – detect questions from the other side and answer automatically</label>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="mic" ${settings.transcribeMic ? 'checked' : ''}/> Also transcribe my microphone (so the AI knows what I already said)</label>
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="meet" ${settings.meetingDetect ? 'checked' : ''}/> Detect meetings (Zoom, Teams, Meet, Webex, Slack huddles) and offer to start a session</label>
      <label class="field" style="max-width:320px"><span>Context budget (characters of resume + docs per request)</span><input type="text" id="ctx" value="${settings.contextChars}"/><div class="hint">20,000 suits Claude. Use ~10,000 on Groq's free tier.</div></label>
    </div>`;
  for (const slot of Object.keys(SLOT_INFO)) wireSlot(slot);
  $view.querySelector('#save').onclick = async () => {
    for (const slot of Object.keys(SLOT_INFO)) settings[slot] = readSlot(slot);
    settings.autoAnswer = $view.querySelector('#auto').checked;
    settings.transcribeMic = $view.querySelector('#mic').checked;
    settings.meetingDetect = $view.querySelector('#meet').checked;
    settings.contextChars = Math.max(1000, parseInt($view.querySelector('#ctx').value, 10) || 20000);
    settings = await api.invoke('settings:save', settings);
    toast('Settings saved', 'ok');
  };
}

function slotCard(slot) {
  const info = SLOT_INFO[slot];
  const c = settings[slot];
  return `<div class="card" data-slot="${slot}"><h3>${info.title}</h3>
    <div class="grid3">
      <label class="field"><span>Provider</span><select class="preset">${info.presets.map((p) => `<option value="${p}" ${c.preset === p ? 'selected' : ''}>${esc(meta.presets[p].label)}</option>`).join('')}</select></label>
      <label class="field" style="grid-column: span 2"><span>API base URL</span><input type="text" class="base" value="${esc(c.baseUrl)}"/></label>
    </div>
    <div class="grid2">
      <label class="field"><span>API key</span><input type="password" class="key" value="${esc(c.apiKey)}" placeholder="${slot === 'chat' ? 'Paste key' : 'Leave empty to reuse a key for the same provider'}"/></label>
      <label class="field"><span>Model</span><input type="text" class="model" list="ml-${slot}" value="${esc(c.model)}"/><datalist id="ml-${slot}"></datalist></label>
    </div>
    <button class="btn small test">Test connection</button> <button class="btn small load">Load model list</button> <span class="hint result"></span>
  </div>`;
}

function readSlot(slot) {
  const el = $view.querySelector(`[data-slot=${slot}]`);
  return { preset: el.querySelector('.preset').value, baseUrl: el.querySelector('.base').value.trim(), apiKey: el.querySelector('.key').value.trim(), model: el.querySelector('.model').value.trim() };
}

function effective(slot) {
  const cfg = readSlot(slot);
  if (!cfg.apiKey) {
    const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
    const donor = Object.keys(SLOT_INFO).map(readSlot).find((c) => c.apiKey && host(c.baseUrl) === host(cfg.baseUrl));
    if (donor) cfg.apiKey = donor.apiKey;
  }
  return cfg;
}

function wireSlot(slot) {
  const el = $view.querySelector(`[data-slot=${slot}]`);
  const res = el.querySelector('.result');
  // Built-in engines have no URL or key to fill in.
  const syncFields = () => {
    const builtin = ['claude', 'local'].includes(el.querySelector('.preset').value);
    for (const sel of ['.base', '.key']) {
      el.querySelector(sel).disabled = builtin;
      el.querySelector(sel).closest('.field').style.opacity = builtin ? 0.45 : 1;
    }
  };
  syncFields();
  el.querySelector('.preset').onchange = (e) => {
    const p = meta.presets[e.target.value];
    if (p.baseUrl) el.querySelector('.base').value = p.baseUrl;
    const m = p[slot === 'stt' ? 'stt' : slot === 'vision' ? 'vision' : 'chat'];
    if (m) el.querySelector('.model').value = m;
    syncFields();
  };
  el.querySelector('.test').onclick = async () => {
    res.textContent = 'Testing…';
    const r = await api.invoke('provider:test', { slot, cfg: effective(slot) });
    res.textContent = r.ok ? '✅ ' + r.text : '❌ ' + r.error;
  };
  el.querySelector('.load').onclick = async () => {
    res.textContent = 'Loading…';
    const r = await api.invoke('models:list', effective(slot));
    if (!r.ok) { res.textContent = '❌ ' + r.error; return; }
    el.querySelector('datalist').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
    res.textContent = `${r.models.length} models – click the Model box to pick one.`;
  };
}

init();
