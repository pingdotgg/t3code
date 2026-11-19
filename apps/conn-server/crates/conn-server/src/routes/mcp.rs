//! `/mcp`: the T3 tool server that agents and Swamp call (`crates/conn-mcp`). This file
//! authenticates the caller and hands the request to the service.
//!
//! Credentials, in order:
//! - an agent token `McpService::issue_thread_credential` issued for a thread;
//! - an environment bearer session (a paired device, `t3 auth session issue`) with
//!   `orchestration:read`. With `orchestration:operate` it may start threads in any runtime
//!   mode, as it already may over `/ws`; without, it is read-only. The T3 server takes only
//!   MCP OAuth clients here; see `crates/conn-mcp/README.md`, "Auth".

use std::sync::Arc;

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use conn_mcp::{Caller, ClientCaller, McpConfig, McpService};
use serde_json::json;

use crate::{AppState, methods::Deps};

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/mcp",
        any(mcp).layer(DefaultBodyLimit::max(conn_mcp::MAX_MCP_BODY_BYTES)),
    )
}

/// The service for these deps, or `None` without an engine and environment.
pub fn service(deps: &Deps) -> Option<Arc<McpService>> {
    let engine = deps.engine.clone()?;
    let environment = deps.environment.clone()?;
    let descriptor = &environment.descriptor;
    let providers = deps.providers.clone();
    let defaults = environment.clone();
    let directory = environment.clone();
    let refresh_deps = deps.clone();
    Some(McpService::new(McpConfig {
        preview: deps.preview.clone(),
        refresh_provider: Some(Arc::new(move |id| {
            let deps = refresh_deps.clone();
            Box::pin(async move {
                crate::methods::provider::refresh(&deps, Some(&id)).await;
            })
        })),
        files: deps.files.clone(),
        worktrees: Some(conn_mcp::WorktreeConfig {
            directory: Arc::new(move || crate::host::worktrees_dir(&directory)),
            settings: Arc::new(move || serde_json::Value::Object(defaults.settings.raw())),
            terminals: deps.terminals.clone(),
            hub: deps.vcs.hub.clone(),
        }),
        engine,
        environment_id: environment.environment_id().to_owned(),
        label: descriptor["label"].as_str().unwrap_or_default().to_owned(),
        server_version: descriptor["serverVersion"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        platform: descriptor["platform"].clone(),
        providers: Arc::new(move || {
            let deps = Deps {
                providers: providers.clone(),
                ..Deps::default()
            };
            crate::methods::provider::server_providers(
                &deps,
                &conn_support::time::iso_from_ms(conn_support::time::now_ms()),
            )
        }),
        hosted_app_url: conn_mcp::DEFAULT_HOSTED_APP_URL.to_owned(),
        scheduled_tasks: deps.scheduled_tasks.clone(),
        annotations: deps.annotations.clone(),
        secrets: deps.secrets.clone(),
        test_logins: deps.test_logins.clone(),
        panels: deps.panels.clone(),
        pull_requests: crate::methods::pull_requests::mcp_host(deps),
    }))
}

async fn mcp(
    State(state): State<AppState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(service) = state.deps.mcp.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let token = bearer(&headers);
    let caller = token
        .and_then(|t| service.resolve_thread_token(t))
        .map(Caller::Thread)
        .or_else(|| {
            let principal = state.auth.authenticate_bearer(token?)?;
            principal.has_scope("orchestration:read").then(|| {
                Caller::Client(ClientCaller {
                    session_id: principal.session_id.clone(),
                    max_runtime_mode: principal
                        .has_scope("orchestration:operate")
                        .then_some("full-access"),
                })
            })
        });
    let Some(caller) = caller else {
        // No OAuth here, so no `resource_metadata`: an agent must never start a sign-in.
        let challenge = if token.is_some() {
            "Bearer error=\"invalid_token\""
        } else {
            "Bearer"
        };
        return (
            StatusCode::UNAUTHORIZED,
            [
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                (
                    header::WWW_AUTHENTICATE,
                    HeaderValue::from_static(challenge),
                ),
            ],
            axum::Json(json!({
                "error": "invalid_mcp_credential",
                "message": "A valid T3 Code MCP credential is required.",
            })),
        )
            .into_response();
    };
    {
        let reply = service.handle(caller, &method, &headers, &body).await;
        let mut response = Response::new(reply.body.map_or_else(Body::empty, Body::from));
        *response.status_mut() = reply.status;
        for (name, value) in reply.headers {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(name, value);
            }
        }
        response
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}
