//! `/oauth/mcp/register`, `/oauth/mcp/decision` and `/oauth/mcp/token`: the MCP OAuth steps
//! another environment's peer link takes (`crate::oauth`). Shapes follow the `mcpOAuth`
//! group of `packages/contracts/src/environmentHttp.ts`.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Extension, Form, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    AppState,
    auth::ClientInfo,
    oauth::{AuthorizationRequest, Decision, McpOAuth, Registration, TokenRequest, Urls},
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/mcp/register", post(register))
        .route("/oauth/mcp/decision", post(decision))
        .route("/oauth/mcp/token", post(token))
}

/// OAuth answers carry credentials: never cached.
fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

fn urls(headers: &HeaderMap) -> Urls {
    Urls::from_host(
        headers.get(header::HOST).and_then(|v| v.to_str().ok()),
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            == Some("https"),
    )
}

/// The service with its signing key loaded (a blocking read on first use).
async fn service(state: &AppState) -> Option<Arc<McpOAuth>> {
    let oauth = state.deps.oauth.clone()?;
    let loading = oauth.clone();
    match tokio::task::spawn_blocking(move || loading.load_key()).await {
        Ok(Ok(())) => Some(oauth),
        Ok(Err(error)) => {
            eprintln!("conn-server: could not read the MCP OAuth signing key: {error}");
            None
        }
        Err(_) => None,
    }
}

fn links_enabled(state: &AppState) -> bool {
    state
        .deps
        .environment
        .as_ref()
        .is_some_and(|e| e.settings.raw().get("linkedEnvironmentsEnabled") == Some(&json!(true)))
}

fn registration_error(error: &str, description: &str) -> Response {
    no_store(
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": error, "error_description": description})),
        )
            .into_response(),
    )
}

async fn register(State(state): State<AppState>, body: Bytes) -> Response {
    let Some(oauth) = service(&state).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let metadata: Registration = match serde_json::from_slice(&body) {
        Ok(metadata) => metadata,
        Err(error) => {
            return registration_error(
                "invalid_client_metadata",
                &format!("Invalid client metadata: {error}"),
            );
        }
    };
    match oauth.register(metadata, links_enabled(&state)) {
        Ok(client) => no_store(
            (
                StatusCode::CREATED,
                Json(json!({
                    "client_id": client.client_id,
                    "client_name": client.name,
                    "redirect_uris": client.redirect_uris,
                    "grant_types": ["authorization_code"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                })),
            )
                .into_response(),
        ),
        Err(error) => registration_error(error.error, &error.description),
    }
}

#[derive(Deserialize)]
struct DecisionRequest {
    authorization: AuthorizationRequest,
    decision: Value,
}

fn approval_error(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"_tag": "AuthMcpApprovalError", "message": message})),
    )
        .into_response()
}

async fn decision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DecisionRequest>,
) -> Response {
    let Some(oauth) = service(&state).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = state.auth.clone();
    let urls = urls(&headers);
    // Spending the code writes `auth.json`.
    let decided = tokio::task::spawn_blocking(move || {
        oauth.decide(&auth, &urls, &request.authorization, &request.decision)
    })
    .await;
    match decided {
        Ok(Decision::Redirect(to)) => no_store(Json(json!({"redirectTo": to})).into_response()),
        Ok(Decision::PageError(message)) => approval_error(&message),
        Err(_) => approval_error("The code could not be checked. Try again."),
    }
}

async fn token(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(request): Form<TokenRequest>,
) -> Response {
    let Some(oauth) = service(&state).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = state.auth.clone();
    let urls = urls(&headers);
    let client = ClientInfo::from_request(
        None,
        None,
        None,
        headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
        peer.map(|Extension(ConnectInfo(addr))| addr.ip().to_canonical().to_string()),
    );
    let exchanged =
        tokio::task::spawn_blocking(move || oauth.exchange(&auth, &urls, &request, client)).await;
    match exchanged {
        Ok(Ok(body)) => no_store(Json(body).into_response()),
        Ok(Err(error)) => no_store(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": error.error, "error_description": error.description})),
            )
                .into_response(),
        ),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
