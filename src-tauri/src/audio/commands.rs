//! Player IPC commands. Each command only forwards a [`PlayerCmd`] to the
//! engine thread over the channel — never touches rodio directly.

use tauri::State;

use super::{AudioController, PlayerCmd};

#[tauri::command]
pub fn player_load(state: State<'_, AudioController>, path: String, autoplay: bool) {
    state.send(PlayerCmd::Load { path, autoplay });
}

#[tauri::command]
pub fn player_play(state: State<'_, AudioController>) {
    state.send(PlayerCmd::Play);
}

#[tauri::command]
pub fn player_pause(state: State<'_, AudioController>) {
    state.send(PlayerCmd::Pause);
}

#[tauri::command]
pub fn player_stop(state: State<'_, AudioController>) {
    state.send(PlayerCmd::Stop);
}

#[tauri::command]
pub fn player_seek(state: State<'_, AudioController>, seconds: f64) {
    state.send(PlayerCmd::Seek { seconds });
}

#[tauri::command]
pub fn player_set_volume(state: State<'_, AudioController>, volume: f32) {
    state.send(PlayerCmd::SetVolume(volume));
}

#[tauri::command]
pub fn player_set_loop(state: State<'_, AudioController>, enabled: bool) {
    state.send(PlayerCmd::SetLoop(enabled));
}
