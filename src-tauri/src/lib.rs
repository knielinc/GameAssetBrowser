mod audio;
mod explorer;
mod metadata;
mod modeltex;
mod portable;
mod scanner;
mod thumbcache;
mod thumbs;
mod types;
mod waveform;

use audio::{AudioController, PlayerCmd};
use tauri::Manager;

/// Read a model (or one of its sibling textures / .bin chunks) for the
/// `model://` scheme.
///
/// The URL path is `/C:/Pack/model.gltf`. WebView2 has already normalized any
/// `../` because it is a real HTTP URL, but the scope check is what actually
/// matters: without it a crafted glTF could reference
/// `../../../../Windows/System32/config/SAM` and exfiltrate it. Only paths
/// inside a root the user explicitly picked are served.
fn model_bytes(app: &tauri::AppHandle, uri_path: &str) -> Option<(Vec<u8>, &'static str)> {
    let decoded = percent_decode(uri_path.trim_start_matches('/'));
    if decoded.is_empty() {
        return None;
    }
    let path = std::path::PathBuf::from(decoded.replace('/', "\\"));
    if !scanner::is_within_roots(app, &path) {
        eprintln!("[model] refused out-of-scope read: {}", path.display());
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    Some((bytes, mime_for(&path)))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Unbounded: player commands are tiny and must never block the caller.
    let (tx, rx) = crossbeam_channel::unbounded::<PlayerCmd>();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AudioController::new(tx))
        .manage(scanner::ScanState::default())
        .manage(waveform::WaveformState::default())
        .manage(thumbs::ThumbState::default())
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
        .setup(move |app| {
            // The engine thread owns the (!Send) rodio OutputStream for the
            // app's whole lifetime; it only ever hears from us via `rx`.
            audio::engine::spawn(app.handle().clone(), rx);

            let data_home = portable::resolve(app)?;
            portable::migrate_legacy_settings(app, &data_home);
            // Redirecting the WebView2 profile only applies to portable
            // copies; installed copies keep tauri's %LOCALAPPDATA% default.
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
            let mut window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Game File Browser")
                    .inner_size(1200.0, 760.0)
                    .min_inner_size(900.0, 600.0)
                    .theme(Some(tauri::Theme::Dark))
                    .background_color(tauri::webview::Color(0x0a, 0x0a, 0x0f, 0xff));
            if let Some(dir) = webview_dir {
                window = window.data_directory(dir);
            }
            window.build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            portable::settings_store_path,
            scanner::start_scan,
            thumbs::request_thumbs,
            thumbs::model_thumb_lookup,
            thumbs::model_thumb_store,
            modeltex::model_texture_hints,
            scanner::approve_texture,
            waveform::request_waveform,
            explorer::show_in_explorer,
            explorer::open_in_explorer,
            audio::commands::player_load,
            audio::commands::player_play,
            audio::commands::player_pause,
            audio::commands::player_stop,
            audio::commands::player_seek,
            audio::commands::player_set_volume,
            audio::commands::player_set_loop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
