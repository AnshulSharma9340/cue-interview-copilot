// Splits a live audio stream into utterances at pauses and hands each one off as a standalone webm blob.
// The recorder runs continuously and is restarted at each cut, so no speech onset is clipped.
class Segmenter {
  constructor(stream, { onSegment, onLevel, minSpeechMs = 350, silenceMs = 900, maxMs = 18000 }) {
    this.stream = stream;
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.minSpeechMs = minSpeechMs;
    this.silenceMs = silenceMs;
    this.maxMs = maxMs;
    this.paused = false;
    this.mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.noise = 0.004;
    this.startRecorder();
    this.timer = setInterval(() => this.tick(), 50);
  }

  startRecorder() {
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.stopped = new Promise((resolve) => {
      rec.onstop = () => {
        if (rec._keep && chunks.length) this.onSegment(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), rec._speechMs);
        resolve();
      };
    });
    rec.start();
    this.rec = rec;
    this.segStart = performance.now();
    this.speechMs = 0;
    this.lastVoice = 0;
  }

  cut(keep) {
    const old = this.rec;
    old._keep = keep;
    old._speechMs = this.speechMs;
    this.startRecorder();
    if (old.state !== 'inactive') old.stop();
    return old.stopped;
  }

  // Ends the current utterance now (if it contains speech); resolves after it has been handed to onSegment.
  flush() {
    return this.speechMs >= this.minSpeechMs ? this.cut(true) : Promise.resolve();
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const now = performance.now();
    // Track the noise floor slowly so the threshold adapts to the room / call volume.
    if (rms < this.noise * 2) this.noise = this.noise * 0.98 + rms * 0.02;
    const threshold = Math.max(0.008, this.noise * 3);
    const voiced = !this.paused && rms > threshold;
    this.onLevel?.(Math.min(1, rms / 0.15), voiced);
    if (voiced) { this.speechMs += 50; this.lastVoice = now; }
    const age = now - this.segStart;
    const hasSpeech = this.speechMs >= this.minSpeechMs;
    if (hasSpeech && this.lastVoice && now - this.lastVoice > this.silenceMs) this.cut(true);
    else if (age > this.maxMs) this.cut(hasSpeech);
    else if (!hasSpeech && age > 8000 && now - this.lastVoice > 1500) this.cut(false); // drop accumulated silence
  }

  // Resolves after the final utterance (if any) has been handed to onSegment.
  stop() {
    clearInterval(this.timer);
    this.ctx.close();
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve();
    rec._keep = this.speechMs >= this.minSpeechMs;
    rec._speechMs = this.speechMs;
    rec.stop();
    return rec.stopped;
  }
}

// Streams a live audio track to the local Whisper server (stt/stt_server.py) and reports partial and final text.
// Same control surface as Segmenter (paused, flush, drain, stop) so the overlay can use either.
class LocalStream {
  constructor(stream, { port, token, language, prompt, partials, onPartial, onFinal, onLevel, onError }) {
    Object.assign(this, { stream, port, token, language, prompt, partials, onPartial, onFinal, onLevel, onError });
    this.paused = false;
    this.flushWaiters = [];
    this.pending = new Int16Array(0);
  }

  async start() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('Could not connect to local Whisper'));
    });
    this.ws.send(JSON.stringify({ type: 'config', token: this.token, language: this.language, prompt: this.prompt, partials: this.partials }));
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'partial') this.onPartial?.(m.text);
      else if (m.type === 'final') this.onFinal?.(m.text);
      else if (m.type === 'flushed') this.flushWaiters.splice(0).forEach((r) => r());
      else if (m.type === 'error') this.onError?.(m.message);
    };
    this.ws.onclose = () => { this.flushWaiters.splice(0).forEach((r) => r()); if (!this.stopped) this.onError?.('Local Whisper disconnected'); };

    this.ctx = new AudioContext({ sampleRate: 16000 });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap');
    src.connect(this.node);
    let levelAcc = 0, levelN = 0;
    this.node.port.onmessage = (e) => {
      const f = e.data;
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      levelAcc += sum; levelN += f.length;
      if (levelN >= 800) {
        const rms = Math.sqrt(levelAcc / levelN);
        this.onLevel?.(Math.min(1, rms / 0.15), !this.paused && rms > 0.01);
        levelAcc = 0; levelN = 0;
      }
      const pcm = new Int16Array(f.length);
      if (!this.paused) for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, f[i] * 32768));
      const merged = new Int16Array(this.pending.length + pcm.length);
      merged.set(this.pending); merged.set(pcm, this.pending.length);
      this.pending = merged;
      if (this.pending.length >= 1600 && this.ws.readyState === 1) { // send every 100 ms
        this.ws.send(this.pending.buffer);
        this.pending = new Int16Array(0);
      }
    };
    return this;
  }

  // Ends the current utterance now; resolves after its final text has arrived.
  flush() {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve();
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.ws.send(JSON.stringify({ type: 'flush' }));
      setTimeout(resolve, 15000);
    });
  }

  drain() { return Promise.resolve(); }

  async stop() {
    await this.flush();
    this.stopped = true;
    try { this.node?.disconnect(); } catch {}
    this.ctx?.close();
    this.ws?.close();
  }
}

// System audio (what the other side says) via loopback capture; the main process supplies the source.
async function getSystemAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
  if (!stream.getAudioTracks().length) throw new Error('No system audio track was provided');
  return stream;
}

async function getMicAudio() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

window.CueAudio = { Segmenter, LocalStream, getSystemAudio, getMicAudio };
