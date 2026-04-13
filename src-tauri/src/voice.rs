//! Voice UX copy and TTS gating (STT from webview + `elevenlabs`, TTS in `tts`).
use std::env;

/// If false, `speak_reply` from the client is ignored (no TTS after answers).
pub fn voice_tts_enabled() -> bool {
    env::var("OPENJARVIS_VOICE_TTS").ok().as_deref() != Some("0")
}

pub fn start_voice_notification_body() -> &'static str {
    "Recording your voice — OpenJarvis will send audio to ElevenLabs for transcription."
}
