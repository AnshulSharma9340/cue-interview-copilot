"""Local streaming speech-to-text for Cue.

WebSocket on 127.0.0.1. Each connection is one audio stream ("Them" or "Me").
Client -> server: first a JSON text frame {"type":"config","token":..,"language":"en"|"auto","partials":true},
then binary frames of 16 kHz mono little-endian int16 PCM, and optionally {"type":"flush"}.
Server -> client: {"type":"partial","text"} while someone is talking, {"type":"final","text"} when they pause,
{"type":"flushed"} after a flush, {"type":"error","message"}.
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SR = 16000
FRAME = 480  # 30 ms
PREROLL_FRAMES = 10  # 300 ms of audio kept from before speech starts
END_SILENCE_S = 0.6  # pause that ends an utterance
MAX_UTTERANCE_S = 25.0
PARTIAL_EVERY_S = 0.9
MIN_SPEECH_S = 0.3

HALLUCINATION = re.compile(r"^(thank you\.?|thanks for watching!?|thank you for watching\.?|you|bye\.?|\.+|subtitles by .*|please subscribe.*|okay\.?)$", re.I)


def load_model(name, device):
    if device == "cuda":
        try:
            import torch  # noqa: F401  (its bundled cuBLAS/cuDNN DLLs serve ctranslate2)
            os.add_dll_directory(os.path.join(os.path.dirname(torch.__file__), "lib"))
        except Exception:
            pass
    from faster_whisper import WhisperModel
    if device == "cuda":
        try:
            return WhisperModel(name, device="cuda", compute_type="int8_float16"), "cuda"
        except Exception as e:  # no usable GPU: fall back to a CPU-sized model
            print(json.dumps({"type": "log", "message": f"CUDA unavailable ({e}); using CPU"}), flush=True)
    cpu_name = name if name in ("tiny", "tiny.en", "base", "base.en", "small", "small.en") else "small.en"
    return WhisperModel(cpu_name, device="cpu", compute_type="int8"), "cpu"


class Engine:
    def __init__(self, model):
        self.model = model
        self.pool = ThreadPoolExecutor(max_workers=1)  # one GPU job at a time
        self.busy = 0

    def _run(self, audio, language, prompt, beam):
        segs, _info = self.model.transcribe(
            audio,
            language=None if language in (None, "", "auto") else language,
            beam_size=beam,
            vad_filter=False,
            without_timestamps=True,
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            temperature=0.0,
        )
        keep = []
        for s in segs:
            if s.no_speech_prob > 0.6 and s.avg_logprob < -0.8:
                continue
            keep.append(s.text)
        text = " ".join(t.strip() for t in keep).strip()
        return "" if HALLUCINATION.match(text) else text

    async def transcribe(self, audio, language, prompt, beam=1):
        self.busy += 1
        try:
            return await asyncio.get_running_loop().run_in_executor(self.pool, self._run, audio, language, prompt, beam)
        finally:
            self.busy -= 1


class Stream:
    """Energy VAD + utterance buffer for one connection."""

    def __init__(self, engine, ws, language, partials):
        self.engine = engine
        self.ws = ws
        self.language = language
        self.partials = partials
        self.pending = np.zeros(0, np.float32)
        self.preroll = []
        self.utter = []
        self.in_speech = False
        self.speech_s = 0.0
        self.silence_s = 0.0
        self.noise = 0.003
        self.last_partial = 0.0
        self.prompt = ""
        self.final_lock = asyncio.Lock()

    def utter_audio(self):
        return np.concatenate(self.utter) if self.utter else np.zeros(0, np.float32)

    async def feed(self, pcm_bytes):
        x = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.pending = np.concatenate([self.pending, x])
        while len(self.pending) >= FRAME:
            frame, self.pending = self.pending[:FRAME], self.pending[FRAME:]
            await self.on_frame(frame)

    async def on_frame(self, frame):
        rms = float(np.sqrt(np.mean(frame * frame)))
        if not self.in_speech and rms < self.noise * 2:
            self.noise = self.noise * 0.97 + rms * 0.03
        voiced = rms > max(0.006, self.noise * 3.2)
        dt = FRAME / SR
        if not self.in_speech:
            self.preroll.append(frame)
            if len(self.preroll) > PREROLL_FRAMES:
                self.preroll.pop(0)
            if voiced:
                self.in_speech = True
                self.utter = list(self.preroll)
                self.preroll = []
                self.speech_s = dt
                self.silence_s = 0.0
                self.last_partial = time.monotonic()
            return
        self.utter.append(frame)
        if voiced:
            self.speech_s += dt
            self.silence_s = 0.0
        else:
            self.silence_s += dt
        dur = len(self.utter) * dt
        if self.silence_s >= END_SILENCE_S or dur >= MAX_UTTERANCE_S:
            self.finalize()
        elif self.partials and time.monotonic() - self.last_partial >= PARTIAL_EVERY_S and self.speech_s >= MIN_SPEECH_S:
            self.last_partial = time.monotonic()
            if self.engine.busy == 0:  # never queue a partial behind other work
                asyncio.create_task(self.send_partial(self.utter_audio()))

    async def send_partial(self, audio):
        text = await self.engine.transcribe(audio, self.language, self.prompt)
        if text and self.in_speech:
            await self.send({"type": "partial", "text": text})

    def finalize(self):
        """Close the current utterance and transcribe it in the background, so audio keeps flowing in."""
        audio = self.utter_audio()
        enough = self.speech_s >= MIN_SPEECH_S
        self.in_speech = False
        self.utter = []
        self.speech_s = 0.0
        self.silence_s = 0.0
        self.last_task = asyncio.create_task(self._final(audio if enough else None))

    async def _final(self, audio):
        # The lock is FIFO, so finals are sent in the order people spoke.
        async with self.final_lock:
            if audio is None or len(audio) == 0:
                await self.send({"type": "partial", "text": ""})
                return
            text = await self.engine.transcribe(audio, self.language, self.prompt, beam=2)
            if text:
                self.prompt = (self.prompt + " " + text)[-200:]
            await self.send({"type": "final", "text": text})

    async def flush(self):
        if self.in_speech:
            self.finalize()
        if getattr(self, "last_task", None):
            await self.last_task
        async with self.final_lock:
            await self.send({"type": "flushed"})

    async def send(self, obj):
        try:
            await self.ws.send(json.dumps(obj))
        except Exception:
            pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8823)
    ap.add_argument("--token", required=True)
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()

    import websockets

    t = time.time()
    model, device = load_model(args.model, args.device)
    engine = Engine(model)
    # Warm-up so the first real utterance isn't slow.
    await engine.transcribe(np.zeros(SR, np.float32), "en", "")

    async def handler(ws):
        try:
            cfg = json.loads(await asyncio.wait_for(ws.recv(), 10))
        except Exception:
            return
        if cfg.get("token") != args.token:
            await ws.close(code=4001, reason="bad token")
            return
        stream = Stream(engine, ws, cfg.get("language", "en"), bool(cfg.get("partials", True)))
        # Vocabulary hint (role, tech names) so Whisper spells domain words right.
        stream.prompt = str(cfg.get("prompt", ""))[-200:]
        await stream.send({"type": "ready", "device": device})
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                await stream.feed(msg)
            else:
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if m.get("type") == "flush":
                    await stream.flush()
                elif m.get("type") == "language":
                    stream.language = m.get("language", stream.language)

    async with websockets.serve(handler, "127.0.0.1", args.port, max_size=2**22):
        print(json.dumps({"type": "ready", "port": args.port, "device": device, "model": args.model, "load_s": round(time.time() - t, 1)}), flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
