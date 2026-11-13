//! HTTP routes: the environment descriptor, pairing and auth, and the `/ws` upgrade.
//! Shapes follow `packages/contracts/src/environmentHttp.ts` and `auth.ts`.

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Extension, Form, Json, Router,
    extract::{ConnectInfo, Path, Query, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use conn_engine::{Engine, EngineError};

use crate::{
    auth::{
        self, AccessChange, AuthStore, ClientInfo, ExchangeError, PairingRequest, Principal,
        iso8601, scope_response,
    },
    session::{self, SessionOptions},
    table::{CallContext, MethodTable},
};

pub const ORCHESTRATION_PROTOCOL_VERSION: u32 = 2;
const ORCHESTRATION_PROTOCOL_QUERY_PARAM: &str = "orchestrationProtocol";
const ORCHESTRATION_PROTOCOL_HEADER: &str = "x-t3-orchestration-protocol";
/// The largest client message `/ws` accepts.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub table: Arc<MethodTable>,
    pub auth: Arc<AuthStore>,
    /// `ExecutionEnvironmentDescriptor`.
    pub descriptor: Arc<Value>,
    /// Backs the orchestration snapshot routes; without it they answer 404.
    pub engine: Option<Arc<dyn Engine>>,
    /// The services the method table was built from, for the routes in `routes/`.
    pub deps: crate::methods::Deps,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/.well-known/t3/environment", get(descriptor))
        .route("/api/auth/session", get(session_state))
        .route("/oauth/token", post(token))
        .route("/api/auth/websocket-ticket", post(ticket))
        .route("/api/auth/websocket-ticket/{use}", post(ticket_for))
        .route("/api/auth/pairing-token", post(pairing_token))
        .route("/api/auth/pairing-links/revoke", post(revoke_pairing_link))
        .route("/api/auth/clients", get(clients))
        .route("/api/auth/clients/revoke", post(revoke_client))
        .route(
            "/api/auth/clients/revoke-others",
            post(revoke_other_clients),
        )
        .route("/api/orchestration/shell", get(shell_snapshot))
        .route("/api/projects/mutate", post(projects_mutate))
        .route(
            "/api/orchestration/threads/{thread_id}",
            get(thread_snapshot),
        )
        .route("/ws", get(ws))
        .merge(crate::routes::router())
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

/// Packaged T3 allows any origin: credentials are bearer tokens, never cookies.
async fn cors(request: Request, next: Next) -> Response {
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "authorization, b3, traceparent, content-type, dpop, x-t3-orchestration-protocol",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let coverage = state.table.coverage();
    // The T3 server has no `/health`; this route is how a caller tells the Conn Server apart.
    Json(json!({
        "status": "ok",
        "server": "conn-server",
        "version": env!("CARGO_PKG_VERSION"),
        "contractCommit": conn_contract::contract_commit(),
        "methods": { "implemented": coverage.implemented, "total": coverage.total },
    }))
}

async fn descriptor(State(state): State<AppState>) -> Json<Value> {
    Json(state.descriptor.as_ref().clone())
}

async fn session_state(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let Some(principal) = bearer(&headers).and_then(|t| state.auth.authenticate_bearer(t)) else {
        return Json(json!({ "authenticated": false, "auth": state.auth.descriptor() }));
    };
    let mut body = scope_response(&principal.scopes);
    body["authenticated"] = json!(true);
    body["auth"] = state.auth.descriptor();
    body["sessionMethod"] = json!("bearer-access-token");
    body["expiresAt"] = json!(iso8601(principal.expires_at_ms));
    Json(body)
}

/// `AuthTokenExchangeRequest`, form encoded.
#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    subject_token: String,
    subject_token_type: String,
    requested_token_type: String,
    scope: Option<String>,
    client_label: Option<String>,
    client_device_type: Option<String>,
    client_os: Option<String>,
}

const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";

async fn token(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(request): Form<TokenRequest>,
) -> Response {
    if request.grant_type != GRANT_TYPE
        || request.subject_token_type != BOOTSTRAP_TOKEN_TYPE
        || request.requested_token_type != ACCESS_TOKEN_TYPE
    {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_command",
        );
    }
    // A DPoP client expects a key-bound token. A bearer token would drop that binding,
    // so refuse before the code is spent.
    if headers.contains_key("dpop") {
        return auth_invalid("invalid_credential");
    }
    let requested: Option<Vec<String>> = request
        .scope
        .as_deref()
        .map(|scope| scope.split_whitespace().map(str::to_owned).collect());
    let device_type = request.client_device_type.filter(|d| {
        matches!(
            d.as_str(),
            "desktop" | "mobile" | "tablet" | "bot" | "unknown"
        )
    });
    let client = ClientInfo::from_request(
        request.client_label,
        device_type,
        request.client_os.filter(|o| !o.trim().is_empty()),
        headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
        peer.map(|Extension(ConnectInfo(addr))| addr.ip().to_canonical().to_string()),
    );
    match state
        .auth
        .exchange(&request.subject_token, requested.as_deref(), client)
    {
        Ok(issued) => Json(json!({
            "access_token": issued.token,
            "issued_token_type": ACCESS_TOKEN_TYPE,
            "token_type": "Bearer",
            "expires_in": issued.principal.expires_at_ms.saturating_sub(auth::now_ms()) / 1000,
            "scope": issued.principal.scopes.join(" "),
        }))
        .into_response(),
        Err(ExchangeError::InvalidCredential) => auth_invalid("invalid_credential"),
        Err(ExchangeError::InvalidScope) => error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        ),
        Err(ExchangeError::ScopeNotGranted) => error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "scope_not_granted",
        ),
    }
}

async fn ticket(State(state): State<AppState>, headers: HeaderMap) -> Response {
    issue_ticket(&state, &headers, None)
}

async fn ticket_for(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Response {
    if route != "rpc" && route != "media" {
        return StatusCode::NOT_FOUND.into_response();
    }
    issue_ticket(&state, &headers, Some(&route))
}

fn issue_ticket(state: &AppState, headers: &HeaderMap, route: Option<&str>) -> Response {
    let Some(token) = bearer(headers) else {
        return auth_invalid("missing_credential");
    };
    match state.auth.issue_ticket(token, route) {
        Some((ticket, expires_at_ms)) => {
            Json(json!({ "ticket": ticket, "expiresAt": iso8601(expires_at_ms) })).into_response()
        }
        None => auth_invalid("invalid_credential"),
    }
}

/// `AuthCreatePairingCredentialInput`.
#[derive(Deserialize, Default)]
struct PairingTokenRequest {
    label: Option<String>,
    scopes: Option<Vec<String>>,
    access: Option<String>,
}

/// The bearer session behind a request that needs `scope`, or the response refusing it.
fn require_scope(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
) -> Result<Principal, Box<Response>> {
    let Some(token) = bearer(headers) else {
        return Err(Box::new(auth_invalid("missing_credential")));
    };
    let Some(principal) = state.auth.authenticate_bearer(token) else {
        return Err(Box::new(auth_invalid("invalid_credential")));
    };
    if !principal.has_scope(scope) {
        return Err(Box::new(scope_required(scope)));
    }
    Ok(principal)
}

/// `EnvironmentScopeRequiredError`, 403.
fn scope_required(scope: &str) -> Response {
    Json(json!({
        "_tag": "EnvironmentScopeRequiredError",
        "code": "insufficient_scope",
        "requiredScope": auth::legacy_parent(scope),
        "requiredPermission": scope,
        "traceId": trace_id(),
    }))
    .with_status(StatusCode::FORBIDDEN)
}

fn internal(reason: &str, error: std::io::Error) -> Response {
    eprintln!("conn-server: {reason}: {error}");
    Json(json!({
        "_tag": "EnvironmentInternalError",
        "code": "internal_error",
        "reason": reason,
        "traceId": trace_id(),
    }))
    .with_status(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `POST /api/auth/pairing-token`: a one-time link with the standard scopes or the ones named,
/// each of which the caller must hold. Orbit's Gateway creates its device links here.
async fn pairing_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<PairingTokenRequest>>,
) -> Response {
    let principal = match require_scope(&state, &headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let request = body.map(|Json(b)| b).unwrap_or_default();
    // MCP approval codes (`access`) need the MCP OAuth flow, which this server lacks.
    if request.access.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        );
    }
    let scopes: Vec<String> = request.scopes.unwrap_or_else(|| {
        auth::STANDARD_SCOPES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    let mut unique = scopes.clone();
    unique.sort();
    unique.dedup();
    if scopes.is_empty()
        || unique.len() != scopes.len()
        || !scopes.iter().all(|s| auth::is_grant_scope(s))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        );
    }
    if let Some(missing) = scopes.iter().find(|s| !principal.has_scope(s)) {
        return scope_required(missing);
    }
    let label = request.label.filter(|l| !l.trim().is_empty());
    let issued = match state.auth.issue_pairing(PairingRequest {
        scopes,
        label,
        ttl_ms: auth::PAIRING_CODE_TTL_MS,
    }) {
        Ok(issued) => issued,
        Err(e) => return internal("pairing_credential_issuance_failed", e),
    };
    let mut body = json!({
        "id": issued.id,
        "credential": issued.code,
        "expiresAt": iso8601(issued.expires_at_ms),
    });
    if let Some(label) = issued.label {
        body["label"] = json!(label);
    }
    Json(body).into_response()
}

#[derive(Deserialize)]
struct IdRequest {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdRequest {
    session_id: String,
}

async fn revoke_pairing_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<IdRequest>,
) -> Response {
    if let Err(response) = require_scope(&state, &headers, "access:write") {
        return *response;
    }
    match state.auth.revoke_pairing_link(&request.id) {
        Ok(revoked) => Json(json!({ "revoked": revoked })).into_response(),
        Err(e) => internal("pairing_link_revoke_failed", e),
    }
}

/// `GET /api/auth/clients`: the Gateway checks a session's owner here before revoking it.
async fn clients(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match require_scope(&state, &headers, "access:read") {
        Ok(principal) => {
            Json(state.auth.client_sessions(Some(&principal.session_id))).into_response()
        }
        Err(response) => *response,
    }
}

async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SessionIdRequest>,
) -> Response {
    let principal = match require_scope(&state, &headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state
        .auth
        .revoke_session(Some(&principal.session_id), &request.session_id)
    {
        Ok(Ok(revoked)) => Json(json!({ "revoked": revoked })).into_response(),
        Ok(Err(auth::RevokeCurrentSession)) => Json(json!({
            "_tag": "EnvironmentOperationForbiddenError",
            "code": "operation_forbidden",
            "reason": "current_session_revoke_not_allowed",
            "traceId": trace_id(),
        }))
        .with_status(StatusCode::FORBIDDEN),
        Err(e) => internal("client_session_revoke_failed", e),
    }
}

async fn revoke_other_clients(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let principal = match require_scope(&state, &headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.auth.revoke_other_sessions(&principal.session_id) {
        Ok(count) => Json(json!({ "revokedCount": count })).into_response(),
        Err(e) => internal("client_session_revoke_failed", e),
    }
}

/// Checks what every `/api/orchestration/*` route requires: the protocol header, a bearer
/// token with `orchestration:read`, and an engine.
fn orchestration_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Arc<dyn Engine>, Box<Response>> {
    if headers
        .get(ORCHESTRATION_PROTOCOL_HEADER)
        .and_then(|v| v.to_str().ok())
        != Some("2")
    {
        return Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_command",
        )));
    }
    let Some(token) = bearer(headers) else {
        return Err(Box::new(auth_invalid("missing_credential")));
    };
    let Some(principal) = state.auth.authenticate_bearer(token) else {
        return Err(Box::new(auth_invalid("invalid_credential")));
    };
    if !principal.has_scope("orchestration:read") {
        return Err(Box::new(
            Json(json!({
                "_tag": "EnvironmentScopeRequiredError",
                "code": "insufficient_scope",
                "requiredScope": "orchestration:read",
                "traceId": trace_id(),
            }))
            .with_status(StatusCode::FORBIDDEN),
        ));
    }
    state
        .engine
        .clone()
        .ok_or_else(|| Box::new(StatusCode::NOT_FOUND.into_response()))
}

fn snapshot_failed<E>(reason: &str, error: EngineError<E>) -> Response {
    if let EngineError::Internal(message) = &error {
        eprintln!("{reason}: {message}");
    }
    Json(json!({
        "_tag": "EnvironmentInternalError",
        "code": "internal_error",
        "reason": reason,
        "traceId": trace_id(),
    }))
    .with_status(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `GET /api/orchestration/shell`: always the full snapshot, which is valid for any query.
async fn shell_snapshot(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    match engine.shell_snapshot().await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => snapshot_failed("orchestration_snapshot_failed", error),
    }
}

/// `GET /api/orchestration/threads/:threadId`. An unknown thread is a plain 404, never the
/// structured not-found error, which would make the client mark the thread deleted.
async fn thread_snapshot(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    match engine.thread_snapshot(thread_id.into()).await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => snapshot_failed("orchestration_thread_snapshot_failed", error),
    }
}

/// `POST /api/projects/mutate`: `projects.mutate` over HTTP, so `conn-server project add`
/// reaches a running server without a WebSocket (Orbit adds its project this way). The body
/// is the method's payload; the answer its success or typed error.
async fn projects_mutate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return auth_invalid("missing_credential");
    };
    let Some(principal) = state.auth.authenticate_bearer(token) else {
        return auth_invalid("invalid_credential");
    };
    if !principal.has_scope("orchestration:operate") {
        return Json(json!({
            "_tag": "EnvironmentScopeRequiredError",
            "code": "insufficient_scope",
            "requiredScope": "orchestration:operate",
            "traceId": trace_id(),
        }))
        .with_status(StatusCode::FORBIDDEN);
    }
    let Some(engine) = &state.engine else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match engine.call("projects.mutate", body).await {
        Ok(result) => Json(result).into_response(),
        Err(EngineError::Rejected(error)) => Json(error).with_status(StatusCode::BAD_REQUEST),
        Err(EngineError::Internal(message)) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EnvironmentInternalError",
            "internal_error",
            &message,
        ),
    }
}

async fn ws(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if query
        .get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)
        .map(String::as_str)
        != Some("2")
    {
        return Json(json!({
            "code": "orchestration_protocol_incompatible",
            "message": format!("Update this client to one that supports orchestration protocol {ORCHESTRATION_PROTOCOL_VERSION}."),
            "orchestrationProtocolVersion": ORCHESTRATION_PROTOCOL_VERSION,
        }))
        .with_status(StatusCode::UPGRADE_REQUIRED);
    }
    let Some(principal) = authenticate_upgrade(&state, &query, &headers) else {
        let reason =
            if query.contains_key("wsTicket") || headers.contains_key(header::AUTHORIZATION) {
                "invalid_credential"
            } else {
                "missing_credential"
            };
        return auth_invalid(reason);
    };
    let session_id = principal.session_id.clone();
    let options = SessionOptions {
        frame_parts: query.contains_key(conn_wire::frame_parts::QUERY_PARAM),
        max_message_bytes: MAX_MESSAGE_BYTES,
        idle_timeout: Duration::from_secs(60),
        context: CallContext {
            headers: Vec::new(),
            principal: Some(Arc::new(principal)),
            ..CallContext::default()
        },
    };
    let table = state.table.clone();
    let auth = state.auth.clone();
    upgrade
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _connected = auth.connect(&session_id);
            // A revoked session loses its open sockets at once, as with the T3 server.
            tokio::select! {
                _ = session::run(socket, table, options) => {}
                _ = revoked(&auth, &session_id) => {}
            }
        })
}

/// Resolves once `session_id` is revoked or expires, here or by another process (the CLI).
async fn revoked(auth: &AuthStore, session_id: &str) {
    let mut changes = auth.subscribe();
    let mut check = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            change = changes.recv() => match change {
                Ok(AccessChange::ClientRemoved(id)) if id == session_id => return,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
                    if !auth.session_active(session_id) => return,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
                _ => {}
            },
            _ = check.tick() => {
                if !auth.session_active(session_id) {
                    return;
                }
            }
        }
    }
}

/// `authenticateWebSocketUpgrade`: an RPC ticket in `wsTicket`, else a bearer header.
fn authenticate_upgrade(
    state: &AppState,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Option<Principal> {
    match query
        .get("wsTicket")
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        Some(ticket) => state.auth.authenticate_ticket(ticket, "rpc"),
        None => bearer(headers).and_then(|t| state.auth.authenticate_bearer(t)),
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

fn trace_id() -> String {
    auth::random_hex(16)
}

fn auth_invalid(reason: &str) -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "EnvironmentAuthInvalidError",
        "auth_invalid",
        reason,
    )
}

fn error(status: StatusCode, tag: &str, code: &str, reason: &str) -> Response {
    Json(json!({ "_tag": tag, "code": code, "reason": reason, "traceId": trace_id() }))
        .with_status(status)
}

trait WithStatus {
    fn with_status(self, status: StatusCode) -> Response;
}

impl<T: IntoResponse> WithStatus for T {
    fn with_status(self, status: StatusCode) -> Response {
        (status, self).into_response()
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    async fn serve() -> (std::net::SocketAddr, Arc<AuthStore>) {
        serve_with(None).await
    }

    async fn serve_with(engine: Option<Arc<dyn Engine>>) -> (std::net::SocketAddr, Arc<AuthStore>) {
        let auth = AuthStore::in_memory();
        let state = AppState {
            table: Arc::new(MethodTable::new()),
            auth: auth.clone(),
            descriptor: Arc::new(crate::environment::descriptor("env-test", "Test")),
            engine,
            deps: Default::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        (addr, auth)
    }

    /// One HTTP/1.1 request; returns the status and the body.
    async fn call(addr: std::net::SocketAddr, head: &str, body: &str) -> (u16, String) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "{head}\r\nhost: {addr}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            bytes.extend_from_slice(&buf[..n]);
            // An upgraded socket stays open; its headers are all there is to read.
            let upgraded =
                bytes.starts_with(b"HTTP/1.1 101") && bytes.windows(4).any(|w| w == b"\r\n\r\n");
            if n == 0 || upgraded {
                break;
            }
        }
        let response = String::from_utf8(bytes).unwrap();
        let status = response[9..12].parse().unwrap();
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_owned())
            .unwrap_or_default();
        (status, body)
    }

    const UPGRADE: &str = "connection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==";

    #[tokio::test(flavor = "current_thread")]
    async fn pairs_and_authenticates_the_socket() {
        let (addr, auth) = serve().await;
        let (status, body) = call(addr, "GET /.well-known/t3/environment HTTP/1.1", "").await;
        assert_eq!(status, 200);
        let descriptor: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(descriptor["orchestrationProtocolVersion"], 2);

        let (_, body) = call(addr, "GET /api/auth/session HTTP/1.1", "").await;
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["authenticated"],
            false
        );

        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type={}&subject_token={code}&subject_token_type={}&requested_token_type={}",
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
            "urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap",
            "urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        let (status, body) = call(addr, head, &form).await;
        assert_eq!(status, 200, "{body}");
        let token: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(token["token_type"], "Bearer");
        let access = token["access_token"].as_str().unwrap();
        // The code is spent.
        let (status, body) = call(addr, head, &form).await;
        assert_eq!(status, 401);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "invalid_credential"
        );

        let bearer = format!("authorization: Bearer {access}");
        let (_, body) = call(
            addr,
            &format!("GET /api/auth/session HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        let session: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(session["authenticated"], true);
        assert_eq!(session["sessionMethod"], "bearer-access-token");

        let (status, body) = call(
            addr,
            &format!("POST /api/auth/websocket-ticket/rpc HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let ticket: Value = serde_json::from_str(&body).unwrap();
        let ticket = ticket["ticket"].as_str().unwrap();

        let ws = |query: String| format!("GET /ws?{query} HTTP/1.1\r\n{UPGRADE}");
        let (status, _) = call(
            addr,
            &ws(format!("orchestrationProtocol=2&wsTicket={ticket}")),
            "",
        )
        .await;
        assert_eq!(status, 101);
        let (status, body) = call(
            addr,
            &ws("orchestrationProtocol=2&wsTicket=forged".into()),
            "",
        )
        .await;
        assert_eq!(
            (
                status,
                serde_json::from_str::<Value>(&body).unwrap()["reason"].clone()
            ),
            (401, json!("invalid_credential"))
        );
        let (status, body) = call(addr, &ws("orchestrationProtocol=2".into()), "").await;
        assert_eq!(
            (
                status,
                serde_json::from_str::<Value>(&body).unwrap()["reason"].clone()
            ),
            (401, json!("missing_credential"))
        );
        // The bearer token is not accepted as a ticket.
        let (status, _) = call(
            addr,
            &ws(format!("orchestrationProtocol=2&wsTicket={access}")),
            "",
        )
        .await;
        assert_eq!(status, 401);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn orchestration_snapshots_need_the_protocol_header_and_a_bearer() {
        let dir = std::env::temp_dir().join(format!("conn-server-http-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "P".into(),
            workspace_root: "/tmp/p".into(),
        }];
        let engine: Arc<dyn Engine> = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let (addr, auth) = serve_with(Some(engine)).await;
        let access = auth
            .exchange(
                &auth
                    .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap()
            .token;
        let bearer = format!("authorization: Bearer {access}");
        let header = "x-t3-orchestration-protocol: 2";
        let get = |path: &str, headers: &[&str]| {
            let head = [format!("GET {path} HTTP/1.1")]
                .into_iter()
                .chain(headers.iter().map(|h| (*h).to_owned()))
                .collect::<Vec<_>>()
                .join("\r\n");
            async move { call(addr, &head, "").await }
        };

        let shell = "/api/orchestration/shell";
        assert_eq!(get(shell, &[&bearer]).await.0, 400);
        assert_eq!(get(shell, &[header]).await.0, 401);
        assert_eq!(
            get(shell, &[header, "authorization: Bearer forged"])
                .await
                .0,
            401
        );
        let (status, body) = get(shell, &[header, &bearer]).await;
        assert_eq!(status, 200, "{body}");
        let snapshot: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(snapshot["projects"][0]["title"], "P");
        // An unknown thread is a plain 404, never the structured not-found error.
        let (status, body) = get("/api/orchestration/threads/nope", &[header, &bearer]).await;
        assert_eq!((status, body.as_str()), (404, ""));

        // `project add` on a running server: an operate-scoped bearer adds the project now.
        let root = dir.to_string_lossy().into_owned();
        let add = json!({"type": "project.create", "commandId": "add-1",
            "projectId": conn_engine::SqliteEngine::project_id_for(&root),
            "title": "Added", "workspaceRoot": root})
        .to_string();
        let post = |auth_header: String| {
            let head = format!(
                "POST /api/projects/mutate HTTP/1.1\r\ncontent-type: application/json\r\n{auth_header}"
            );
            let add = add.clone();
            async move { call(addr, &head, &add).await }
        };
        assert_eq!(post("x-none: 1".into()).await.0, 401);
        let (status, body) = post(bearer.clone()).await;
        assert_eq!(status, 200, "{body}");
        let (_, body) = get(shell, &[header, &bearer]).await;
        let snapshot: Value = serde_json::from_str(&body).unwrap();
        let titles: Vec<&str> = snapshot["projects"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["title"].as_str())
            .collect();
        assert!(titles.contains(&"Added"), "{titles:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn access_routes_issue_scoped_links_list_and_revoke_clients() {
        let (addr, auth) = serve().await;
        let admin = auth
            .issue_session(auth::SessionRequest {
                scopes: vec![
                    "access:read".into(),
                    "access:write".into(),
                    "relay:read".into(),
                ],
                label: Some("Orbit Gateway".into()),
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .unwrap();
        let bearer = format!("authorization: Bearer {}", admin.token);
        let post = |path: &str, body: &str| {
            let head =
                format!("POST {path} HTTP/1.1\r\n{bearer}\r\ncontent-type: application/json");
            let body = body.to_owned();
            async move { call(addr, &head, &body).await }
        };

        let (status, body) = post(
            "/api/auth/pairing-token",
            r#"{"label":"node via Orbit","scopes":["relay:read","access:read"]}"#,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let link: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(link["label"], "node via Orbit");
        // A scope the caller lacks is refused with the exact permission.
        let (status, body) = post(
            "/api/auth/pairing-token",
            r#"{"scopes":["settings:write"]}"#,
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["requiredPermission"],
            "settings:write"
        );
        let (status, _) = post(
            "/api/auth/pairing-token",
            r#"{"scopes":["access:read","access:read"]}"#,
        )
        .await;
        assert_eq!(status, 400);

        let device = auth
            .exchange(
                link["credential"].as_str().unwrap(),
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let (status, body) = call(
            addr,
            &format!("GET /api/auth/clients HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 200);
        let clients: Vec<Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(clients.len(), 2);
        assert!(
            clients
                .iter()
                .any(|c| c["current"] == true && c["client"]["label"] == "Orbit Gateway")
        );

        let mine = format!(r#"{{"sessionId":"{}"}}"#, admin.principal.session_id);
        let (status, body) = post("/api/auth/clients/revoke", &mine).await;
        assert_eq!(status, 403);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "current_session_revoke_not_allowed"
        );
        let theirs = format!(r#"{{"sessionId":"{}"}}"#, device.principal.session_id);
        let (status, body) = post("/api/auth/clients/revoke", &theirs).await;
        assert_eq!((status, body.as_str()), (200, r#"{"revoked":true}"#));
        assert!(auth.authenticate_bearer(&device.token).is_none());

        let unused = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap();
        let (_, body) = post(
            "/api/auth/pairing-links/revoke",
            &format!(r#"{{"id":"{}"}}"#, unused.id),
        )
        .await;
        assert_eq!(body, r#"{"revoked":true}"#);
        let (_, body) = post("/api/auth/clients/revoke-others", "").await;
        assert_eq!(body, r#"{"revokedCount":0}"#);
        // Without access:read the list is refused.
        let (status, _) = call(addr, "GET /api/auth/clients HTTP/1.1", "").await;
        assert_eq!(status, 401);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_revoked_session_loses_its_open_socket() {
        let (addr, auth) = serve().await;
        let session = auth
            .exchange(
                &auth
                    .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let (ticket, _) = auth.issue_ticket(&session.token, Some("rpc")).unwrap();
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /ws?orchestrationProtocol=2&wsTicket={ticket} HTTP/1.1\r\nhost: {addr}\r\n{UPGRADE}\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(buf[..n].starts_with(b"HTTP/1.1 101"));
        // Connected sockets show in the access list.
        let listed = auth.client_session(&session.principal.session_id, None);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut connected = listed.is_some_and(|s| s.connected);
        while !connected && tokio::time::Instant::now() < deadline {
            tokio::task::yield_now().await;
            connected = auth
                .client_session(&session.principal.session_id, None)
                .is_some_and(|s| s.connected);
        }
        assert!(connected);
        auth.revoke_session(None, &session.principal.session_id)
            .unwrap()
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "the socket stayed open after revocation");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refuses_other_protocol_versions_before_auth() {
        let (addr, _) = serve().await;
        for query in ["", "orchestrationProtocol=1", "orchestrationProtocol=3"] {
            let (status, body) =
                call(addr, &format!("GET /ws?{query} HTTP/1.1\r\n{UPGRADE}"), "").await;
            assert_eq!(status, 426);
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["code"], "orchestration_protocol_incompatible");
            assert_eq!(body["orchestrationProtocolVersion"], 2);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dpop_exchanges_are_refused_without_spending_the_code() {
        let (addr, auth) = serve().await;
        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token={code}&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        let (status, _) = call(addr, &format!("{head}\r\ndpop: x.y.z"), &form).await;
        assert_eq!(status, 401);
        let (status, _) = call(addr, head, &form).await;
        assert_eq!(status, 200);
    }
}
