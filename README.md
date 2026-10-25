# Cue – real-time AI interview & call assistant

A Windows desktop app (Electron) that listens to your calls, transcribes both sides live, detects questions and streams suggested answers in about 3 seconds. It runs with **no API keys**: speech-to-text uses Whisper on your own GPU, and answers come from Claude through your signed-in Claude Code app.

## Features

- **Live transcription**: system audio ("Them") and microphone ("Me"), with live partial text, using local faster-whisper `large-v3-turbo` on CUDA (CPU fallback)
- **Auto Answer**: detects questions and streams an answer grounded in your resume, instructions and documents
- **Answer / Screenshot / Chat**: answer on demand (Ctrl+Shift+A), solve a coding problem on screen (Ctrl+Shift+S), message the AI privately
- **Sessions**: interview, regular call or mock interview mode; 50+ languages; per-session model, instructions (20k chars) and documents (PDF/DOCX/TXT, searched with BM25)
- **AI notes** after every call; export sessions to Markdown or PDF
- **Mock interviews** with a spoken AI interviewer and feedback
- **Meeting auto-detect** for Zoom, Teams, Google Meet, Webex and Slack huddles
- **Question Bank** of every question you were asked, with practice answers
- **Resume tailoring** to a job description
- **Interview Check**: tests the AI, Whisper, system-audio capture and mic end to end before an interview

## Providers

| Slot | Default (no key) | Alternatives |
|---|---|---|
| Answers & chat | Claude via local Claude Code CLI (pre-started, primed process pool) | claude-bridge, Groq, Gemini, OpenAI, Ollama, any OpenAI-compatible API |
| Screenshot reading | Claude | claude-bridge, Gemini, OpenAI, Ollama |
| Transcription | Local Whisper (GPU) | Groq Whisper, OpenAI |

## Requirements

- Windows 10/11, Node.js 24+
- Python 3.10+ with `pip install faster-whisper websockets` (plus a CUDA-capable PyTorch for GPU speed)
- [Claude Code](https://claude.com/claude-code) installed and signed in (for the default Claude provider)

## Run / build

```bash
npm install
npm start          # run from source
npm run dist       # build dist/Cue-Setup-<version>.exe
```

## Layout

```
main.js              Electron main process: windows, IPC, hotkeys, screen capture
src/claude-direct.js Claude CLI process pool (sealed: no tools, no MCP, no settings)
src/stt-local.js     starts the local Whisper server
stt/stt_server.py    streaming Whisper over WebSocket (energy VAD, partials, finals)
src/ai.js            OpenAI-compatible client + bridge support
src/prompts.js       answer / chat / screenshot / notes / mock / resume prompts
src/rag.js           BM25 document search
src/meetings.js      meeting detection from window titles
renderer/            dashboard (index.html, app.js, pages.js) and live overlay (overlay.*)
```

Cue does not hide itself from screen sharing or proctoring tools. Use it only where AI assistance is allowed.
