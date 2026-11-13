//! `/mcp`: the T3 tool server that agents and Swamp call. Owner: the MCP track.

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
