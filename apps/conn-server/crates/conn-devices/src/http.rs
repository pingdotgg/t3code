//! HTTP/1 to the device hub and the agent-device daemon. Both listen on loopback (an SSH
//! forward for a remote host), so this client speaks plain HTTP to `127.0.0.1` only.

use std::time::Duration;

use http_body_util::{BodyExt as _, Full, Limited};
use hyper::{
    Request, Response,
    body::{Bytes, Incoming},
};
use hyper_util::rt::TokioIo;

/// A JSON answer from the hub or the daemon is small; more is unknown framing.
pub const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
/// A screenshot PNG.
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// `host:port` of an `http://127.0.0.1:<port>` origin.
fn authority(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("not an http URL: {url}"))?;
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return Err(format!("no host in {url}"));
    }
    Ok(authority.to_owned())
}

/// Sends one request on a new connection. The connection runs in its own task until the
/// response body is read or dropped, so a caller can stream the body.
pub async fn send<B>(request: Request<B>) -> Result<Response<Incoming>, String>
where
    B: hyper::body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let address = authority(&request.uri().to_string())?;
    let stream = tokio::net::TcpStream::connect(&address)
        .await
        .map_err(|e| format!("connect {address}: {e}"))?;
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    sender
        .send_request(request)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One request with an optional JSON body, read whole up to `max_bytes`, within `timeout`.
pub async fn fetch(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&serde_json::Value>,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Answer, String> {
    let work = async {
        let mut builder = Request::builder()
            .method(method)
            .uri(url)
            .header("host", authority(url)?);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let payload = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Bytes::from(value.to_string())
            }
            None => Bytes::new(),
        };
        let request = builder
            .body(Full::new(payload))
            .map_err(|e| e.to_string())?;
        let response = send(request).await?;
        let status = response.status().as_u16();
        let body = Limited::new(response.into_body(), max_bytes)
            .collect()
            .await
            .map_err(|e| e.to_string())?
            .to_bytes()
            .to_vec();
        Ok(Answer { status, body })
    };
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or_else(|_| Err(format!("{method} {url} timed out")))
}

/// `GET` that counts only a 2xx answer, within one second, as `waitForHttpReady` probes.
pub async fn ok(url: &str, timeout: Duration) -> bool {
    fetch("GET", url, &[], None, timeout, MAX_JSON_BYTES)
        .await
        .is_ok_and(|a| (200..300).contains(&a.status))
}

/// Polls `url` every 100 ms until it answers 2xx or `timeout` passes.
pub async fn wait_ready(url: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if ok(url, Duration::from_secs(1)).await {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_authority() {
        assert_eq!(
            authority("http://127.0.0.1:9/a/b").unwrap_or_default(),
            "127.0.0.1:9",
            "authority"
        );
        assert!(authority("https://x").is_err(), "https refused");
    }
}
