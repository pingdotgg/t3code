//! The Conn server: HTTP and WebSocket listener, pairing endpoints, method table.

pub mod auth;
pub mod environment;
pub mod http;
pub mod methods;
pub mod session;
pub mod table;

pub use http::{AppState, router};
use table::MethodTable;

/// Builds the method table with every area registered.
pub fn method_table(deps: &methods::Deps) -> MethodTable {
    let mut table = MethodTable::new();
    methods::register_all(&mut table, deps);
    table
}
