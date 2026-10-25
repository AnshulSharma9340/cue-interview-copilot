// "Claude (fast)": streams answers from the local Claude Code CLI using the user's Claude plan.
// The CLI takes ~6-8 s to start, so a small pool of processes is started ahead of time; each request uses a
// warm process once (no conversation carry-over) and a replacement starts in the background.
// Every process runs sealed: no tools, no MCP servers, no settings/CLAUDE.md, nothing saved to disk.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM = 'You are Cue, a real-time assistant. Follow the instructions in each message exactly. Never use tools.';
const POOL_SIZE = 3;
const MAX_IDLE_MS = 20 * 60 * 1000; // recycle processes that sat unused (keeps auth/session fresh)

function findClaude() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'claude';
}

const pools = new Map(); // model -> [{proc, started, ready}]
const workdir = path.join(os.homedir(), '.cue', 'claude-work');

// Each worker is primed with one tiny exchange right after it starts: the CLI does most of its one-time setup on
// the first request, so the real question then pays only network time (~2 s to first words instead of ~6-9 s).
function spawnWorker(model) {
  fs.mkdirSync(workdir, { recursive: true });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--model', model, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', SYSTEM];
  // No extended thinking: live answers need the first words fast, not a long deliberation.
  const env = { ...process.env, MAX_THINKING_TOKENS: '0' };
  const proc = spawn(findClaude(), args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const w = { proc, model, started: Date.now(), dead: false, ready: false, stderr: '', onEvent: null };
  w.primed = new Promise((resolve) => { w.markReady = resolve; });
  proc.on('exit', () => { w.dead = true; w.markReady(); });
  proc.on('error', (e) => { w.dead = true; w.stderr += String(e); w.markReady(); });
  proc.stderr.on('data', (d) => { w.stderr = (w.stderr + d).slice(-2000); });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (!w.ready) {
        if (j.type === 'result') { w.ready = true; w.markReady(); }
        continue; // the priming reply is discarded
      }
      w.onEvent?.(j);
    }
  });
  proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Connection check. Reply with just: ready' } }) + '\n');
  return w;
}

function fill(model) {
  const pool = pools.get(model) || [];
  const now = Date.now();
  for (const w of pool) if (now - w.started > MAX_IDLE_MS) { w.proc.kill(); w.dead = true; }
  const alive = pool.filter((w) => !w.dead);
  while (alive.length < POOL_SIZE) alive.push(spawnWorker(model));
  pools.set(model, alive);
}

function take(model) {
  fill(model);
  const pool = pools.get(model);
  // Prefer a primed process, then the oldest (closest to primed).
  pool.sort((a, b) => (b.ready - a.ready) || (a.started - b.started));
  const w = pool.shift();
  setImmediate(() => fill(model));
  return w;
}

function warm(model) {
  fill(model);
}

function shutdown() {
  for (const pool of pools.values()) for (const w of pool) w.proc.kill();
  pools.clear();
}

// OpenAI-style messages -> one user turn of Claude content blocks.
function toContent(messages) {
  const blocks = [];
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  if (system) blocks.push({ type: 'text', text: `<instructions>\n${system}\n</instructions>` });
  const convo = messages.filter((m) => m.role !== 'system');
  convo.forEach((m, i) => {
    const last = i === convo.length - 1;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const p of parts) {
      if (p.type === 'image_url') {
        const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url) || [];
        if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
      } else {
        const label = last ? '' : m.role === 'assistant' ? '[Your earlier reply]\n' : '[Earlier message]\n';
        blocks.push({ type: 'text', text: label + p.text });
      }
    }
  });
  return blocks;
}

async function chatStream(cfg, messages, onDelta, signal) {
  const w = take(cfg.model);
  await w.primed;
  return new Promise((resolve, reject) => {
    let full = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      w.proc.stdin.end();
      setTimeout(() => w.proc.kill(), 200);
      signal?.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve(full);
    };
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; finish(e); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    const exited = () => finish(new Error('Claude CLI exited: ' + (w.stderr.trim().split('\n').pop() || 'is Claude Code installed and signed in?')));
    if (w.dead) return exited();
    w.proc.on('exit', exited);
    w.onEvent = (j) => {
      if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
        full += j.event.delta.text;
        onDelta(j.event.delta.text);
      } else if (j.type === 'result') {
        if (j.is_error) {
          const msg = String(j.result || j.error || 'Claude returned an error');
          return finish(new Error(/limit|429/i.test(msg) ? `${msg} (Claude usage limit reached)` : msg));
        }
        if (!full && j.result) { full = j.result; onDelta(full); }
        finish();
      }
    };
    w.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: toContent(messages) } }) + '\n');
  });
}

module.exports = { chatStream, warm, shutdown, findClaude };
