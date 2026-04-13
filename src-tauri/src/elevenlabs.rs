//! ElevenLabs Speech-to-Text and Text-to-Speech (replaces browser Web Speech in WebView2).
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::env;

const API: &str = "https://api.elevenlabs.io";

pub fn has_api_key() -> bool {
    env::var("ELEVENLABS_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

pub fn has_tts_config() -> bool {
    // Allow explicit opt-out to force OS TTS even if ElevenLabs vars exist
    // (dotenvy won't overwrite real environment variables).
    if env::var("OPENJARVIS_TTS_PROVIDER")
        .ok()
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("local"))
        == Some(true)
    {
        return false;
    }
    has_api_key()
        && env::var("ELEVENLABS_VOICE_ID")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

fn guess_audio_mime(filename: &str) -> &'static str {
    let l = filename.to_lowercase();
    if l.ends_with(".webm") {
        return "audio/webm";
    }
    if l.ends_with(".wav") {
        return "audio/wav";
    }
    if l.ends_with(".mp3") {
        return "audio/mpeg";
    }
    if l.ends_with(".ogg") {
        return "audio/ogg";
    }
    if l.ends_with(".m4a") || l.ends_with(".mp4") {
        return "audio/mp4";
    }
    "application/octet-stream"
}

pub async fn transcribe_audio_bytes(client: &Client, bytes: Vec<u8>, filename: &str) -> Result<String> {
    let key = env::var("ELEVENLABS_API_KEY").context("ELEVENLABS_API_KEY not set")?;
    let model = env::var("ELEVENLABS_STT_MODEL").unwrap_or_else(|_| "scribe_v2".into());
    let mime = guess_audio_mime(filename);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str(mime)
        .context("mime")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model_id", model);

    let resp = client
        .post(format!("{API}/v1/speech-to-text"))
        .header("xi-api-key", key)
        .multipart(form)
        .send()
        .await
        .context("elevenlabs stt request")?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("ElevenLabs STT HTTP {status}: {body}");
    }

    let v: Value = serde_json::from_str(&body).context("parse stt json")?;
    let text = v
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    text.context("empty or missing `text` in ElevenLabs STT response")
}

/// Raw PCM s16le mono 16 kHz (from `output_format=pcm_16000`).
pub async fn fetch_tts_pcm_16k(client: &Client, text: &str) -> Result<Vec<u8>> {
    let key = env::var("ELEVENLABS_API_KEY").context("ELEVENLABS_API_KEY not set")?;
    let voice = env::var("ELEVENLABS_VOICE_ID").context("ELEVENLABS_VOICE_ID not set")?;
    let model =
        env::var("ELEVENLABS_TTS_MODEL").unwrap_or_else(|_| "eleven_multilingual_v2".into());
    let url = format!("{API}/v1/text-to-speech/{voice}?output_format=pcm_16000");
    let body = serde_json::json!({
        "text": text,
        "model_id": model,
    });

    let resp = client
        .post(&url)
        .header("xi-api-key", key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .context("elevenlabs tts request")?;

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    if !status.is_success() {
        let n = bytes.len().min(512);
        let preview = String::from_utf8_lossy(&bytes[..n]);
        anyhow::bail!("ElevenLabs TTS HTTP {status}: {preview}");
    }
    Ok(bytes.to_vec())
}
