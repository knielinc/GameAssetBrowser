//! `cargo run --bin headless` — no window, no display required.
//!
//! Exit code 0 means the custom wgpu pass rendered something; 1 means it did
//! not. That is the pass/fail a macOS CI runner reports.

fn main() -> std::process::ExitCode {
    // Optional output path: `cargo run --bin headless -- frame.png`. CI passes
    // one and uploads it, so a regression can be looked at rather than guessed
    // at from a coverage percentage.
    let save = std::env::args().nth(1).map(std::path::PathBuf::from);

    match gab_native_spike::headless::render_once(save.as_deref()) {
        Ok(r) => {
            let pct = 100.0 * r.covered as f32 / r.total as f32;
            println!("adapter : {} ({})", r.adapter, r.backend);
            println!("covered : {}/{} pixels ({pct:.1}%)", r.covered, r.total);
            if let Some(path) = &r.written_to {
                println!("frame   : {path}");
            }
            // A lit sphere filling a square viewport covers roughly a fifth of
            // the frame. A blank result is the failure this check exists to
            // catch, so demand meaningful coverage rather than a single pixel.
            if pct < 5.0 {
                eprintln!("FAIL: frame is essentially blank — the custom pass did not draw");
                return std::process::ExitCode::FAILURE;
            }
            println!("OK: custom wgpu pass rendered");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("FAIL: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
