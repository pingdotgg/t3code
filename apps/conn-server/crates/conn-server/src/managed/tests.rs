//! Lab tests: a real managed ingress on loopback, real RPC WebSockets, the real engine, and
//! an in-memory Gateway that follows the contract (revisions, tokens bound to edges and
//! peers, owed ACKs). Caller A comes from 127.0.0.1, caller B from ::1, so the Gateway tells
//! them apart by address as it does by WireGuard peer. They run on the wall clock with the
//! lab values (probe 1 s, lease 3 s) and print the measured bounds (`--nocapture`).

use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use futures_core::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

use super::{
    Shared,
    authority::Notice,
    gateway::{Gateway, GatewayError},
    ingress::{self, Managed},
};
use crate::AppState;

pub(crate) const ENV: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const NODE_A: u64 = 101;
const NODE_B: u64 = 102;
const EDGE_A: u64 = 11;
const EDGE_B: u64 = 12;

/// 0: answers; 1: refuses every call at once (an explicit close); 2: never answers (a silent
/// partition).
const UP: u8 = 0;
const CLOSED: u8 = 1;
const SILENT: u8 = 2;

#[derive(Clone)]
pub(crate) struct Token {
    pub edge: u64,
    pub caller: u64,
    pub expires_ms: u64,
    pub revoked: bool,
    /// Extra claims a later profile adds (the task worker grant).
    pub extra: serde_json::Map<String, Value>,
    pub scopes: Vec<String>,
}

#[derive(Default)]
pub(crate) struct FakeState {
    pub edges: BTreeMap<u64, u64>,
    pub revision: u64,
    pub removed: BTreeMap<u64, Vec<u64>>,
    pub tokens: HashMap<String, Token>,
    pub peers: HashMap<String, u64>,
    /// Owed revision to its first ACK body.
    pub owed: BTreeMap<u64, Option<Value>>,
    pub ack_calls: u32,
    pub lose_ack_requests: u32,
    /// A refusal code every introspection answers with.
    pub introspect_refusal: Option<(u16, String)>,
    /// When each answered probe arrived, as the send time's upper bound.
    pub answered_probes: Vec<Instant>,
}

pub(crate) struct FakeGateway {
    pub state: Mutex<FakeState>,
    pub mode: AtomicU8,
}

impl FakeGateway {
    pub(crate) fn new() -> Arc<Self> {
        let mut state = FakeState::default();
        state.edges.insert(EDGE_A, NODE_A);
        state.edges.insert(EDGE_B, NODE_B);
        state.peers.insert("127.0.0.1".into(), NODE_A);
        state.peers.insert("::1".into(), NODE_B);
        Arc::new(Self {
            state: Mutex::new(state),
            mode: AtomicU8::new(UP),
        })
    }

    /// The edge-removal transaction: delete, raise the revision, revoke tokens, owe an ACK.
    /// Returns the notice the Gateway would publish after the commit.
    pub(crate) fn remove_edge(&self, edge: u64) -> Notice {
        let mut state = self.state.lock().unwrap();
        state.edges.remove(&edge);
        state.revision += 1;
        let revision = state.revision;
        state.removed.insert(revision, vec![edge]);
        for token in state.tokens.values_mut() {
            if token.edge == edge {
                token.revoked = true;
            }
        }
        state.owed.insert(revision, None);
        Notice {
            environment_id: ENV.into(),
            generation: 1,
            revision,
            edge_ids: vec![edge],
        }
    }

    pub(crate) fn issue(&self, caller: u64) -> String {
        self.issue_with(
            caller,
            super::READER_SCOPES
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            serde_json::Map::new(),
        )
    }

    pub(crate) fn issue_with(
        &self,
        caller: u64,
        scopes: Vec<String>,
        extra: serde_json::Map<String, Value>,
    ) -> String {
        let mut state = self.state.lock().unwrap();
        let edge = *state
            .edges
            .iter()
            .find(|(_, c)| **c == caller)
            .expect("a direct edge")
            .0;
        let token = format!("conn_mt_{}", &crate::auth::random_hex(32)[..43]);
        state.tokens.insert(
            token.clone(),
            Token {
                edge,
                caller,
                expires_ms: conn_support::time::now_ms() + 15 * 60_000,
                revoked: false,
                extra,
                scopes,
            },
        );
        token
    }

    fn gate(&self) -> Option<BoxFuture<'static, Result<Value, GatewayError>>> {
        match self.mode.load(Ordering::SeqCst) {
            CLOSED => Some(Box::pin(async {
                Err(GatewayError::Transport("connection refused".into()))
            })),
            SILENT => Some(Box::pin(std::future::pending())),
            _ => None,
        }
    }

    fn owed_list(state: &FakeState) -> Value {
        Value::Array(
            state
                .owed
                .iter()
                .filter(|(_, acked)| acked.is_none())
                .map(|(r, _)| json!({"revision": r, "edge_ids": state.removed.get(r).cloned().unwrap_or_default()}))
                .collect(),
        )
    }
}

fn refused(status: u16, code: &str) -> Result<Value, GatewayError> {
    Err(GatewayError::Refused {
        status,
        code: code.into(),
    })
}

impl Gateway for FakeGateway {
    fn authority(
        &self,
        nonce: String,
        after: Option<u64>,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        if let Some(gate) = self.gate() {
            return gate;
        }
        let mut state = self.state.lock().unwrap();
        state.answered_probes.push(Instant::now());
        let head = state.revision;
        let mut reply = json!({
            "nonce": nonce, "environment_id": ENV, "generation": 1,
            "head_revision": head, "server_time": conn_support::time::now_iso(),
            "owed": Self::owed_list(&state),
        });
        match after {
            None => {
                reply["kind"] = json!("snapshot");
                reply["edges"] = state
                    .edges
                    .iter()
                    .map(|(e, c)| json!({"edge_id": e, "consumer_node_id": c}))
                    .collect();
            }
            Some(after) if after > head => {
                return Box::pin(async { refused(409, "conn.managed_revision_future") });
            }
            Some(after) if after == head => reply["kind"] = json!("current"),
            Some(after) => {
                reply["kind"] = json!("delta");
                reply["revisions"] = state
                    .removed
                    .range(after + 1..)
                    .map(|(r, e)| json!({"revision": r, "edge_ids": e}))
                    .collect();
            }
        }
        Box::pin(async move { Ok(reply) })
    }

    fn introspect(
        &self,
        nonce: String,
        token: String,
        peer: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        if let Some(gate) = self.gate() {
            return gate;
        }
        let state = self.state.lock().unwrap();
        if let Some((status, code)) = state.introspect_refusal.clone() {
            return Box::pin(async move { refused(status, &code) });
        }
        let result = match state.tokens.get(&token) {
            Some(t)
                if !t.revoked
                    && state.edges.contains_key(&t.edge)
                    && t.expires_ms > conn_support::time::now_ms() =>
            {
                if state.peers.get(&peer) != Some(&t.caller) {
                    refused(403, "conn.managed_peer_mismatch")
                } else {
                    let mut claims = json!({
                        "nonce": nonce, "environment_id": ENV, "generation": 1,
                        "token_id": format!("tok-{}", t.edge), "caller_node_id": t.caller,
                        "edge_id": t.edge, "scopes": t.scopes,
                        "expires_at": conn_support::time::iso_from_ms(t.expires_ms),
                        "revision": state.revision,
                    });
                    for (k, v) in &t.extra {
                        claims[k] = v.clone();
                    }
                    Ok(claims)
                }
            }
            _ => refused(403, "conn.managed_token_invalid"),
        };
        Box::pin(async move { result })
    }

    fn ack(&self, body: Value) -> BoxFuture<'static, Result<Value, GatewayError>> {
        if let Some(gate) = self.gate() {
            return gate;
        }
        let mut state = self.state.lock().unwrap();
        state.ack_calls += 1;
        if state.lose_ack_requests > 0 {
            // The request never reached the Gateway: the row stays owed.
            state.lose_ack_requests -= 1;
            return Box::pin(async { Err(GatewayError::Transport("request lost".into())) });
        }
        let revision = body["revision"].as_u64().unwrap_or_default();
        let result = match state.owed.get_mut(&revision) {
            None => refused(409, "conn.managed_ack_unknown"),
            Some(first) => {
                // The first valid ACK is recorded; an exact retry answers it again.
                let recorded = first.get_or_insert(body).clone();
                Ok(json!({"revision": revision, "kind": recorded["kind"]}))
            }
        };
        Box::pin(async move { result })
    }

    fn realtime(&self) -> BoxFuture<'static, Result<Value, GatewayError>> {
        Box::pin(async { refused(404, "unused") })
    }

    fn broadcasting_auth(
        &self,
        _: String,
        _: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        Box::pin(async { refused(404, "unused") })
    }
}

pub(crate) struct Lab {
    pub fake: Arc<FakeGateway>,
    pub shared: Arc<Shared>,
    pub v4: SocketAddr,
    pub v6: SocketAddr,
    pub native: SocketAddr,
    pub app: AppState,
    _dir: TempDir,
}

pub(crate) struct TempDir(pub std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Lab {
    pub(crate) async fn start() -> Self {
        let dir = std::env::temp_dir().join(format!("conn-managed-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![
            conn_engine::ProjectConfig {
                title: "P".into(),
                workspace_root: "/tmp/p".into(),
            },
            conn_engine::ProjectConfig {
                title: "Q".into(),
                workspace_root: "/tmp/q".into(),
            },
        ];
        // A scripted provider, so runs start, wait, ask and end as a real turn would.
        let fake: Arc<dyn conn_provider::Provider> =
            Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
        config.provider_set = Some(conn_provider::ProviderSet::from(vec![fake]));
        let engine: Arc<dyn conn_engine::Engine> =
            Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let deps = crate::methods::Deps {
            engine: Some(engine.clone()),
            ..crate::methods::Deps::default()
        };
        let app = AppState {
            table: Arc::new(crate::method_table(&deps)),
            auth: crate::auth::AuthStore::in_memory(),
            descriptor: Arc::new(crate::environment::descriptor(ENV, "Lab", false, None)),
            engine: Some(engine),
            deps,
        };
        let fake = FakeGateway::new();
        let shared = Shared::new(ENV.into(), 1);
        let gateway: Arc<dyn Gateway> = fake.clone();
        shared.spawn(gateway.clone());
        // The lab delivers notices by hand; the link itself is up.
        shared.set_notice_link(true);
        let managed = Managed::new(shared.clone(), gateway, vec![]);
        let router = ingress::router(app.clone(), managed);
        let serve = |addr: &'static str| {
            let router = router.clone();
            async move {
                let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
                let local = listener.local_addr().unwrap();
                tokio::spawn(async move { super::conn::serve(listener, router).await });
                local
            }
        };
        let v4 = serve("127.0.0.1:0").await;
        let v6 = serve("[::1]:0").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = listener.local_addr().unwrap();
        let native_router = crate::router(app.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                native_router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });
        let lab = Self {
            fake,
            shared,
            v4,
            v6,
            native,
            app,
            _dir: TempDir(dir),
        };
        lab.until_available().await;
        lab
    }

    pub(crate) async fn until_available(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.shared.read(|a| a.available(Instant::now())) {
            assert!(Instant::now() < deadline, "managed access never opened");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub(crate) fn deliver(&self, notice: &Notice) {
        self.shared.notice(notice);
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Opens the managed RPC socket with a bearer, or returns the refusal status.
pub(crate) async fn connect(
    addr: SocketAddr,
    query: &str,
    bearer: Option<&str>,
) -> Result<Socket, u16> {
    let url = format!("ws://{addr}/ws?orchestrationProtocol=2{query}");
    let mut request = url.into_client_request().unwrap();
    if let Some(token) = bearer {
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    match tokio_tungstenite::client_async(request, tcp).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(error) => panic!("{error}"),
    }
}

pub(crate) async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

/// The next JSON frame, acking chunks; `None` once the socket closed.
pub(crate) async fn next(socket: &mut Socket) -> Option<Value> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value["_tag"] == "Chunk" {
                    send(
                        socket,
                        json!({"_tag": "Ack", "requestId": value["requestId"]}),
                    )
                    .await;
                }
                return Some(value);
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => {}
        }
    }
}

/// Waits for the close; returns when it came.
async fn closed_at(socket: &mut Socket) -> Instant {
    while next(socket).await.is_some() {}
    Instant::now()
}

/// Sends a Ping and expects the Pong, skipping stream chunks.
pub(crate) async fn ping(socket: &mut Socket) -> bool {
    send(socket, json!({"_tag": "Ping"})).await;
    let pong = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match next(socket).await {
                Some(v) if v["_tag"] == "Pong" => return true,
                Some(_) => {}
                None => return false,
            }
        }
    })
    .await;
    pong.unwrap_or(false)
}

async fn subscribed(addr: SocketAddr, token: &str) -> Socket {
    let mut socket = connect(addr, "", Some(token)).await.expect("admitted");
    send(
        &mut socket,
        json!({"_tag": "Request", "id": "1", "tag": "orchestration.subscribeShell", "payload": {}, "headers": []}),
    )
    .await;
    let first = next(&mut socket).await.expect("a first chunk");
    assert_eq!(first["_tag"], "Chunk", "{first}");
    socket
}

pub(crate) async fn http(
    addr: SocketAddr,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &str,
) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = bearer
        .map(|t| format!("authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nhost: lab\r\n{auth}x-t3-orchestration-protocol: 2\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out).await;
    let text = String::from_utf8_lossy(&out);
    text.split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

async fn mint_ticket(addr: SocketAddr, token: &str, route: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "POST /api/auth/websocket-ticket/{route} HTTP/1.1\r\nhost: lab\r\nauthorization: Bearer {token}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out).await;
    let text = String::from_utf8_lossy(&out);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default();
    serde_json::from_str::<Value>(body).unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn until_ack(lab: &Lab, revision: u64) -> (Value, Instant) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(Some(ack)) = lab.fake.state.lock().unwrap().owed.get(&revision).cloned() {
            return (ack, Instant::now());
        }
        assert!(Instant::now() < deadline, "no ACK for revision {revision}");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

fn ms(d: Duration) -> u128 {
    d.as_millis()
}

/// The contract's main case: removing A's edge fences A's open RPC stream at once, refuses
/// A's new calls, old bearer and unspent ticket, and leaves B's stream running. The target
/// acknowledges the revision with its measured fence and close times.
#[tokio::test(flavor = "current_thread")]
async fn revoking_one_edge_mid_stream_fences_only_that_caller() {
    let lab = Lab::start().await;
    let token_a = lab.fake.issue(NODE_A);
    let token_b = lab.fake.issue(NODE_B);
    let mut a = subscribed(lab.v4, &token_a).await;
    let mut b = subscribed(lab.v6, &token_b).await;
    let unspent = mint_ticket(lab.v4, &token_a, "rpc").await;

    let notice = lab.fake.remove_edge(EDGE_A);
    let committed = Instant::now();
    lab.deliver(&notice);
    let a_closed = tokio::time::timeout(Duration::from_secs(2), closed_at(&mut a))
        .await
        .expect("A's stream was not fenced");
    assert!(ping(&mut b).await, "B's stream must survive");

    // New calls, the old bearer, the unspent ticket and the HTTP snapshot are refused.
    assert_eq!(connect(lab.v4, "", Some(&token_a)).await.err(), Some(401));
    assert_eq!(
        connect(lab.v4, &format!("&wsTicket={unspent}"), None)
            .await
            .err(),
        Some(401)
    );
    assert_eq!(
        http(
            lab.v4,
            "GET",
            "/api/orchestration/shell",
            Some(&token_a),
            ""
        )
        .await,
        401
    );
    // B's own bearer presented from A's address is refused: the peer is not B.
    assert_eq!(connect(lab.v4, "", Some(&token_b)).await.err(), Some(401));
    assert_eq!(
        http(
            lab.v6,
            "GET",
            "/api/orchestration/shell",
            Some(&token_b),
            ""
        )
        .await,
        200
    );

    let (ack, acked) = until_ack(&lab, notice.revision).await;
    assert_eq!(ack["kind"], "observed");
    assert!(
        ack["fenced_at"].is_string() && ack["handlers_closed_at"].is_string(),
        "{ack}"
    );
    assert!(ack["notice_received_at"].is_string());
    assert!(ack["recovered_at"].is_null());
    eprintln!(
        "LAB revoke mid-stream: commit→client sees close {} ms; commit→ACK {} ms",
        ms(a_closed - committed),
        ms(acked - committed)
    );
    assert!(a_closed - committed < Duration::from_millis(500));
}

/// A notice that never arrives: the next probe (every second) still fences the edge.
#[tokio::test(flavor = "current_thread")]
async fn a_dropped_notice_still_fences_through_the_next_probe() {
    let lab = Lab::start().await;
    let token_a = lab.fake.issue(NODE_A);
    let token_b = lab.fake.issue(NODE_B);
    let mut a = subscribed(lab.v4, &token_a).await;
    let mut b = subscribed(lab.v6, &token_b).await;
    let notice = lab.fake.remove_edge(EDGE_A);
    let committed = Instant::now();
    let a_closed = tokio::time::timeout(Duration::from_secs(3), closed_at(&mut a))
        .await
        .expect("the probe never fenced A");
    assert!(ping(&mut b).await);
    let (ack, _) = until_ack(&lab, notice.revision).await;
    assert!(
        ack["notice_received_at"].is_null(),
        "no notice arrived: {ack}"
    );
    eprintln!(
        "LAB dropped notice: commit→client sees close {} ms (probe every 1000 ms)",
        ms(a_closed - committed)
    );
    assert!(a_closed - committed <= Duration::from_millis(1_500));
}

/// A silent partition between target and Gateway: all managed access fails closed when the
/// lease ends, 3 s after the last applied probe's send time, with no grace. On rejoin B
/// recovers, A's edge (removed during the outage) stays refused, and the engine's state is
/// still there.
#[tokio::test(flavor = "current_thread")]
async fn a_silent_partition_fails_closed_at_the_lease_and_recovers_only_unrelated_edges() {
    let lab = Lab::start().await;
    let token_a = lab.fake.issue(NODE_A);
    let token_b = lab.fake.issue(NODE_B);
    let mut a = subscribed(lab.v4, &token_a).await;
    let mut b = subscribed(lab.v6, &token_b).await;
    lab.fake.mode.store(SILENT, Ordering::SeqCst);
    let cut = Instant::now();
    let last_probe = *lab
        .fake
        .state
        .lock()
        .unwrap()
        .answered_probes
        .last()
        .unwrap();
    let (a_closed, b_closed) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(5), closed_at(&mut a)),
        tokio::time::timeout(Duration::from_secs(5), closed_at(&mut b)),
    );
    let (a_closed, b_closed) = (
        a_closed.expect("A stayed open"),
        b_closed.expect("B stayed open"),
    );
    let detection = a_closed.max(b_closed) - last_probe;
    eprintln!(
        "LAB silent partition: fault→fence {} ms; last confirmed probe→fence {} ms (lease 3000 ms)",
        ms(a_closed.max(b_closed) - cut),
        ms(detection)
    );
    assert!(detection <= Duration::from_millis(3_200), "{detection:?}");
    assert!(
        detection >= Duration::from_millis(2_000),
        "fenced before the lease ended"
    );
    assert_eq!(connect(lab.v6, "", Some(&token_b)).await.err(), Some(503));

    // A's edge goes while the target cannot hear; then the network heals.
    let removal = lab.fake.remove_edge(EDGE_A);
    lab.fake.mode.store(UP, Ordering::SeqCst);
    lab.until_available().await;
    let mut b = connect(lab.v6, "", Some(&token_b))
        .await
        .expect("B recovers");
    assert!(ping(&mut b).await);
    assert_eq!(connect(lab.v4, "", Some(&token_a)).await.err(), Some(401));
    // The same process fenced it (at the snapshot that no longer listed it): observed.
    let (ack, _) = until_ack(&lab, removal.revision).await;
    assert_eq!(ack["kind"], "observed", "{ack}");
}

/// An explicit failure (the Gateway refuses the connection) fails closed on detection, at
/// the next probe, without waiting for the lease.
#[tokio::test(flavor = "current_thread")]
async fn an_explicit_authority_failure_fails_closed_at_detection() {
    let lab = Lab::start().await;
    let token_b = lab.fake.issue(NODE_B);
    let mut b = subscribed(lab.v6, &token_b).await;
    lab.fake.mode.store(CLOSED, Ordering::SeqCst);
    let cut = Instant::now();
    let closed = tokio::time::timeout(Duration::from_secs(3), closed_at(&mut b))
        .await
        .expect("still open");
    eprintln!("LAB explicit close: fault→fence {} ms", ms(closed - cut));
    assert!(closed - cut <= Duration::from_millis(1_200));
}

/// The managed ingress refuses native credentials, routes outside the reader profile, and
/// methods outside its allowlist. A managed token never works on the native ingress.
#[tokio::test(flavor = "current_thread")]
async fn the_managed_ingress_admits_only_managed_readers() {
    let lab = Lab::start().await;
    let auth = &lab.app.auth;
    let code = auth
        .issue_pairing_code(None, crate::auth::PAIRING_CODE_TTL_MS)
        .unwrap()
        .code;
    let native = auth
        .exchange(&code, None, crate::auth::ClientInfo::default())
        .unwrap();
    assert_eq!(
        connect(lab.v4, "", Some(&native.token)).await.err(),
        Some(401)
    );
    let (native_ticket, _) = lab
        .app
        .auth
        .issue_ticket(&native.token, Some("rpc"))
        .unwrap();
    assert_eq!(
        connect(lab.v4, &format!("&wsTicket={native_ticket}"), None)
            .await
            .err(),
        Some(401)
    );
    let token_b = lab.fake.issue(NODE_B);
    for (method, path) in [
        ("POST", "/api/auth/pairing-token"),
        ("POST", "/oauth/token"),
        ("POST", "/mcp"),
        ("GET", "/api/auth/clients"),
        ("POST", "/api/projects/mutate"),
        ("GET", "/api/assets/x"),
    ] {
        assert_eq!(
            http(lab.v6, method, path, Some(&token_b), "{}").await,
            403,
            "{path}"
        );
    }
    // A managed token on the native ingress is just an unknown bearer.
    assert_eq!(
        http(
            lab.native,
            "GET",
            "/api/orchestration/shell",
            Some(&token_b),
            ""
        )
        .await,
        401
    );
    // A write is not in the reader profile: the method is not served here.
    let mut b = connect(lab.v6, "", Some(&token_b)).await.unwrap();
    send(
        &mut b,
        json!({"_tag": "Request", "id": "9", "tag": "orchestration.dispatchCommand",
               "payload": {"type": "thread.stop", "commandId": "c", "threadId": "t"}, "headers": []}),
    )
    .await;
    let exit = next(&mut b).await.unwrap();
    assert_eq!(exit["_tag"], "Exit");
    assert!(
        exit.to_string().contains("ConnServerNotSupported"),
        "{exit}"
    );
    // A token with other scopes is no reader.
    let wide = lab.fake.issue_with(
        NODE_B,
        vec!["orchestration:read".into(), "orchestration:operate".into()],
        serde_json::Map::new(),
    );
    assert_eq!(connect(lab.v6, "", Some(&wide)).await.err(), Some(403));
}

/// A lost ACK request leaves the revision owed; the target sends it again while `owed`
/// lists it, and stops once the Gateway settled it.
#[tokio::test(flavor = "current_thread")]
async fn a_lost_ack_is_sent_again_and_settles_once() {
    let lab = Lab::start().await;
    lab.fake.state.lock().unwrap().lose_ack_requests = 1;
    let notice = lab.fake.remove_edge(EDGE_A);
    lab.deliver(&notice);
    let (ack, _) = until_ack(&lab, notice.revision).await;
    assert_eq!(ack["kind"], "observed");
    tokio::time::sleep(Duration::from_millis(1_200)).await;
    assert_eq!(
        lab.fake.state.lock().unwrap().ack_calls,
        2,
        "sent again after the loss, then quiet once settled"
    );
}

/// A refusal of the target itself during an introspection (here a generation mismatch)
/// fails closed for every managed caller at once, not just the one being admitted.
#[tokio::test(flavor = "current_thread")]
async fn a_target_refusal_during_introspection_fails_everything_closed() {
    let lab = Lab::start().await;
    let token_a = lab.fake.issue(NODE_A);
    let token_b = lab.fake.issue(NODE_B);
    let mut b = subscribed(lab.v6, &token_b).await;
    lab.fake.state.lock().unwrap().introspect_refusal =
        Some((409, "conn.managed_generation_mismatch".into()));
    let cut = Instant::now();
    assert_eq!(connect(lab.v4, "", Some(&token_a)).await.err(), Some(503));
    let closed = tokio::time::timeout(Duration::from_secs(1), closed_at(&mut b))
        .await
        .expect("B stayed open");
    eprintln!(
        "LAB target refusal on introspection: fault→fence {} ms",
        ms(closed - cut)
    );
    if let Some((low, high)) = lab.shared.read(|a| a.offset_bounds()) {
        eprintln!("LAB clock offset bounds (Gateway − target): [{low}, {high}] ms");
    }
}

/// A caller that stops reading cannot hold a revoked edge open: its socket is cut at the
/// fence, its handler ends, and the ACK goes out.
#[tokio::test(flavor = "current_thread")]
async fn a_stalled_reader_is_cut_at_the_fence_and_acknowledged() {
    let lab = Lab::start().await;
    let token_a = lab.fake.issue(NODE_A);
    let _a = subscribed(lab.v4, &token_a).await;
    // A stops reading; its stream keeps producing.
    let notice = lab.fake.remove_edge(EDGE_A);
    let committed = Instant::now();
    lab.deliver(&notice);
    let (ack, acked) = until_ack(&lab, notice.revision).await;
    assert_eq!(ack["kind"], "observed");
    assert_eq!(lab.shared.read(|a| a.open_handlers()), 0);
    eprintln!(
        "LAB stalled reader: commit→ACK {} ms",
        ms(acked - committed)
    );
}

/// The ACK bodies meet the merged Gateway's `/ack` rules (Orbit `d023758a54f9`,
/// `ConnManagedTargetRequest`): an integer revision of at least 1; `notice_received_at`
/// present; `observed` with fence and close times and no `recovered_at`, close not before
/// fence; `recovered` with only `recovered_at`; every time RFC 3339 with an offset.
#[test]
fn ack_bodies_meet_the_gateway_rules() {
    use super::authority::{Ack, AckKind};
    let rfc3339 = |v: &Value| {
        v.as_str()
            .and_then(conn_support::time::millis_from_iso)
            .is_some()
    };
    let observed = super::ack_body(&Ack {
        revision: 3,
        kind: AckKind::Observed,
        notice_received_ms: None,
        fenced_ms: Some(1_800_000_000_100),
        handlers_closed_ms: Some(1_800_000_000_100),
        recovered_ms: None,
    });
    assert!(observed["revision"].is_u64() && observed["revision"].as_u64() >= Some(1));
    assert_eq!(observed["kind"], "observed");
    assert!(
        observed
            .as_object()
            .unwrap()
            .contains_key("notice_received_at")
    );
    assert!(observed["notice_received_at"].is_null());
    assert!(rfc3339(&observed["fenced_at"]) && rfc3339(&observed["handlers_closed_at"]));
    assert!(observed["handlers_closed_at"].as_str() >= observed["fenced_at"].as_str());
    assert!(observed["recovered_at"].is_null());
    let recovered = super::ack_body(&Ack {
        revision: 4,
        kind: AckKind::Recovered,
        notice_received_ms: None,
        fenced_ms: None,
        handlers_closed_ms: None,
        recovered_ms: Some(1_800_000_000_200),
    });
    assert_eq!(recovered["kind"], "recovered");
    assert!(rfc3339(&recovered["recovered_at"]));
    for key in ["notice_received_at", "fenced_at", "handlers_closed_at"] {
        assert!(recovered.as_object().unwrap().contains_key(key) && recovered[key].is_null());
    }
}
