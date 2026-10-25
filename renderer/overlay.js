// Live session window: captures audio, transcribes, detects questions and streams answers.
const sessionId = new URLSearchParams(location.search).get('id');
const $ = (id) => document.getElementById(id);

let session = null;
let settings = null;
const lines = []; // {who, text, ts}
const answers = []; // {id, label, text, ts}
const chatHistory = [];
const segmenters = [];
const streams = [];
let autoAnswer = true;
let startedAt = Date.now();
let ending = false;
let currentAuto = null; // {requestId, started}
let dirty = false; // unsaved transcript/answer changes
const lastSttError = { msg: '', at: 0 };

const QUESTION_RE = /\?|(^|[.!]\s+)(what|why|how|when|where|who|which|whom|whose|can|could|would|will|should|do|does|did|is|are|was|were|have|has|tell me|tell us|explain|describe|walk me|walk us|give me|give us|share|talk about|define|compare|implement|write|design|build|imagine|suppose|let's say|so what|please|i'd like you to|i want you to|go ahead and|how about|what about|any questions)\b/i;
const FILLER_RE = /^(ok(ay)?|right|sure|yes|yeah|yep|no|nope|cool|great|perfect|got it|i see|mm+|hm+|uh+|um+|alright|thanks?( you)?)[.!,\s]*$/i;

// A finished utterance from the other side that deserves an answer.
function isQuestion(text) {
  const t = text.trim();
  if (FILLER_RE.test(t) || t.split(/\s+/).length < 3) return false;
  return QUESTION_RE.test(t);
}

async function init() {
  [session, settings] = await Promise.all([api.invoke('sessions:get', sessionId), api.invoke('settings:get')]);
  if (!session) { toast('Session not found', 'error'); return; }
  document.title = `Cue – ${session.title}`;
  autoAnswer = settings.autoAnswer;
  $('b-auto').classList.toggle('active', autoAnswer);
  // Restarting a session continues it: keep its transcript, answers and elapsed time.
  lines.push(...(session.transcript || []));
  answers.push(...(session.answers || []));
  startedAt = Date.now() - (session.durationMs || 0);
  renderLines();
  if (session.endedAt) persist({ endedAt: null });
  setInterval(() => ($('timer').textContent = fmtDuration(Date.now() - startedAt)), 1000);
  setInterval(() => { if (dirty) persist(); }, 8000);
  wireUi();
  if (session.mode === 'mock') return initMock();
  welcome();
  await startAudio();
}

function welcome() {
  $('feed').innerHTML = `<div class="welcome">
    <b>Listening.</b> Join your call (Zoom, Meet, Teams, a phone call on speaker…).<br/>
    • Questions from the other side are answered automatically when <b>Auto</b> is on.<br/>
    • Press <b>Answer</b> (Ctrl+Shift+A) any time to answer the latest question.<br/>
    • Press <b>Screenshot</b> (Ctrl+Shift+S) to solve a coding problem on your screen.<br/>
    • Type below to message the AI privately.</div>`;
}

let localStt = null; // {port, token} when Local Whisper is used

async function startAudio({ them = true, me = settings.transcribeMic } = {}) {
  const meterThem = $('m-them');
  const meterMe = $('m-me');
  if (settings.stt.preset === 'local') {
    const status = await api.invoke('stt:status');
    if (!status.running) setStatus('Loading the speech model… (first start of the day takes ~20 s)');
    const r = await api.invoke('stt:local');
    setStatus('');
    if (!r.ok) { toast('Local Whisper: ' + r.error, 'error'); return; }
    localStt = r;
  }
  if (them) {
    try {
      const sys = await CueAudio.getSystemAudio();
      streams.push(sys);
      segmenters.push(await makeSegmenter(sys, 'Them', meterThem));
    } catch (e) {
      meterThem.classList.add('off');
      toast('Could not capture system audio: ' + e.message, 'error');
    }
  } else meterThem.classList.add('off');
  if (me) {
    try {
      const mic = await CueAudio.getMicAudio();
      streams.push(mic);
      segmenters.push(await makeSegmenter(mic, 'Me', meterMe));
    } catch (e) {
      meterMe.classList.add('off');
      toast('Microphone unavailable: ' + e.message, 'error');
    }
  } else meterMe.classList.add('off');
}

function setStatus(text) {
  let el = document.getElementById('status');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'status'; el.className = 'welcome'; $('feed').prepend(el); }
  el.textContent = text;
}

// Handles one finished utterance from either speaker.
function onFinalText(who, text, ts) {
  if (!text) return;
  addLine(who, text, ts);
  if (who === 'Them' && autoAnswer && session.mode !== 'mock') {
    // A follow-up right after a question ("…and explain the trade-offs") refreshes the answer in progress.
    const followUp = currentAuto && Date.now() - currentAuto.started < 6000 && text.split(/\s+/).length >= 3;
    if (isQuestion(text) || followUp) autoTrigger();
  }
  if (who === 'Me' && session.mode === 'mock') mockHeard(text);
}

function vocabularyHint() {
  return [session.title, (session.instructions || '').slice(0, 300)].filter(Boolean).join('. ');
}

async function makeSegmenter(stream, who, meterEl) {
  const bar = meterEl.querySelector('b');
  const onLevel = (lvl, voiced) => { bar.style.width = `${Math.round(lvl * 100)}%`; meterEl.classList.toggle('on', voiced); };
  if (localStt) {
    const live = new CueAudio.LocalStream(stream, {
      port: localStt.port,
      token: localStt.token,
      language: session.language,
      prompt: vocabularyHint(),
      partials: who === 'Them' || session.mode === 'mock',
      onLevel,
      onPartial: (text) => showPartial(who, text),
      onFinal: (text) => { showPartial(who, ''); onFinalText(who, text, Date.now()); },
      onError: (msg) => toast('Local Whisper: ' + msg, 'error'),
    });
    await live.start();
    segmenters[who] = live;
    return live;
  }
  return makeCloudSegmenter(stream, who, onLevel);
}

// Live, still-changing text of what someone is saying right now.
function showPartial(who, text) {
  const id = 'partial-' + who;
  let el = document.getElementById(id);
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = id; el.className = 'line pending'; $('lines').appendChild(el); }
  el.innerHTML = `<b>${esc(who)}:</b> ${esc(text)}`;
  scrollLines();
  if (who === 'Me' && session.mode === 'mock') {
    const box = $('feed').querySelector('.mock-a');
    if (box) box.textContent = (mock.answer ? mock.answer + ' ' : '') + text;
  }
}

function makeCloudSegmenter(stream, who, onLevel) {
  let queue = Promise.resolve();
  let prevText = '';
  const seg = new CueAudio.Segmenter(stream, {
    onLevel,
    onSegment: (blob) => {
      const ts = Date.now();
      const pending = addPending(who);
      queue = queue.then(async () => {
        const r = await api.invoke('stt:transcribe', { audio: await blob.arrayBuffer(), mime: blob.type, language: session.language, prompt: prevText });
        pending.remove();
        if (!r.ok) {
          // A missing key fails every segment; don't stack identical toasts.
          if (r.error !== lastSttError.msg || Date.now() - lastSttError.at > 30000) toast('Transcription: ' + r.error, 'error');
          Object.assign(lastSttError, { msg: r.error, at: Date.now() });
          return;
        }
        if (!r.text) return;
        prevText = r.text;
        onFinalText(who, r.text, ts);
      });
    },
  });
  // Resolves once every segment handed off so far has been transcribed.
  seg.drain = () => queue;
  segmenters[who] = seg;
  return seg;
}

function addPending(who) {
  const el = document.createElement('div');
  el.className = 'line pending';
  el.textContent = `${who}: …`;
  $('lines').appendChild(el);
  scrollLines();
  return el;
}

function addLine(who, text, ts) {
  // Merge consecutive fragments from the same speaker within a few seconds into one line.
  const last = lines[lines.length - 1];
  if (last && last.who === who && ts - last.ts < 6000) { last.text += ' ' + text; last.ts = ts; }
  else lines.push({ who, text, ts });
  dirty = true;
  renderLines();
}

function renderLines() {
  const box = $('lines');
  const pend = [...box.querySelectorAll('.pending')];
  box.innerHTML = lines.map((l) => `<div class="line ${l.who === 'Me' ? 'me' : ''}"><b>${esc(l.who)}:</b> ${esc(l.text)}</div>`).join('');
  pend.forEach((p) => box.appendChild(p));
  scrollLines();
}

function scrollLines() { const s = $('lines'); s.scrollTop = s.scrollHeight; }

// ---------- answers ----------
function newCard(label, image) {
  if ($('feed').querySelector('.welcome')) $('feed').innerHTML = '';
  const el = document.createElement('div');
  el.className = 'card-a';
  el.innerHTML = `<div class="lbl"><span>${esc(label)}</span><span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>${image ? `<img class="shot" src="${image}"/>` : ''}<div class="prose cursor"></div>`;
  $('feed').prepend(el);
  $('feed').scrollTop = 0;
  return el;
}

async function runStream(channel, payload, label) {
  const requestId = uid();
  const card = newCard(label);
  const body = card.querySelector('.prose');
  let text = '';
  let raf = 0;
  const off = api.on('ai:delta', (d) => {
    if (d.requestId !== requestId) return;
    text += d.delta;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; body.innerHTML = md(text); });
  });
  const offShot = api.on('ai:screenshot-taken', (d) => {
    if (d.requestId !== requestId) return;
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = d.image;
    card.insertBefore(img, body);
  });
  const handle = { requestId, card, started: Date.now() };
  const done = api.invoke(channel, { requestId, sessionId, lines, ...payload })
    .catch((e) => ({ ok: false, error: e.message }))
    .then((r) => {
      off(); offShot();
      body.classList.remove('cursor');
      if (r.aborted) { card.remove(); return null; }
      if (!r.ok) { card.classList.add('err'); body.textContent = r.error; return null; }
      body.innerHTML = md(r.text);
      answers.push({ id: requestId, label, text: r.text, ts: Date.now() });
      dirty = true;
      return r.text;
    });
  handle.done = done;
  return handle;
}

function lastQuestion() {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].who === 'Them') return lines[i].text;
  return '';
}

function autoTrigger() {
  // If the interviewer keeps talking, replace a fresh auto answer with one that sees the whole question.
  if (currentAuto && Date.now() - currentAuto.started < 6000) api.invoke('ai:cancel', currentAuto.requestId);
  runStream('ai:answer', {}, 'Auto · ' + lastQuestion().slice(0, 90)).then((h) => {
    currentAuto = h;
    h.done.then(() => { if (currentAuto === h) currentAuto = null; });
  });
}

function manualAnswer() {
  if (session.mode === 'mock') return mockNext();
  const q = lastQuestion();
  runStream('ai:answer', {}, q ? 'Answer · ' + q.slice(0, 90) : 'Answer');
}

function screenshot() {
  runStream('ai:screenshot', {}, 'Screenshot');
}

async function sendChat(msg) {
  chatHistory.push({ role: 'user', content: msg });
  const h = await runStream('ai:chat', { history: chatHistory.slice(0, -1), message: msg }, 'You: ' + msg.slice(0, 90));
  const text = await h.done;
  if (text) chatHistory.push({ role: 'assistant', content: text });
}

// ---------- mock interview ----------
const mock = { history: [], answer: '', busy: false, question: '' };

async function initMock() {
  $('m-them').classList.add('off');
  $('b-shot').disabled = true;
  $('b-auto').disabled = true;
  $('b-answer').innerHTML = 'Next question <kbd>⌃⇧A</kbd>';
  $('feed').innerHTML = '<div class="welcome"><b>Mock interview.</b> The interviewer will speak each question. Answer out loud, then press <b>Next question</b> for feedback and the next one.</div>';
  await startAudio({ them: false, me: true });
  mockNext();
}

function mockHeard(text) {
  mock.answer += (mock.answer ? ' ' : '') + text;
  const el = $('feed').querySelector('.mock-a');
  if (el) el.textContent = mock.answer;
}

async function mockNext() {
  if (mock.busy) return;
  mock.busy = true;
  // Cut the utterance in progress and wait for it to be transcribed so the whole answer is graded.
  const mic = segmenters.Me;
  if (mic && mock.question) {
    const btn = $('feed').querySelector('[data-next]');
    if (btn) { btn.disabled = true; btn.textContent = 'Finishing transcription…'; }
    await mic.flush();
    await mic.drain();
    if (btn) { btn.disabled = false; btn.textContent = 'Next question'; }
  }
  setMicPaused(true);
  const answer = mock.answer.trim();
  if (mock.question && !answer) { toast('Answer out loud first – nothing was transcribed yet.'); mock.busy = false; setMicPaused(false); return; }
  const requestId = uid();
  let text = '';
  const off = api.on('ai:delta', (d) => { if (d.requestId === requestId) text += d.delta; });
  const r = await api.invoke('ai:mock', { requestId, sessionId, history: mock.history, answer: mock.question ? answer : null })
    .catch((e) => ({ ok: false, error: e.message }));
  off();
  mock.busy = false;
  // Keep the answer on failure so pressing Next again retries it.
  if (!r.ok) { toast(r.error, 'error'); setMicPaused(false); return; }
  mock.answer = '';
  dirty = true;
  text = r.text;
  mock.history.push({ role: 'user', content: mock.question ? `Candidate's answer: ${answer}` : 'Start the interview with a short greeting and the first question.' });
  mock.history.push({ role: 'assistant', content: text });
  const fb = (text.match(/FEEDBACK:\s*([\s\S]*?)(?=QUESTION:|$)/i) || [])[1]?.trim();
  const q = ((text.match(/QUESTION:\s*([\s\S]*)$/i) || [])[1] || text).trim();
  if (mock.question && fb && !/^none\.?$/i.test(fb)) answers.push({ id: uid(), label: 'Feedback · ' + mock.question.slice(0, 80), text: fb, ts: Date.now() });
  mock.question = q;
  lines.push({ who: 'Them', text: q, ts: Date.now() });
  renderLines();
  if ($('feed').querySelector('.welcome')) $('feed').innerHTML = '';
  const el = document.createElement('div');
  el.innerHTML = `<div class="mock-q">${fb && !/^none\.?$/i.test(fb) ? `<div class="fb">💬 ${esc(fb)}</div>` : ''}<div class="q">${esc(q)}</div></div>
    <div class="mock-actions"><button class="tb" data-repeat>🔊 Repeat</button><button class="tb main" data-next>Next question</button></div>
    <div class="ph" style="padding-left:2px">Your answer</div><div class="mock-a"></div>`;
  $('feed').innerHTML = '';
  $('feed').appendChild(el);
  el.querySelector('[data-repeat]').onclick = () => speak(q);
  el.querySelector('[data-next]').onclick = () => mockNext();
  speak(q);
}

function speak(text) {
  speechSynthesis.cancel();
  setMicPaused(true);
  const u = new SpeechSynthesisUtterance(text);
  if (session.language && session.language !== 'auto') u.lang = session.language;
  u.rate = 1.02;
  u.onend = u.onerror = () => setTimeout(() => setMicPaused(false), 250);
  speechSynthesis.speak(u);
}

function setMicPaused(p) { if (segmenters.Me) segmenters.Me.paused = p; }

// ---------- lifecycle ----------
function persist(extra = {}) {
  dirty = false;
  // quiet: the main window doesn't need to re-render for periodic saves.
  return api.invoke('sessions:save', { id: sessionId, transcript: lines, answers, durationMs: Date.now() - startedAt, ...extra }, { quiet: !('endedAt' in extra) });
}

async function end() {
  if (ending) return;
  ending = true;
  $('b-end').textContent = 'Saving…';
  $('b-end').disabled = true;
  speechSynthesis.cancel();
  const durationMs = Date.now() - startedAt;
  // Flush the final utterances and wait for them to transcribe (capped so a stuck request can't block forever).
  const finished = Promise.all(segmenters.map(async (s) => { await s.stop(); await s.drain(); }));
  await Promise.race([finished, new Promise((r) => setTimeout(r, 90000))]);
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  startedAt = Date.now() - durationMs;
  await persist({ endedAt: Date.now() });
  if (lines.length) {
    toast('Writing AI notes…');
    const r = await api.invoke('ai:notes', { sessionId, lines });
    if (r.ok) await persist({ endedAt: Date.now(), notes: r.text });
  }
  api.invoke('overlay:close');
}

function wireUi() {
  $('b-answer').onclick = manualAnswer;
  $('b-shot').onclick = screenshot;
  $('b-auto').onclick = () => { autoAnswer = !autoAnswer; $('b-auto').classList.toggle('active', autoAnswer); };
  $('b-tr').onclick = () => $('body').classList.toggle('no-tr');
  $('b-fade').onclick = async () => {
    const opacity = await api.invoke('overlay:opacity:get');
    api.invoke('overlay:opacity', opacity <= 0.55 ? 1 : opacity - 0.2);
  };
  $('b-min').onclick = () => api.invoke('overlay:minimize');
  $('b-end').onclick = end;
  $('chat').onsubmit = (e) => {
    e.preventDefault();
    const v = $('chat-in').value.trim();
    if (!v) return;
    $('chat-in').value = '';
    sendChat(v);
  };
  api.on('hotkey', (a) => (a === 'answer' ? manualAnswer() : a === 'screenshot' && session.mode !== 'mock' ? screenshot() : null));
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter' && document.activeElement !== $('chat-in')) manualAnswer();
  });
}

init();
