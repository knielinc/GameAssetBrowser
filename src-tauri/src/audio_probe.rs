//! Shared symphonia container setup for the audio decoders.
//!
//! `waveform.rs` (peaks) and `spectrogram.rs` had the identical ~25-line
//! boilerplate: open the file, hint the extension, probe the container, pick
//! the default track, and build a decoder for it. Factored here so the two
//! can't drift (and `metadata.rs`'s header-only probe stays separate — it
//! deliberately never builds a decoder).

use std::fs::File;
use std::path::Path;

use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Open `path`, probe its container, and build a decoder for the default audio
/// track. Returns `(format reader, default-track id, decoder)`. The `Err` is a
/// human-readable reason (unrecognized format / no track / unsupported codec).
pub fn open_default_track(
    path: &str,
) -> Result<(Box<dyn FormatReader>, u32, Box<dyn Decoder>), String> {
    let file = File::open(path).map_err(|e| format!("could not open file: {e}"))?;
    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(&ext.to_ascii_lowercase());
    }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("unrecognized format: {e}"))?;
    let format = probed.format;
    let (track_id, codec_params) = {
        let track = format.default_track().ok_or("no default audio track")?;
        (track.id, track.codec_params.clone())
    };
    let decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder for codec: {e}"))?;
    Ok((format, track_id, decoder))
}
