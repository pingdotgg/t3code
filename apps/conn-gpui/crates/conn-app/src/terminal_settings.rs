//! The terminal's saved look (Settings → Terminal), shared by the right-panel Terminal tab and
//! the bottom drawer, which are the same view.
//!
//! The model is [`conn_state::terminal_settings::TerminalSettings`]. This keeps it in a GPUI
//! global, loads it at start and writes it back to `terminal-settings.json` beside the other
//! `conn-gpui` files on every change. A change refreshes every window, so the terminal repaints
//! with the new font at once.

use std::path::PathBuf;

use conn_state::terminal_settings::TerminalSettings;
use gpui_kit::{App, Global};

#[derive(Default)]
struct Store {
    settings: TerminalSettings,
    path: Option<PathBuf>,
}

impl Global for Store {}

/// Where the settings are kept: `terminal-settings.json` under `CONN_GPUI_CONFIG_DIR` or the
/// app's Application Support folder. Unit tests keep nothing on disk.
fn settings_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("terminal-settings.json"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join("Library/Application Support/conn-gpui/terminal-settings.json"))
}

/// Loads the saved settings (the defaults when there is no file) into the app.
pub(crate) fn init(cx: &mut App) {
    let path = settings_path();
    let settings = path
        .as_deref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|json| TerminalSettings::from_json(&json))
        .unwrap_or_default();
    cx.set_global(Store { settings, path });
}

/// The settings now in force (the defaults before [`init`]).
#[must_use]
pub(crate) fn current(cx: &App) -> TerminalSettings {
    cx.try_global::<Store>()
        .map(|store| store.settings.clone())
        .unwrap_or_default()
}

/// Changes the settings, saves them, and repaints every window.
pub(crate) fn update(cx: &mut App, change: impl FnOnce(&mut TerminalSettings)) {
    let store = cx.default_global::<Store>();
    let mut next = store.settings.clone();
    change(&mut next);
    let next = next.clamped();
    if next == store.settings {
        return;
    }
    store.settings = next;
    if let Some(path) = &store.path {
        let _ = crate::drafts::write_drafts_file(path, &store.settings.to_json());
    }
    cx.refresh_windows();
}
