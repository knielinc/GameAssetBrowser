//! Layered art documents — Krita (`.kra`) and Aseprite (`.aseprite`/`.ase`).
//!
//! Split in two on purpose, because the two halves have wildly different costs:
//!
//!  * `layer_doc` (IPC command) returns METADATA only — the layer tree, frame
//!    durations, animation tags. It is an XML walk (Krita) or a header parse
//!    (Aseprite), so it lands in single-digit milliseconds even for a 500-layer
//!    document and the panel can paint immediately.
//!  * The `cels` URI scheme returns PIXELS — every layer's cel, cropped to its
//!    opaque box, as RAW RGBA in one binary pack (see [`pack_cels`]).
//!
//! The pixels used to be PNG-encoded, base64'd and embedded in the command's
//! JSON reply. That paid for a deflate compress in Rust, a ~4/3 blowup into a
//! JS string, a JSON parse, and a PNG decode in the webview — per layer, per
//! frame. Raw bytes over a custom scheme pay for none of it: WebView2 fetches
//! them off-thread and `createImageBitmap` uploads them straight to the GPU.
//!
//! WHY PHOTOSHOP IS NOT DECODED HERE. It looks inconsistent, and it was
//! measured rather than assumed. The Rust `ag-psd` port decodes the same files
//! only 1.1-1.4x faster than the JavaScript original (89 MB file: 693 ms vs
//! 950 ms; its structure-only parse is actually slower, because it copies
//! channel data where the JS reader takes views). Meanwhile bytes cross into
//! the webview at ~60 MB/s no matter the transport, and a decoded document is
//! far bigger than the file it came from — that 89 MB PSD is 367 MB of layer
//! pixels. Moving the decode here would trade a 950 ms JS decode for a 6 s
//! transfer. Krita and Aseprite are decoded here because their cels are small
//! and their formats have no JS reader worth the name; Photoshop stays in the
//! worker, and the win came instead from not shipping cels until something
//! asks for them (see `useLayeredDoc`).

use std::io::Read;
use std::path::Path;

// ---------------------------------------------------------------------------
// Metadata (the JSON half)
// ---------------------------------------------------------------------------

/// One node of the layer tree. Covers both formats; fields a format doesn't
/// have take their neutral value (`clip: false`, `passthrough: false`, ...).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerNode {
    pub name: String,
    /// `paint` | `group` | `mask` | `filter` | `vector` | `clone` | `file` |
    /// `other`. Drives the panel's icon and nothing else — compositing keys off
    /// `is_group` / `inert`.
    pub kind: String,
    pub opacity: f32,
    pub blend: String,
    /// This layer's OWN eye state (not inherited from parent groups).
    pub visible: bool,
    /// Nesting depth for the tree (0 = top level).
    pub depth: u32,
    /// A group/folder layer (holds children, no pixels of its own).
    pub is_group: bool,
    /// Index of the parent group in `layers`, or -1 for a top-level layer.
    pub parent: i32,
    /// Krita "inherit alpha" / Photoshop clipping — clip to the layers below it
    /// in its group instead of drawing flat.
    pub clip: bool,
    /// A pass-through group (composites as if its children were in the parent,
    /// no isolation). Only meaningful when `is_group`.
    pub passthrough: bool,
    /// A mask is baked into this layer's cel alpha, so the pixels you get are
    /// already masked. Purely informational (the panel shows a badge).
    pub masked: bool,
    /// Listed in the tree but never composited: selection masks, filter layers
    /// and other nodes we can show the name of but cannot render. Without this
    /// they would silently draw as nothing and look like a bug.
    pub inert: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMeta {
    pub duration_ms: u32,
}

/// An Aseprite animation tag (a named frame range).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMeta {
    pub name: String,
    pub from: u32,
    pub to: u32,
    /// `forward` | `reverse` | `pingpong` | `pingpongreverse`.
    pub direction: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDoc {
    pub width: u32,
    pub height: u32,
    /// False when nothing in the file can be composited per-layer (a Krita doc
    /// of nothing but vector/clone layers, say) — the view then shows only the
    /// flattened image and the panel's eyes are disabled.
    pub layered: bool,
    pub layers: Vec<LayerNode>,
    pub frames: Vec<FrameMeta>,
    pub tags: Vec<TagMeta>,
    /// A flattened image is available at `cels://<path>?what=merged`.
    pub merged: bool,
    /// Whether that flattened image is the AUTHORITY on how the document looks.
    ///
    /// True for Krita, whose `mergedimage.png` is what Krita itself rendered at
    /// save time, filters and all — better than anything we can recompute, so
    /// the view keeps showing it until the user toggles a layer. False for
    /// Aseprite, where the per-cel composite is exact and the flattened image is
    /// only a first-frame placeholder to fill the moment before the cels land
    /// (showing it any longer would freeze the animation).
    pub merged_exact: bool,
}

// ---------------------------------------------------------------------------
// Pixels (the binary half)
// ---------------------------------------------------------------------------

/// One layer's pixels on one frame, cropped to its opaque box and positioned on
/// the canvas.
pub struct Cel {
    /// Index into `LayerDoc::layers`, or -1 for a standalone/merged image.
    pub layer: i32,
    pub frame: u32,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// `w * h * 4` bytes, straight RGBA8, NOT premultiplied.
    pub rgba: Vec<u8>,
}

/// Serialize cels into the wire format the frontend's `celPack.ts` reads:
///
/// ```text
/// magic  u32  "LYR1" (little-endian 0x3152_594C)
/// count  u32
/// count x record { layer i32, frame u32, x i32, y i32, w u32, h u32,
///                  offset u32, len u32 }   // 32 bytes each
/// payload bytes (RGBA runs, in record order)
/// ```
///
/// One allocation for the whole reply, and the frontend can hand each record's
/// byte range to `createImageBitmap` without copying.
///
/// Takes the cels BY VALUE and drops each one as its bytes are copied. A busy
/// 300-layer .kra runs to ~120 MB of raw RGBA; holding the source cels and the
/// finished pack alive at the same time would double that for no reason.
fn pack_cels(cels: Vec<Cel>) -> Vec<u8> {
    const HEADER: usize = 8;
    const RECORD: usize = 32;
    let payload: usize = cels.iter().map(|c| c.rgba.len()).sum();
    let mut out = Vec::with_capacity(HEADER + RECORD * cels.len() + payload);
    out.extend_from_slice(&0x3152_594Cu32.to_le_bytes());
    out.extend_from_slice(&(cels.len() as u32).to_le_bytes());
    let mut offset = 0u32;
    for c in &cels {
        out.extend_from_slice(&c.layer.to_le_bytes());
        out.extend_from_slice(&c.frame.to_le_bytes());
        out.extend_from_slice(&c.x.to_le_bytes());
        out.extend_from_slice(&c.y.to_le_bytes());
        out.extend_from_slice(&c.w.to_le_bytes());
        out.extend_from_slice(&c.h.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(c.rgba.len() as u32).to_le_bytes());
        offset += c.rgba.len() as u32;
    }
    for c in cels {
        out.extend_from_slice(&c.rgba);
        // `c` (and its buffer) is freed here, before the next one is copied.
    }
    out
}

/// Tighten `rgba` (a `w`x`h` buffer whose top-left sits at canvas `x`,`y`) to
/// its opaque bounding box. Most layers cover a small part of the canvas, and a
/// cel's payload is the whole cost of this pipeline, so this is worth doing even
/// though the compositor would draw the transparent margin harmlessly.
/// Returns None when the layer is fully transparent — nothing to draw at all.
fn crop_opaque(rgba: Vec<u8>, x: i64, y: i64, w: usize, h: usize) -> Option<Cel> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (usize::MAX, usize::MAX, 0usize, 0usize);
    for row in 0..h {
        let base = row * w * 4;
        let mut first = None;
        let mut last = 0usize;
        for col in 0..w {
            if rgba[base + col * 4 + 3] != 0 {
                if first.is_none() {
                    first = Some(col);
                }
                last = col;
            }
        }
        if let Some(f) = first {
            if min_y == usize::MAX {
                min_y = row;
            }
            max_y = row;
            min_x = min_x.min(f);
            max_x = max_x.max(last);
        }
    }
    if min_y == usize::MAX {
        return None;
    }
    let (cw, ch) = (max_x - min_x + 1, max_y - min_y + 1);
    let mut cropped = vec![0u8; cw * ch * 4];
    for row in 0..ch {
        let src = ((min_y + row) * w + min_x) * 4;
        let dst = row * cw * 4;
        cropped[dst..dst + cw * 4].copy_from_slice(&rgba[src..src + cw * 4]);
    }
    Some(Cel {
        layer: -1,
        frame: 0,
        x: (x + min_x as i64) as i32,
        y: (y + min_y as i64) as i32,
        w: cw as u32,
        h: ch as u32,
        rgba: cropped,
    })
}

// ---------------------------------------------------------------------------
// Krita
// ---------------------------------------------------------------------------

/// LibLZF decompression (the variant Krita uses for its layer tiles). A control
/// byte < 32 introduces a literal run of `ctrl + 1` bytes; otherwise it starts a
/// back-reference of `(ctrl >> 5) + 2` bytes (extended by one more byte when the
/// length nibble is 7) at offset `((ctrl & 0x1f) << 8 | next) + 1` behind the
/// output cursor. `expected` pre-sizes the buffer; a malformed stream returns
/// None rather than panicking. ~40 lines, so no crate (and no transitive deps).
fn lzf_decompress(input: &[u8], expected: usize) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(expected);
    let mut ip = 0usize;
    while ip < input.len() {
        let ctrl = input[ip] as usize;
        ip += 1;
        if ctrl < 32 {
            // Literal run.
            let len = ctrl + 1;
            if ip + len > input.len() {
                return None;
            }
            out.extend_from_slice(&input[ip..ip + len]);
            ip += len;
        } else {
            // Back-reference.
            let mut len = ctrl >> 5;
            if len == 7 {
                if ip >= input.len() {
                    return None;
                }
                len += input[ip] as usize;
                ip += 1;
            }
            if ip >= input.len() {
                return None;
            }
            let off = ((ctrl & 0x1f) << 8) | input[ip] as usize;
            ip += 1;
            let mut src = out.len().checked_sub(off + 1)?;
            for _ in 0..len + 2 {
                let b = *out.get(src)?;
                out.push(b);
                src += 1;
            }
        }
    }
    Some(out)
}

/// Per-channel storage in a Krita tile.
#[derive(Clone, Copy, PartialEq)]
enum Depth {
    U8,
    U16,
    /// IEEE half.
    F16,
    F32,
}

impl Depth {
    fn bytes(self) -> usize {
        match self {
            Depth::U8 => 1,
            Depth::U16 | Depth::F16 => 2,
            Depth::F32 => 4,
        }
    }

    /// One channel, normalized to 8 bits. Float channels are scene-linear-ish in
    /// Krita's F16/F32 spaces but the merged PNG Krita itself writes is a plain
    /// clamp, so clamping matches what the user saw at save time.
    fn read(self, b: &[u8]) -> u8 {
        match self {
            Depth::U8 => b[0],
            Depth::U16 => b[1], // little-endian: high byte is the 8-bit value
            Depth::F16 => f32_to_u8(half_to_f32(u16::from_le_bytes([b[0], b[1]]))),
            Depth::F32 => {
                f32_to_u8(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            }
        }
    }
}

fn f32_to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// IEEE 754 binary16 → f32. Handles subnormals and inf/NaN; ~10 lines beats a
/// crate for the one place we need it.
fn half_to_f32(h: u16) -> f32 {
    let sign = ((h >> 15) & 1) as u32;
    let exp = ((h >> 10) & 0x1f) as u32;
    let frac = (h & 0x3ff) as u32;
    let bits = if exp == 0 {
        if frac == 0 {
            sign << 31
        } else {
            // Subnormal: renormalize into a float32 exponent.
            let mut e = -1i32;
            let mut f = frac;
            while f & 0x400 == 0 {
                f <<= 1;
                e -= 1;
            }
            let f = f & 0x3ff;
            (sign << 31) | (((127 - 15 + e) as u32) << 23) | (f << 13)
        }
    } else if exp == 0x1f {
        (sign << 31) | (0xff << 23) | (frac << 13)
    } else {
        (sign << 31) | ((exp + 127 - 15) << 23) | (frac << 13)
    };
    f32::from_bits(bits)
}

/// How one pixel is laid out in a layer's (planar) tile data.
#[derive(Clone, Copy)]
struct PixelSpec {
    /// Channels per pixel: 4 = BGRA, 2 = gray+alpha, 1 = alpha only.
    n: usize,
    depth: Depth,
}

impl PixelSpec {
    fn size(self) -> usize {
        self.n * self.depth.bytes()
    }

    /// Krita's `colorspacename` attribute → layout. `pixel_size` (from the tile
    /// header) is the tie-breaker and the fallback: GRAYA16 and RGBA both have
    /// PIXELSIZE 4, so the name is what tells them apart, but plenty of nodes
    /// (masks especially) carry no name at all.
    fn parse(name: Option<&str>, pixel_size: usize) -> Option<PixelSpec> {
        let spec = match name.unwrap_or("").to_ascii_uppercase().as_str() {
            "RGBA" => Some(PixelSpec { n: 4, depth: Depth::U8 }),
            "RGBA16" => Some(PixelSpec { n: 4, depth: Depth::U16 }),
            "RGBAF16" => Some(PixelSpec { n: 4, depth: Depth::F16 }),
            "RGBAF32" => Some(PixelSpec { n: 4, depth: Depth::F32 }),
            "GRAYA" => Some(PixelSpec { n: 2, depth: Depth::U8 }),
            "GRAYA16" => Some(PixelSpec { n: 2, depth: Depth::U16 }),
            "GRAYAF16" => Some(PixelSpec { n: 2, depth: Depth::F16 }),
            "GRAYAF32" => Some(PixelSpec { n: 2, depth: Depth::F32 }),
            "ALPHA" | "ALPHA8" => Some(PixelSpec { n: 1, depth: Depth::U8 }),
            "ALPHA16" => Some(PixelSpec { n: 1, depth: Depth::U16 }),
            _ => None,
        };
        // Trust the name only when it agrees with the bytes actually stored.
        match spec {
            Some(s) if s.size() == pixel_size => Some(s),
            _ => match pixel_size {
                1 => Some(PixelSpec { n: 1, depth: Depth::U8 }),
                2 => Some(PixelSpec { n: 2, depth: Depth::U8 }),
                4 => Some(PixelSpec { n: 4, depth: Depth::U8 }),
                8 => Some(PixelSpec { n: 4, depth: Depth::U16 }),
                16 => Some(PixelSpec { n: 4, depth: Depth::F32 }),
                _ => None,
            },
        }
    }
}

/// A decoded Krita node's pixels, in canvas space.
struct Plane {
    x: i64,
    y: i64,
    w: usize,
    h: usize,
    /// RGBA8 when `rgba`, single-byte alpha otherwise.
    data: Vec<u8>,
    rgba: bool,
}

impl Plane {
    /// Alpha at a canvas pixel, or `outside` when the point is beyond the tiles
    /// this node actually stored.
    fn alpha_at(&self, cx: i64, cy: i64, outside: u8) -> u8 {
        if cx < self.x || cy < self.y {
            return outside;
        }
        let (dx, dy) = ((cx - self.x) as usize, (cy - self.y) as usize);
        if dx >= self.w || dy >= self.h {
            return outside;
        }
        if self.rgba {
            self.data[(dy * self.w + dx) * 4 + 3]
        } else {
            self.data[dy * self.w + dx]
        }
    }
}

/// Read one `\n`-terminated line, advancing `pos` past the newline.
fn read_line(data: &[u8], pos: &mut usize) -> Option<String> {
    let start = *pos;
    while *pos < data.len() && data[*pos] != b'\n' {
        *pos += 1;
    }
    if *pos >= data.len() {
        return None;
    }
    let line = String::from_utf8_lossy(&data[start..*pos]).into_owned();
    *pos += 1;
    Some(line)
}

/// Decode one Krita node's tile file into a canvas-space [`Plane`].
///
/// The file is a tiny ASCII header (`VERSION`/`TILEWIDTH`/`TILEHEIGHT`/
/// `PIXELSIZE`/`DATA <count>`) followed by `count` tiles, each a
/// `left,top,LZF,bytes` header line then `bytes` of data whose first byte is a
/// compression flag (1 = LZF). Krita de-interleaves the channels before
/// compressing, so a decompressed tile is PLANAR — every byte of channel 0, then
/// channel 1, and so on — and RGB colorspaces are stored B, G, R, A at every
/// depth (Krita's `KoBgrTraits<T>`, a Qt inheritance).
///
/// Tiles are placed at `tile_pos + (off_x, off_y)`, the node's device offset from
/// maindoc. The output buffer covers only the UNION of the stored tiles clipped
/// to the canvas — a 200-layer document on a 4K canvas would otherwise allocate
/// 200 x 64 MB of mostly-empty RGBA just to throw it away at the crop step.
fn kra_tiles(
    data: &[u8],
    off_x: i64,
    off_y: i64,
    canvas_w: u32,
    canvas_h: u32,
    colorspace: Option<&str>,
    want_rgba: bool,
) -> Option<Plane> {
    let mut pos = 0usize;
    let (mut tw, mut th, mut ps) = (0usize, 0usize, 0usize);
    let ntiles: usize = loop {
        let line = read_line(data, &mut pos)?;
        let line = line.trim();
        if let Some(v) = line.strip_prefix("TILEWIDTH ") {
            tw = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("TILEHEIGHT ") {
            th = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("PIXELSIZE ") {
            ps = v.trim().parse().ok()?;
        } else if let Some(v) = line.strip_prefix("DATA ") {
            break v.trim().parse().ok()?;
        }
        // VERSION and any unknown header lines are ignored.
    };
    if tw == 0 || th == 0 || ps == 0 {
        return None;
    }
    let spec = PixelSpec::parse(colorspace, ps)?;
    let plane = tw.checked_mul(th)?;
    let tile_len = plane.checked_mul(ps)?;

    // Pass 1: walk the tile chain for positions only, so the output buffer can
    // be sized to what the layer actually covers.
    let mut tiles: Vec<(i64, i64, usize, usize)> = Vec::with_capacity(ntiles);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
    for _ in 0..ntiles {
        let header = read_line(data, &mut pos)?;
        let parts: Vec<&str> = header.trim().split(',').collect();
        if parts.len() < 4 {
            return None;
        }
        let left: i64 = parts[0].trim().parse().ok()?;
        let top: i64 = parts[1].trim().parse().ok()?;
        // parts[2] is the compression name ("LZF").
        let dsize: usize = parts[3].trim().parse().ok()?;
        if dsize == 0 || pos + dsize > data.len() {
            return None;
        }
        tiles.push((left + off_x, top + off_y, pos, dsize));
        pos += dsize;
        min_x = min_x.min(left + off_x);
        min_y = min_y.min(top + off_y);
        max_x = max_x.max(left + off_x + tw as i64);
        max_y = max_y.max(top + off_y + th as i64);
    }
    if tiles.is_empty() {
        return None;
    }
    // Clip the union to the canvas — tiles routinely hang off the edges.
    let x0 = min_x.max(0);
    let y0 = min_y.max(0);
    let x1 = max_x.min(canvas_w as i64);
    let y1 = max_y.min(canvas_h as i64);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (bw, bh) = ((x1 - x0) as usize, (y1 - y0) as usize);
    let stride = if want_rgba { 4 } else { 1 };
    let mut out = vec![0u8; bw.checked_mul(bh)?.checked_mul(stride)?];

    // Pass 2: decompress and de-planarize into the buffer.
    let cbytes = spec.depth.bytes();
    for (tx, ty, start, dsize) in tiles {
        let blob = &data[start..start + dsize];
        let compressed = blob[0] != 0;
        let payload = &blob[1..];
        let tile = if compressed {
            match lzf_decompress(payload, tile_len) {
                Some(t) => t,
                None => continue, // one bad tile shouldn't lose the layer
            }
        } else {
            payload.to_vec()
        };
        if tile.len() < tile_len {
            continue;
        }
        for py in 0..th {
            let cy = ty + py as i64;
            if cy < y0 || cy >= y1 {
                continue;
            }
            let row = (cy - y0) as usize * bw;
            for px in 0..tw {
                let cx = tx + px as i64;
                if cx < x0 || cx >= x1 {
                    continue;
                }
                let idx = py * tw + px;
                let o = (row + (cx - x0) as usize) * stride;
                // Channel c of pixel `idx` lives at plane c, offset idx.
                let ch = |c: usize| spec.depth.read(&tile[(c * plane + idx) * cbytes..]);
                match (spec.n, want_rgba) {
                    (4, true) => {
                        out[o] = ch(2); // R (stored B,G,R,A)
                        out[o + 1] = ch(1);
                        out[o + 2] = ch(0);
                        out[o + 3] = ch(3);
                    }
                    (2, true) => {
                        let g = ch(0);
                        out[o] = g;
                        out[o + 1] = g;
                        out[o + 2] = g;
                        out[o + 3] = ch(1);
                    }
                    (1, true) => {
                        out[o] = 0;
                        out[o + 1] = 0;
                        out[o + 2] = 0;
                        out[o + 3] = ch(0);
                    }
                    // Alpha-only output (masks): take the last channel, which is
                    // alpha for BGRA/gray+alpha and the value itself for ALPHA.
                    (n, false) => out[o] = ch(n - 1),
                    _ => return None,
                }
            }
        }
    }
    Some(Plane { x: x0, y: y0, w: bw, h: bh, data: out, rgba: want_rgba })
}

/// A Krita node parsed from maindoc.xml (tree order, top-first). Covers `<layer>`
/// and `<mask>` elements alike — masks are children of the layer they modify.
struct KraNode {
    name: String,
    filename: String,
    nodetype: String,
    colorspace: Option<String>,
    opacity: f32,
    blend: String,
    visible: bool,
    depth: u32,
    parent: i32,
    /// Layer device offset from maindoc — Krita stores tiles in the node's LOCAL
    /// coordinate space and translates the whole device by (x, y) when
    /// compositing, so a tile at grid (tx, ty) lands at canvas (tx+x, ty+y).
    x: i64,
    y: i64,
    /// "Inherit alpha" — channelflags with the alpha bit cleared ("1110").
    clip: bool,
    /// Pass-through group.
    passthrough: bool,
}

impl KraNode {
    fn is_group(&self) -> bool {
        self.nodetype == "grouplayer"
    }
    fn is_paint(&self) -> bool {
        self.nodetype == "paintlayer"
    }
    /// Nodes whose alpha multiplies into the layer they hang off. Krita's
    /// transparency mask is the direct analogue of a Photoshop layer mask, and
    /// is the one mask type we can honour exactly.
    fn is_transparency_mask(&self) -> bool {
        self.nodetype == "transparencymask"
    }
    /// Shown in the tree, never composited.
    fn is_inert(&self) -> bool {
        !self.is_paint() && !self.is_group()
    }
    fn kind(&self) -> &'static str {
        match self.nodetype.as_str() {
            "paintlayer" => "paint",
            "grouplayer" => "group",
            "transparencymask" | "selectionmask" | "colorizemask" | "transformmask" => "mask",
            "filtermask" | "adjustmentlayer" => "filter",
            "shapelayer" => "vector",
            "clonelayer" => "clone",
            "filelayer" => "file",
            _ => "other",
        }
    }
}

fn kra_walk(parent_el: roxmltree::Node, depth: u32, parent: i32, out: &mut Vec<KraNode>) {
    // A layer's own masks are listed under <masks>; treat them as children so
    // the panel shows them nested under the layer they modify.
    let is_node = |c: &roxmltree::Node| {
        c.is_element() && matches!(c.tag_name().name(), "layer" | "mask")
    };
    for el in parent_el.children().filter(is_node) {
        let nodetype = el.attribute("nodetype").unwrap_or("").to_string();
        let idx = out.len() as i32;
        out.push(KraNode {
            name: el.attribute("name").unwrap_or("").to_string(),
            filename: el.attribute("filename").unwrap_or("").to_string(),
            nodetype,
            colorspace: el.attribute("colorspacename").map(str::to_string),
            opacity: el.attribute("opacity").and_then(|s| s.parse::<f32>().ok()).unwrap_or(255.0)
                / 255.0,
            blend: el.attribute("compositeop").unwrap_or("normal").to_string(),
            visible: el.attribute("visible").map(|s| s != "0").unwrap_or(true),
            depth,
            parent,
            x: el.attribute("x").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
            y: el.attribute("y").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
            // channelflags is per-channel enable "RGBA"; alpha bit cleared ("1110")
            // is Krita's "inherit alpha" (clip to below). Empty = all channels on.
            clip: el.attribute("channelflags").unwrap_or("").as_bytes().get(3) == Some(&b'0'),
            passthrough: el.attribute("passthrough") == Some("1"),
        });
        for sub in el
            .children()
            .filter(|c| c.is_element() && matches!(c.tag_name().name(), "layers" | "masks"))
        {
            kra_walk(sub, depth + 1, idx, out);
        }
    }
}

/// Parse a .kra's maindoc.xml into (width, height, image name, nodes). Cheap —
/// just an XML walk, no tile decoding.
fn kra_parse(p: &Path) -> Option<(u32, u32, String, Vec<KraNode>)> {
    let file = std::fs::File::open(p).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut xml = String::new();
    zip.by_name("maindoc.xml").ok()?.read_to_string(&mut xml).ok()?;
    let opts = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = match roxmltree::Document::parse_with_options(&xml, opts) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[kra] {}: maindoc parse ({e})", p.display());
            return None;
        }
    };
    let image = doc.descendants().find(|nd| nd.tag_name().name() == "IMAGE")?;
    let img_name = image.attribute("name").unwrap_or("").to_string();
    let w = image.attribute("width").and_then(|s| s.parse().ok())?;
    let h = image.attribute("height").and_then(|s| s.parse().ok())?;
    let top = image.children().find(|c| c.is_element() && c.tag_name().name() == "layers")?;
    let mut nodes = Vec::new();
    kra_walk(top, 0, -1, &mut nodes);
    Some((w, h, img_name, nodes))
}

fn kra_doc(p: &Path) -> Option<LayerDoc> {
    let (w, h, _img, nodes) = kra_parse(p)?;
    let masked: Vec<bool> = nodes
        .iter()
        .enumerate()
        .map(|(i, _)| {
            nodes.iter().any(|m| m.parent == i as i32 && m.is_transparency_mask() && m.visible)
        })
        .collect();
    let layers = nodes
        .iter()
        .enumerate()
        .map(|(i, nd)| LayerNode {
            name: nd.name.clone(),
            kind: nd.kind().to_string(),
            opacity: nd.opacity,
            blend: nd.blend.clone(),
            visible: nd.visible,
            depth: nd.depth,
            is_group: nd.is_group(),
            parent: nd.parent,
            clip: nd.clip && !nd.is_group(),
            passthrough: nd.passthrough && nd.is_group(),
            masked: masked[i],
            inert: nd.is_inert(),
        })
        .collect();
    Some(LayerDoc {
        width: w,
        height: h,
        layered: nodes.iter().any(KraNode::is_paint),
        layers,
        frames: vec![FrameMeta { duration_ms: 0 }],
        tags: Vec::new(),
        merged: true,
        merged_exact: true,
    })
}

/// Read a node's tile file out of the archive. Krita names every node's data
/// `<image name>/layers/<filename>`, masks included.
fn kra_blob(zip: &mut zip::ZipArchive<std::fs::File>, img: &str, filename: &str) -> Option<Vec<u8>> {
    if filename.is_empty() {
        return None;
    }
    let path = format!("{img}/layers/{filename}");
    let mut bytes = Vec::new();
    zip.by_name(&path).ok()?.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

/// The alpha Krita uses OUTSIDE a node's stored tiles. Written next to the tile
/// file as `<filename>.defaultpixel`, one raw pixel in the node's own layout.
/// It matters for transparency masks: a mask whose default is opaque must not
/// erase everything its tiles don't cover (and vice versa).
fn kra_default_alpha(
    zip: &mut zip::ZipArchive<std::fs::File>,
    img: &str,
    filename: &str,
    colorspace: Option<&str>,
) -> u8 {
    let Some(bytes) = kra_blob(zip, img, &format!("{filename}.defaultpixel")) else {
        return 0;
    };
    let Some(spec) = PixelSpec::parse(colorspace, bytes.len()) else { return 0 };
    let cb = spec.depth.bytes();
    let last = (spec.n - 1) * cb;
    if bytes.len() < last + cb {
        return 0;
    }
    spec.depth.read(&bytes[last..])
}

/// The HEAVY half of a Krita decode: assemble every paint layer's tiles, apply
/// its transparency masks, crop to the opaque box — in parallel.
fn kra_cels(p: &Path) -> Vec<Cel> {
    use rayon::prelude::*;
    let Some((w, h, img_name, nodes)) = kra_parse(p) else { return Vec::new() };
    let Ok(file) = std::fs::File::open(p) else { return Vec::new() };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return Vec::new() };

    // Read the raw blobs sequentially (a zip reader is single-threaded), then
    // decode them in parallel. Each job carries its layer's blob plus the blobs
    // of the transparency masks hanging off it.
    struct Job {
        idx: usize,
        bytes: Vec<u8>,
        colorspace: Option<String>,
        x: i64,
        y: i64,
        masks: Vec<(Vec<u8>, Option<String>, i64, i64, u8)>,
    }
    let mut jobs: Vec<Job> = Vec::new();
    for (idx, nd) in nodes.iter().enumerate() {
        if !nd.is_paint() {
            continue;
        }
        let Some(bytes) = kra_blob(&mut zip, &img_name, &nd.filename) else { continue };
        let masks = nodes
            .iter()
            .filter(|m| m.parent == idx as i32 && m.is_transparency_mask() && m.visible)
            .filter_map(|m| {
                let b = kra_blob(&mut zip, &img_name, &m.filename)?;
                let d = kra_default_alpha(&mut zip, &img_name, &m.filename, m.colorspace.as_deref());
                Some((b, m.colorspace.clone(), m.x, m.y, d))
            })
            .collect();
        jobs.push(Job {
            idx,
            bytes,
            colorspace: nd.colorspace.clone(),
            x: nd.x,
            y: nd.y,
            masks,
        });
    }

    jobs.par_iter()
        .filter_map(|job| {
            let mut plane =
                kra_tiles(&job.bytes, job.x, job.y, w, h, job.colorspace.as_deref(), true)?;
            for (bytes, cs, mx, my, default) in &job.masks {
                let Some(mask) = kra_tiles(bytes, *mx, *my, w, h, cs.as_deref(), false) else {
                    // No tiles at all: the whole mask is its default pixel.
                    if *default == 0 {
                        return None; // fully masked out
                    }
                    continue;
                };
                for row in 0..plane.h {
                    let cy = plane.y + row as i64;
                    for col in 0..plane.w {
                        let a = &mut plane.data[(row * plane.w + col) * 4 + 3];
                        let m = mask.alpha_at(plane.x + col as i64, cy, *default) as u32;
                        *a = ((*a as u32 * m + 127) / 255) as u8;
                    }
                }
            }
            let mut cel = crop_opaque(plane.data, plane.x, plane.y, plane.w, plane.h)?;
            cel.layer = job.idx as i32;
            Some(cel)
        })
        .collect()
}

/// Cache of PSD merged previews, keyed by (path, mtime, requested size). Small
/// by design — it exists so reopening a document, or asking for a size already
/// served, is transfer-only.
type MergedKey = (String, u64, u32);
static PSD_MERGED_CACHE: std::sync::Mutex<Vec<(MergedKey, std::sync::Arc<Vec<u8>>)>> =
    std::sync::Mutex::new(Vec::new());

/// The PSD composite as a single-record LYR1 cel pack (layer -1), decoded at
/// `max_edge` by [`psdcomp`] — which reads only the rows that size samples.
fn psd_merged_pack(p: &Path, max_edge: u32) -> Option<Vec<u8>> {
    let mtime = std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key: MergedKey = (p.to_string_lossy().to_string(), mtime, max_edge);
    if let Some(hit) = PSD_MERGED_CACHE.lock().ok()?.iter().find(|(k, _)| *k == key) {
        return Some(hit.1.as_ref().clone());
    }
    let c = psdcomp::from_file(p, max_edge)?;
    let pack = pack_cels(vec![Cel {
        layer: -1,
        frame: 0,
        x: 0,
        y: 0,
        w: c.width,
        h: c.height,
        rgba: c.rgba,
    }]);
    let mut cache = PSD_MERGED_CACHE.lock().ok()?;
    if cache.len() >= 6 {
        cache.remove(0);
    }
    cache.push((key, std::sync::Arc::new(pack.clone())));
    Some(pack)
}

/// Krita's own flattened image, straight out of the archive — no decode, no
/// re-encode. This is the pixel-exact default preview.
fn kra_merged_png(p: &Path) -> Option<Vec<u8>> {
    let file = std::fs::File::open(p).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    for name in ["mergedimage.png", "preview.png"] {
        if let Ok(mut e) = zip.by_name(name) {
            let mut buf = Vec::with_capacity(e.size() as usize);
            if e.read_to_end(&mut buf).is_ok() {
                return Some(buf);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Aseprite
// ---------------------------------------------------------------------------

/// Layers are presented TOP-first (index 0 = topmost) to match Krita and the
/// panel; Aseprite stores them bottom-first. Returns (old ids top-first, old→new).
fn ase_order(n: u32) -> (Vec<u32>, Vec<i32>) {
    let order: Vec<u32> = (0..n).rev().collect();
    let mut new_of = vec![-1i32; n as usize];
    for (ni, &old) in order.iter().enumerate() {
        new_of[old as usize] = ni as i32;
    }
    (order, new_of)
}

fn ase_doc(p: &Path) -> Result<LayerDoc, String> {
    let ase = ah_asefile::AsepriteFile::read_file(p).map_err(|e| e.to_string())?;
    let n = ase.num_layers();
    let (order, new_of) = ase_order(n);
    let layers = order
        .iter()
        .map(|&old| {
            let l = ase.layer(old);
            let mut depth = 0u32;
            let mut pid = l.parent().map(|p| p.id());
            while let Some(id) = pid {
                depth += 1;
                pid = ase.layer(id).parent().map(|p| p.id());
            }
            let is_group = matches!(l.layer_type(), ah_asefile::LayerType::Group);
            // Aseprite group layers carry an opacity byte that is usually 0
            // ("unset") — Aseprite itself ignores it. Applying it would multiply
            // the whole group to nothing, so treat a group's zero as opaque.
            //
            // A PAINT layer's opacity is deliberately reported as 1: asefile
            // bakes layer opacity x cel opacity into the cel pixels it hands us,
            // so the compositor must not apply it a second time.
            let opacity = if is_group {
                if l.opacity() == 0 { 1.0 } else { l.opacity() as f32 / 255.0 }
            } else {
                1.0
            };
            LayerNode {
                name: l.name().to_string(),
                kind: if is_group { "group" } else { "paint" }.to_string(),
                opacity,
                blend: format!("{:?}", l.blend_mode()).to_ascii_lowercase(),
                visible: l.flags().contains(ah_asefile::LayerFlags::VISIBLE),
                depth,
                is_group,
                parent: l.parent().map(|p| new_of[p.id() as usize]).unwrap_or(-1),
                clip: false,
                passthrough: false,
                masked: false,
                inert: false,
            }
        })
        .collect();
    let frames = (0..ase.num_frames())
        .map(|f| FrameMeta { duration_ms: ase.frame(f).duration() })
        .collect();
    let tags = (0..ase.num_tags())
        .map(|i| {
            let t = ase.tag(i);
            TagMeta {
                name: t.name().to_string(),
                from: t.from_frame(),
                to: t.to_frame(),
                direction: format!("{:?}", t.animation_direction()).to_ascii_lowercase(),
            }
        })
        .collect();
    Ok(LayerDoc {
        width: ase.width() as u32,
        height: ase.height() as u32,
        layered: true,
        layers,
        frames,
        tags,
        // Frame 0's composite, purely as a placeholder — see `merged_exact`.
        merged: true,
        merged_exact: false,
    })
}

fn ase_cels(p: &Path) -> Vec<Cel> {
    use rayon::prelude::*;
    let Ok(ase) = ah_asefile::AsepriteFile::read_file(p) else { return Vec::new() };
    let (w, h) = (ase.width() as usize, ase.height() as usize);
    let n = ase.num_layers();
    let (_, new_of) = ase_order(n);
    // (frame, old layer id) for every non-empty cel. asefile's reader is
    // read-only and Sync, so the per-cel rasterize parallelizes directly.
    let ids: Vec<(u32, u32)> = (0..ase.num_frames())
        .flat_map(|f| (0..n).map(move |l| (f, l)))
        .filter(|&(f, l)| !ase.cel(f, l).is_empty())
        .collect();
    ids.par_iter()
        .filter_map(|&(f, old)| {
            // `cel.image()` is full-canvas with the cel written into it, and
            // asefile has already folded layer x cel opacity into its alpha.
            // Crop it back down to the pixels that are actually there.
            let img = ase.cel(f, old).image();
            if img.width() as usize != w || img.height() as usize != h {
                return None;
            }
            let mut cel = crop_opaque(img.into_raw(), 0, 0, w, h)?;
            cel.layer = new_of[old as usize];
            cel.frame = f;
            Some(cel)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

fn doc_inner(p: &Path) -> Result<LayerDoc, String> {
    match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("aseprite") | Some("ase") => ase_doc(p),
        Some("kra") => kra_doc(p).ok_or_else(|| "kra: unreadable maindoc".to_string()),
        _ => Err("not a layered art file".into()),
    }
}

/// The layer tree, frame timings and tags for a kra/aseprite file. Metadata
/// only — pixels come over the `cels` scheme. Panic-safe like `decode_image`
/// (asefile panics on some malformed inputs).
#[tauri::command]
pub fn layer_doc(app: tauri::AppHandle, path: String) -> Result<LayerDoc, String> {
    let p = Path::new(&path);
    if !crate::scanner::is_within_roots(&app, p) {
        return Err("out of scope".into());
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc_inner(p)))
        .unwrap_or_else(|_| Err("layered: decoder panicked".into()))
}

/// Every cel in the document, packed for the `cels` scheme. Empty on any
/// failure — the view falls back to the flattened image.
pub fn cel_pack(app: &tauri::AppHandle, path: &str) -> Option<Vec<u8>> {
    let p = Path::new(path);
    if !crate::scanner::is_within_roots(app, p) {
        return None;
    }
    let cels = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("kra") => kra_cels(p),
            Some("aseprite") | Some("ase") => ase_cels(p),
            _ => Vec::new(),
        }
    }))
    .unwrap_or_else(|_| {
        eprintln!("[layered] {}: cel decode panicked", p.display());
        Vec::new()
    });
    Some(pack_cels(cels))
}

/// Aseprite's own composite of frame 0, PNG-encoded. Just a placeholder to fill
/// the gap before the cels arrive (see `LayerDoc::merged_exact`), so it is worth
/// the one encode and nothing more.
fn ase_first_frame_png(p: &Path) -> Option<Vec<u8>> {
    let ase = ah_asefile::AsepriteFile::read_file(p).ok()?;
    let frame = ase.frame(0).image();
    let (w, h) = (frame.width(), frame.height());
    let buf = image::RgbaImage::from_raw(w, h, frame.into_raw())?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(buf)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

/// The document's own flattened image: PNG bytes for Krita/Aseprite, a
/// single-record LYR1 cel pack for Photoshop (downscaled — see
/// [`psdcomp::from_file`]). The mime tells the worker which decode to use.
/// Length of the file prefix that contains a PSD's whole layer tree, plus the
/// file's total size, as `"<prefix> <total>"`.
///
/// The webview uses it to Range-fetch just that prefix and parse the tree from
/// it, so the layer panel appears without waiting for tens of megabytes of
/// pixel data it does not need yet.
pub fn psd_prefix(app: &tauri::AppHandle, path: &str) -> Option<Vec<u8>> {
    let p = Path::new(path);
    if !crate::scanner::is_within_roots(app, p) {
        return None;
    }
    let total = std::fs::metadata(p).ok()?.len();
    let prefix = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| psdcomp::records_end(p)))
        .ok()
        .flatten()?;
    Some(format!("{prefix} {total}").into_bytes())
}

pub fn merged_bytes(
    app: &tauri::AppHandle,
    path: &str,
    max_edge: u32,
) -> Option<(Vec<u8>, &'static str)> {
    let p = Path::new(path);
    if !crate::scanner::is_within_roots(app, p) {
        return None;
    }
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
            Some("kra") => kra_merged_png(p).map(|b| (b, "image/png")),
            Some("aseprite") | Some("ase") => ase_first_frame_png(p).map(|b| (b, "image/png")),
            Some("psd") | Some("psb") => {
                psd_merged_pack(p, max_edge).map(|b| (b, "application/octet-stream"))
            }
            _ => None,
        }
    }))
    .unwrap_or(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_floats_round_trip_the_endpoints() {
        assert_eq!(half_to_f32(0x0000), 0.0);
        assert_eq!(half_to_f32(0x3C00), 1.0);
        assert_eq!(half_to_f32(0x3800), 0.5);
        assert!(half_to_f32(0x0001) > 0.0); // smallest subnormal
    }

    #[test]
    fn pixel_spec_falls_back_to_the_stored_size() {
        // GRAYA16 and RGBA both store 4 bytes; only the name separates them.
        assert_eq!(PixelSpec::parse(Some("GRAYA16"), 4).unwrap().n, 2);
        assert_eq!(PixelSpec::parse(Some("RGBA"), 4).unwrap().n, 4);
        // A name that disagrees with the bytes is ignored.
        assert_eq!(PixelSpec::parse(Some("RGBAF32"), 4).unwrap().n, 4);
        // Masks carry no colorspace at all.
        assert_eq!(PixelSpec::parse(None, 1).unwrap().n, 1);
        assert!(PixelSpec::parse(None, 3).is_none());
    }

    #[test]
    fn crop_drops_the_transparent_margin() {
        let (w, h) = (4usize, 4usize);
        let mut px = vec![0u8; w * h * 4];
        // One opaque pixel at (2, 1).
        px[(1 * w + 2) * 4 + 3] = 255;
        let cel = crop_opaque(px, 10, 20, w, h).unwrap();
        assert_eq!((cel.x, cel.y, cel.w, cel.h), (12, 21, 1, 1));
        let empty = crop_opaque(vec![0u8; w * h * 4], 0, 0, w, h);
        assert!(empty.is_none());
    }

    /// Build one Krita tile file: the ASCII header, then a single uncompressed
    /// tile at (0,0). `planes` is the PLANAR pixel data — every byte of channel
    /// 0, then channel 1, and so on — exactly as Krita stores it.
    fn tile_file(pixel_size: usize, planes: &[u8]) -> Vec<u8> {
        let tile_len = 64 * 64 * pixel_size;
        assert_eq!(planes.len(), tile_len);
        let mut out =
            format!("VERSION 2\nTILEWIDTH 64\nTILEHEIGHT 64\nPIXELSIZE {pixel_size}\nDATA 1\n")
                .into_bytes();
        out.extend_from_slice(format!("0,0,LZF,{}\n", tile_len + 1).as_bytes());
        out.push(0); // not compressed
        out.extend_from_slice(planes);
        out
    }

    /// A .kra holding one 4x4 paint layer with a transparency mask over it.
    fn write_masked_kra(path: &Path) {
        let mut layer = vec![0u8; 64 * 64 * 4];
        let plane = 64 * 64;
        // Pixel (0,0): B=10 G=20 R=30 A=255. Everything else stays transparent.
        layer[0] = 10;
        layer[plane] = 20;
        layer[2 * plane] = 30;
        layer[3 * plane] = 255;
        // Pixel (1,0) is opaque too, so the mask has something to erase.
        layer[1] = 40;
        layer[plane + 1] = 50;
        layer[2 * plane + 1] = 60;
        layer[3 * plane + 1] = 255;

        // Alpha-only mask: keep (0,0) at half strength, erase (1,0) outright.
        let mut mask = vec![0u8; 64 * 64];
        mask[0] = 128;
        mask[1] = 0;

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DOC>
 <IMAGE name="doc" width="4" height="4">
  <layers>
   <layer nodetype="paintlayer" name="Paint" filename="layer2" opacity="255"
          visible="1" x="0" y="0" colorspacename="RGBA">
    <masks>
     <mask nodetype="transparencymask" name="Mask" filename="layer3" visible="1" x="0" y="0"/>
    </masks>
   </layer>
   <layer nodetype="selectionmask" name="Sel" filename="layer4" visible="1" x="0" y="0"/>
  </layers>
 </IMAGE>
</DOC>"#;

        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in [
            ("maindoc.xml", xml.as_bytes().to_vec()),
            ("doc/layers/layer2", tile_file(4, &layer)),
            ("doc/layers/layer3", tile_file(1, &mask)),
        ] {
            use std::io::Write as _;
            zip.start_file(name, opts).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn kra_reads_a_layer_tree_with_masks() {
        let path = std::env::temp_dir().join("gab-layered-tree.kra");
        write_masked_kra(&path);
        let doc = kra_doc(&path).expect("doc");
        assert_eq!((doc.width, doc.height), (4, 4));
        assert!(doc.layered);
        // The mask is a NODE in the tree, nested under the layer it modifies,
        // and the selection mask is listed but flagged as never rendered.
        assert_eq!(doc.layers.len(), 3);
        assert_eq!(doc.layers[0].kind, "paint");
        assert!(doc.layers[0].masked, "the paint layer reports its mask");
        assert_eq!(doc.layers[1].kind, "mask");
        assert_eq!(doc.layers[1].parent, 0);
        assert_eq!(doc.layers[1].depth, 1);
        assert!(doc.layers[1].inert);
        assert!(doc.layers[2].inert, "a selection mask never composites");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn kra_bakes_the_transparency_mask_into_layer_alpha() {
        let path = std::env::temp_dir().join("gab-layered-mask.kra");
        write_masked_kra(&path);
        let cels = kra_cels(&path);
        assert_eq!(cels.len(), 1, "one paint layer, one cel");
        let cel = &cels[0];
        // (1,0) was masked to zero, so the opaque box is the single pixel (0,0).
        assert_eq!((cel.x, cel.y, cel.w, cel.h), (0, 0, 1, 1));
        // Stored B,G,R,A -> emitted R,G,B,A; alpha is 255 * 128/255 = 128.
        assert_eq!(cel.rgba, vec![30, 20, 10, 128]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pack_layout_is_header_records_payload() {
        let cels = vec![
            Cel { layer: 0, frame: 0, x: 1, y: 2, w: 1, h: 1, rgba: vec![1, 2, 3, 4] },
            Cel { layer: 3, frame: 1, x: 0, y: 0, w: 1, h: 1, rgba: vec![5, 6, 7, 8] },
        ];
        let packed = pack_cels(cels);
        assert_eq!(&packed[0..4], b"LYR1");
        assert_eq!(u32::from_le_bytes(packed[4..8].try_into().unwrap()), 2);
        // Second record's offset field sits at 8 + 32 + 24.
        let off = u32::from_le_bytes(packed[64..68].try_into().unwrap());
        assert_eq!(off, 4);
        assert_eq!(&packed[8 + 64..], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }
}
