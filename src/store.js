// Local JSON persistence in the Electron userData folder. API keys are encrypted with the OS keychain (safeStorage).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = {
  claude: { label: 'Claude – fast, uses your Claude plan (no key)', baseUrl: 'local', chat: 'claude-sonnet-5', vision: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-fable-5'] },
  local: { label: 'Local Whisper – GPU, offline, free (no key)', baseUrl: 'local', stt: 'large-v3-turbo', models: ['large-v3-turbo', 'small.en', 'base.en', 'large-v3'] },
  groq: { label: 'Groq (free tier)', baseUrl: 'https://api.groq.com/openai/v1', chat: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3-turbo' },
  gemini: { label: 'Google Gemini (free tier)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', chat: 'gemini-flash-latest', vision: 'gemini-flash-latest' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chat: 'gpt-4o-mini', vision: 'gpt-4o-mini', stt: 'whisper-1' },
  ollama: { label: 'Ollama (local, free)', baseUrl: 'http://localhost:11434/v1', chat: 'llama3.1', vision: 'llava' },
  bridge: { label: 'Claude bridge (local, uses your Claude plan)', baseUrl: 'http://127.0.0.1:8821/v1', chat: 'claude-haiku-4-5', vision: 'claude-haiku-4-5' },
  custom: { label: 'Custom OpenAI-compatible', baseUrl: '' },
};

const DEFAULT_SETTINGS = {
  chat: { preset: 'claude', baseUrl: 'local', apiKey: '', model: PRESETS.claude.chat },
  vision: { preset: 'claude', baseUrl: 'local', apiKey: '', model: PRESETS.claude.vision },
  stt: { preset: 'local', baseUrl: 'local', apiKey: '', model: PRESETS.local.stt },
  autoAnswer: true,
  meetingDetect: true,
  transcribeMic: true,
  contextChars: 20000,
  resume: '',
  resumeName: '',
  // Local claude-bridge (RUH-HRMS ops/claude-bridge). Its token is read from envFile, never stored here.
  bridge: {
    serverPath: 'D:/hrms-cfo/RUH-HRMS/ops/claude-bridge/server.mjs',
    envFile: path.join(require('os').homedir(), '.cue', 'bridge.env'),
    autoStart: true,
  },
};

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function writeJson(name, data) {
  fs.mkdirSync(dir(), { recursive: true });
  const p = file(name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(p + '.tmp', p);
}

const SLOTS = ['chat', 'vision', 'stt'];

function encrypt(s) {
  if (!s) return '';
  if (!safeStorage.isEncryptionAvailable()) return 'plain:' + s;
  return 'enc:' + safeStorage.encryptString(s).toString('base64');
}

function decrypt(s) {
  if (!s) return '';
  if (s.startsWith('plain:')) return s.slice(6);
  try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
}

function getSettings() {
  const raw = readJson('settings.json', {});
  const out = { ...DEFAULT_SETTINGS, ...raw, bridge: { ...DEFAULT_SETTINGS.bridge, ...(raw.bridge || {}) } };
  for (const slot of SLOTS) {
    out[slot] = { ...DEFAULT_SETTINGS[slot], ...(raw[slot] || {}) };
    out[slot].apiKey = decrypt(out[slot].apiKeyEnc);
    delete out[slot].apiKeyEnc;
  }
  return out;
}

function saveSettings(next) {
  const toSave = { ...next };
  for (const slot of SLOTS) {
    const { apiKey, ...rest } = next[slot] || {};
    toSave[slot] = { ...rest, apiKeyEnc: encrypt((apiKey || '').trim()) };
  }
  writeJson('settings.json', toSave);
  return getSettings();
}

// A slot with no key of its own borrows the key of another slot on the same host.
function resolveSlot(settings, slot) {
  const cfg = { ...settings[slot] };
  if (!cfg.apiKey && cfg.preset === 'bridge') cfg.apiKey = bridgeToken(settings);
  if (!cfg.apiKey) {
    const host = safeHost(cfg.baseUrl);
    const donor = SLOTS.map((s) => settings[s]).find((c) => c.apiKey && safeHost(c.baseUrl) === host);
    if (donor) cfg.apiKey = donor.apiKey;
  }
  return cfg;
}

function bridgeToken(settings) {
  try {
    const m = /^BRIDGE_TOKEN=(.*)$/m.exec(fs.readFileSync(settings.bridge.envFile, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return ''; }
}

function listSessions() {
  return readJson('sessions.json', []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getSession(id) {
  return readJson('sessions.json', []).find((s) => s.id === id) || null;
}

function saveSession(session) {
  const all = readJson('sessions.json', []);
  const now = Date.now();
  const i = all.findIndex((x) => x.id === session.id);
  const s = { ...session, id: session.id || crypto.randomUUID(), updatedAt: now, createdAt: session.createdAt || all[i]?.createdAt || now };
  if (i >= 0) all[i] = { ...all[i], ...s }; else all.push(s);
  writeJson('sessions.json', all);
  return i >= 0 ? all[i] : s;
}

function deleteSession(id) {
  writeJson('sessions.json', readJson('sessions.json', []).filter((s) => s.id !== id));
}

module.exports = { PRESETS, getSettings, saveSettings, resolveSlot, listSessions, getSession, saveSession, deleteSession };
