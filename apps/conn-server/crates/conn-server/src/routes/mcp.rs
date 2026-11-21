//! `/mcp`: the T3 tool server that agents and Swamp call (`crates/conn-mcp`). This file
//! authenticates the caller and hands the request to the service.
//!
//! Credentials, in order:
//! - an agent token `McpService::issue_thread_credential` issued for a thread;
//! - an MCP OAuth client session (`crate::oauth`): an outside agent or another environment's
//!   peer link, at the access it was approved with, narrowed by `T3-Mode-Limit`;
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
    let descriptor = environment.descriptor();
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
        label: {
            let environment = environment.clone();
            conn_mcp::Label::live(move || environment.label())
        },
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
        peers: deps
            .peers
            .clone()
            .map(|p| Arc::new(crate::peers::McpPeers(p)) as Arc<dyn conn_mcp::Peers>),
        settings: Some(settings_port(environment.clone())),
        devices: deps.devices.clone(),
        pull_requests: crate::methods::pull_requests::mcp_host(deps),
        clone_repository: Some(crate::methods::source_control::clone_host(deps)),
    }))
}

/// The settings file as it stands (sparse: only what differs from the defaults).
fn full_settings(environment: &crate::environment::Environment) -> conn_mcp::SettingsMap {
    environment.settings.raw()
}

fn settings_port(environment: Arc<crate::environment::Environment>) -> conn_mcp::SettingsPort {
    let reader = environment.clone();
    conn_mcp::SettingsPort {
        read: Arc::new(move || full_settings(&reader)),
        update: Arc::new(move |patch| {
            let environment = environment.clone();
            Box::pin(async move {
                let writer = environment.clone();
                tokio::task::spawn_blocking(move || writer.settings.update_server(patch))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| format!("{e:?}"))?;
                Ok(full_settings(&environment))
            })
        }),
    }
}

/// `T3-Mode-Limit: <runtimeMode>/<interactionMode>`: `Some(None)` when absent, `None` when
/// malformed.
fn mode_limit(headers: &HeaderMap) -> Option<Option<(&'static str, &'static str)>> {
    let Some(value) = headers.get("t3-mode-limit") else {
        return Some(None);
    };
    let text = value.to_str().ok()?.trim();
    let mut parts = text.split('/');
    let (runtime, interaction) = (parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let runtime = [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
    ]
    .into_iter()
    .find(|m| *m == runtime)?;
    let interaction = ["default", "plan"]
        .into_iter()
        .find(|m| *m == interaction)?;
    Some(Some((runtime, interaction)))
}

fn json_refusal(status: StatusCode, error: &str, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(json!({"error": error, "message": message})),
    )
        .into_response()
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
    let caller = match token.and_then(|t| service.resolve_thread_token(t)) {
        Some(thread) => Some(Caller::Thread(thread)),
        // The auth store may reread `auth.json`: blocking file work, off the runtime thread.
        None => match token.map(str::to_owned) {
            Some(token) => {
                let auth = state.auth.clone();
                tokio::task::spawn_blocking(move || client_caller(&auth, &token))
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        },
    };
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
    // The transport allows no browser origin, refused before anything else, as T3 does.
    let caller = match caller {
        Caller::Client(mut client) if !headers.contains_key(header::ORIGIN) => {
            let Some(limit) = mode_limit(&headers) else {
                return json_refusal(
                    StatusCode::BAD_REQUEST,
                    "invalid_mode_limit",
                    "T3-Mode-Limit must be <runtimeMode>/<interactionMode>, e.g. auto/default.",
                );
            };
            client.narrowed = limit;
            // A link waits while Linked environments is off here.
            if client.linked && state.deps.peers.as_ref().is_none_or(|p| !p.enabled()) {
                return json_refusal(
                    StatusCode::FORBIDDEN,
                    "linked_environments_off",
                    "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
                );
            }
            Caller::Client(client)
        }
        other => other,
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

/// An MCP OAuth client at its approved access, else a native bearer session with its scopes.
/// Blocking: the auth store may reread its file.
fn client_caller(auth: &crate::auth::AuthStore, token: &str) -> Option<Caller> {
    if let Some(client) = auth.authenticate_mcp_client(token) {
        return Some(Caller::Client(ClientCaller {
            session_id: client.session_id,
            max_runtime_mode: crate::auth::MCP_ACCESS_LEVELS
                .iter()
                .copied()
                .find(|level| *level == client.access && *level != "read-only"),
            label: client.label,
            linked: client.peer_link,
            narrowed: None,
            scopes: None,
        }));
    }
    let principal = auth.authenticate_bearer(token)?;
    principal.has_scope("orchestration:read").then(|| {
        Caller::Client(ClientCaller {
            session_id: principal.session_id.clone(),
            max_runtime_mode: principal
                .has_scope("orchestration:operate")
                .then_some("full-access"),
            scopes: Some(principal.scopes.clone()),
            ..ClientCaller::default()
        })
    })
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}
