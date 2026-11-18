//! The managed ingress: its own listener and its own routes. Every path needs a managed
//! principal. A native session, a native bearer, a cookie or a paired device's credential is
//! refused here, even on a route the reader profile allows, and a failed `conn_mt_` token
//! never falls through to native auth.

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;

use super::{
    AdmitError, Claims, Handle, ManagedPrincipal, READER_SCOPES, Shared, gateway::Gateway,
    provision::PreviewTab,
};
use crate::{
    AppState,
    session::{self, SessionGate, SessionOptions},
    table::{CallContext, MethodTable},
};

/// The RPC methods of the `reader` profile. Everything else is refused on this ingress.
pub const READER_METHODS: [&str; 4] = [
    "orchestration.subscribeShell",
    "orchestration.subscribeThread",
    "terminal.observe",
    "subscribeTerminalMetadata",
];

/// Managed tickets start with this, so a native ticket never redeems here and a managed one
/// never redeems on the native ingress.
const TICKET_PREFIX: &str = "conn_mtk_";
const TICKET_TTL_MS: u64 = 30_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Route {
    Rpc,
    Media,
}

impl Route {
    fn name(self) -> &'static str {
        match self {
            Route::Rpc => "rpc",
            Route::Media => "media",
        }
    }
}

/// The managed ingress's state.
pub struct Managed {
    pub shared: Arc<Shared>,
    pub gateway: Arc<dyn Gateway>,
    preview_tabs: Vec<PreviewTab>,
}

impl std::fmt::Debug for Managed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Managed").finish_non_exhaustive()
    }
}

impl Managed {
    pub fn new(
        shared: Arc<Shared>,
        gateway: Arc<dyn Gateway>,
        preview_tabs: Vec<PreviewTab>,
    ) -> Arc<Self> {
        Arc::new(Self {
            shared,
            gateway,
            preview_tabs,
        })
    }
}

#[derive(Clone)]
struct IngressState {
    app: AppState,
    managed: Arc<Managed>,
    table: Arc<MethodTable>,
}

/// Whether the claims are a `reader` token: exactly the reader scopes and no grant of a
/// later profile.
pub fn is_reader(claims: &Claims) -> bool {
    let mut scopes: Vec<&str> = claims.scopes.iter().map(String::as_str).collect();
    scopes.sort_unstable();
    scopes.dedup();
    let mut reader = READER_SCOPES.to_vec();
    reader.sort_unstable();
    scopes == reader && claims.extra.is_empty()
}

pub fn router(app: AppState, managed: Arc<Managed>) -> Router {
    let table = Arc::new(app.table.restricted(&READER_METHODS));
    let state = IngressState {
        app,
        managed,
        table,
    };
    Router::new()
        .route("/api/auth/websocket-ticket/{use}", post(ticket))
        .route("/ws", get(ws))
        .route("/api/orchestration/shell", get(shell_snapshot))
        .route(
            "/api/orchestration/threads/{thread_id}",
            get(thread_snapshot),
        )
        .route("/api/preview-stream/ws", get(preview))
        .fallback(refused)
        .layer(axum::middleware::map_response(close_after))
        .with_state(state)
}

/// One request per managed HTTP connection: its handler ends with the connection.
async fn close_after(mut response: Response) -> Response {
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        response.headers_mut().insert(
            header::CONNECTION,
            header::HeaderValue::from_static("close"),
        );
    }
    response
}

fn error(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(json!({ "_tag": "ManagedAccessError", "code": code })),
    )
        .into_response()
}

async fn refused() -> Response {
    error(StatusCode::FORBIDDEN, "managed_route_refused")
}

fn admit_failed(error_kind: &AdmitError) -> Response {
    match error_kind {
        AdmitError::Invalid => error(StatusCode::UNAUTHORIZED, "managed_token_invalid"),
        AdmitError::Forbidden => error(StatusCode::FORBIDDEN, "managed_access_refused"),
        AdmitError::Unavailable => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "managed_authority_unavailable",
        ),
    }
}

/// The bearer of the request. Only an `Authorization: Bearer` header counts; a cookie or a
/// query token is never read.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

/// The caller's address as the Gateway resolves it: the TCP peer, never a header.
fn peer(addr: SocketAddr) -> String {
    addr.ip().to_canonical().to_string()
}

async fn admit_bearer(
    state: &IngressState,
    headers: &HeaderMap,
    addr: SocketAddr,
) -> Result<(ManagedPrincipal, Handle), Box<Response>> {
    let Some(token) = bearer(headers) else {
        return Err(Box::new(error(
            StatusCode::UNAUTHORIZED,
            "managed_token_missing",
        )));
    };
    state
        .managed
        .shared
        .admit(&state.managed.gateway, token, peer(addr), None, is_reader)
        .await
        .map_err(|e| Box::new(admit_failed(&e)))
}

fn native_principal(principal: &ManagedPrincipal, handle: &Handle) -> crate::auth::Principal {
    crate::auth::Principal {
        session_id: format!("managed:{}:{handle:?}", principal.token_id),
        subject: format!("orbit-node:{}", principal.caller_node_id),
        scopes: principal.scopes.clone(),
        expires_at_ms: principal.expires_ms,
    }
}

/// `POST /api/auth/websocket-ticket/{rpc|media}`: a one-use ticket bound to the managed
/// token. Redeeming it introspects the token again.
async fn ticket(
    State(state): State<IngressState>,
    ConnectInfo(conn): ConnectInfo<super::conn::Peer>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Response {
    let route = match route.as_str() {
        "rpc" => Route::Rpc,
        "media" => Route::Media,
        _ => return refused().await,
    };
    let (principal, handle) = match admit_bearer(&state, &headers, conn.addr).await {
        Ok(admitted) => admitted,
        Err(response) => return *response,
    };
    // The handler rides the connection from here on, whatever this answers.
    let handle = Arc::new(handle);
    conn.slot.attach(handle.clone());
    // Monotonic throughout: the token's deadline (from the verified Gateway time) and the
    // ticket's own lifetime. The wall time only labels the answer.
    let now = tokio::time::Instant::now();
    let deadline = handle
        .deadline()
        .min(now + Duration::from_millis(TICKET_TTL_MS));
    let expires_ms = conn_support::time::now_ms()
        + u64::try_from(deadline.saturating_duration_since(now).as_millis()).unwrap_or(0);
    let ticket = format!("{TICKET_PREFIX}{}", crate::auth::random_hex(32));
    let shared = &state.managed.shared;
    let Some(token) = bearer(&headers) else {
        return error(StatusCode::UNAUTHORIZED, "managed_token_missing");
    };
    let binding = super::authority::TicketBinding {
        edge: principal.edge_id,
        redeem_by: deadline,
        id: 0,
    };
    let minted = shared.with(|a| {
        (
            a.mint_ticket(ticket.clone(), token.to_owned(), route.name(), binding, now),
            Default::default(),
        )
    });
    match minted {
        Ok(()) => {}
        Err(super::authority::MintRefusal::Full) => {
            return error(StatusCode::TOO_MANY_REQUESTS, "managed_ticket_limit");
        }
        Err(super::authority::MintRefusal::Fenced) => {
            return admit_failed(&AdmitError::Forbidden);
        }
    }
    if !crate::session::pass(Some(&SessionGate(handle))).await {
        shared.with(|a| {
            a.drop_ticket(&ticket);
            ((), Default::default())
        });
        return admit_failed(&AdmitError::Forbidden);
    }
    let mut response = Json(json!({
        "ticket": ticket,
        "expiresAt": conn_support::time::iso_from_ms(expires_ms),
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response
}

/// Admits a managed ticket or bearer for an upgrade. A ticket is spent at once and its token
/// introspected again: the redemption is a transport admission of its own.
async fn admit_upgrade(
    state: &IngressState,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    addr: SocketAddr,
    route: Route,
) -> Result<(ManagedPrincipal, Handle), Box<Response>> {
    let Some(ticket) = query
        .get("wsTicket")
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    else {
        return admit_bearer(state, headers, addr).await;
    };
    if !ticket.starts_with(TICKET_PREFIX) {
        return Err(Box::new(error(
            StatusCode::UNAUTHORIZED,
            "managed_ticket_invalid",
        )));
    }
    let now = tokio::time::Instant::now();
    let spent = state
        .managed
        .shared
        .with(|a| (a.take_ticket(ticket, route.name(), now), Default::default()));
    let Some((token, binding)) = spent else {
        return Err(Box::new(error(
            StatusCode::UNAUTHORIZED,
            "managed_ticket_invalid",
        )));
    };
    // The redemption is checked again where the handler registers: the ticket's own edge,
    // no fence since it was minted, and its deadline. The session then carries the token's
    // principal and expiry, as the contract asks of a managed ticket.
    state
        .managed
        .shared
        .admit(
            &state.managed.gateway,
            &token,
            peer(addr),
            Some(binding),
            is_reader,
        )
        .await
        .map_err(|e| Box::new(admit_failed(&e)))
}

async fn ws(
    upgrade: WebSocketUpgrade,
    State(state): State<IngressState>,
    ConnectInfo(conn): ConnectInfo<super::conn::Peer>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if query.get("orchestrationProtocol").map(String::as_str) != Some("2") {
        return error(
            StatusCode::UPGRADE_REQUIRED,
            "orchestration_protocol_incompatible",
        );
    }
    let (principal, handle) =
        match admit_upgrade(&state, &query, &headers, conn.addr, Route::Rpc).await {
            Ok(admitted) => admitted,
            Err(response) => return *response,
        };
    let context = CallContext {
        principal: Some(Arc::new(native_principal(&principal, &handle))),
        ..CallContext::default()
    };
    // The socket itself is fenced with the handler: the upgraded connection keeps it.
    let handle = Arc::new(handle);
    conn.slot.attach(handle.clone());
    // The handler is registered before the upgrade completes: a fence that lands now closes
    // the socket on its first check.
    let options = SessionOptions {
        frame_parts: query.contains_key(conn_wire::frame_parts::QUERY_PARAM),
        max_message_bytes: crate::http::MAX_MESSAGE_BYTES,
        idle_timeout: Duration::from_secs(60),
        context,
        gate: Some(SessionGate(handle)),
    };
    let table = state.table.clone();
    upgrade
        .max_message_size(crate::http::MAX_MESSAGE_BYTES)
        .max_frame_size(crate::http::MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| session::run(socket, table, options))
}

fn engine(
    state: &IngressState,
    headers: &HeaderMap,
) -> Result<Arc<dyn conn_engine::Engine>, Box<Response>> {
    if headers
        .get("x-t3-orchestration-protocol")
        .and_then(|v| v.to_str().ok())
        != Some("2")
    {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, "invalid_command")));
    }
    state
        .app
        .engine
        .clone()
        .ok_or_else(|| Box::new(StatusCode::NOT_FOUND.into_response()))
}

/// Runs `read` while the handler is open (waiting out a pause), and returns its value only
/// if the handler still passes after it. The handler is attached to the connection, which
/// carries only this request: it stays registered until Hyper wrote or dropped the last byte,
/// and a fence ends the connection at the socket.
async fn guarded(
    conn: &super::conn::Peer,
    handle: Handle,
    read: impl std::future::Future<Output = Result<Response, Response>>,
) -> Response {
    let handle = Arc::new(handle);
    conn.slot.attach(handle.clone());
    let gate = SessionGate(handle);
    let closed = gate.0.closed();
    let response = tokio::select! {
        biased;
        () = closed => return admit_failed(&AdmitError::Forbidden),
        response = read => response,
    };
    let response = match response {
        Ok(response) | Err(response) => response,
    };
    if crate::session::pass(Some(&gate)).await {
        response
    } else {
        admit_failed(&AdmitError::Forbidden)
    }
}

async fn shell_snapshot(
    State(state): State<IngressState>,
    ConnectInfo(conn): ConnectInfo<super::conn::Peer>,
    headers: HeaderMap,
) -> Response {
    let engine = match engine(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    let (_, handle) = match admit_bearer(&state, &headers, conn.addr).await {
        Ok(admitted) => admitted,
        Err(response) => return *response,
    };
    guarded(&conn, handle, async move {
        match engine.shell_snapshot().await {
            Ok(snapshot) => Ok(Json(snapshot).into_response()),
            Err(_) => Err(crate::http::internal_reason(
                "orchestration_snapshot_failed",
            )),
        }
    })
    .await
}

async fn thread_snapshot(
    State(state): State<IngressState>,
    ConnectInfo(conn): ConnectInfo<super::conn::Peer>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let engine = match engine(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    let (_, handle) = match admit_bearer(&state, &headers, conn.addr).await {
        Ok(admitted) => admitted,
        Err(response) => return *response,
    };
    guarded(&conn, handle, async move {
        match engine.thread_snapshot(thread_id.into()).await {
            Ok(Some(snapshot)) => Ok(Json(snapshot).into_response()),
            Ok(None) => Err(StatusCode::NOT_FOUND.into_response()),
            Err(_) => Err(crate::http::internal_reason(
                "orchestration_thread_snapshot_failed",
            )),
        }
    })
    .await
}

/// A read-only viewer of a preview tab the provisioning names.
async fn preview(
    ws: WebSocketUpgrade,
    State(state): State<IngressState>,
    ConnectInfo(conn): ConnectInfo<super::conn::Peer>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let (thread, tab) = (
        query.get("threadId").cloned().unwrap_or_default(),
        query.get("tabId").cloned().unwrap_or_default(),
    );
    let known = state
        .managed
        .preview_tabs
        .iter()
        .any(|t| t.thread_id == thread && t.tab_id == tab);
    if !known {
        return refused().await;
    }
    let (_, handle) = match admit_upgrade(&state, &query, &headers, conn.addr, Route::Media).await {
        Ok(admitted) => admitted,
        Err(response) => return *response,
    };
    // The handler rides the connection from here on, whatever this answers.
    let handle = Arc::new(handle);
    conn.slot.attach(handle.clone());
    let Some(preview) = state.app.deps.preview.clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let gate = SessionGate(handle);
    crate::routes::preview::upgrade_viewer(ws, preview, &thread, &tab, false, &query, Some(gate))
        .await
}
