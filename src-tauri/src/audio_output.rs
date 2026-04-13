//! Play raw PCM s16le mono 16kHz via in-process audio output.
use anyhow::Result;
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};

pub fn play_pcm_s16le_16k_mono(pcm: &[u8]) -> Result<()> {
    if pcm.is_empty() {
        return Ok(());
    }
    if pcm.len() % 2 != 0 {
        anyhow::bail!("odd PCM byte length");
    }

    let mut samples: Vec<i16> = Vec::with_capacity(pcm.len() / 2);
    for chunk in pcm.chunks_exact(2) {
        samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }

    let (_stream, handle) = OutputStream::try_default()?;
    let sink = Sink::try_new(&handle)?;
    let src = SamplesBuffer::new(1, 16_000, samples);
    sink.append(src);
    sink.sleep_until_end();
    Ok(())
}

