#![forbid(unsafe_code)]

//! Pure Rust state and reducers for `conn-gpui`.
//!
//! Intentionally free of GPUI and I/O dependencies so state transitions can be tested
//! deterministically and rapidly with `cargo test -p conn-state`.

/// Top-level right-panel surface tabs matching Conn desktop (`RightPanelTabs.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RightPanelTab {
    Files,
    Diff,
    Terminal,
    Browser,
    Database,
    Mcp,
    Device,
}
