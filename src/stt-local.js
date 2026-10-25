// Runs stt/stt_server.py (faster-whisper on the GPU) and hands its port + token to the renderer.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const net = require('net');

let proc = null;
let info = null; // {port, token, device, model}
let starting = null;
let lastError = '';
let wantedModel = null;

// Inside a packaged app the script lives in app.asar.unpacked.
const script = () => path.join(__dirname, '..', 'stt', 'stt_server.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function start(model = 'large-v3-turbo', device = 'cuda') {
  if (info && wantedModel === model) return Promise.resolve(info);
  if (starting && wantedModel === model) return starting;
  stop();
  wantedModel = model;
  starting = (async () => {
    const port = await freePort();
    const token = crypto.randomBytes(16).toString('hex');
    const python = process.env.CUE_PYTHON || 'python';
    proc = spawn(python, ['-u', script(), '--port', String(port), '--token', token, '--model', model, '--device', device], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = proc;
    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
    return new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('Local Whisper took too long to start (first run downloads ~1.6 GB). ' + errTail.slice(-300))), 15 * 60 * 1000);
      p.stdout.on('data', (d) => {
        out += d;
        let i;
        while ((i = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, i); out = out.slice(i + 1);
          try {
            const j = JSON.parse(line);
            if (j.type === 'ready') { clearTimeout(timer); info = { port, token, device: j.device, model, loadSeconds: j.load_s }; resolve(info); }
          } catch {}
        }
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (proc === p) { proc = null; info = null; starting = null; }
        lastError = `Local Whisper stopped (exit ${code}). ${errTail.trim().split('\n').slice(-2).join(' ')}`;
        reject(new Error(lastError + (/No module named/.test(errTail) ? ' – run: pip install faster-whisper websockets' : '')));
      });
      p.on('error', (e) => { clearTimeout(timer); lastError = 'Could not start Python: ' + e.message; reject(new Error(lastError)); });
    });
  })();
  starting.catch(() => { starting = null; });
  return starting;
}

function stop() {
  if (proc) proc.kill();
  proc = null;
  info = null;
  starting = null;
}

function status() {
  return { running: !!info, starting: !!starting && !info, info, lastError };
}

module.exports = { start, stop, status };
