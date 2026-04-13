# BUILD.md — OpenJarvis (Current State)

## Overview

OpenJarvis is a Tauri desktop app (Rust backend + React frontend) with:

- Streaming chat via Vercel AI Gateway
- MCP tool integration through a pooled Rust MCP manager
- Voice input (browser mic capture -> ElevenLabs transcription)
- Optional spoken replies (TTS)
- Multiple voice activators: hotkey, wake word, fast double clap

## Active Stack

- Tauri v2 + Rust (`src-tauri`)
- React 19 + TypeScript + Vite 7 (`src`)
- Terminal UI via `@xterm/xterm`
- AI provider path: OpenAI-compatible Chat Completions through AI Gateway
- Notifications via `tauri-plugin-notification`
- Global shortcut via `tauri-plugin-global-shortcut`

## High-Level Architecture

```text
Frontend (React)
  -> invoke("send_message", history)
  -> receives token/tool_use/tool_result/done events

Rust (Tauri commands + ai.rs)
  -> builds OpenAI-format messages
  -> streams assistant tokens from AI Gateway
  -> runs MCP tool loop when tool_calls are returned

Voice path (Frontend-heavy)
  -> MediaRecorder captures browser mic audio
  -> audio chunk sent to invoke("elevenlabs_transcribe_audio")
  -> transcript fed back into same send_message flow
```

## Implemented Voice Behavior

- Primary toggle event: `activate_voice` in frontend
- Voice session records utterances and auto-sends on silence (VAD)
- Voice start methods currently available:
  - Global hotkey (`Ctrl/Cmd + Shift + Space`)
  - Wake phrase from `VITE_WAKE_WORD` (when runtime supports Web Speech API)
  - Fast double-clap trigger from `VITE_WAKE_DOUBLE_CLAP=1`
- Clap trigger currently tuned for quick two-clap timing:
  - min gap: `120ms`
  - max gap: `320ms`

## Current Environment Variables

Required:

```env
AI_GATEWAY_API_KEY=
ELEVENLABS_API_KEY=
```

Optional:

```env
OPENJARVIS_AI_MODEL=deepseek/deepseek-v3.2
ELEVENLABS_VOICE_ID=
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
OPENJARVIS_VOICE_TTS=1
VITE_WAKE_WORD=hey jarvis
VITE_WAKE_DOUBLE_CLAP=1
```

## Tauri Commands (Implemented)

- `send_message`
- `start_voice`
- `stop_voice` (stub/no-op currently)
- `speak`
- `notify_user`
- `get_mcp_servers`
- `reload_mcp_config`
- `elevenlabs_transcribe_audio`

## Scripts (package.json)

- `npm run dev` - Vite frontend dev
- `npm run build` - TypeScript + Vite production build
- `npm run preview` - preview dist
- `npm run tauri dev` - full desktop dev loop
- `npm run tauri build` - desktop bundles
- `npm run searxng:up|down|logs` - local SearXNG helpers

## Build and Run

```bash
npm install
npm run tauri dev
```

Production:

```bash
npm run build
npm run tauri build
```

## What Changed vs Older Docs

- Voice STT is no longer local Whisper-based in app flow; it uses ElevenLabs transcription command.
- Frontend/runtime deps are React 19 + Vite 7 + `@xterm/*`.
- `notify_user` is the current command name (not `notify`).
- Wake capabilities now include wake word and fast double-clap options in addition to hotkey.