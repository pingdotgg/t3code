//! Asset, attachment and file download routes. Owner: the files track.

use axum::Router;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
