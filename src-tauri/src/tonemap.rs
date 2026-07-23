//! HDR/EXR (and developed camera-RAW) tone mapping: map floating-point,
//! wider-than-display colour into 8-bit sRGB for a PNG/thumbnail.
//!
//! A float image straight-truncated to 8-bit looks wrong — HDR values run well
//! past 1.0, so every bright pixel clamps to flat white. A tone-mapper squeezes
//! the whole range into [0,1] with a filmic shoulder instead.
//!
//! The five curves are EXACT ports of three.js's tone-mapping shader
//! (`tonemapping_pars_fragment.glsl.js`), so a `.hdr`/`.exr` looks the same in
//! its Rust-decoded 2D preview as it does lit on the 3D surface (which three
//! tone-maps live). If three's constants change on a bump, re-port them here.
//!
//! Each curve takes LINEAR rgb (exposure already folded in per three's shader,
//! which multiplies by `toneMappingExposure` inside the curve) and returns
//! linear rgb in [0,1]; we then apply the sRGB OETF exactly as three's renderer
//! does when `outputColorSpace = SRGBColorSpace`.

use image::DynamicImage;

/// The selectable tone-mapping operators, mirrored by `TONEMAPS` in
/// `src/stores/tonemapPrefs.ts`. `id()` is the wire token used in the
/// `preview://…?tm=<id>` query and in the preview cache key.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tonemap {
    /// Clamp to [0,1] then sRGB — "no shoulder", blows out highlights but shows
    /// the raw values. (three: LinearToneMapping.)
    Linear,
    /// `c/(1+c)` — the cheap classic; desaturates highlights. (three: Reinhard.)
    Reinhard,
    /// Filmic ACES fit — the industry-standard look and this app's default, so a
    /// thumbnail matches the ACES 3D viewport. (three: ACESFilmic.)
    Aces,
    /// Modern neutral filmic with clean highlight de-tint — the Blender default.
    /// (three: AgX.)
    Agx,
    /// Khronos PBR-neutral — preserves saturated hues, gentle rolloff.
    /// (three: Neutral.)
    Neutral,
}

impl Tonemap {
    /// Grid thumbnails and "Copy image" use this fixed operator; only the
    /// preview panel lets the user pick. ACES so the 2D thumb matches the 3D
    /// viewport's `ACESFilmicToneMapping`.
    pub const DEFAULT: Tonemap = Tonemap::Aces;

    pub fn id(self) -> &'static str {
        match self {
            Tonemap::Linear => "linear",
            Tonemap::Reinhard => "reinhard",
            Tonemap::Aces => "aces",
            Tonemap::Agx => "agx",
            Tonemap::Neutral => "neutral",
        }
    }

    /// Unknown tokens fall back to the default rather than failing — a stale or
    /// hand-edited `?tm=` should still render.
    pub fn from_id(s: &str) -> Tonemap {
        match s {
            "linear" => Tonemap::Linear,
            "reinhard" => Tonemap::Reinhard,
            "agx" => Tonemap::Agx,
            "neutral" => Tonemap::Neutral,
            _ => Tonemap::Aces,
        }
    }
}

/// Parse the `preview://` query string into `(operator, exposure_ev)`.
/// Missing/garbage values fall back to the default operator and 0 EV.
pub fn parse_query(query: Option<&str>) -> (Tonemap, f32) {
    let mut tm = Tonemap::DEFAULT;
    let mut ev = 0.0f32;
    if let Some(q) = query {
        for kv in q.split('&') {
            let mut it = kv.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("tm"), Some(v)) => tm = Tonemap::from_id(v),
                (Some("ev"), Some(v)) => ev = v.parse::<f32>().unwrap_or(0.0).clamp(-16.0, 16.0),
                _ => {}
            }
        }
    }
    (tm, ev)
}

/// Tone-map a floating-point image to 8-bit sRGB. Non-float images (already
/// display-referred 8/16-bit) pass through untouched — tone mapping a decoded
/// PNG/JPEG/DDS would only crush a picture that is already correct.
pub fn apply(img: DynamicImage, tm: Tonemap, exposure_ev: f32) -> DynamicImage {
    match img {
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => {
            let exposure = 2.0f32.powf(exposure_ev);
            let src = img.to_rgba32f();
            let mut out = image::RgbaImage::new(src.width(), src.height());
            for (s, d) in src.pixels().zip(out.pixels_mut()) {
                let rgb = [clean(s[0]), clean(s[1]), clean(s[2])];
                let mapped = match tm {
                    Tonemap::Linear => linear(rgb, exposure),
                    Tonemap::Reinhard => reinhard(rgb, exposure),
                    Tonemap::Aces => aces(rgb, exposure),
                    Tonemap::Agx => agx(rgb, exposure),
                    Tonemap::Neutral => neutral(rgb, exposure),
                };
                *d = image::Rgba([
                    encode(mapped[0]),
                    encode(mapped[1]),
                    encode(mapped[2]),
                    (s[3].clamp(0.0, 1.0) * 255.0) as u8,
                ]);
            }
            DynamicImage::ImageRgba8(out)
        }
        other => other,
    }
}

/// NaN/Inf → 0, negatives → 0. HDR files ship both (dead pixels, alpha tricks)
/// and a NaN propagates through every curve to a garbage pixel otherwise.
#[inline]
fn clean(v: f32) -> f32 {
    if v.is_finite() {
        v.max(0.0)
    } else {
        0.0
    }
}

/// Linear → sRGB OETF (the accurate piecewise curve three's renderer applies),
/// then quantise to 8-bit.
#[inline]
fn encode(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let s = if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

/// GLSL `mat3(c0, c1, c2) * v` — the arguments are COLUMNS, so this matches the
/// three.js source line-for-line (column-major multiply).
#[inline]
fn mat3(c0: [f32; 3], c1: [f32; 3], c2: [f32; 3], v: [f32; 3]) -> [f32; 3] {
    [
        c0[0] * v[0] + c1[0] * v[1] + c2[0] * v[2],
        c0[1] * v[0] + c1[1] * v[1] + c2[1] * v[2],
        c0[2] * v[0] + c1[2] * v[1] + c2[2] * v[2],
    ]
}

fn linear(c: [f32; 3], exp: f32) -> [f32; 3] {
    [
        (c[0] * exp).clamp(0.0, 1.0),
        (c[1] * exp).clamp(0.0, 1.0),
        (c[2] * exp).clamp(0.0, 1.0),
    ]
}

fn reinhard(c: [f32; 3], exp: f32) -> [f32; 3] {
    let f = |x: f32| {
        let x = x * exp;
        (x / (1.0 + x)).clamp(0.0, 1.0)
    };
    [f(c[0]), f(c[1]), f(c[2])]
}

fn aces(c: [f32; 3], exp: f32) -> [f32; 3] {
    // color *= toneMappingExposure / 0.6
    let k = exp / 0.6;
    let v = [c[0] * k, c[1] * k, c[2] * k];
    let v = mat3(
        [0.59719, 0.07600, 0.02840],
        [0.35458, 0.90834, 0.13383],
        [0.04823, 0.01566, 0.83777],
        v,
    );
    let fit = |x: f32| {
        let a = x * (x + 0.024_578_6) - 0.000_090_537;
        let b = x * (0.983_729 * x + 0.432_951_0) + 0.238_081;
        a / b
    };
    let v = [fit(v[0]), fit(v[1]), fit(v[2])];
    let v = mat3(
        [1.60475, -0.10208, -0.00327],
        [-0.53108, 1.10813, -0.07276],
        [-0.07367, -0.00605, 1.07602],
        v,
    );
    [v[0].clamp(0.0, 1.0), v[1].clamp(0.0, 1.0), v[2].clamp(0.0, 1.0)]
}

fn agx(c: [f32; 3], exp: f32) -> [f32; 3] {
    let v = [c[0] * exp, c[1] * exp, c[2] * exp];
    // linear sRGB (rec.709) -> linear rec.2020
    let v = mat3(
        [0.627_403_9, 0.069_097_0, 0.016_391_6],
        [0.329_282_0, 0.919_540_0, 0.088_013_2],
        [0.043_313_6, 0.011_361_2, 0.895_595_0],
        v,
    );
    // AgXInsetMatrix
    let v = mat3(
        [0.856_627_15, 0.137_318_97, 0.111_898_21],
        [0.095_121_24, 0.761_241_99, 0.076_799_42],
        [0.048_251_61, 0.101_439_04, 0.811_302_38],
        v,
    );
    const MIN_EV: f32 = -12.473_93;
    const MAX_EV: f32 = 4.026_069;
    let log2 = |x: f32| {
        let x = x.max(1e-10);
        ((x.log2() - MIN_EV) / (MAX_EV - MIN_EV)).clamp(0.0, 1.0)
    };
    let v = [log2(v[0]), log2(v[1]), log2(v[2])];
    let v = [contrast(v[0]), contrast(v[1]), contrast(v[2])];
    // AgXOutsetMatrix
    let v = mat3(
        [1.127_100_6, -0.141_329_76, -0.141_329_76],
        [-0.110_606_64, 1.157_823_7, -0.110_606_64],
        [-0.016_493_94, -0.016_493_94, 1.251_936_4],
        v,
    );
    // "look" gamma
    let v = [v[0].max(0.0).powf(2.2), v[1].max(0.0).powf(2.2), v[2].max(0.0).powf(2.2)];
    // linear rec.2020 -> linear sRGB
    let v = mat3(
        [1.6605, -0.1246, -0.0182],
        [-0.5876, 1.1329, -0.1006],
        [-0.0728, -0.0083, 1.1187],
        v,
    );
    [v[0].clamp(0.0, 1.0), v[1].clamp(0.0, 1.0), v[2].clamp(0.0, 1.0)]
}

/// AgX's 6th-order contrast approximation (three's `agxDefaultContrastApprox`).
fn contrast(x: f32) -> f32 {
    let x2 = x * x;
    let x4 = x2 * x2;
    15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x
        - 0.00232
}

fn neutral(c: [f32; 3], exp: f32) -> [f32; 3] {
    const START_COMPRESSION: f32 = 0.8 - 0.04;
    const DESATURATION: f32 = 0.15;
    let mut color = [c[0] * exp, c[1] * exp, c[2] * exp];
    let x = color[0].min(color[1]).min(color[2]);
    let offset = if x < 0.08 { x - 6.25 * x * x } else { 0.04 };
    color = [color[0] - offset, color[1] - offset, color[2] - offset];
    let peak = color[0].max(color[1]).max(color[2]);
    if peak < START_COMPRESSION {
        return color;
    }
    let d = 1.0 - START_COMPRESSION;
    let new_peak = 1.0 - d * d / (peak + d - START_COMPRESSION);
    let s = new_peak / peak;
    color = [color[0] * s, color[1] * s, color[2] * s];
    let g = 1.0 - 1.0 / (DESATURATION * (peak - new_peak) + 1.0);
    [
        color[0] + (new_peak - color[0]) * g,
        color[1] + (new_peak - color[1]) * g,
        color[2] + (new_peak - color[2]) * g,
    ]
}
