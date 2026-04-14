# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- Windows NSIS optional SearXNG step after install: prompts whether to enable local search, then opens a terminal session that writes a temp PowerShell script and runs Docker (`openjarvis-searxng` on `127.0.0.1:8080`).
- `src-tauri/windows/hooks.nsh` NSIS post-install hook wired via `bundle.windows.nsis.installerHooks`.
- `scripts/install-searxng.ps1` for manual or dev SearXNG setup (Docker Compose); bundle still ships compose/settings as resources for reference.
- `src-tauri/src/elevenlabs.rs`: ElevenLabs STT/TTS helpers used by voice commands and TTS playback.

### Changed
- `README.md`: documents Windows installer + optional SearXNG flow.
- `src-tauri/tauri.conf.json`: bundle resources for SearXNG compose, settings, and install script.

### Removed
- `whisper-rs` dependency from `src-tauri/Cargo.toml` so release builds on Windows do not require LLVM `libclang` for `whisper-rs-sys` / bindgen.

## [0.1.1] - 2026-04-13

### Added
- System tray support with `Show OpenJarvis` and `Quit` actions.
- Wake restore command to show the main window, focus it, and set always-on-top.
- Time-based spoken greeting on double-clap wake:
  - `Good morning sir`
  - `Good afternoon sir`
  - `Good evening sir`
- Optional clap sensitivity tuning via `VITE_WAKE_DOUBLE_CLAP_THRESHOLD`.

### Changed
- Main window close behavior now hides to tray (standby) instead of quitting.
- Double-clap wake detection tuned for better reliability with a wider timing window and lower default threshold.

