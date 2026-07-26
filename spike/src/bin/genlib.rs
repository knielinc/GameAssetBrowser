//! Writes a synthetic texture library: `genlib <dir> <count>`.
//!
//! For exercising scan and grid behaviour at 20k-file scale when a real pack is
//! not to hand. It is NOT a substitute for one: these are small, cheap-to-decode
//! PNGs, so any number measured against them understates decode cost and
//! flatters the grid. Use it to shake out scrolling, residency and eviction;
//! quote frame times from a real library.
//!
//! One file in every thousand gets a non-ASCII name, because font fallback is a
//! real cost of leaving the webview and a synthetic library should not quietly
//! hide it.

use std::path::PathBuf;

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(dir), Some(count)) = (args.next(), args.next()) else {
        eprintln!("usage: genlib <dir> <count>");
        return std::process::ExitCode::FAILURE;
    };
    let dir = PathBuf::from(dir);
    let count: usize = match count.parse() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("bad count: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    // Spread across subdirectories: a single directory with 20k entries is not
    // what a real asset pack looks like, and directory size affects scan time.
    for bucket in 0..(count.div_ceil(500)) {
        if let Err(e) = std::fs::create_dir_all(dir.join(format!("pack{bucket:03}"))) {
            eprintln!("could not create directory: {e}");
            return std::process::ExitCode::FAILURE;
        }
    }

    let started = std::time::Instant::now();
    for i in 0..count {
        let bucket = i / 500;
        let name = if i % 1000 == 0 {
            format!("テクスチャ_{i:05}.png")
        } else {
            format!("tex_{i:05}.png")
        };
        let path = dir.join(format!("pack{bucket:03}")).join(name);

        // 64x64, hue varying by index so the grid is visually distinguishable
        // while scrolling — a wall of identical squares makes it impossible to
        // see whether cells are actually updating.
        let size = 64u32;
        let mut pixels = Vec::with_capacity((size * size * 4) as usize);
        let (r, g, b) = hue(i as f32 / count.max(1) as f32);
        for y in 0..size {
            for x in 0..size {
                let edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
                if edge {
                    pixels.extend_from_slice(&[20, 20, 20, 255]);
                } else {
                    let shade = 1.0 - (y as f32 / size as f32) * 0.4;
                    pixels.extend_from_slice(&[
                        (r as f32 * shade) as u8,
                        (g as f32 * shade) as u8,
                        (b as f32 * shade) as u8,
                        255,
                    ]);
                }
            }
        }
        let Some(img) = image::RgbaImage::from_raw(size, size, pixels) else {
            eprintln!("internal: buffer size mismatch");
            return std::process::ExitCode::FAILURE;
        };
        if let Err(e) = img.save(&path) {
            eprintln!("could not write {}: {e}", path.display());
            return std::process::ExitCode::FAILURE;
        }
    }

    println!(
        "wrote {count} files to {} in {:.1} s",
        dir.display(),
        started.elapsed().as_secs_f32()
    );
    std::process::ExitCode::SUCCESS
}

/// Minimal HSV->RGB at full saturation and value.
fn hue(h: f32) -> (u8, u8, u8) {
    let h = (h.fract() * 6.0).clamp(0.0, 6.0);
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    let (r, g, b) = match h as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    ((r * 235.0) as u8, (g * 235.0) as u8, (b * 235.0) as u8)
}
