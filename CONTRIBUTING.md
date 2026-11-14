# Contributing to Cue

Thanks for helping! Cue is a small codebase with no build step for development, so getting started takes a couple of minutes.

## Dev setup

```bash
git clone https://github.com/AnshulSharma9340/cue-interview-copilot.git
cd cue-interview-copilot
npm install
pip install faster-whisper websockets   # + a CUDA build of torch for GPU speed
npm start
```

You need Windows 10/11, Node.js 24+, Python 3.10+, and [Claude Code](https://claude.com/claude-code) signed in. You can also switch the answer provider to Groq, Gemini, OpenAI or Ollama in Settings.

## Before you open a PR

```bash
node --check main.js preload.js src/*.js renderer/*.js
python -m py_compile stt/stt_server.py
```

CI runs the same checks. If your change touches audio, STT or answers, run **Interview Check** in the app and make sure it's all green.

## Where things live

| You want to… | Look at |
|---|---|
| Support a new meeting app | `src/meetings.js` |
| Add a transcription language | `src/languages.js` |
| Change how answers are written | `src/prompts.js` |
| Tune transcription latency | `stt/stt_server.py` (VAD, pause length, partial interval) |
| Add an AI provider | `src/ai.js` (OpenAI-compatible) |
| Change the overlay | `renderer/overlay.*` |

## Ground rules

- **No stealth features.** PRs that hide Cue from screen sharing, task managers or proctoring software won't be merged.
- **No secrets.** Never commit API keys, tokens or real interview transcripts.
- **Keep it local-first.** New features should work without a Cue server. Cue doesn't have one, and that's on purpose.
- **No third-party proprietary code.** Cue was modelled on Parakeet AI's architecture but contains none of its code or assets. Keep it that way.

## Commit style

Use short, imperative subject lines, for example `Add Webex huddle detection` or `Fix partial transcript flicker`. One logical change per PR.
