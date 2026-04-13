# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

