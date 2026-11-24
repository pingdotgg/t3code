//! Extra HTTP routes, one file per area, merged into the main router (`http::router`).
//! Each file has one owner. A route reads its services from `AppState` (`state.deps`,
//! `state.auth`, `state.engine`).

use axum::Router;

use crate::AppState;

mod assets;
mod definitions;
mod device_hub;
mod hooks;
pub mod mcp;
mod oauth_mcp;
pub(crate) mod preview;
pub(crate) mod preview_tunnel;
mod pull_requests;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(mcp::router())
        .merge(oauth_mcp::router())
        .merge(assets::router())
        .merge(definitions::router())
        .merge(device_hub::router())
        .merge(hooks::router())
        .merge(preview::router())
        .merge(preview_tunnel::router())
        .merge(pull_requests::router())
}
