//! Native backends for conn-gpui's right-panel surfaces.
//!
//! Conn's desktop app runs these in its Electron main process
//! (`apps/desktop/src/ipc/methods/*.ts`). Here each is a GPUI-free async module that the app
//! drives on its Tokio runtime. Request and response types mirror Conn's IPC schemas field for
//! field, so the panels can port Conn's renderer logic directly.
#![forbid(unsafe_code)]

pub mod api_request;
pub mod control;
pub mod database;
pub mod mcp;
pub mod operator;
pub mod orbit;
pub mod server_store;
pub mod vault;
