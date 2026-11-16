//! The PR code tab uses HTTP for large patches, with the same read scope as the RPC reads.
use crate::{AppState, http::require_scope, methods::pull_requests, table::Failure};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use conn_contract::PullRequestDiffInput;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/pull-requests/diff", post(diff))
}
async fn diff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PullRequestDiffInput>,
) -> Response {
    if let Err(response) = require_scope(&state, &headers, "orchestration:read") {
        return *response;
    }
    match pull_requests::diff(&state.deps, input).await {
        Ok(value) => Json(value).into_response(),
        Err(Failure::Fail(value)) => {
            let unavailable = value.get("_tag").and_then(serde_json::Value::as_str)
                == Some("PullRequestUnavailableError");
            (
                if unavailable {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::BAD_GATEWAY
                },
                Json(value),
            )
                .into_response()
        }
        Err(Failure::Die(_)) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
