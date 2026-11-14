# Changelog

All notable changes to Cue are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-25

The first public release: an open-source rebuild of the Parakeet AI interview copilot, built from a teardown of its public web app.

### Added
- **Streaming local transcription**: faster-whisper `large-v3-turbo` on CUDA (CPU fallback) over a local WebSocket, with partial transcripts and a 0.6 s end-of-sentence pause.
- **Primed Claude pool**: 3 pre-started, sealed Claude Code processes. First answer words arrive about 3 s after the question ends.
- **Auto Answer** with question detection, follow-up merging and streaming first-person answers.
- **Screenshot solve** (`Ctrl+Shift+S`): Cue hides itself during capture.
- **Private chat** with the live transcript as context.
- **Resume, instructions and documents** as context, with BM25 search over long documents.
- **Mock interviews** with spoken questions and feedback.
- **Meeting auto-detect** for Zoom, Teams, Google Meet, Webex and Slack huddles.
- **Question bank**, AI notes after each call, Markdown/PDF export and resume tailoring.
- **Interview Check**: an end-to-end pre-flight (TTS → loopback → Whisper round trip).
- Swappable providers: Groq, Gemini, OpenAI, Ollama, claude-bridge and any OpenAI-compatible API.
- NSIS installer (`Cue-Setup-2.0.0.exe`, per-user).

[2.0.0]: https://github.com/AnshulSharma9340/cue-interview-copilot/releases/tag/v2.0.0
