// Question Bank and Interview Check pages (loaded after app.js; uses its helpers).

function looksLikeQuestion(t) {
  const s = t.trim();
  return /\?\s*$/.test(s) || /^(what|why|how|when|where|who|which|can|could|would|tell me|tell us|explain|describe|walk me|give me|talk about|design|implement|write|imagine|suppose)\b/i.test(s);
}

// Every question the other side asked, across all sessions, newest first and de-duplicated.
async function collectQuestions() {
  const sessions = await api.invoke('sessions:list');
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    for (const l of s.transcript || []) {
      if (l.who !== 'Them') continue;
      for (const sentence of l.text.split(/(?<=[?.!])\s+/)) {
        const q = sentence.trim();
        const key = q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ');
        if (q.length < 15 || !looksLikeQuestion(q) || seen.has(key)) continue;
        seen.add(key);
        out.push({ q, session: s, ts: l.ts || s.createdAt });
      }
    }
  }
  return out;
}

async function startMockWith(questions, title, base = {}) {
  if (!questions.length) return toast('No questions to practise yet.', 'error');
  const list = questions.slice(0, 25).map((q) => `- ${q}`).join('\n');
  const s = await api.invoke('sessions:save', {
    title,
    mode: 'mock',
    language: base.language || 'en',
    model: base.model || '',
    documents: base.documents || [],
    instructions: `${base.instructions ? base.instructions + '\n\n' : ''}Ask these questions, one at a time, in this order (rephrase naturally):\n${list}`,
  });
  startSession(s.id);
}

async function renderQuestions() {
  const all = await collectQuestions();
  $view.innerHTML = `
    <div class="head"><div><h1>Question Bank</h1><p>Every question you were asked in your sessions. Practise answers or run a mock interview with them.</p></div>
      <button class="btn primary" id="mockSel" disabled>🎯 Mock interview with selected</button></div>
    <input type="text" id="qsearch" placeholder="Search questions…" style="margin-bottom:14px" />
    <div class="list" id="qlist"></div>`;
  const draw = () => {
    const term = $view.querySelector('#qsearch').value.toLowerCase();
    const shown = all.filter((x) => !term || x.q.toLowerCase().includes(term));
    $view.querySelector('#qlist').innerHTML = shown.length
      ? shown.map((x, i) => `<div class="card" style="margin:0;padding:12px 16px" data-i="${all.indexOf(x)}">
          <div style="display:flex;gap:12px;align-items:flex-start">
            <input type="checkbox" class="pick" style="margin-top:4px" />
            <div class="grow" style="flex:1"><div style="font-weight:600">${esc(x.q)}</div><div class="hint">${esc(x.session.title)} · ${fmtDate(x.ts)}</div></div>
            <button class="btn small prep">Practise answer</button>
          </div><div class="prepOut" style="margin-top:8px"></div></div>`).join('')
      : `<div class="empty">${all.length ? 'No questions match.' : 'No questions yet. They appear here after your first session.'}</div>`;
    $view.querySelectorAll('[data-i]').forEach((card) => {
      const x = all[+card.dataset.i];
      card.querySelector('.prep').onclick = (e) => {
        e.target.disabled = true;
        streamInto('ai:prep', { sessionId: x.session.id, question: x.q }, card.querySelector('.prepOut')).finally(() => (e.target.disabled = false));
      };
      card.querySelector('.pick').onchange = () => {
        $view.querySelector('#mockSel').disabled = !$view.querySelector('.pick:checked');
      };
    });
  };
  $view.querySelector('#qsearch').oninput = draw;
  $view.querySelector('#mockSel').onclick = () => {
    const picked = [...$view.querySelectorAll('.pick:checked')].map((c) => all[+c.closest('[data-i]').dataset.i]);
    startMockWith(picked.map((x) => x.q), `Practice – ${new Date().toLocaleDateString()}`, picked[0]?.session);
  };
  draw();
}

// ---------- Interview Check ----------
const CHECKS = [
  { id: 'answers', title: 'AI answers', hint: 'Sends a test prompt and measures how fast the first words arrive.' },
  { id: 'vision', title: 'Screenshot reading', hint: 'Checks the screenshot model responds.' },
  { id: 'whisper', title: 'Speech model', hint: 'Starts transcription (local Whisper loads onto the GPU).' },
  { id: 'system', title: 'Hearing the other side', hint: 'Speaks a test sentence through your speakers/headphones and transcribes it from system audio, end to end.' },
  { id: 'mic', title: 'Your microphone', hint: 'Say a few words when asked.' },
];

function renderCheck() {
  $view.innerHTML = `
    <div class="head"><div><h1>Interview Check</h1><p>Run this before an interview: it tests every part of the live pipeline on this PC.</p></div>
      <button class="btn primary" id="run">▶ Run check</button></div>
    <div class="list">${CHECKS.map((c) => `<div class="row" style="cursor:default" data-check="${c.id}"><span class="icon" style="font-size:20px;width:26px">⚪</span>
      <div class="grow"><div class="title">${c.title}</div><div class="meta">${c.hint}</div></div><span class="meta result" style="max-width:46%;text-align:right"></span></div>`).join('')}</div>
    <div class="card" id="summary" style="margin-top:14px;display:none"></div>`;
  $view.querySelector('#run').onclick = runChecks;
}

function setCheck(id, state, text) {
  const row = $view.querySelector(`[data-check=${id}]`);
  if (!row) return;
  row.querySelector('.icon').textContent = { run: '⏳', ok: '✅', warn: '⚠️', fail: '❌' }[state];
  row.querySelector('.result').textContent = text || '';
}

async function runChecks() {
  const btn = $view.querySelector('#run');
  btn.disabled = true;
  settings = await api.invoke('settings:get');
  const results = {};
  let firstToken = null;

  setCheck('answers', 'run', 'Testing…');
  let r = await api.invoke('provider:test', { slot: 'chat', cfg: settings.chat });
  const m = r.ok && /after ([\d.]+) s/.exec(r.text);
  if (m) firstToken = parseFloat(m[1]);
  results.answers = r.ok;
  setCheck('answers', r.ok ? (firstToken > 4 ? 'warn' : 'ok') : 'fail', r.ok ? r.text : r.error);

  setCheck('vision', 'run', 'Testing…');
  r = await api.invoke('provider:test', { slot: 'vision', cfg: settings.vision });
  results.vision = r.ok;
  setCheck('vision', r.ok ? 'ok' : 'fail', r.ok ? 'Ready.' : r.error);

  setCheck('whisper', 'run', settings.stt.preset === 'local' ? 'Loading Whisper onto the GPU (up to ~20 s)…' : 'Testing…');
  r = await api.invoke('provider:test', { slot: 'stt', cfg: settings.stt });
  results.whisper = r.ok;
  setCheck('whisper', r.ok ? 'ok' : 'fail', r.ok ? r.text : r.error);

  setCheck('system', 'run', 'Playing a test sentence – keep your volume up…');
  try {
    const heard = await systemAudioRoundTrip();
    results.system = /audio|check|hear/i.test(heard);
    setCheck('system', results.system ? 'ok' : 'warn', heard ? `Heard: "${heard}"` : 'Nothing was transcribed. Is the volume muted?');
  } catch (e) {
    results.system = false;
    setCheck('system', 'fail', e.message);
  }

  setCheck('mic', 'run', '🎤 Say something now (4 seconds)…');
  try {
    const peak = await micPeak(4000);
    results.mic = peak > 0.04;
    setCheck('mic', results.mic ? 'ok' : 'warn', results.mic ? `Working (level ${Math.round(peak * 100)}%).` : 'Very quiet – check the input device in Windows sound settings.');
  } catch (e) {
    results.mic = false;
    setCheck('mic', 'fail', e.message);
  }

  const allOk = Object.values(results).every(Boolean);
  const sum = $view.querySelector('#summary');
  sum.style.display = 'block';
  sum.innerHTML = `<h3>${allOk ? '✅ Ready for your interview' : '⚠️ Fix the items above before your interview'}</h3>
    <div class="prose">${firstToken != null ? `Expected delay from the end of a question to the first words of the answer: <b>about ${(firstToken + 1).toFixed(1)} s</b> (≈1 s to finish transcribing + ${firstToken.toFixed(1)} s for the AI).<br/>` : ''}
    Tips: wear headphones so your mic doesn't pick up the interviewer; keep the Cue window where you can glance at it; Ctrl+Shift+A answers on demand.</div>`;
  btn.disabled = false;
}

// Speaks through the speakers and transcribes it back from loopback audio.
async function systemAudioRoundTrip() {
  const sys = await CueAudio.getSystemAudio();
  const sentence = 'This is a Cue audio check. Can you hear me clearly?';
  let finalText = '';
  let stopper;
  try {
    if (settings.stt.preset === 'local') {
      const info = await api.invoke('stt:local');
      if (!info.ok) throw new Error(info.error);
      const live = await new CueAudio.LocalStream(sys, { port: info.port, token: info.token, language: 'en', partials: false, onFinal: (t) => { finalText += ' ' + t; } }).start();
      stopper = () => live.stop();
    } else {
      const seg = new CueAudio.Segmenter(sys, {
        onSegment: async (blob) => {
          const t = await api.invoke('stt:transcribe', { audio: await blob.arrayBuffer(), mime: blob.type, language: 'en' });
          if (t.ok) finalText += ' ' + t.text;
        },
      });
      stopper = async () => { await seg.stop(); await new Promise((r) => setTimeout(r, 3000)); };
    }
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = 'en-US';
      u.onend = u.onerror = resolve;
      speechSynthesis.speak(u);
      setTimeout(resolve, 9000);
    });
    await new Promise((r) => setTimeout(r, 1200));
    await stopper();
  } finally {
    sys.getTracks().forEach((t) => t.stop());
  }
  return finalText.trim();
}

async function micPeak(ms) {
  const mic = await CueAudio.getMicAudio();
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  ctx.createMediaStreamSource(mic).connect(an);
  const buf = new Float32Array(1024);
  let peak = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    peak = Math.max(peak, Math.sqrt(s / buf.length) / 0.15);
    await new Promise((r) => setTimeout(r, 50));
  }
  mic.getTracks().forEach((t) => t.stop());
  ctx.close();
  return Math.min(1, peak);
}
