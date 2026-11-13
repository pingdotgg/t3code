//! The Conn server: HTTP and WebSocket listener, pairing endpoints, method table.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{State, WebSocketUpgrade},
    response::Response,
    routing::get,
};
use serde_json::{Value, json};

pub mod methods;
pub mod session;
pub mod table;

use table::MethodTable;

/// Builds the method table with every area registered.
pub fn method_table(deps: &methods::Deps) -> MethodTable {
    let mut table = MethodTable::new();
    methods::register_all(&mut table, deps);
    table
}

/// The HTTP routes. Pairing and auth routes (`/.well-known/t3/environment`, `/api/auth/*`,
/// `/oauth/token`) belong to track (a).
pub fn router(table: Arc<MethodTable>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws))
        .with_state(table)
}

async fn health(State(table): State<Arc<MethodTable>>) -> Json<Value> {
    let coverage = table.coverage();
    Json(json!({
        "status": "ok",
        "contractCommit": conn_contract::contract_commit(),
        "methods": { "implemented": coverage.implemented, "total": coverage.total },
    }))
}

async fn ws(upgrade: WebSocketUpgrade, State(table): State<Arc<MethodTable>>) -> Response {
    upgrade.on_upgrade(move |socket| session::run(socket, table))
}
