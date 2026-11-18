//! The Conn server: HTTP and WebSocket listener, pairing endpoints, method table.

pub mod acp_mcp_bridge;
pub mod auth;
pub mod cli;
pub mod diagnostics;
pub mod environment;
pub mod home;
pub mod host;
pub mod http;
pub mod instances;
pub mod keybindings;
pub mod limits;
pub mod managed;
pub mod methods;
pub mod model_manifest;
mod project;
pub mod restart;
pub mod routes;
pub mod scopes;
pub mod serve;
pub mod session;
pub mod settings;
pub mod table;
pub mod text_generation;
mod workflow_script;

pub use http::{AppState, router};
use table::MethodTable;

/// Builds the method table with every area registered.
pub fn method_table(deps: &methods::Deps) -> MethodTable {
    let mut table = MethodTable::new();
    methods::register_all(&mut table, deps);
    table
}

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-server lock poisoned")
}
