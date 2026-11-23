//! The Orbit Gateway call, with Conn's allowlist.
//!
//! Port of `apps/desktop/src/ipc/methods/orbitGateway.ts`. Conn runs this in the Electron main
//! process because the Gateway refuses requests that carry a page `Origin`, and only the main
//! process trusts the Orbit root CA from the keychain. Here it is a plain `reqwest` client backed
//! by `rustls-platform-verifier`, and it never sends `Origin`.
//!
//! Every Conn call goes below `/api/v1/conn`. A `root` call goes below `/api/v1`, and only the
//! exact calls in [`resolve_root_url`] may go that way.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rustls_platform_verifier::BuilderVerifierExt as _;
use url::Url;

/// The Gateway every call goes to.
pub const DEFAULT_ORBIT_GATEWAY_URL: &str = "https://gateway.orbit";
const CONN_PREFIX: &str = "/api/v1/conn";
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(15_000);
const MAX_BODY_LEN: usize = 2_000_000;

/// The message for a path outside the allowlist.
pub const PATH_NOT_ALLOWED: &str = "That Gateway path is not allowed.";
/// The message for a query outside the allowlist.
pub const QUERY_NOT_ALLOWED: &str = "That Gateway query is not allowed.";
/// The message for a call that ran past its time limit.
pub const TIMED_OUT: &str = "The Orbit Gateway did not answer in time.";

/// The HTTP methods the Gateway client may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GatewayMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl GatewayMethod {
    fn as_reqwest(self) -> reqwest::Method {
        match self {
            Self::Get => reqwest::Method::GET,
            Self::Post => reqwest::Method::POST,
            Self::Put => reqwest::Method::PUT,
            Self::Patch => reqwest::Method::PATCH,
            Self::Delete => reqwest::Method::DELETE,
        }
    }
}

/// One Gateway call. Mirrors Conn's `OrbitGatewayRequest` IPC payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayRequest {
    pub method: GatewayMethod,
    /// A path below `/api/v1/conn` (or below `/api/v1` when `root`), such as `/me`.
    pub path: String,
    /// A JSON body, already serialized.
    pub body: Option<String>,
    /// Checked against the allowlist; a path without an entry takes no query.
    pub query: BTreeMap<String, String>,
    /// A longer limit for a call the Gateway answers slowly (1–120 s).
    pub timeout: Option<Duration>,
    /// Sent as `Idempotency-Key`.
    pub idempotency_key: Option<String>,
    /// The path is below `/api/v1`; only the calls in [`resolve_root_url`] go out this way.
    pub root: bool,
}

impl GatewayRequest {
    /// A `GET` below `/api/v1/conn`.
    pub fn get(path: impl Into<String>) -> Self {
        Self::with_method(GatewayMethod::Get, path)
    }

    /// A `POST` below `/api/v1/conn`.
    pub fn post(path: impl Into<String>) -> Self {
        Self::with_method(GatewayMethod::Post, path)
    }

    /// A `PUT` below `/api/v1/conn`.
    pub fn put(path: impl Into<String>) -> Self {
        Self::with_method(GatewayMethod::Put, path)
    }

    /// A `PATCH` below `/api/v1/conn`.
    pub fn patch(path: impl Into<String>) -> Self {
        Self::with_method(GatewayMethod::Patch, path)
    }

    /// A `DELETE` below `/api/v1/conn` (allowed only on `/reservations/{id}`).
    pub fn delete(path: impl Into<String>) -> Self {
        Self::with_method(GatewayMethod::Delete, path)
    }

    fn with_method(method: GatewayMethod, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            body: None,
            query: BTreeMap::new(),
            timeout: None,
            idempotency_key: None,
            root: false,
        }
    }

    /// Attaches a serialized JSON request body.
    #[must_use]
    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// The same request with one query parameter added.
    #[must_use]
    pub fn with_query(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.insert(key.into(), value.into());
        self
    }

    /// Sets a custom request timeout (must be between 1 and 120 seconds).
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Attaches an `Idempotency-Key` header.
    #[must_use]
    pub fn with_idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// The same request, sent below `/api/v1` instead of `/api/v1/conn`.
    #[must_use]
    pub fn at_root(mut self) -> Self {
        self.root = true;
        self
    }
}

/// The Gateway's answer: any HTTP status, with the body as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: String,
}

/// Why a call did not reach the Gateway or got no answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GatewayError {
    #[error("That Gateway path is not allowed.")]
    PathNotAllowed,
    #[error("That Gateway query is not allowed.")]
    QueryNotAllowed,
    /// The request itself is malformed (bad idempotency key, body too large, bad timeout).
    #[error("{0}")]
    InvalidRequest(String),
    #[error("The Orbit Gateway did not answer in time.")]
    Timeout,
    /// Any other network failure, with the client's message.
    #[error("{0}")]
    Network(String),
}

/// A boxed, sendable future, so transports can be trait objects.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Anything that answers Gateway requests: the live Gateway or the offline fixtures.
pub trait GatewayTransport: Send + Sync {
    fn send(&self, request: GatewayRequest)
    -> BoxFuture<'_, Result<GatewayResponse, GatewayError>>;
}

impl<T: GatewayTransport + ?Sized> GatewayTransport for Arc<T> {
    fn send(
        &self,
        request: GatewayRequest,
    ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
        (**self).send(request)
    }
}

/// Builds a `rustls::ClientConfig` backed by `rustls-platform-verifier` and `ring`.
///
/// Why `rustls-platform-verifier` instead of `rustls-tls-native-roots` (`rustls-native-certs`):
/// - `rustls-native-certs` 0.8 only queries Apple's keychain under `#[cfg(target_os = "macos")]`.
///   On `target_os = "ios"` it falls through to `#[cfg(all(unix, not(target_os = "macos")))]`,
///   which runs `openssl-probe` against `/etc/ssl/certs` and never reads the iOS device trust
///   store — so Orbit's root CA (installed via iOS Configuration Profile + Certificate Trust
///   Settings) would be rejected on iOS.
/// - `rustls-platform-verifier` compiles its Apple verifier under `#[cfg(target_vendor = "apple")]`
///   (macOS, iOS, iPadOS, visionOS, tvOS) and delegates chain verification directly to Apple's
///   `Security.framework` (`SecPolicy::create_ssl` + `SecTrust::create_with_certificates` +
///   `SecTrustEvaluateWithError`), trusting both system roots and user-trusted CAs on macOS and
///   iOS without dumping raw certificates.
/// - Passing `rustls::crypto::ring::default_provider()` explicitly avoids panicking if an iOS
///   or UniFFI host has not installed a process-wide default `CryptoProvider`.
///
/// iOS deployment notes (not compile-verified on this macOS-only host):
/// - The iOS `.xcframework` link step must link `-framework Security -framework CoreFoundation`.
/// - On iOS devices, installing the Orbit root CA profile also requires enabling full trust in
///   Settings → General → About → Certificate Trust Settings.
pub(crate) fn platform_tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_platform_verifier()?
        .with_no_client_auth())
}

fn http_tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut config = platform_tls_config()?;
    // Workspace `reqwest` enables HTTP/1.1 (`default-features = false`); advertise ALPN `http/1.1`
    // explicitly because `use_preconfigured_tls` bypasses reqwest's automatic ALPN setup.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// The live Gateway over HTTPS, trusting the OS certificate verifier (macOS Keychain and iOS
/// device trust store via `rustls-platform-verifier`).
#[derive(Debug, Clone)]
pub struct OrbitGateway {
    http: reqwest::Client,
    base_url: Url,
}

impl OrbitGateway {
    /// Builds the client targeting [`DEFAULT_ORBIT_GATEWAY_URL`]. Redirects are off, so no answer
    /// can lead a call off the allowlist.
    ///
    /// # Errors
    /// Returns [`GatewayError::Network`] if the platform TLS verifier or HTTP client fails to
    /// initialize.
    pub fn new() -> Result<Self, GatewayError> {
        Self::with_base_url(DEFAULT_ORBIT_GATEWAY_URL)
    }

    /// Builds the client targeting a custom Orbit Gateway origin (`http://` or `https://`).
    ///
    /// # Errors
    /// Returns [`GatewayError::InvalidRequest`] if `base_url` is not a valid `http://` or
    /// `https://` URL with a host, or [`GatewayError::Network`] if the TLS/HTTP client fails to
    /// initialize.
    pub fn with_base_url(base_url: &str) -> Result<Self, GatewayError> {
        let parsed = parse_gateway_base_url(base_url)?;
        let tls = http_tls_config().map_err(|error| GatewayError::Network(error.to_string()))?;
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| GatewayError::Network(error.to_string()))?;
        Ok(Self {
            http,
            base_url: parsed,
        })
    }

    /// Normalized base origin this Gateway client targets.
    #[must_use]
    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    /// Sends one allowed call and returns any HTTP answer. Port of `send` in `orbitGateway.ts`.
    pub async fn send(&self, request: &GatewayRequest) -> Result<GatewayResponse, GatewayError> {
        let mut url = checked_url_with_base(&self.base_url, request)?;
        if !request.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in &request.query {
                pairs.append_pair(key, value);
            }
        }
        let mut builder = self
            .http
            .request(request.method.as_reqwest(), url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(request.timeout.unwrap_or(DEFAULT_TIMEOUT));
        if let Some(body) = &request.body {
            builder = builder
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }
        if let Some(key) = &request.idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }
        let response = builder.send().await.map_err(network_error)?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(network_error)?;
        Ok(GatewayResponse { status, body })
    }
}

impl GatewayTransport for OrbitGateway {
    fn send(
        &self,
        request: GatewayRequest,
    ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
        Box::pin(async move { OrbitGateway::send(self, &request).await })
    }
}

fn network_error(error: reqwest::Error) -> GatewayError {
    if error.is_timeout() {
        GatewayError::Timeout
    } else {
        GatewayError::Network(error.to_string())
    }
}

fn parse_gateway_base_url(raw: &str) -> Result<Url, GatewayError> {
    let mut parsed = Url::parse(raw.trim()).map_err(|err| {
        GatewayError::InvalidRequest(format!("invalid Orbit Gateway URL `{raw}`: {err}"))
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() {
        return Err(GatewayError::InvalidRequest(format!(
            "expected http:// or https:// Orbit Gateway URL with host, got `{raw}`"
        )));
    }
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed)
}

/// Validates the whole request against [`DEFAULT_ORBIT_GATEWAY_URL`] and returns its URL.
pub fn checked_url(request: &GatewayRequest) -> Result<Url, GatewayError> {
    let base = gateway_base().ok_or(GatewayError::PathNotAllowed)?;
    checked_url_with_base(&base, request)
}

/// Validates the whole request (the IPC schema's rules, then the allowlist) against `base` and
/// returns its URL.
pub fn checked_url_with_base(base: &Url, request: &GatewayRequest) -> Result<Url, GatewayError> {
    if !is_request_path(&request.path) || !is_allowed_conn_method(request) {
        return Err(GatewayError::PathNotAllowed);
    }
    if let Some(body) = &request.body
        && body.len() > MAX_BODY_LEN
    {
        return Err(GatewayError::InvalidRequest(
            "The Gateway request body is too large.".to_owned(),
        ));
    }
    if let Some(timeout) = request.timeout
        && !(Duration::from_millis(1_000)..=Duration::from_millis(120_000)).contains(&timeout)
    {
        return Err(GatewayError::InvalidRequest(
            "The Gateway request timeout must be 1 to 120 seconds.".to_owned(),
        ));
    }
    if let Some(key) = &request.idempotency_key
        && !is_idempotency_key(key)
    {
        return Err(GatewayError::InvalidRequest(
            "The Gateway idempotency key is not valid.".to_owned(),
        ));
    }
    let url = if request.root {
        resolve_root_url_with_base(base, request)
    } else {
        resolve_conn_url_with_base(base, &request.path)
    };
    let url = url.ok_or(GatewayError::PathNotAllowed)?;
    if !request.root && !is_allowed_conn_query(request) {
        return Err(GatewayError::QueryNotAllowed);
    }
    Ok(url)
}

/// `DELETE` is only permitted on non-root `/reservations/{id}` (matching `orbitGateway.ts`).
#[must_use]
pub fn is_allowed_conn_method(request: &GatewayRequest) -> bool {
    if request.method != GatewayMethod::Delete {
        return true;
    }
    if request.root {
        return false;
    }
    let Some(parts) = segments(&request.path) else {
        return false;
    };
    matches!(
        parts.as_slice(),
        ["reservations", id]
            if (1..=64).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    )
}

/// `^\/[A-Za-z0-9/_.%-]{0,512}$`
fn is_request_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    rest.len() <= 512
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'.' | b'%' | b'-'))
}

/// `^[A-Za-z0-9:._-]{1,128}$`
fn is_idempotency_key(key: &str) -> bool {
    (1..=128).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'-'))
}

/// `decodeURIComponent`: `None` for a malformed escape or bytes that are not UTF-8.
fn decode_uri_component(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// True when a path segment is `.` or `..` (also percent-encoded), or holds an encoded slash.
pub fn has_unsafe_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| match decode_uri_component(segment) {
            None => true,
            Some(decoded) => {
                decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\')
            }
        })
}

fn gateway_base() -> Option<Url> {
    Url::parse(DEFAULT_ORBIT_GATEWAY_URL).ok()
}

/// The Gateway URL for a Conn path, or `None` when the path would leave `/api/v1/conn`.
pub fn resolve_conn_url(path: &str) -> Option<Url> {
    resolve_conn_url_with_base(&gateway_base()?, path)
}

/// The Gateway URL for a Conn path under `base`, or `None` when the path would leave `/api/v1/conn`.
pub fn resolve_conn_url_with_base(base: &Url, path: &str) -> Option<Url> {
    if has_unsafe_segment(path) {
        return None;
    }
    let origin = base.origin().ascii_serialization();
    let url = Url::parse(&format!("{origin}{CONN_PREFIX}{path}")).ok()?;
    let inside = url.path() == CONN_PREFIX || url.path().starts_with(&format!("{CONN_PREFIX}/"));
    (inside && url.origin() == base.origin()).then_some(url)
}

/// `^[1-9][0-9]{0,15}$`
pub(crate) fn is_orbit_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=16).contains(&bytes.len()) && bytes[0] != b'0' && bytes.iter().all(u8::is_ascii_digit)
}

/// Splits `path` into segments after the leading slash.
fn segments(path: &str) -> Option<Vec<&str>> {
    path.strip_prefix('/').map(|rest| rest.split('/').collect())
}

/// The Tasks board's insights: one of the board's periods, and optionally one Project.
fn is_task_insights_query(query: &BTreeMap<String, String>) -> bool {
    query.iter().all(|(key, value)| match key.as_str() {
        "period" => super::tasks::InsightsPeriod::ALL
            .iter()
            .any(|period| period.as_str() == value),
        "project_id" => is_orbit_id(value),
        _ => false,
    })
}

/// `^[0-9]{1,20}\.[0-9]{1,20}$`
fn is_socket_id(value: &str) -> bool {
    let digits =
        |part: &str| (1..=20).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    value
        .split_once('.')
        .is_some_and(|(left, right)| digits(left) && digits(right))
}

/// Only `{ socket_id, channel_name: "private-orbit" }` may be signed.
fn is_channel_auth_body(body: Option<&str>) -> bool {
    let Some(Ok(serde_json::Value::Object(data))) =
        body.map(serde_json::from_str::<serde_json::Value>)
    else {
        return false;
    };
    data.len() == 2
        && data.get("channel_name").and_then(serde_json::Value::as_str) == Some("private-orbit")
        && data
            .get("socket_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_socket_id)
}

/// The exact calls below `/api/v1`: projects, lifecycle reads and wake, the private Tasks channel,
/// and insights.
fn is_root_call(method: GatewayMethod, path: &str) -> bool {
    let Some(parts) = segments(path) else {
        return false;
    };
    match (method, parts.as_slice()) {
        (GatewayMethod::Get, ["projects"]) => true,
        (GatewayMethod::Post, ["instances", id, "wake"]) => is_orbit_id(id),
        (GatewayMethod::Get, ["operations", id]) => is_orbit_id(id),
        (GatewayMethod::Get, ["realtime"]) => true,
        (GatewayMethod::Post, ["broadcasting", "auth"]) => true,
        _ => false,
    }
}

/// The Gateway URL of an allowed call below `/api/v1`, or `None` for anything else.
pub fn resolve_root_url(request: &GatewayRequest) -> Option<Url> {
    resolve_root_url_with_base(&gateway_base()?, request)
}

/// The Gateway URL of an allowed call below `/api/v1` under `base`, or `None` for anything else.
pub fn resolve_root_url_with_base(base: &Url, request: &GatewayRequest) -> Option<Url> {
    let origin = base.origin().ascii_serialization();
    if request.method == GatewayMethod::Get && request.path == "/task-insights" {
        return if is_task_insights_query(&request.query) {
            Url::parse(&format!("{origin}/api/v1/task-insights")).ok()
        } else {
            None
        };
    }
    if !request.query.is_empty() {
        return None;
    }
    if request.path == "/broadcasting/auth" && !is_channel_auth_body(request.body.as_deref()) {
        return None;
    }
    if !is_root_call(request.method, &request.path) {
        return None;
    }
    Url::parse(&format!("{origin}/api/v1{}", request.path)).ok()
}

/// `^[a-z0-9-]{1,63}$`: Orbit's Instance name rule.
fn is_name_check_value(value: &str) -> bool {
    (1..=63).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

const ORBIT_BRANCH_QUERY_MAX_LENGTH: usize = 200;

/// A bounded, printable branch search. Length counts UTF-16 units, as JavaScript does.
fn is_branch_query_value(value: &str) -> bool {
    let length = value.encode_utf16().count();
    (1..=ORBIT_BRANCH_QUERY_MAX_LENGTH).contains(&length)
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// `^[a-z_]{1,32}$`
fn is_status_value(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// `^[1-9][0-9]?$|^100$`
fn is_limit_value(value: &str) -> bool {
    value == "100"
        || (matches!(value.len(), 1 | 2)
            && !value.starts_with('0')
            && value.bytes().all(|b| b.is_ascii_digit()))
}

type ValueRule = fn(&str) -> bool;

/// The query rules of one Conn path: each key with its value rule, and whether keys are optional.
fn conn_query_spec(
    method: GatewayMethod,
    path: &str,
) -> Option<(&'static [(&'static str, ValueRule)], bool)> {
    if method != GatewayMethod::Get {
        return None;
    }
    let parts = segments(path)?;
    match parts.as_slice() {
        ["projects"] => Some((&[("include_unavailable", |v| v == "1")], false)),
        ["projects", id, "instances", "check"] if is_orbit_id(id) => {
            Some((&[("name", is_name_check_value)], false))
        }
        ["projects", id, "branches"] if is_orbit_id(id) => {
            Some((&[("query", is_branch_query_value)], false))
        }
        ["tasks"] => Some((
            &[
                ("project", is_orbit_id),
                ("instance", is_orbit_id),
                ("status", is_status_value),
                ("limit", is_limit_value),
                ("cursor", is_orbit_id),
            ],
            true,
        )),
        _ => None,
    }
}

/// Whether the request's query may go to the Gateway; no query always may.
pub fn is_allowed_conn_query(request: &GatewayRequest) -> bool {
    if request.query.is_empty() {
        return true;
    }
    let Some((rules, optional)) = conn_query_spec(request.method, &request.path) else {
        return false;
    };
    if !optional && request.query.len() != rules.len() {
        return false;
    }
    request.query.iter().all(|(key, value)| {
        rules
            .iter()
            .find(|(name, _)| name == key)
            .is_some_and(|(_, rule)| rule(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str, query: &[(&str, &str)]) -> GatewayRequest {
        let mut request = GatewayRequest::get(path);
        for (key, value) in query {
            request = request.with_query(*key, *value);
        }
        request
    }

    fn root(method: GatewayMethod, path: &str, body: Option<serde_json::Value>) -> GatewayRequest {
        GatewayRequest {
            method,
            body: body.map(|value| value.to_string()),
            ..GatewayRequest::get(path).at_root()
        }
    }

    fn conn_path(path: &str) -> Option<String> {
        resolve_conn_url(path).map(|url| url.path().to_owned())
    }

    #[test]
    fn keeps_ordinary_conn_paths_below_the_prefix() {
        assert_eq!(conn_path("/me").as_deref(), Some("/api/v1/conn/me"));
        assert_eq!(
            conn_path("/instances/41/destroy").as_deref(),
            Some("/api/v1/conn/instances/41/destroy")
        );
        assert_eq!(
            conn_path("/profiles/1/settings").as_deref(),
            Some("/api/v1/conn/profiles/1/settings")
        );
        assert_eq!(conn_path("/").as_deref(), Some("/api/v1/conn/"));
    }

    #[test]
    fn rejects_traversal() {
        for path in [
            "/../nodes",
            "/../../../v1/nodes",
            "/./me",
            "/..",
            "/%2e%2e/nodes",
            "/%2E%2E/nodes",
            "/.%2e/nodes",
            "/%2e/me",
            "/profiles/%2e%2e/%2e%2e/nodes",
            "/..%2fnodes",
            "/%2e%2e%2fnodes",
            "/%",
            "/%zz",
        ] {
            assert_eq!(resolve_conn_url(path), None, "{path}");
        }
    }

    #[test]
    fn allows_dots_inside_a_segment_name() {
        assert_eq!(
            conn_path("/profiles/a..b").as_deref(),
            Some("/api/v1/conn/profiles/a..b")
        );
    }

    #[test]
    fn lets_a_request_without_a_query_through() {
        assert!(is_allowed_conn_query(&get("/me", &[])));
        assert!(is_allowed_conn_query(&get("/projects", &[])));
    }

    #[test]
    fn allows_the_listed_queries() {
        let long = "a".repeat(200);
        for request in [
            get("/projects/66/instances/check", &[("name", "pricing-page")]),
            get("/projects/66/instances/check", &[("name", "default")]),
            get("/projects", &[("include_unavailable", "1")]),
            get("/projects/66/branches", &[("query", "feature/Login")]),
            get("/projects/66/branches", &[("query", &long)]),
            get("/projects/66/branches", &[]),
            get("/tasks", &[("project", "78"), ("limit", "100")]),
            get(
                "/tasks",
                &[
                    ("project", "78"),
                    ("instance", "3599"),
                    ("status", "waiting_for_review"),
                    ("cursor", "5700"),
                ],
            ),
        ] {
            assert!(is_allowed_conn_query(&request), "{request:?}");
        }
    }

    #[test]
    fn refuses_other_queries() {
        let long_name = "a".repeat(64);
        let long_branch = "a".repeat(201);
        let cases = [
            (
                "another key",
                get("/projects/66/instances/check", &[("query", "x")]),
            ),
            (
                "an extra key",
                get(
                    "/projects/66/instances/check",
                    &[("name", "a"), ("limit", "5")],
                ),
            ),
            (
                "a bad name",
                get("/projects/66/instances/check", &[("name", "Bad Name")]),
            ),
            (
                "a long name",
                get("/projects/66/instances/check", &[("name", &long_name)]),
            ),
            (
                "an empty name",
                get("/projects/66/instances/check", &[("name", "")]),
            ),
            (
                "a non-numeric project",
                get("/projects/x/instances/check", &[("name", "a")]),
            ),
            (
                "include_unavailable=true",
                get("/projects", &[("include_unavailable", "true")]),
            ),
            (
                "include_unavailable=0",
                get("/projects", &[("include_unavailable", "0")]),
            ),
            (
                "include_unavailable with another key",
                get("/projects", &[("include_unavailable", "1"), ("a", "b")]),
            ),
            (
                "a query on another path",
                get("/environments", &[("include_unavailable", "1")]),
            ),
            (
                "a long branch search",
                get("/projects/66/branches", &[("query", &long_branch)]),
            ),
            (
                "an empty branch search",
                get("/projects/66/branches", &[("query", "")]),
            ),
            (
                "a control character",
                get("/projects/66/branches", &[("query", "a\nb")]),
            ),
            (
                "another key on branches",
                get("/projects/66/branches", &[("name", "main")]),
            ),
            (
                "an extra key on branches",
                get("/projects/66/branches", &[("query", "a"), ("limit", "5")]),
            ),
            (
                "branches of a non-numeric project",
                get("/projects/x/branches", &[("query", "a")]),
            ),
            (
                "another key on tasks",
                get("/tasks", &[("project", "78"), ("search", "a")]),
            ),
            (
                "a task list limit over 100",
                get("/tasks", &[("limit", "101")]),
            ),
            (
                "a non-numeric task cursor",
                get("/tasks", &[("cursor", "abc")]),
            ),
            (
                "a query on one task",
                get("/tasks/5753", &[("project", "78")]),
            ),
            (
                "a POST",
                GatewayRequest {
                    method: GatewayMethod::Post,
                    ..get("/projects", &[("include_unavailable", "1")])
                },
            ),
        ];
        for (label, request) in cases {
            assert!(!is_allowed_conn_query(&request), "{label}");
        }
    }

    #[test]
    fn allows_the_exact_root_routes() {
        let auth = serde_json::json!({ "socket_id": "123.456", "channel_name": "private-orbit" });
        assert_eq!(
            resolve_root_url(&root(GatewayMethod::Get, "/projects", None))
                .map(|url| url.to_string())
                .as_deref(),
            Some("https://gateway.orbit/api/v1/projects")
        );
        assert_eq!(
            resolve_root_url(&root(GatewayMethod::Post, "/instances/41/wake", None))
                .map(|url| url.to_string())
                .as_deref(),
            Some("https://gateway.orbit/api/v1/instances/41/wake")
        );
        assert_eq!(
            resolve_root_url(&root(GatewayMethod::Get, "/operations/501", None))
                .map(|url| url.to_string())
                .as_deref(),
            Some("https://gateway.orbit/api/v1/operations/501")
        );
        assert_eq!(
            resolve_root_url(&root(GatewayMethod::Get, "/realtime", None))
                .map(|url| url.path().to_owned())
                .as_deref(),
            Some("/api/v1/realtime")
        );
        assert_eq!(
            resolve_root_url(&root(GatewayMethod::Post, "/broadcasting/auth", Some(auth)))
                .map(|url| url.path().to_owned())
                .as_deref(),
            Some("/api/v1/broadcasting/auth")
        );
    }

    #[test]
    fn refuses_other_root_routes() {
        use GatewayMethod::{Get, Post};
        let body = |value: serde_json::Value| Some(value);
        let cases = [
            root(Post, "/projects", None),
            root(Get, "/instances/41/wake", None),
            root(Post, "/realtime", None),
            root(Get, "/broadcasting/auth", None),
            root(Post, "/broadcasting/auth", None),
            root(
                Post,
                "/broadcasting/auth",
                body(serde_json::json!({ "socket_id": "1.2", "channel_name": "private-admin" })),
            ),
            root(
                Post,
                "/broadcasting/auth",
                body(serde_json::json!({ "socket_id": "bad", "channel_name": "private-orbit" })),
            ),
            root(
                Post,
                "/broadcasting/auth",
                body(serde_json::json!({
                    "socket_id": "1.2", "channel_name": "private-orbit", "extra": true
                })),
            ),
            root(Post, "/instances/41/sleep", None),
            root(Post, "/instances/41/destroy", None),
            root(Post, "/operations/501", None),
            root(Post, "/operations/501/cancel", None),
            root(Get, "/instances/0/wake", None),
            root(Post, "/instances/41/wake/../../nodes", None),
            root(Post, "/conn/instances/41/destroy", None),
        ];
        for request in cases {
            assert_eq!(resolve_root_url(&request), None, "{request:?}");
        }
    }

    #[test]
    fn refuses_a_query_on_an_allowed_root_call() {
        let request =
            root(GatewayMethod::Get, "/operations/501", None).with_query("include", "steps");
        assert_eq!(resolve_root_url(&request), None);
    }

    #[test]
    fn allows_the_board_insights_with_a_period_and_one_project_only() {
        let insights = |query: &[(&str, &str)], method: GatewayMethod| {
            let mut request = root(method, "/task-insights", None);
            for (key, value) in query {
                request = request.with_query(*key, *value);
            }
            resolve_root_url(&request).map(|url| url.path().to_owned())
        };
        let ok = Some("/api/v1/task-insights".to_owned());
        assert_eq!(insights(&[], GatewayMethod::Get), ok);
        assert_eq!(
            insights(
                &[("period", "7d"), ("project_id", "78")],
                GatewayMethod::Get
            ),
            ok
        );
        for period in super::super::tasks::InsightsPeriod::ALL {
            assert_eq!(
                insights(&[("period", period.as_str())], GatewayMethod::Get),
                ok
            );
            assert_eq!(
                insights(
                    &[("period", period.as_str()), ("project_id", "78")],
                    GatewayMethod::Get
                ),
                ok
            );
        }
        assert_eq!(insights(&[("period", "24h")], GatewayMethod::Get), ok);
        assert_eq!(insights(&[("period", "90d")], GatewayMethod::Get), None);
        assert_eq!(insights(&[("project_id", "0")], GatewayMethod::Get), None);
        assert_eq!(
            insights(&[("period", "30d"), ("search", "x")], GatewayMethod::Get),
            None
        );
        assert_eq!(insights(&[("period", "30d")], GatewayMethod::Post), None);
    }

    #[test]
    fn checks_the_whole_request_with_conn_error_strings() {
        let error = |request: GatewayRequest| checked_url(&request).err().map(|e| e.to_string());
        assert_eq!(
            error(get("/../nodes", &[])).as_deref(),
            Some(PATH_NOT_ALLOWED)
        );
        assert_eq!(
            error(get("/me?x=1", &[])).as_deref(),
            Some(PATH_NOT_ALLOWED)
        );
        assert_eq!(
            error(get("/tasks", &[("search", "a")])).as_deref(),
            Some(QUERY_NOT_ALLOWED)
        );
        assert_eq!(error(get("/tasks", &[("limit", "5")])), None);
        assert_eq!(
            checked_url(&get("/tasks", &[("limit", "5"), ("project", "78")]))
                .map(|url| url.to_string())
                .ok()
                .as_deref(),
            Some("https://gateway.orbit/api/v1/conn/tasks")
        );
        assert_eq!(GatewayError::Timeout.to_string(), TIMED_OUT);
    }

    #[test]
    fn builds_platform_verified_tls_config_and_gateway_client() {
        let ws_tls = platform_tls_config().expect("platform TLS config builds without default");
        assert!(
            ws_tls.alpn_protocols.is_empty(),
            "WebSocket TLS config leaves ALPN unset for HTTP/1.1 Upgrade"
        );

        let http_tls = http_tls_config().expect("HTTP platform TLS config builds");
        assert_eq!(
            http_tls.alpn_protocols,
            vec![b"http/1.1".to_vec()],
            "HTTP TLS config advertises http/1.1 ALPN"
        );

        OrbitGateway::new().expect("OrbitGateway builds with platform TLS verifier");
    }

    #[test]
    fn supports_custom_gateway_base_url_and_reservation_delete_allowlist() {
        let custom = OrbitGateway::with_base_url("https://gateway.staging.orbit:8443/ignored/")
            .expect("custom gateway URL builds");
        assert_eq!(
            custom.base_url().as_str(),
            "https://gateway.staging.orbit:8443/",
            "base URL normalizes to origin"
        );
        assert_eq!(
            checked_url_with_base(custom.base_url(), &GatewayRequest::get("/me"))
                .expect("conn route resolves under custom origin")
                .as_str(),
            "https://gateway.staging.orbit:8443/api/v1/conn/me"
        );
        assert_eq!(
            checked_url_with_base(
                custom.base_url(),
                &GatewayRequest::get("/projects").at_root()
            )
            .expect("root route resolves under custom origin")
            .as_str(),
            "https://gateway.staging.orbit:8443/api/v1/projects"
        );
        assert!(
            OrbitGateway::with_base_url("ftp://gateway.orbit").is_err(),
            "non-http(s) gateway URL must be rejected"
        );

        let allowed_delete = GatewayRequest::delete("/reservations/res-123-abc");
        assert_eq!(
            checked_url(&allowed_delete)
                .expect("DELETE /reservations/{id} is allowed")
                .as_str(),
            "https://gateway.orbit/api/v1/conn/reservations/res-123-abc"
        );
        assert_eq!(
            checked_url(&GatewayRequest::delete("/profiles/1")),
            Err(GatewayError::PathNotAllowed),
            "DELETE outside /reservations/{{id}} must be rejected"
        );
        assert_eq!(
            checked_url(&GatewayRequest::delete("/reservations/res-1").at_root()),
            Err(GatewayError::PathNotAllowed),
            "root DELETE must be rejected"
        );
    }
}
