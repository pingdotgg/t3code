//! Agent cursor overlay — Mac parity on Windows and Linux (X11).
//!
//! macOS lives in the Swift `t3-desktop-mcp` package. This module covers the
//! Rust desktop MCP platforms.

#[cfg(windows)]
#[path = "agent_cursor_windows.rs"]
mod imp;

#[cfg(target_os = "linux")]
#[path = "agent_cursor_linux.rs"]
mod imp;

pub use imp::*;
