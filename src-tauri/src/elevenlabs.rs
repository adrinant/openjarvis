use anyhow::{anyhow, Context, Result};
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::env;

const STT_URL: &str = "https://api.elevenlabs.io/v1/speech-to-text";
const TTS_URL_FMT: &str = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}";

fn api_key() -> Option<String> {
    env::var("ELEVENLABS_API_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn tts_voice_id() -> Option<String> {
    env::var("ELEVENLABS_VOICE_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn stt_model() -> String {
    env::var("ELEVENLABS_STT_MODEL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "scribe_v2".to_string())
}

fn tts_model() -> String {
    env::var("ELEVENLABS_TTS_MODEL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "eleven_multilingual_v2".to_string())
}

pub fn has_api_key() -> bool {
    api_key().is_some()
}

pub fn has_tts_config() -> bool {
    api_key().is_some() && tts_voice_id().is_some()
}

pub async fn transcribe_audio_bytes(client: &reqwest::Client, bytes: Vec<u8>, filename: &str) -> Result<String> {
    let key = api_key().ok_or_else(|| anyhow!("missing ELEVENLABS_API_KEY"))?;
    let model = stt_model();

    let part = Part::bytes(bytes)
        .file_name(filename.to_string())
        .mime_str("audio/webm")
        .context("failed to set multipart mime type")?;

    let form = Form::new()
        .part("file", part)
        .text("model_id", model);

    let response = client
        .post(STT_URL)
        .header("xi-api-key", key)
        .multipart(form)
        .send()
        .await
        .context("failed to call ElevenLabs STT")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("ElevenLabs STT failed ({status}): {body}"));
    }

    let json: Value = response
        .json()
        .await
        .context("invalid ElevenLabs STT JSON response")?;

    let text = json
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    if text.is_empty() {
        return Err(anyhow!("ElevenLabs STT returned empty transcript"));
    }

    Ok(text)
}

pub async fn fetch_tts_pcm_16k(client: &reqwest::Client, text: &str) -> Result<Vec<u8>> {
    let key = api_key().ok_or_else(|| anyhow!("missing ELEVENLABS_API_KEY"))?;
    let voice_id = tts_voice_id().ok_or_else(|| anyhow!("missing ELEVENLABS_VOICE_ID"))?;
    let model = tts_model();
    let url = TTS_URL_FMT.replace("{voice_id}", &voice_id);

    let payload = serde_json::json!({
        "text": text,
        "model_id": model,
        "output_format": "pcm_16000"
    });

    let response = client
        .post(url)
        .header("xi-api-key", key)
        .header("accept", "audio/pcm")
        .json(&payload)
        .send()
        .await
        .context("failed to call ElevenLabs TTS")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("ElevenLabs TTS failed ({status}): {body}"));
    }

    let bytes = response
        .bytes()
        .await
        .context("failed to read ElevenLabs TTS audio bytes")?;

    if bytes.is_empty() {
        return Err(anyhow!("ElevenLabs TTS returned empty audio"));
    }

    Ok(bytes.to_vec())
}
