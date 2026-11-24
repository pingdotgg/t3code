//! A server that refuses the WebSocket handshake with 401: the default keeps retrying, and
//! `stop_on_auth_rejection` ends the connection with `Failed`. With `expected_environment`, the
//! bearer goes only to a server whose descriptor names that environment.
#![expect(
    clippy::expect_used,
    reason = "test setup panics when the local socket can't be set up"
)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use conn_client::{
    ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig, StartOptions,
};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

async fn refusing_server() -> url::Url {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = tcp.read(&mut buf).await;
            let _ = tcp
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
        }
    });
    url::Url::parse(&format!("http://{addr}")).expect("url")
}

async fn next_status(events: &mut mpsc::Receiver<ClientEvent>) -> ConnectionStatus {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("a status arrives")
            .expect("events stay open");
        if let ClientEvent::Status(status) = event
            && status != ConnectionStatus::Connecting
        {
            return status;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_401_stops_only_when_asked() {
    let rt = tokio::runtime::Handle::current();
    let config = |url: url::Url| ServerConfig {
        http_base_url: url,
        credential: Credential::Bearer("revoked".to_owned()),
    };

    let (default, mut events) = Connection::start(config(refusing_server().await), &rt);
    assert!(
        matches!(
            next_status(&mut events).await,
            ConnectionStatus::Reconnecting { .. }
        ),
        "by default a 401 is retried"
    );
    assert!(default.auth_rejected(), "the rejection is still recorded");
    default.close();

    let (stopping, mut events) = Connection::start_with_options(
        config(refusing_server().await),
        &rt,
        StartOptions {
            stop_on_auth_rejection: true,
            ..StartOptions::default()
        },
    );
    assert!(
        matches!(next_status(&mut events).await, ConnectionStatus::Failed(_)),
        "with the option a 401 ends the connection"
    );
    assert!(stopping.auth_rejected(), "the rejection is recorded");
}

/// Answers the environment descriptor with `env`, and anything else with 401. Records whether
/// any request carried an `Authorization` header.
async fn server_named(env: &'static str) -> (url::Url, std::sync::Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let saw_bearer = std::sync::Arc::new(AtomicBool::new(false));
    let seen = std::sync::Arc::clone(&saw_bearer);
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let n = tcp.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
            if head.contains("\r\nauthorization:") {
                seen.store(true, Ordering::SeqCst);
            }
            let reply = if head.starts_with("get /.well-known/t3/environment") {
                let body = format!(r#"{{"environmentId":"{env}"}}"#);
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_owned()
            };
            let _ = tcp.write_all(reply.as_bytes()).await;
        }
    });
    (
        url::Url::parse(&format!("http://{addr}")).expect("url"),
        saw_bearer,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_bearer_goes_only_to_the_expected_environment() {
    let rt = tokio::runtime::Handle::current();
    let start = |url: url::Url| {
        Connection::start_with_options(
            ServerConfig {
                http_base_url: url,
                credential: Credential::Bearer("saved-bearer".to_owned()),
            },
            &rt,
            StartOptions {
                stop_on_auth_rejection: true,
                expected_environment: Some("env-a".to_owned()),
            },
        )
    };

    // B answers at A's address: the connection stops and B never sees the bearer.
    let (url, saw_bearer) = server_named("env-b").await;
    let (conn, mut events) = start(url);
    assert!(
        matches!(next_status(&mut events).await, ConnectionStatus::Failed(_)),
        "another environment stops the connection"
    );
    assert_eq!(
        conn.identity_mismatch().as_deref(),
        Some("env-b"),
        "it says who answered"
    );
    assert!(
        !saw_bearer.load(Ordering::SeqCst),
        "no request to B carried an Authorization header"
    );

    // A answers: only then does the handshake carry the bearer.
    let (url, saw_bearer) = server_named("env-a").await;
    let (conn, mut events) = start(url);
    let _ = next_status(&mut events).await;
    assert!(
        saw_bearer.load(Ordering::SeqCst),
        "the matching environment gets the handshake with the bearer"
    );
    assert_eq!(conn.identity_mismatch(), None, "no mismatch");
    conn.close();
}
