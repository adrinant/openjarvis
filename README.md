# OpenJarvis

OpenJarvis is a desktop AI assistant built with Tauri + React + Rust.  
It provides a terminal-style chat UI, streamed model responses, MCP tool-calling, and voice input with optional wake triggers.

## Current Features

- Chat UI powered by xterm-style terminal rendering
- Streaming assistant responses via AI Gateway
- MCP server integration (`mcp-servers.json`) with live reload
- Voice transcription via ElevenLabs STT
- Optional TTS replies via ElevenLabs TTS
- Voice activation options:
  - Global hotkey: `Ctrl+Shift+Space` (Windows/Linux), `Cmd+Shift+Space` (macOS)
  - Wake word via Web Speech API (`VITE_WAKE_WORD`)
  - Fast double-clap detector (`VITE_WAKE_DOUBLE_CLAP=1`)

## Tech Stack

- Frontend: React 19, TypeScript, Vite 7, `@xterm/xterm`
- Desktop shell: Tauri v2
- Backend (Tauri): Rust + Tokio + Reqwest
- AI routing: Vercel AI Gateway (OpenAI-compatible Chat Completions)
- Tools: MCP pool managed in Rust

## Quick Start

### Prerequisites

- Node.js 18+
- Rust toolchain (`rustup`)
- Tauri prerequisites for your OS
  - Windows: WebView2 runtime + MSVC Build Tools
  - macOS: Xcode Command Line Tools

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and set at least:

```env
AI_GATEWAY_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Optional voice wake settings:

```env
VITE_WAKE_WORD=hey jarvis
VITE_WAKE_DOUBLE_CLAP=1
OPENJARVIS_VOICE_TTS=1
```

### Run

```bash
npm run tauri dev
```

### Build

```bash
npm run build        # frontend typecheck + bundle
npm run tauri build  # desktop app bundle
```

## Scripts

- `npm run dev` - frontend only (Vite)
- `npm run build` - TypeScript + production bundle
- `npm run preview` - preview built frontend
- `npm run tauri dev` - full desktop dev mode
- `npm run tauri build` - desktop production build
- `npm run searxng:up|down|logs` - helper scripts for local SearXNG

## Project Layout

- `src/` React app (terminal UI, hooks, voice UI)
- `src-tauri/src/` Rust commands, AI bridge, MCP pool, notifications, TTS
- `.env.example` environment template
- `mcp-servers.example.json` MCP config template

## Notes

- Keep real secrets in `.env` only (never commit it).
- Wake-word support depends on runtime Web Speech API availability.
- Clap wake uses passive microphone listening while enabled.
