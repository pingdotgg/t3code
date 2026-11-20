//! Embedded Chromium (CEF-on-demand) browser runtime for `conn-gpui`.
//!
//! Reference implementation: `.refs/threadbear/desktop/web/` (`cef-rs` + `dlopen` loader +
//! macOS `offscreen.rs` / `devtools.rs`).
//!
//! Kept isolated from `conn-state` and `conn-app` views so the core desktop app builds and
//! runs without requiring a CEF archive on disk until a user opens a Browser panel.

/// Lifecycle state of the on-demand CEF runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebRuntimeState {
    NotInstalled,
    Downloading { progress_percent: u8 },
    Starting,
    Running,
    Failed(String),
}
