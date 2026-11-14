//! `/api/hooks/<hook id>/<token>`: webhook deliveries for scheduled tasks, as the T3 server's
//! `webhookRoute.ts`. No session: the token in the path and the task's signature check are the
//! only gate. The body is read only up to 1 MiB, also when chunked; every answer names its
//! outcome in `x-t3-hook-outcome`.
//!
//! What a caller without the token can make the server do: look up one task by id in memory
//! and compare the token in constant time, then answer 404. Nothing is stored or logged.

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, State, rejection::PathRejection},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

use conn_features::scheduled::webhook::{Delivery, MAX_BODY_BYTES, TriggerResult};

use crate::AppState;

/// The relay records this header.
const OUTCOME_HEADER: &str = "x-t3-hook-outcome";

pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/hooks/{hook_id}/{token}",
        get(hook).post(hook).put(hook).patch(hook).head(hook),
    )
}

fn answer(status: StatusCode, error_or_id: (&str, &str), outcome: &str) -> Response {
    let (key, value) = error_or_id;
    let mut response = (status, axum::Json(json!({ key: value }))).into_response();
    if let Ok(outcome) = HeaderValue::from_str(outcome) {
        response.headers_mut().insert(OUTCOME_HEADER, outcome);
    }
    response
}

/// Node's `IncomingMessage.headers`: lowercase names, one value per name (repeats joined
/// with `, `, cookies with `; `), bytes read as Latin-1.
fn request_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        let text: String = value.as_bytes().iter().map(|b| char::from(*b)).collect();
        let name = name.as_str().to_ascii_lowercase();
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some((_, existing)) => {
                existing.push_str(if name == "cookie" { "; " } else { ", " });
                existing.push_str(&text);
            }
            None => out.push((name, text)),
        }
    }
    out
}

async fn hook(
    State(state): State<AppState>,
    path: Result<Path<(String, String)>, PathRejection>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // A path that does not decode names no hook.
    let Ok(Path((hook_id, token))) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(tasks) = state.deps.scheduled_tasks.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The router answers HEAD with the GET route; link checkers probe with HEAD.
    if method == Method::HEAD {
        let mut response = answer(
            StatusCode::METHOD_NOT_ALLOWED,
            ("error", "method_not_allowed"),
            "method_not_allowed",
        );
        response.headers_mut().insert(
            header::ALLOW,
            HeaderValue::from_static("GET, POST, PUT, PATCH"),
        );
        return response;
    }
    // `Number(content-length ?? "0")`: a value that is not a finite number is refused too.
    let declared = headers.get(header::CONTENT_LENGTH).map(|v| {
        v.to_str()
            .ok()
            .map(str::trim)
            .and_then(|v| v.parse::<f64>().ok())
    });
    let too_large = match declared {
        None => false,
        Some(None) => headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|v| !v.as_bytes().iter().all(u8::is_ascii_whitespace)),
        Some(Some(length)) => !length.is_finite() || length > MAX_BODY_BYTES as f64,
    };
    if too_large {
        return answer(
            StatusCode::PAYLOAD_TOO_LARGE,
            ("error", "body_too_large"),
            "body_too_large",
        );
    }
    // Chunked requests carry no length, so the reader itself stops at the cap.
    let Ok(body) = to_bytes(body, MAX_BODY_BYTES).await else {
        return answer(
            StatusCode::PAYLOAD_TOO_LARGE,
            ("error", "body_too_large_or_unreadable"),
            "body_too_large",
        );
    };
    let delivery = Delivery {
        hook_id: hook_id.clone(),
        token,
        method: method.as_str().to_owned(),
        query: uri.query().unwrap_or("").to_owned(),
        headers: request_headers(&headers),
        body: body.to_vec(),
    };
    match tasks.trigger_webhook(delivery).await {
        Ok(TriggerResult::Accepted {
            delivery_id,
            outcome,
        }) => answer(StatusCode::ACCEPTED, ("deliveryId", &delivery_id), outcome),
        Ok(TriggerResult::NotFound) => answer(
            StatusCode::NOT_FOUND,
            ("error", "hook_not_found"),
            "not_found",
        ),
        Ok(TriggerResult::RejectedSignature) => answer(
            StatusCode::UNAUTHORIZED,
            ("error", "invalid_signature"),
            "rejected_signature",
        ),
        Ok(TriggerResult::Disabled) => {
            answer(StatusCode::CONFLICT, ("error", "hook_disabled"), "disabled")
        }
        Ok(TriggerResult::RateLimited(outcome)) => {
            answer(StatusCode::TOO_MANY_REQUESTS, ("error", outcome), outcome)
        }
        Ok(TriggerResult::Expired) => {
            answer(StatusCode::GONE, ("error", "delivery_too_old"), "expired")
        }
        Err(_) => {
            // The cause stays out of the answer; the hook id is not secret.
            eprintln!("conn-server: webhook delivery failed for hook {hook_id}");
            answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                ("error", "internal_error"),
                "error",
            )
        }
    }
}
