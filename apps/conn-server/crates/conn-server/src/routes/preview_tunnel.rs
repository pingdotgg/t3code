//! `/api/preview/tunnel` (`PreviewTunnel.ts`): a remote desktop's browser reaches this
//! machine's loopback ports through it, one TCP connection per WebSocket. Raw bytes, so pages
//! keep their own origin, HMR sockets and TLS. A media ticket with `terminal:operate` opens
//! it, and the tunnel closes with its session like the RPC socket.

use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Mutex,
    time::Duration,
};

use axum::{
    Router,
    body::Bytes,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::AppState;

/// Marks a refusal about the port itself, so a client can tell "nothing listens there" from a
/// proxy in front of the environment answering 502 because the environment is down.
const PORT_REFUSED_HEADER: &str = "x-t3-tunnel-port-refused";
const SCOPE: &str = "terminal:operate";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// One read from the loopback port; also the most a client message may carry.
const CHUNK_BYTES: usize = 64 * 1024;
/// What may wait in the WebSocket's send buffer before a send waits for the client.
const SEND_HIGH_WATER_BYTES: usize = 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The ports this process serves HTTP on. Tunnelling to one would hand the page an
/// unauthenticated loopback client of this server.
static SERVED_PORTS: Mutex<Vec<u16>> = Mutex::new(Vec::new());

/// Records a port this process listens on, so the tunnel refuses it.
pub(crate) fn serving_on(port: u16) {
    let mut ports = SERVED_PORTS.lock().unwrap_or_else(|e| e.into_inner());
    if !ports.contains(&port) {
        ports.push(port);
    }
}

fn is_served(port: u16) -> bool {
    SERVED_PORTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&port)
}

pub(super) fn router() -> Router<AppState> {
    // A literal path, so tools/bump-report.mjs sees the route.
    Router::new().route("/api/preview/tunnel", get(tunnel))
}

fn refused(status: StatusCode, message: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::HeaderName::from_static(PORT_REFUSED_HEADER), "1"),
        ],
        message,
    )
        .into_response()
}

async fn dial(port: u16) -> Option<TcpStream> {
    for ip in [Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()] {
        let addr = SocketAddr::new(ip, port);
        if let Ok(Ok(stream)) =
            tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await
        {
            return Some(stream);
        }
    }
    None
}

async fn tunnel(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let port = query
        .get("port")
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p >= 1);
    let (Ok(upgrade), Some(port)) = (upgrade, port) else {
        return (StatusCode::BAD_REQUEST, "Bad Request").into_response();
    };
    let Some(principal) = crate::http::authenticate_upgrade(&state, &query, &headers, "media")
    else {
        let reason =
            if query.contains_key("wsTicket") || headers.contains_key(header::AUTHORIZATION) {
                "invalid_credential"
            } else {
                "missing_credential"
            };
        return crate::http::auth_invalid(reason);
    };
    if !principal.has_scope(SCOPE) {
        return crate::http::scope_required(SCOPE);
    }
    if is_served(port) {
        return refused(
            StatusCode::FORBIDDEN,
            format!("Port {port} is this Conn Server's own port."),
        );
    }
    // Dialled before the upgrade so a dead port fails the handshake instead of an open socket.
    let Some(upstream) = dial(port).await else {
        return refused(
            StatusCode::BAD_GATEWAY,
            format!("Nothing accepted a connection on loopback port {port}."),
        );
    };
    let auth = state.auth.clone();
    let session_id = principal.session_id;
    upgrade
        .max_message_size(MAX_CLIENT_MESSAGE_BYTES)
        .max_write_buffer_size(SEND_HIGH_WATER_BYTES + CHUNK_BYTES)
        .write_buffer_size(0)
        .on_upgrade(move |socket| async move {
            let _connected = auth.connect(&session_id);
            tokio::select! {
                () = pump(socket, upstream) => {}
                () = crate::http::revoked(&auth, &session_id) => {}
            }
        })
}

/// Copies bytes both ways until either side ends. Each direction waits for its writer, so a
/// slow reader slows the other end down instead of filling memory.
async fn pump(socket: WebSocket, upstream: TcpStream) {
    let (mut client_tx, mut client_rx) = socket.split();
    let (mut upstream_rx, mut upstream_tx) = upstream.into_split();
    let down = async {
        let mut buffer = vec![0u8; CHUNK_BYTES];
        loop {
            let read = match upstream_rx.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = Bytes::copy_from_slice(buffer.get(..read).unwrap_or_default());
            if client_tx.send(Message::Binary(chunk)).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    let up = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let bytes = match message {
                Message::Binary(bytes) => bytes,
                Message::Text(text) => Bytes::from(text),
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => continue,
            };
            if upstream_tx.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.shutdown().await;
    };
    // Either side ending ends the tunnel, as `raceFirst` does in the T3 server.
    tokio::select! {
        () = down => {}
        () = up => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth, auth::AuthStore, http::router, table::MethodTable};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

    async fn serve() -> (SocketAddr, Arc<AuthStore>) {
        let auth = AuthStore::in_memory();
        let state = AppState {
            table: Arc::new(MethodTable::new()),
            auth: auth.clone(),
            descriptor: crate::environment::fixed_descriptor(crate::environment::descriptor(
                "env-test", "Test", false, None,
            )),
            engine: None,
            deps: Default::default(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        serving_on(addr.port());
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        (addr, auth)
    }

    fn session(auth: &AuthStore, scopes: &[&str]) -> String {
        auth.issue_session(auth::SessionRequest {
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            label: None,
            subject: None,
            ttl_ms: auth::SESSION_TTL_MS,
        })
        .unwrap()
        .token
    }

    async fn open(
        addr: SocketAddr,
        query: &str,
        token: Option<&str>,
    ) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>, tungstenite::Error> {
        let mut request = format!("ws://{addr}/api/preview/tunnel?{query}")
            .into_client_request()
            .unwrap();
        if let Some(token) = token {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
        }
        let stream = TcpStream::connect(addr).await.unwrap();
        tokio_tungstenite::client_async(request, stream)
            .await
            .map(|(socket, _)| socket)
    }

    fn status(result: Result<impl Sized, tungstenite::Error>) -> (u16, bool) {
        match result {
            Err(tungstenite::Error::Http(response)) => (
                response.status().as_u16(),
                response.headers().contains_key(PORT_REFUSED_HEADER),
            ),
            Err(error) => panic!("unexpected error: {error}"),
            Ok(_) => (101, false),
        }
    }

    /// An echo server on loopback; it answers each read with `echo:` and the bytes.
    async fn echo() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let mut reply = b"echo:".to_vec();
                reply.extend_from_slice(&buffer[..read]);
                stream.write_all(&reply).await.unwrap();
            }
        });
        port
    }

    #[tokio::test(flavor = "current_thread")]
    async fn carries_raw_bytes_both_ways() {
        let (addr, auth) = serve().await;
        let token = session(&auth, &["terminal:operate"]);
        let port = echo().await;
        let mut socket = open(addr, &format!("port={port}"), Some(&token))
            .await
            .unwrap();
        socket
            .send(tungstenite::Message::Binary(
                b"GET / HTTP/1.1\r\n".to_vec().into(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        assert_eq!(reply.into_data().as_ref(), b"echo:GET / HTTP/1.1\r\n");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refuses_bad_requests_credentials_scopes_and_ports() {
        let (addr, auth) = serve().await;
        let operate = session(&auth, &["terminal:operate"]);
        let read_only = session(&auth, &["orchestration:read"]);
        // A closed port: bind one, note it, drop the listener.
        let closed = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(status(open(addr, "port=0", Some(&operate)).await).0, 400);
        assert_eq!(
            status(open(addr, "port=70000", Some(&operate)).await).0,
            400
        );
        assert_eq!(status(open(addr, "port=80", None).await).0, 401);
        assert_eq!(status(open(addr, "port=80", Some(&read_only)).await).0, 403);
        assert_eq!(
            status(open(addr, &format!("port={}", addr.port()), Some(&operate)).await),
            (403, true)
        );
        assert_eq!(
            status(open(addr, &format!("port={closed}"), Some(&operate)).await),
            (502, true)
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_revoked_session_closes_its_tunnel() {
        let (addr, auth) = serve().await;
        let token = session(&auth, &["terminal:operate"]);
        let session_id = auth.authenticate_bearer(&token).unwrap().session_id;
        let port = echo().await;
        let mut socket = open(addr, &format!("port={port}"), Some(&token))
            .await
            .unwrap();
        auth.revoke_session(None, &session_id).unwrap().unwrap();
        // The server drops the socket: the stream ends or errors, never yields data.
        assert!(!matches!(
            socket.next().await,
            Some(Ok(tungstenite::Message::Binary(_)))
        ));
    }
}
