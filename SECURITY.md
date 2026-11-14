# Security Policy

## Supported versions

| Version | Supported |
|---|:---:|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report them privately through GitHub: go to **[Security → Report a vulnerability](https://github.com/AnshulSharma9340/cue-interview-copilot/security/advisories/new)**.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a reply within 7 days.

## Scope

These areas are especially worth reporting:

- The `preload.js` bridge and IPC handlers in `main.js` (renderer → main privilege boundary)
- The local STT WebSocket server (`stt/stt_server.py`)
- How API keys are stored (`src/store.js`, Windows DPAPI)
- Spawning the Claude Code CLI (`src/claude-direct.js`)
- Parsing untrusted documents (PDF / DOCX) uploaded as context
