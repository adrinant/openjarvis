use anyhow::Result;

/// Spoken reply via ElevenLabs TTS.
pub async fn speak(text: &str) -> Result<()> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(());
    }

    if !crate::elevenlabs::has_tts_config() {
        anyhow::bail!("ElevenLabs TTS requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID");
    }
    let client = reqwest::Client::new();
    let pcm = crate::elevenlabs::fetch_tts_pcm_16k(&client, t).await?;
    tokio::task::spawn_blocking(move || crate::audio_output::play_pcm_s16le_16k_mono(&pcm))
        .await
        .map_err(|_| anyhow::anyhow!("tts playback task failed"))??;
    Ok(())
}
