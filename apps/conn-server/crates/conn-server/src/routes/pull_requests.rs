//! The PR code tab uses HTTP for large patches, with the same read scope as the RPC reads.
use crate::{AppState, http::require_scope, methods::pull_requests, table::Failure};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use conn_contract::PullRequestDiffInput;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/pull-requests/diff", post(diff))
}
async fn diff(State(state): State<AppState>, headers: HeaderMap, request: Request) -> Response {
    if let Err(response) = require_scope(&state, &headers, "orchestration:read") {
        return *response;
    }
    use axum::extract::FromRequest;
    let input = match Json::<PullRequestDiffInput>::from_request(request, &state).await {
        Ok(Json(input)) => input,
        Err(rejection) => return rejection.into_response(),
    };
    response(pull_requests::diff(&state.deps, input).await)
}

fn response(result: Result<serde_json::Value, Failure>) -> Response {
    match result {
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
        Err(Failure::Die(message)) => {
            eprintln!("conn-server: pullRequests.diff: {message}");
            crate::http::internal_reason("internal_error")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn defects_return_the_environment_json_error_without_leaking_the_cause() {
        let response = response(Err(Failure::die("private defect")));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("body");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON error");
        assert_eq!(value["_tag"], "EnvironmentInternalError");
        assert_eq!(value["code"], "internal_error");
        assert_eq!(value["reason"], "internal_error");
        assert!(!value["traceId"].as_str().expect("trace id").is_empty());
        assert!(!String::from_utf8_lossy(&bytes).contains("private defect"));
    }
}
