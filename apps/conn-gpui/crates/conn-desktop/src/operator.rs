//! Local Operator dictation session client (`/dictate/{start,stop,wait,cancel}`).
//!
//! Port of Conn's `apps/desktop/src/preview/AnnotatorDictation.ts` protocol for macOS local
//! Operator dictation — shared by both the chat composer (`conn-app`) and browser/device
//! annotations (Slice 3).
//!
//! Protocol summary (see `FORK.md`):
//! - Auth: Operator's Local API expects `Authorization: Bearer <token>` (or `X-Operator-Token`)
//!   from Operator → Settings → Local API.
//! - `POST <origin>/dictate/start`  with `{"session":"<id>"}` -> 2xx started, 400/404 unsupported.
//! - `POST <origin>/dictate/wait`   with `{"session":"<id>"}` -> 2xx `{"text":"..."}`, 504 still
//!   waiting (caller retries while active), 400/404 unsupported (older Operator without wait).
//! - `POST <origin>/dictate/stop`   with `{"session":"<id>"}` -> 2xx `{"text":"..."}`.
//! - `POST <origin>/dictate/cancel` with `{"session":"<id>"}` -> 2xx cancelled.
//! - Legacy fallback: `POST <origin>/dictate` (empty body) for Operator builds before sessions.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

/// Default local Operator HTTP endpoint on macOS.
pub const DEFAULT_OPERATOR_URL: &str = "http://127.0.0.1:12321";

/// Documented path to Operator's own Local API config (`token`, `enabled`, optional `port`).
/// See `~/apps/operator/mac/README.md` ("Local recording API").
const OPERATOR_CONTROL_REL_PATH: &str =
    "Library/Application Support/com.nckrtl.operator/control.json";

/// Fields read from Operator's documented `control.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OperatorControlInfo {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub token: Option<String>,
}

impl OperatorControlInfo {
    /// Default location of Operator's `control.json` on macOS.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join(OPERATOR_CONTROL_REL_PATH))
    }

    /// Reads Operator's `control.json` from `path`, returning `None` if absent or unreadable.
    #[must_use]
    pub fn load_from(path: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(path).ok()?;
        let val: Value = serde_json::from_str(&raw).ok()?;
        let obj = val.as_object()?;
        let enabled = obj.get("enabled").and_then(Value::as_bool);
        let port = obj
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .filter(|&p| p > 0);
        let token = obj
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        Some(Self {
            enabled,
            port,
            token,
        })
    }

    /// Reads Operator's `control.json` from the default macOS path.
    #[must_use]
    pub fn load_default() -> Option<Self> {
        let path = Self::default_path()?;
        Self::load_from(&path)
    }
}

/// Request timeout for fast control calls (`start`, `cancel`, legacy `start`).
const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
/// Request timeout for calls that wait on audio transcription (`stop`, `wait`).
/// Operator gives up around 120s (504), so we allow 130s.
const TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(130);

/// Local Operator connection configuration saved on this Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorConfig {
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl Default for OperatorConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_OPERATOR_URL.to_owned(),
            token: None,
        }
    }
}

impl OperatorConfig {
    /// Default config file path (`~/Library/Application Support/conn-gpui/operator.json`),
    /// overridable with `CONN_GPUI_CONFIG_DIR` for isolated dev/test sessions.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("operator.json"));
        }
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/Application Support/conn-gpui")
                .join("operator.json"),
        )
    }

    /// Loads saved config from `path`, falling back to [`Default`].
    #[must_use]
    pub fn load_from(path: &Path) -> Self {
        let mut cfg: Self = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        if cfg.base_url.trim().is_empty() {
            cfg.base_url = DEFAULT_OPERATOR_URL.to_owned();
        }
        cfg.token = cfg
            .token
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty());
        cfg
    }

    /// Loads config from `conn-gpui`'s saved override, auto-discovering Operator's documented
    /// `com.nckrtl.operator/control.json` (`token` & `port`) when not overridden, with
    /// `CONN_OPERATOR_URL` / `CONN_OPERATOR_TOKEN` env vars taking highest precedence.
    #[must_use]
    pub fn load_effective() -> Self {
        let mut cfg = Self::default_path()
            .map(|p| Self::load_from(&p))
            .unwrap_or_default();

        if let Some(control) = OperatorControlInfo::load_default() {
            if cfg.token.is_none() {
                cfg.token = control.token;
            }
            if cfg.base_url == DEFAULT_OPERATOR_URL
                && let Some(port) = control.port
            {
                cfg.base_url = format!("http://127.0.0.1:{port}");
            }
        }

        if let Ok(url) = std::env::var("CONN_OPERATOR_URL") {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                cfg.base_url = trimmed.to_owned();
            }
        }
        if let Ok(tok) = std::env::var("CONN_OPERATOR_TOKEN") {
            let trimmed = tok.trim();
            if !trimmed.is_empty() {
                cfg.token = Some(trimmed.to_owned());
            }
        }
        cfg
    }

    /// Persists config atomically to `path` with `0600` permissions on Unix.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let clean = Self {
            base_url: if self.base_url.trim().is_empty() {
                DEFAULT_OPERATOR_URL.to_owned()
            } else {
                self.base_url.trim().to_owned()
            },
            token: self
                .token
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(ToOwned::to_owned),
        };
        let json = serde_json::to_string_pretty(&clean)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(tmp, path)
    }

    /// Persists config to [`Self::default_path`].
    pub fn save_default(&self) -> std::io::Result<()> {
        let path = Self::default_path().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "cannot resolve Operator config directory",
            )
        })?;
        self.save_to(&path)
    }
}

/// Errors from talking to local Operator.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OperatorError {
    #[error("Invalid Operator base URL: {0}")]
    InvalidBaseUrl(String),
    #[error("Invalid dictation session id: {0}")]
    InvalidSessionId(String),
    #[error("Operator is not reachable at {url}: {message}")]
    Unreachable { url: String, message: String },
    #[error("Operator requires a Local API token: {0}")]
    Unauthorized(String),
    #[error("Operator rejected the request (HTTP {status}): {message}")]
    Rejected { status: u16, message: String },
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

/// Client for local Operator HTTP dictation sessions.
#[derive(Debug, Clone)]
pub struct OperatorClient {
    base_origin: Url,
    token: Option<String>,
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
            token: None,
            origin_header: None,
            http,
        })
    }

    /// Creates a client from saved [`OperatorConfig`] and env overrides (`CONN_OPERATOR_URL`,
    /// `CONN_OPERATOR_TOKEN`).
    pub fn from_config() -> OperatorResult<Self> {
        let cfg = OperatorConfig::load_effective();
        let mut client = Self::new(&cfg.base_url)?;
        if let Some(token) = cfg.token {
            client = client.with_token(token);
        }
        Ok(client)
    }

    /// Sets the Operator Local API token sent as `Authorization: Bearer <token>`.
    #[must_use]
    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        let trimmed = token.into().trim().to_owned();
        self.token = (!trimmed.is_empty()).then_some(trimmed);
        self
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
        if let Some(token) = &self.token {
            req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
        }
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
        let (status, text) = self
            .post_json("/dictate/start", Some(body), CONTROL_TIMEOUT)
            .await?;
        match status {
            200..=299 => Ok(DictationStart::Started),
            400 | 404 => Ok(DictationStart::Unsupported),
            401 => Err(OperatorError::Unauthorized(parse_error_message(&text))),
            other => Err(OperatorError::Rejected {
                status: other,
                message: parse_error_message(&text),
            }),
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
            401 => Err(OperatorError::Unauthorized(parse_error_message(&text))),
            other => Err(OperatorError::Rejected {
                status: other,
                message: parse_error_message(&text),
            }),
        }
    }

    /// Stops an active session and returns its transcribed text (`POST /dictate/stop`).
    pub async fn stop(&self, session_id: &str) -> OperatorResult<String> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, text) = self
            .post_json("/dictate/stop", Some(body), TRANSCRIPT_TIMEOUT)
            .await?;
        match status {
            200..=299 => Ok(parse_transcript(&text)),
            401 => Err(OperatorError::Unauthorized(parse_error_message(&text))),
            other => Err(OperatorError::Rejected {
                status: other,
                message: parse_error_message(&text),
            }),
        }
    }

    /// Cancels an active session and discards audio (`POST /dictate/cancel`).
    pub async fn cancel(&self, session_id: &str) -> OperatorResult<()> {
        validate_session(session_id)?;
        let body = json!({ "session": session_id }).to_string();
        let (status, text) = self
            .post_json("/dictate/cancel", Some(body), CONTROL_TIMEOUT)
            .await?;
        match status {
            200..=299 => Ok(()),
            401 => Err(OperatorError::Unauthorized(parse_error_message(&text))),
            other => Err(OperatorError::Rejected {
                status: other,
                message: parse_error_message(&text),
            }),
        }
    }

    /// Legacy sessionless fallback (`POST /dictate`) for older Operator builds.
    pub async fn legacy_toggle(&self) -> OperatorResult<()> {
        let (status, text) = self.post_json("/dictate", None, CONTROL_TIMEOUT).await?;
        match status {
            200..=299 => Ok(()),
            401 => Err(OperatorError::Unauthorized(parse_error_message(&text))),
            other => Err(OperatorError::Rejected {
                status: other,
                message: parse_error_message(&text),
            }),
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

fn parse_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "request rejected".to_owned())
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

    #[test]
    fn config_round_trips_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("operator.json");
        let cfg = OperatorConfig {
            base_url: "http://127.0.0.1:12321".to_owned(),
            token: Some("op_test_token".to_owned()),
        };
        cfg.save_to(&path).unwrap();
        assert_eq!(OperatorConfig::load_from(&path), cfg);
    }

    #[test]
    fn control_info_parses_operator_control_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.json");
        std::fs::write(
            &path,
            r#"{"enabled":true,"port":12321,"token":"abcdef0123456789"}"#,
        )
        .unwrap();
        let info = OperatorControlInfo::load_from(&path).unwrap();
        assert_eq!(info.enabled, Some(true));
        assert_eq!(info.port, Some(12321));
        assert_eq!(info.token.as_deref(), Some("abcdef0123456789"));
    }

    #[tokio::test]
    async fn start_wait_504_then_transcript_with_bearer_token_and_origin() {
        let (base, handle) = spawn_mock_operator(vec![
            ("/dictate/start", 200, "{}"),
            ("/dictate/wait", 504, "{}"),
            ("/dictate/wait", 200, r#"{"text":"ship it"}"#),
        ])
        .await;

        let client = OperatorClient::new(&base)
            .unwrap()
            .with_token("secret-local-token")
            .with_origin("https://myapp.test");
        assert_eq!(client.start("sess-1").await, Ok(DictationStart::Started));
        assert_eq!(client.wait("sess-1").await, Ok(DictationWait::StillWaiting));
        assert_eq!(
            client.wait("sess-1").await,
            Ok(DictationWait::Transcript("ship it".to_owned()))
        );

        let seen = handle.await.unwrap();
        let headers_lc = seen[0].to_ascii_lowercase();
        assert!(headers_lc.contains("authorization: bearer secret-local-token"));
        assert!(headers_lc.contains("origin: https://myapp.test"));
        assert!(seen[0].contains(r#"{"session":"sess-1"}"#));
    }

    #[tokio::test]
    async fn unauthorized_401_and_stop_cancel_and_404() {
        let (base, handle) = spawn_mock_operator(vec![
            (
                "/dictate/start",
                401,
                r#"{"error":"Send the Local API token as Authorization: Bearer <token>."}"#,
            ),
            ("/dictate/start", 404, "{}"),
            ("/dictate/stop", 200, r#"{"text":"manual stop"}"#),
            ("/dictate/cancel", 200, "{}"),
        ])
        .await;

        let client = OperatorClient::new(&base).unwrap();
        assert_eq!(
            client.start("sess-2").await,
            Err(OperatorError::Unauthorized(
                "Send the Local API token as Authorization: Bearer <token>.".to_owned()
            ))
        );
        assert_eq!(
            client.start("sess-2").await,
            Ok(DictationStart::Unsupported)
        );
        assert_eq!(client.stop("sess-2").await, Ok("manual stop".to_owned()));
        assert_eq!(client.cancel("sess-2").await, Ok(()));
        let _ = handle.await.unwrap();
    }
}
