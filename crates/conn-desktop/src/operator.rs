//! Local Operator dictation session client (`/dictate/{start,stop,wait,cancel}`).
//!
//! Port of Conn's `apps/desktop/src/preview/AnnotatorDictation.ts` protocol for macOS local
//! Operator dictation — shared by both the chat composer (`conn-app`) and browser/device
//! annotations (Slice 3).
//!
//! Protocol summary (see `../conn/FORK.md`):
//! - `POST <origin>/dictate/start`  with `{"session":"<id>"}` -> 2xx started, 400/404 unsupported.
//! - `POST <origin>/dictate/wait`   with `{"session":"<id>"}` -> 2xx `{"text":"..."}`, 504 still
//!   waiting (caller retries while active), 400/404 unsupported (older Operator without wait).
//! - `POST <origin>/dictate/stop`   with `{"session":"<id>"}` -> 2xx `{"text":"..."}`.
//! - `POST <origin>/dictate/cancel` with `{"session":"<id>"}` -> 2xx cancelled.
//! - Legacy fallback: `POST <origin>/dictate` (empty body) for Operator builds before sessions.

use std::time::Duration;

use serde_json::{Value, json};
use url::Url;

/// Default local Operator HTTP endpoint on macOS.
pub const DEFAULT_OPERATOR_URL: &str = "http://127.0.0.1:12321";

/// Request timeout for fast control calls (`start`, `cancel`, legacy `start`).
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
/// Request timeout for calls that wait on audio transcription (`stop`, `wait`).
/// Operator gives up around 120s (504), so we allow 130s.
const TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(130);

/// Errors from talking to local Operator.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OperatorError {
    #[error("Invalid Operator base URL: {0}")]
    InvalidBaseUrl(String),
    #[error("Invalid dictation session id: {0}")]
    InvalidSessionId(String),
    #[error("Operator is not reachable at {url}: {message}")]
    Unreachable { url: String, message: String },
    #[error("Operator rejected the request (HTTP {status}).")]
    Rejected { status: u16 },
}

pub type OperatorResult<T> = Result<T, OperatorError>;

/// Outcome of `POST /dictate/start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictationStart {
    /// Session started; caller may begin polling `/dictate/wait` or later call `/dictate/stop`.
    Started,
    /// Operator rejected the session payload/route (400/404) — older build without session API.
    Unsupported,
}

/// Outcome of `POST /dictate/wait`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DictationWait {
    /// Session ended (e.g. via Operator's global shortcut) and returned final transcript text.
    Transcript(String),
    /// Operator returned 504 before recording finished; caller should call `wait` again.
    StillWaiting,
    /// Operator predates `/dictate/wait` (400/404); caller waits for explicit `stop`/`cancel`.
    Unsupported,
}

/// Validates a dictation session id (`^[A-Za-z0-9_-]{1,128}$`).
#[must_use]
pub fn is_valid_session_id(session_id: &str) -> bool {
    (1..=128).contains(&session_id.len())
        && session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Resolves the configured Operator base URL from `CONN_OPERATOR_URL`, falling back to
/// [`DEFAULT_OPERATOR_URL`].
#[must_use]
pub fn configured_operator_url() -> String {
    std::env::var("CONN_OPERATOR_URL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_OPERATOR_URL.to_owned())
}

/// Client for local Operator HTTP dictation sessions.
#[derive(Debug, Clone)]
pub struct OperatorClient {
    base_origin: Url,
    origin_header: Option<String>,
    http: reqwest::Client,
}

impl OperatorClient {
    /// Creates a client targeting `base_url` (HTTP/HTTPS only; redirects disabled).
    pub fn new(base_url: &str) -> OperatorResult<Self> {
        let parsed = Url::parse(base_url.trim())
            .map_err(|err| OperatorError::InvalidBaseUrl(err.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() {
            return Err(OperatorError::InvalidBaseUrl(
                "only http(s) URLs with a host are allowed".to_owned(),
            ));
        }
        // Normalize down to origin (`scheme://host[:port]/`).
        let origin_str = parsed.origin().ascii_serialization();
        let base_origin = Url::parse(&origin_str)
            .map_err(|err| OperatorError::InvalidBaseUrl(err.to_string()))?;

        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|err| OperatorError::Unreachable {
                url: origin_str,
                message: err.to_string(),
            })?;

        Ok(Self {
            base_origin,
            origin_header: None,
            http,
        })
    }

    /// Creates a client for [`configured_operator_url`].
    pub fn from_env() -> OperatorResult<Self> {
        Self::new(&configured_operator_url())
    }

    /// Sets an optional `Origin` header (used by Browser Annotations so Operator enforces its
    /// per-website approval rules).
    #[must_use]
    pub fn with_origin(mut self, origin: impl Into<String>) -> Self {
        let trimmed = origin.into().trim().to_owned();
        self.origin_header = (!trimmed.is_empty()).then_some(trimmed);
        self
    }

    fn endpoint(&self, path: &str) -> OperatorResult<Url> {
        self.base_origin
            .join(path)
            .map_err(|err| OperatorError::InvalidBaseUrl(err.to_string()))
    }

    async fn post_json(
        &self,
        path: &str,
        body: Option<String>,
        timeout: Duration,
    ) -> OperatorResult<(u16, String)> {
        let url = self.endpoint(path)?;
        let mut req = self.http.post(url.clone()).timeout(timeout);
        if let Some(origin) = &self.origin_header {
            req = req.header(reqwest::header::ORIGIN, origin);
        }
        if let Some(payload) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload);
        }
        let resp = req.send().await.map_err(|err| OperatorError::Unreachable {
            url: url.to_string(),
            message: err.to_string(),
        })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }

    /// Starts a named Operator dictation session (`POST /dictate/start`).
    pub async fn start(&self, session_id: &str) -> OperatorResult<DictationStart> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, _) = self
            .post_json("/dictate/start", Some(body), CONTROL_TIMEOUT)
            .await?;
        match status {
            200..=299 => Ok(DictationStart::Started),
            400 | 404 => Ok(DictationStart::Unsupported),
            other => Err(OperatorError::Rejected { status: other }),
        }
    }

    /// Long-polls Operator until the active session ends externally (`POST /dictate/wait`).
    pub async fn wait(&self, session_id: &str) -> OperatorResult<DictationWait> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, text) = self
            .post_json("/dictate/wait", Some(body), TRANSCRIPT_TIMEOUT)
            .await?;
        match status {
            200..=299 => Ok(DictationWait::Transcript(parse_transcript(&text))),
            504 => Ok(DictationWait::StillWaiting),
            400 | 404 => Ok(DictationWait::Unsupported),
            other => Err(OperatorError::Rejected { status: other }),
        }
    }

    /// Stops an active session and returns its transcribed text (`POST /dictate/stop`).
    pub async fn stop(&self, session_id: &str) -> OperatorResult<String> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, text) = self
            .post_json("/dictate/stop", Some(body), TRANSCRIPT_TIMEOUT)
            .await?;
        if (200..=299).contains(&status) {
            Ok(parse_transcript(&text))
        } else {
            Err(OperatorError::Rejected { status })
        }
    }

    /// Cancels an active session and discards audio (`POST /dictate/cancel`).
    pub async fn cancel(&self, session_id: &str) -> OperatorResult<()> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, _) = self
            .post_json("/dictate/cancel", Some(body), CONTROL_TIMEOUT)
            .await?;
        if (200..=299).contains(&status) {
            Ok(())
        } else {
            Err(OperatorError::Rejected { status })
        }
    }

    /// Legacy sessionless fallback (`POST /dictate`) for older Operator builds.
    pub async fn legacy_toggle(&self) -> OperatorResult<()> {
        let (status, _) = self.post_json("/dictate", None, CONTROL_TIMEOUT).await?;
        if (200..=299).contains(&status) {
            Ok(())
        } else {
            Err(OperatorError::Rejected { status })
        }
    }
}

fn validate_session(session_id: &str) -> OperatorResult<()> {
    if is_valid_session_id(session_id) {
        Ok(())
    } else {
        Err(OperatorError::InvalidSessionId(session_id.to_owned()))
    }
}

/// Extracts `"text"` from Operator's JSON transcript body, returning empty string on non-JSON.
#[must_use]
pub fn parse_transcript(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("text")?.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    async fn spawn_mock_operator(
        responses: Vec<(&'static str, u16, &'static str)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for (expected_path, status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                let first_line = raw.lines().next().unwrap_or("").to_owned();
                assert!(
                    first_line.starts_with(&format!("POST {expected_path} ")),
                    "unexpected request line: {first_line}"
                );
                seen.push(raw);
                let reply = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
                stream.shutdown().await.unwrap();
            }
            seen
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn validates_session_id_and_parses_transcript() {
        assert!(is_valid_session_id("conn-composer-123_abc"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("bad id with spaces"));
        assert!(!is_valid_session_id("../escape"));

        assert_eq!(parse_transcript(r#"{"text":"hello world"}"#), "hello world");
        assert_eq!(parse_transcript(r#"{"text":42}"#), "");
        assert_eq!(parse_transcript("not json"), "");
    }

    #[tokio::test]
    async fn start_wait_504_then_transcript_and_origin_header() {
        let (base, handle) = spawn_mock_operator(vec![
            ("/dictate/start", 200, "{}"),
            ("/dictate/wait", 504, "{}"),
            ("/dictate/wait", 200, r#"{"text":"ship it"}"#),
        ])
        .await;

        let client = OperatorClient::new(&base)
            .unwrap()
            .with_origin("https://myapp.test");
        assert_eq!(client.start("sess-1").await, Ok(DictationStart::Started));
        assert_eq!(client.wait("sess-1").await, Ok(DictationWait::StillWaiting));
        assert_eq!(
            client.wait("sess-1").await,
            Ok(DictationWait::Transcript("ship it".to_owned()))
        );

        let seen = handle.await.unwrap();
        assert!(
            seen[0]
                .to_ascii_lowercase()
                .contains("origin: https://myapp.test")
        );
        assert!(seen[0].contains(r#"{"session":"sess-1"}"#));
    }

    #[tokio::test]
    async fn stop_cancel_and_unsupported_404() {
        let (base, handle) = spawn_mock_operator(vec![
            ("/dictate/start", 404, "{}"),
            ("/dictate/stop", 200, r#"{"text":"manual stop"}"#),
            ("/dictate/cancel", 200, "{}"),
        ])
        .await;

        let client = OperatorClient::new(&base).unwrap();
        assert_eq!(
            client.start("sess-2").await,
            Ok(DictationStart::Unsupported)
        );
        assert_eq!(client.stop("sess-2").await, Ok("manual stop".to_owned()));
        assert_eq!(client.cancel("sess-2").await, Ok(()));
        let _ = handle.await.unwrap();
    }
}
