//! `send` against a local HTTP/1.1 server.

use std::net::SocketAddr;
use std::time::Duration;

use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;

/// What the test server received.
#[derive(Debug, Default)]
struct Received {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Option<Received> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let mut received = Received {
        method: start.next()?.to_owned(),
        path: start.next()?.to_owned(),
        ..Received::default()
    };
    for line in lines {
        let (name, value) = line.split_once(':')?;
        received
            .headers
            .push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
    }
    let length: usize = received
        .headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    received.body = body;
    Some(received)
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn handle(mut stream: TcpStream) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    match request.path.as_str() {
        "/echo" | "/echo?x=1" => {
            let headers: serde_json::Map<String, serde_json::Value> = request
                .headers
                .iter()
                .map(|(name, value)| (name.clone(), value.clone().into()))
                .collect();
            let body = serde_json::json!({
                "method": request.method,
                "path": request.path,
                "headers": headers,
                "body": String::from_utf8_lossy(&request.body),
            })
            .to_string();
            respond(
                &mut stream,
                "201 Created",
                &[
                    ("content-type", "application/json"),
                    ("x-multi", "a"),
                    ("x-multi", "b"),
                ],
                body.as_bytes(),
            )
            .await;
        }
        "/binary" => {
            respond(
                &mut stream,
                "200 OK",
                &[("content-type", "image/png")],
                &[0, 1, 2, 255],
            )
            .await;
        }
        "/untyped" => respond(&mut stream, "200 OK", &[], b"plain").await,
        "/large" => {
            let body = vec![b'a'; MAX_BODY_BYTES + 5];
            respond(
                &mut stream,
                "200 OK",
                &[("content-type", "text/plain")],
                &body,
            )
            .await;
        }
        "/slow" => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            respond(&mut stream, "200 OK", &[], b"late").await;
        }
        "/redirect" => {
            respond(&mut stream, "302 Found", &[("location", "/echo")], b"").await;
        }
        _ => {
            respond(
                &mut stream,
                "404 Not Found",
                &[("content-type", "text/plain")],
                b"nope",
            )
            .await
        }
    }
}

async fn server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("binds a local port");
    let address = listener.local_addr().expect("has an address");
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(handle(stream));
        }
    });
    address
}

fn request(method: &str, url: String) -> ApiRequest {
    ApiRequest {
        method: method.to_owned(),
        url,
        headers: Vec::new(),
        body: None,
        timeout_ms: None,
    }
}

fn echoed(response: &ApiResponse) -> serde_json::Value {
    serde_json::from_str(&response.body).expect("echo body is JSON")
}

#[tokio::test]
async fn sends_get_with_headers_and_no_body() {
    let address = server().await;
    let mut get = request("get", format!("http://{address}/echo?x=1"));
    get.headers = vec![
        ApiHeader::new(" Accept ", "application/json"),
        ApiHeader::new("X-Toolbar", " 1 "),
        ApiHeader::new("  ", "skipped"),
    ];
    get.body = Some("ignored for GET".to_owned());
    let response = send(&get).await;
    assert_eq!(response.error, None, "no error");
    assert_eq!(
        (response.status, response.status_text.as_str()),
        (201, "Created"),
        "status"
    );
    assert_eq!(response.body_encoding, BodyEncoding::Text, "JSON is text");
    let echo = echoed(&response);
    assert_eq!(echo["method"], "GET", "upper-cased method");
    assert_eq!(echo["path"], "/echo?x=1", "path and query");
    assert_eq!(
        echo["headers"]["accept"], "application/json",
        "trimmed name"
    );
    assert_eq!(echo["headers"]["x-toolbar"], "1", "trimmed value");
    assert_eq!(echo["body"], "", "GET sends no body");
    assert_eq!(
        response.header("X-Multi"),
        Some("a, b"),
        "repeated headers joined"
    );
    let names: Vec<&str> = response.headers.iter().map(|h| h.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "headers sorted by name");
    assert_eq!(response.size, response.body.len() as u64, "size");
    assert!(!response.truncated, "whole body");
    assert!(response.duration_ms >= 0.0, "duration");
    assert_eq!(
        response.url,
        format!("http://{address}/echo?x=1"),
        "final URL"
    );
}

#[tokio::test]
async fn sends_post_with_a_body() {
    let address = server().await;
    let mut post = request("POST", format!("http://{address}/echo"));
    post.headers = vec![ApiHeader::new("Content-Type", "application/json")];
    post.body = Some(r#"{"name":"é"}"#.to_owned());
    let response = send(&post).await;
    let echo = echoed(&response);
    assert_eq!(echo["method"], "POST", "method");
    assert_eq!(echo["body"], r#"{"name":"é"}"#, "body sent");
    assert_eq!(
        echo["headers"]["content-type"], "application/json",
        "content type"
    );
}

#[tokio::test]
async fn follows_redirects_and_reports_the_final_url() {
    let address = server().await;
    let response = send(&request("GET", format!("http://{address}/redirect"))).await;
    assert_eq!(response.status, 201, "followed");
    assert_eq!(response.url, format!("http://{address}/echo"), "final URL");
}

#[tokio::test]
async fn encodes_binary_bodies_as_base64_and_untyped_as_text() {
    let address = server().await;
    let response = send(&request("GET", format!("http://{address}/binary"))).await;
    assert_eq!(response.body_encoding, BodyEncoding::Base64, "binary");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&response.body)
            .expect("valid base64"),
        [0, 1, 2, 255],
        "bytes kept"
    );
    assert_eq!(response.size, 4, "size");
    let response = send(&request("GET", format!("http://{address}/untyped"))).await;
    assert_eq!(
        (response.body_encoding, response.body.as_str()),
        (BodyEncoding::Text, "plain"),
        "no content type is text"
    );
    let response = send(&request("GET", format!("http://{address}/missing"))).await;
    assert_eq!(
        (response.error, response.status),
        (None, 404),
        "error statuses are responses"
    );
}

#[tokio::test]
async fn truncates_at_20_mb_and_reports_the_full_size() {
    let address = server().await;
    let response = send(&request("GET", format!("http://{address}/large"))).await;
    assert_eq!(response.error, None, "no error");
    assert!(response.truncated, "truncated");
    assert_eq!(response.size, (MAX_BODY_BYTES + 5) as u64, "full size");
    assert_eq!(response.body.len(), MAX_BODY_BYTES, "kept 20 MB");
}

#[tokio::test]
async fn truncation_respects_a_smaller_cap() {
    let address = server().await;
    let client = ApiClient::new().expect("client").with_max_body_bytes(3);
    let response = client
        .send(&request("GET", format!("http://{address}/untyped")))
        .await;
    assert_eq!(
        (response.body.as_str(), response.size, response.truncated),
        ("pla", 5, true),
        "cap"
    );
}

#[tokio::test]
async fn times_out() {
    let address = server().await;
    let mut slow = request("GET", format!("http://{address}/slow"));
    slow.timeout_ms = Some(200);
    let response = send(&slow).await;
    assert_eq!(
        response.error.as_deref(),
        Some(TIMEOUT_ERROR),
        "timeout message"
    );
    assert_eq!(response.status, 0, "no status");
    assert_eq!(
        response.url,
        format!("http://{address}/slow"),
        "normalized URL"
    );
    assert!(response.duration_ms >= 200.0, "elapsed time reported");
}

#[tokio::test]
async fn rejects_bad_and_non_http_urls() {
    let response = send(&request("GET", "app.test/api".to_owned())).await;
    assert_eq!(response.error.as_deref(), Some(BAD_URL_ERROR), "bad URL");
    assert_eq!(
        (response.url.as_str(), response.duration_ms),
        ("app.test/api", 0.0),
        "as typed"
    );
    let response = send(&request("GET", "ftp://app.test/file".to_owned())).await;
    assert_eq!(response.error.as_deref(), Some(BAD_SCHEME_ERROR), "ftp");
    let response = send(&request("GET", "file:///etc/hosts".to_owned())).await;
    assert_eq!(response.error.as_deref(), Some(BAD_SCHEME_ERROR), "file");
    let response = send(&request("G T", "https://app.test/".to_owned())).await;
    assert!(response.error.is_some(), "bad method rejected");
}

#[tokio::test]
async fn reports_connection_failures() {
    // Bind and drop a listener so the port is closed.
    let address = {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        listener.local_addr().expect("address")
    };
    let response = send(&request("GET", format!("http://{address}/"))).await;
    let error = response.error.expect("connection refused");
    assert!(
        !error.is_empty() && error != TIMEOUT_ERROR,
        "a connection error: {error}"
    );
    assert_eq!(response.url, format!("http://{address}/"), "URL");
}
