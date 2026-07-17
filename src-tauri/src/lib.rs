mod audio;
mod explorer;
mod metadata;
mod portable;
mod scanner;
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
            app.manage(data_home);

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
