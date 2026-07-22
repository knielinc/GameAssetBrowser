mod audio;
mod dupes;
mod explorer;
mod index;
mod metadata;
mod modeltex;
mod portable;
mod scanner;
mod spectrogram;
mod texmeta;
mod thumbcache;
mod thumbs;
mod types;
mod watcher;
mod waveform;
// winmode is Win32-only (tao maximize/fullscreen bug workaround). Off Windows a
// same-named stub keeps `winmode::set_fullscreen_smooth` — and the invoke
// contract — identical without the module having to compile the `windows` crate.
#[cfg(windows)]
mod winmode;
#[cfg(not(windows))]
#[path = "winmode_stub.rs"]
mod winmode;
mod workflow;

use audio::{AudioController, PlayerCmd};
use tauri::Manager;

/// Read a model (or one of its sibling textures / .bin chunks) for the
/// `model://` scheme.
///
/// The URL path is `/C:/Pack/model.gltf` (Windows) or `/home/u/Pack/model.gltf`
/// (Unix). The scope check is what actually matters for safety: without it a
/// crafted glTF could reference `../../../../etc/shadow` and exfiltrate it. Only
/// paths inside a root the user explicitly picked are served (is_within_roots
/// canonicalizes, resolving any `../` before the prefix test).
/// Resolve a scheme URL path to a real, in-scope file path. The scope check is
/// what makes serving arbitrary paths safe: only files inside a root the user
/// explicitly picked are reachable (is_within_roots canonicalizes, resolving
/// any `../` before the prefix test).
fn scoped_path(app: &tauri::AppHandle, uri_path: &str) -> Option<std::path::PathBuf> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'));
    if decoded.is_empty() {
        return None;
    }
    // The URL carries "/"-separated paths with the leading slash stripped. On
    // Windows rebuild "C:/Pack/x" -> "C:\Pack\x"; on Unix re-add the root that
    // trim_start_matches('/') removed ("home/u/x" -> "/home/u/x").
    #[cfg(windows)]
    let path = std::path::PathBuf::from(decoded.replace('/', "\\"));
    #[cfg(not(windows))]
    let path = std::path::PathBuf::from(format!("/{decoded}"));
    if !scanner::is_within_roots(app, &path) {
        eprintln!("[scheme] refused out-of-scope read: {}", path.display());
        return None;
    }
    Some(path)
}

fn model_bytes(app: &tauri::AppHandle, uri_path: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = scoped_path(app, uri_path)?;
    let bytes = std::fs::read(&path).ok()?;
    Some((bytes, mime_for(&path)))
}

/// Parse a single-range `Range: bytes=…` header into an inclusive `(start, end)`
/// clamped to the file. Handles the open (`bytes=N-`) and suffix (`bytes=-N`)
/// forms; multi-range is declined (None → caller serves the whole file).
fn parse_byte_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (s, e) = spec.split_once('-')?;
    if s.is_empty() {
        let n: u64 = e.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }
    let start: u64 = s.parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if e.is_empty() { total - 1 } else { e.parse::<u64>().ok()?.min(total - 1) };
    if start > end {
        return None;
    }
    Some((start, end))
}

/// Serve a document over `doc://`, honoring HTTP range requests. This is what
/// lets a 500 MB PDF open in a blink: pdf.js reads the file's cross-reference
/// table (a tail range) and then only the objects for the pages you view, via
/// `Range` GETs — never the whole file. A HEAD returns the size without a read;
/// md/txt fetch with no Range and get the full 200 as before.
fn doc_response(
    app: &tauri::AppHandle,
    uri_path: &str,
    range: Option<&str>,
    is_head: bool,
) -> tauri::http::Response<Vec<u8>> {
    let deny = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .expect("static response builds")
    };
    let Some(path) = scoped_path(app, uri_path) else {
        return deny(404);
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return deny(404);
    };
    let total = meta.len();
    let mime = mime_for(&path);
    // Content-Length is CORS-safelisted; Accept-Ranges / Content-Range are not,
    // so expose them for pdf.js's cross-origin fetch to read.
    let expose = "Content-Range, Content-Length, Accept-Ranges";

    if is_head {
        return tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Content-Length", total.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", expose)
            .body(Vec::new())
            .expect("head response builds");
    }

    if let Some((start, end)) = range.and_then(|r| parse_byte_range(r, total)) {
        use std::io::{Read, Seek, SeekFrom};
        let len = end - start + 1;
        let mut buf = vec![0u8; len as usize];
        let read = std::fs::File::open(&path).and_then(|mut f| {
            f.seek(SeekFrom::Start(start))?;
            f.read_exact(&mut buf)
        });
        if read.is_err() {
            return deny(404);
        }
        return tauri::http::Response::builder()
            .status(206)
            .header("Content-Type", mime)
            .header("Content-Range", format!("bytes {start}-{end}/{total}"))
            .header("Content-Length", len.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Expose-Headers", expose)
            .body(buf)
            .expect("range response builds");
    }

    let Ok(bytes) = std::fs::read(&path) else {
        return deny(404);
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Content-Length", total.to_string())
        .header("Accept-Ranges", "bytes")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", expose)
        .body(bytes)
        .expect("full response builds")
}

/// Content-Type by extension. Correct image MIMEs matter for the 2D preview:
/// with `image/gif` the browser ANIMATES the gif in an `<img>`, and a
/// browser-decodable original (png/webp) can be shown at full resolution
/// rather than through the 256px thumbnail. Everything else is served as
/// octet-stream — three.js loaders sniff their own formats.
fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("gif") => "image/gif",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("bmp") => "image/bmp",
        // Documents served over the `doc://` scheme. The frontend fetches these
        // as bytes/text (pdf.js takes the ArrayBuffer, md/txt are decoded as
        // UTF-8), so the Content-Type is advisory — but honest headers keep the
        // scheme reusable if anything ever loads a doc URL directly.
        Some("pdf") => "application/pdf",
        Some("md") | Some("markdown") => "text/markdown; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("psd") | Some("psb") => "image/vnd.adobe.photoshop",
        _ => "application/octet-stream",
    }
}

/// Minimal percent-decoder. glTF spec-compliant exporters encode URIs
/// (`wood%20wall.png`); MTL and FBX emit raw names with literal spaces. A
/// malformed `%` sequence is left as-is rather than throwing, because a
/// filename containing a bare `%` is legal on Windows.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 3;
                    continue;
                }
                Err(_) => {}
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Byte size of a scoped file. pdf.js asks for this once to set up range-based
/// loading (see pdf_range).
#[tauri::command]
fn pdf_size(app: tauri::AppHandle, path: String) -> Result<u64, String> {
    let p = std::path::PathBuf::from(&path);
    if !scanner::is_within_roots(&app, &p) {
        return Err("out of scope".into());
    }
    std::fs::metadata(&p).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Raw byte slice `[start, end)` of a scoped file, returned over Tauri's binary
/// IPC channel (no base64, no custom-scheme Range guesswork). pdf.js pulls only
/// the cross-reference table + the pages you actually view through this, so a
/// 500 MB PDF never loads whole and the first page paints almost immediately.
#[tauri::command]
fn pdf_range(
    app: tauri::AppHandle,
    path: String,
    start: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let p = std::path::PathBuf::from(&path);
    if !scanner::is_within_roots(&app, &p) {
        return Err("out of scope".into());
    }
    let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
    let total = f.metadata().map_err(|e| e.to_string())?.len();
    let end = end.min(total);
    if start >= end {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // asefile panics compositing tilemap cels (a known upstream bug); the
    // decoders catch_unwind it, but the default hook still prints a scary line
    // per file. Silence just asefile panics so a folder of tilemap sprites
    // doesn't flood the log — every other panic keeps the default hook.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let from_asefile = info
            .location()
            .map(|l| l.file().contains("asefile"))
            .unwrap_or(false);
        if !from_asefile {
            default_hook(info);
        }
    }));

    // Unbounded: player commands are tiny and must never block the caller.
    let (tx, rx) = crossbeam_channel::unbounded::<PlayerCmd>();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Native drag-OUT (grid cells / rows → Explorer, DAWs, engines): the
        // webview cannot start an OS drag carrying real file paths itself.
        // Needs "drag:default" in capabilities/default.json.
        .plugin(tauri_plugin_drag::init())
        .manage(AudioController::new(tx))
        .manage(scanner::ScanState::default())
        .manage(watcher::WatcherState::default())
        .manage(waveform::WaveformState::default())
        .manage(spectrogram::SpectrogramState::default())
        .manage(dupes::DupeState::default())
        .manage(thumbs::ThumbState::default())
        .manage(thumbs::PreviewState::default())
        // Thumbnails are served as files over their own scheme rather than as
        // bytes over IPC: WebView2 fetches them out-of-band on its own threads
        // and applies its own HTTP cache. 2000 cells x 256px RGBA over invoke
        // would be ~512 MB of JSON. Custom schemes are a builder API, so
        // capabilities/default.json needs no new permission.
        //
        // On Windows this resolves as http://thumb.localhost/<key>.
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, req, responder| {
            let key = req.uri().path().trim_start_matches('/').to_string();
            let app = ctx.app_handle().clone();
            // Never decode here: no cancellation, no batching, and a 4K PNG
            // would block the handler. Memory/disk lookup only.
            std::thread::spawn(move || {
                let resp = match thumbs::thumb_bytes(&app, &key) {
                    Some(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", "image/png")
                        // The key already encodes size+mtime, so a given URL's
                        // bytes can never change — cache it forever.
                        .header("Cache-Control", "public, max-age=31536000, immutable")
                        // In dev the page is served from localhost:1420, which
                        // is a different origin from thumb.localhost. <img> is
                        // fine without this, but fetch/canvas readback is not.
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new()),
                };
                match resp {
                    Ok(r) => responder.respond(r),
                    Err(e) => eprintln!("[thumb] response build failed: {e}"),
                }
            });
        })
        // Raw RGBA for the WebGL grid — the no-PNG-round-trip path. The grid
        // uploads these pixels straight into a GPU texture atlas; no encode
        // (Rust) or decode (browser) happens. Wire format is [w][h][rgba].
        // On Windows this resolves as http://tex.localhost/<key>.
        .register_asynchronous_uri_scheme_protocol("tex", |ctx, req, responder| {
            let key = req.uri().path().trim_start_matches('/').to_string();
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let resp = match thumbs::tex_bytes(&app, &key) {
                    Some(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", "application/octet-stream")
                        .header("Cache-Control", "public, max-age=31536000, immutable")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new()),
                };
                match resp {
                    Ok(r) => responder.respond(r),
                    Err(e) => eprintln!("[tex] response build failed: {e}"),
                }
            });
        })
        // Full-resolution texture previews for formats the browser can't decode
        // (HDR/EXR/DDS/TGA/…). The grid stays on the 256px thumb; the preview
        // panel and 3D surface fetch the real pixels here, decoded + tone-mapped
        // in Rust to a PNG. URL shape mirrors model://:
        // http://preview.localhost/C:/Pack/env_5k.hdr
        .register_asynchronous_uri_scheme_protocol("preview", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let uri = req.uri().clone();
            std::thread::spawn(move || {
                let decoded = percent_decode(uri.path().trim_start_matches('/'));
                let resp = match thumbs::preview_png(&app, &decoded) {
                    Some(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", "image/png")
                        // Keyed by path+stamp inside; the URL's bytes are stable.
                        .header("Cache-Control", "public, max-age=31536000, immutable")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new()),
                };
                match resp {
                    Ok(r) => responder.respond(r),
                    Err(e) => eprintln!("[preview] response build failed: {e}"),
                }
            });
        })
        // Models load in the webview (three.js) because Rust has no viable FBX
        // story and Synty ships FBX. That means the loader resolves sibling
        // textures and .bin chunks by RELATIVE URL, which is exactly what
        // convertFileSrc breaks: it percent-encodes the whole path into ONE
        // segment, so three's extractUrlBase returns "http://asset.localhost/"
        // and every sibling resolves to garbage — silently, as an untextured
        // model rather than an error.
        //
        // Registering our own scheme fixes it at the root, because we choose
        // the URL shape: http://model.localhost/C:/Pack/model.gltf is
        // slash-separated, so three's relative join works untouched and
        // WebView2 normalizes "../" for us (it's a real HTTP URL). No vfs
        // prefix, no setURLModifier.
        .register_asynchronous_uri_scheme_protocol("model", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let uri = req.uri().clone();
            std::thread::spawn(move || {
                let resp = match model_bytes(&app, uri.path()) {
                    Some((bytes, mime)) => tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes),
                    None => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new()),
                };
                match resp {
                    Ok(r) => responder.respond(r),
                    Err(e) => eprintln!("[model] response build failed: {e}"),
                }
            });
        })
        // Documents (md/txt, and the PDF full-file fallback) served to the
        // webview. Scope-checked (only paths inside a picked root) with a
        // doc-appropriate MIME, and honoring HTTP Range so the fallback path is
        // also incremental. URL shape mirrors model://:
        // http://doc.localhost/C:/Pack/design.pdf. (PDFs normally load via the
        // pdf_range IPC command, which sidesteps custom-scheme Range entirely.)
        .register_asynchronous_uri_scheme_protocol("doc", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let uri = req.uri().clone();
            let is_head = req.method() == tauri::http::Method::HEAD;
            let range = req
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            std::thread::spawn(move || {
                responder.respond(doc_response(&app, uri.path(), range.as_deref(), is_head));
            });
        })
        .setup(move |app| {
            // The engine thread owns the (!Send) rodio OutputStream for the
            // app's whole lifetime; it only ever hears from us via `rx`.
            audio::engine::spawn(app.handle().clone(), rx);

            let data_home = portable::resolve(app)?;
            portable::migrate_legacy_settings(app, &data_home);
            // Redirecting the WebView2 profile only applies to portable copies
            // on Windows; installed copies keep tauri's %LOCALAPPDATA% default,
            // and data_directory() is a WebView2 concept, so it's Windows-only.
            #[cfg(windows)]
            let webview_dir = data_home.is_portable().then(|| data_home.webview_dir());
            // Thumbnails are cached in RAM only — nothing is written to disk.
            // Delete any on-disk cache a previous build left behind. Managed
            // before the window exists so the thumb:// handler can never race
            // the state registration.
            thumbcache::remove_legacy_dir(data_home.dir());
            app.manage(thumbcache::ThumbCache::new());
            app.manage(data_home);

            // The main window is built here instead of being declared in
            // tauri.conf.json because config windows are created before
            // setup() runs — too early to point the WebView2 user-data
            // folder at the portable data home. Keep EXACT parity with the
            // old config (title/size/theme/background); the label must stay
            // "main" (capabilities/default.json and the frontend assume it).
            // `mut` is used only by the Windows data_directory redirect below.
            #[cfg_attr(not(windows), allow(unused_mut))]
            let mut window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Game Asset Browser")
                    .inner_size(1200.0, 760.0)
                    .min_inner_size(900.0, 600.0)
                    // Frameless: the app draws its own title bar (TitleBar.tsx)
                    // with minimize / maximize / fullscreen / close. The window
                    // stays resizable from its edges on Windows despite this.
                    .decorations(false)
                    .theme(Some(tauri::Theme::Dark))
                    .background_color(tauri::webview::Color(0x0a, 0x0a, 0x0f, 0xff));
            #[cfg(windows)]
            if let Some(dir) = webview_dir {
                window = window.data_directory(dir);
            }
            window.build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            portable::settings_store_path,
            portable::settings_export,
            portable::settings_import,
            winmode::set_fullscreen_smooth,
            pdf_size,
            pdf_range,
            scanner::start_scan,
            thumbs::request_thumbs,
            thumbs::sprite_data,
            thumbs::sprite_cels,
            thumbs::model_thumb_lookup,
            thumbs::model_thumb_store,
            modeltex::model_texture_hints,
            scanner::approve_texture,
            waveform::request_waveform,
            spectrogram::request_spectrogram,
            dupes::find_duplicates,
            dupes::cancel_duplicates,
            explorer::show_in_explorer,
            explorer::open_in_explorer,
            workflow::filter_dirs,
            workflow::copy_image_to_clipboard,
            workflow::open_with,
            audio::commands::player_load,
            audio::commands::player_play,
            audio::commands::player_pause,
            audio::commands::player_stop,
            audio::commands::player_seek,
            audio::commands::player_set_volume,
            audio::commands::player_set_loop,
            audio::commands::player_set_speed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
