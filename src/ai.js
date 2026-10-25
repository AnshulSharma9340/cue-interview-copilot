// OpenAI-compatible client (works with Groq, Gemini, OpenAI, Ollama, claude-bridge): chat streaming, transcription,
// model listing. The "claude" preset is routed to the local Claude CLI pool instead (src/claude-direct.js).
const claudeDirect = require('./claude-direct');
const { PRESETS } = require('./store');

function endpoint(cfg, p) {
  if (!cfg.baseUrl) throw new Error('No API base URL set. Open Settings.');
  return cfg.baseUrl.replace(/\/+$/, '') + p;
}

function headers(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function fail(res) {
  let body = '';
  try { body = await res.text(); } catch {}
  let msg = body;
  try { msg = JSON.parse(body).error?.message || body; } catch {}
  const hint = res.status === 401 ? ' (check the API key in Settings)' : res.status === 429 ? ' (free-tier rate limit hit, wait a moment)' : '';
  throw new Error(`${res.status}: ${String(msg).slice(0, 300)}${hint}`);
}

const isBridge = (cfg) => cfg.preset === 'bridge';
const hasImages = (messages) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

// The claude-bridge drops images on /chat/completions; its /read endpoint takes them inline (run with no tools).
async function bridgeRead(cfg, messages, signal) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const content = [];
  for (const m of messages.filter((x) => x.role !== 'system')) {
    for (const p of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) {
      if (p.type === 'text') content.push({ type: 'text', text: p.text });
      if (p.type === 'image_url') {
        const [, mediaType, b64] = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url) || [];
        if (b64) content.push({ type: 'image', media_type: mediaType, b64 });
      }
    }
  }
  const res = await fetch(endpoint(cfg, '/read'), {
    method: 'POST',
    signal,
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ system, content, model: cfg.model }),
  });
  if (!res.ok) await fail(res);
  return (await res.json()).text || '';
}

async function chatStream(cfg, messages, onDelta, signal, opts = {}) {
  if (cfg.preset === 'claude') return claudeDirect.chatStream(cfg, messages, onDelta, signal);
  if (isBridge(cfg) && hasImages(messages)) {
    const text = await bridgeRead(cfg, messages, signal);
    onDelta(text);
    return text;
  }
  const body = { model: cfg.model, messages, stream: true, temperature: opts.temperature ?? 0.4, max_tokens: opts.maxTokens ?? 1500 };
  // Transcripts and documents are untrusted text: never let the bridge's CLI use its own tools on them.
  if (isBridge(cfg)) body.no_tools = true;
  const res = await fetch(endpoint(cfg, '/chat/completions'), {
    method: 'POST',
    signal,
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta?.content;
        if (d) { full += d; onDelta(d); }
      } catch {}
    }
  }
  return full;
}

async function chat(cfg, messages, opts = {}) {
  let out = '';
  await chatStream(cfg, messages, (d) => { out += d; }, opts.signal, opts);
  return out;
}

// Whisper tends to invent these on near-silent audio.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|thank you for watching\.?|you|bye\.?|\.|subtitles by .*|please subscribe.*)$/i;

async function transcribe(cfg, audio, mime, language, prompt) {
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'wav';
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime }), `audio.${ext}`);
  fd.append('model', cfg.model);
  if (language && language !== 'auto') fd.append('language', language);
  if (prompt) fd.append('prompt', prompt.slice(-200));
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  const res = await fetch(endpoint(cfg, '/audio/transcriptions'), { method: 'POST', headers: headers(cfg), body: fd });
  if (!res.ok) await fail(res);
  const text = ((await res.json()).text || '').trim();
  return HALLUCINATIONS.test(text) ? '' : text;
}

async function listModels(cfg) {
  if (PRESETS[cfg.preset]?.models) return PRESETS[cfg.preset].models;
  if (isBridge(cfg)) {
    // The bridge has no /models; /healthz lists the models it accepts.
    const res = await fetch(cfg.baseUrl.replace(/\/v1\/?$/, '') + '/healthz');
    if (!res.ok) await fail(res);
    return (await res.json()).allowedModels || [];
  }
  const res = await fetch(endpoint(cfg, '/models'), { headers: headers(cfg) });
  if (!res.ok) await fail(res);
  const j = await res.json();
  return (j.data || []).map((m) => String(m.id).replace(/^models\//, '')).sort();
}

module.exports = { chatStream, chat, transcribe, listModels };
