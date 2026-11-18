//! Extra HTTP routes, one file per area, merged into the main router (`http::router`).
//! Each file has one owner. A route reads its services from `AppState` (`state.deps`,
//! `state.auth`, `state.engine`).

use axum::Router;

use crate::AppState;

mod assets;
mod hooks;
pub mod mcp;
pub(crate) mod preview;
mod pull_requests;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(mcp::router())
        .merge(assets::router())
        .merge(hooks::router())
        .merge(preview::router())
        .merge(pull_requests::router())
}
