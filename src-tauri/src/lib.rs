mod audio;
mod explorer;
mod metadata;
mod portable;
mod scanner;
mod thumbs;
mod types;
mod waveform;

use audio::{AudioController, PlayerCmd};
use tauri::Manager;

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
                let resp = match thumbs::thumb_file(&app, &key).and_then(|p| std::fs::read(p).ok()) {
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
        .setup(move |app| {
            // The engine thread owns the (!Send) rodio OutputStream for the
            // app's whole lifetime; it only ever hears from us via `rx`.
            audio::engine::spawn(app.handle().clone(), rx);

            let data_home = portable::resolve(app)?;
            portable::migrate_legacy_settings(app, &data_home);
            // Redirecting the WebView2 profile only applies to portable
            // copies; installed copies keep tauri's %LOCALAPPDATA% default.
            let webview_dir = data_home.is_portable().then(|| data_home.webview_dir());
            // Managed before the window exists so `settings_store_path` can
            // never race the state registration.
            let thumbs_dir = data_home.thumbs_dir();
            app.manage(data_home);

            // Trim the thumbnail cache in the background — never block startup
            // on a directory walk that may hold thousands of entries.
            std::thread::spawn(move || thumbs::gc(thumbs_dir, 512 * 1024 * 1024));

            // The main window is built here instead of being declared in
            // tauri.conf.json because config windows are created before
            // setup() runs — too early to point the WebView2 user-data
            // folder at the portable data home. Keep EXACT parity with the
            // old config (title/size/theme/background); the label must stay
            // "main" (capabilities/default.json and the frontend assume it).
            let mut window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("AssetPreviewer")
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
