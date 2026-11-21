//! The API panel's sender and its pure renderer logic.
//!
//! Port of Conn's `apps/desktop/src/ipc/methods/apiRequest.ts` (the Electron main-process
//! sender) plus the panel's pure helpers from `apps/web/src/api/` and
//! `apps/web/src/laravelToolbar/`. The request runs in the app, not in a page, so there is no
//! CORS and every response header is visible. TLS trusts the bundled web roots and the macOS
//! system keychain, so Orbit's local CA for `*.test` hosts works as it does in Conn.
//!
//! - [`send`] / [`ApiClient::send`]: one request, with Conn's exact semantics and error strings.
//! - [`store`]: saved requests per project, drafts, labels and persistence.
//! - [`response_view`]: body formatting and status badges for the response pane.
//! - [`toolbar`]: the Laravel Toolbar payload carried in response headers.

pub mod response_view;
pub mod store;
pub mod toolbar;

#[cfg(test)]
mod send_tests;

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// The most body bytes a response keeps; [`ApiResponse::size`] still reports the full size.
pub const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;
/// Used when [`ApiRequest::timeout_ms`] is not set.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// The longest URL Conn's IPC schema accepts.
pub const MAX_URL_LENGTH: usize = 16_384;
/// The longest timeout Conn's IPC schema accepts.
pub const MAX_TIMEOUT_MS: u64 = 600_000;

/// Error text for a URL that does not parse.
pub const BAD_URL_ERROR: &str = "Enter a full URL, such as https://app.test/api/users.";
/// Error text for a URL with a scheme other than http or https.
pub const BAD_SCHEME_ERROR: &str = "Only http and https URLs can be sent.";
/// Error text when the request (headers or body) did not finish in time.
pub const TIMEOUT_ERROR: &str = "The request timed out.";

/// Conn follows redirects as Chromium's `net.fetch` does (at most 20 hops).
const MAX_REDIRECTS: usize = 20;

/// One request or response header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiHeader {
    pub name: String,
    pub value: String,
}

impl ApiHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }
}

/// Conn's `DesktopApiRequest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    /// 1 to 16 ASCII letters; sent upper-cased.
    pub method: String,
    pub url: String,
    /// Headers with a blank name are skipped; names and values are trimmed.
    pub headers: Vec<ApiHeader>,
    /// Ignored for GET and HEAD.
    pub body: Option<String>,
    /// 1 to 600 000; [`DEFAULT_TIMEOUT_MS`] when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// How [`ApiResponse::body`] holds the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyEncoding {
    /// UTF-8 text (invalid sequences replaced).
    Text,
    /// Standard base64 of the raw bytes.
    Base64,
}

/// Conn's `DesktopApiResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    /// Set when no response arrived (bad URL, DNS, TLS, timeout); the other fields are empty.
    pub error: Option<String>,
    pub status: u16,
    pub status_text: String,
    /// The final URL, after redirects.
    pub url: String,
    /// Lower-case names, sorted, as a fetch `Headers` iterates them.
    pub headers: Vec<ApiHeader>,
    pub body: String,
    pub body_encoding: BodyEncoding,
    /// The full body size in bytes, also when the body was truncated.
    pub size: u64,
    /// True when the server sent more than [`MAX_BODY_BYTES`].
    pub truncated: bool,
    /// Milliseconds, rounded to one decimal.
    pub duration_ms: f64,
}

impl ApiResponse {
    /// A response that never arrived: `error` set, everything else empty.
    pub fn failure(url: impl Into<String>, error: impl Into<String>, duration_ms: f64) -> Self {
        Self {
            error: Some(error.into()),
            status: 0,
            status_text: String::new(),
            url: url.into(),
            headers: Vec::new(),
            body: String::new(),
            body_encoding: BodyEncoding::Text,
            size: 0,
            truncated: false,
            duration_ms,
        }
    }

    /// The first header with this name, in any case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    }
}

/// Failure to set up the HTTP client.
#[derive(Debug, thiserror::Error)]
pub enum ApiClientError {
    #[error("could not build the HTTP client: {0}")]
    Build(#[source] reqwest::Error),
}

/// Sends API panel requests. Cheap to clone; keep one per app.
#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    max_body_bytes: usize,
}

impl ApiClient {
    pub fn new() -> Result<Self, ApiClientError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
            .map_err(ApiClientError::Build)?;
        Ok(Self {
            http,
            max_body_bytes: MAX_BODY_BYTES,
        })
    }

    #[cfg(test)]
    fn with_max_body_bytes(mut self, max_body_bytes: usize) -> Self {
        self.max_body_bytes = max_body_bytes;
        self
    }

    /// Sends one request. Never fails: problems come back in [`ApiResponse::error`].
    pub async fn send(&self, request: &ApiRequest) -> ApiResponse {
        let started = Instant::now();
        let elapsed = || round_tenth(started.elapsed().as_secs_f64() * 1000.0);

        // Conn's IPC schema rejects these before the handler runs; the panel then shows the
        // rejection as a failed response with no duration.
        if let Some(error) = schema_error(request) {
            return ApiResponse::failure(&request.url, error, 0.0);
        }
        let Ok(url) = url::Url::parse(&request.url) else {
            return ApiResponse::failure(&request.url, BAD_URL_ERROR, 0.0);
        };
        if url.scheme() != "http" && url.scheme() != "https" {
            return ApiResponse::failure(&request.url, BAD_SCHEME_ERROR, 0.0);
        }
        let method_name = request.method.to_ascii_uppercase();
        let method = match reqwest::Method::from_bytes(method_name.as_bytes()) {
            Ok(method) => method,
            Err(error) => return ApiResponse::failure(&request.url, error.to_string(), 0.0),
        };
        let headers = match request_headers(&request.headers) {
            Ok(headers) => headers,
            Err(error) => return ApiResponse::failure(&request.url, error, 0.0),
        };
        let bodyless = method_name == "GET" || method_name == "HEAD";
        let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

        let mut builder = self
            .http
            .request(method, url.clone())
            .headers(headers)
            .timeout(timeout);
        if let (false, Some(body)) = (bodyless, &request.body) {
            builder = builder.body(body.clone());
        }

        let result = async {
            let mut response = builder.send().await?;
            let (bytes, size) = read_body(&mut response, self.max_body_bytes).await?;
            Ok::<_, reqwest::Error>((response, bytes, size))
        }
        .await;

        match result {
            Ok((response, bytes, size)) => {
                let headers = response_headers(response.headers());
                let content_type = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .map(|value| header_text(value.as_bytes()))
                    .unwrap_or_default();
                let text = content_type.is_empty() || is_text_content_type(&content_type);
                let truncated = size > bytes.len() as u64;
                let status = response.status();
                ApiResponse {
                    error: None,
                    status: status.as_u16(),
                    status_text: status.canonical_reason().unwrap_or_default().to_owned(),
                    url: response.url().to_string(),
                    headers,
                    body: if text {
                        decode_text(&bytes)
                    } else {
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    },
                    body_encoding: if text {
                        BodyEncoding::Text
                    } else {
                        BodyEncoding::Base64
                    },
                    size,
                    truncated,
                    duration_ms: elapsed(),
                }
            }
            Err(error) => {
                let message = if error.is_timeout() {
                    TIMEOUT_ERROR.to_owned()
                } else {
                    error_message(&error)
                };
                ApiResponse::failure(url.as_str(), message, elapsed())
            }
        }
    }
}

/// Sends one request with a shared [`ApiClient`]. Never fails: problems come back in
/// [`ApiResponse::error`].
pub async fn send(request: &ApiRequest) -> ApiResponse {
    static CLIENT: OnceLock<Result<ApiClient, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| ApiClient::new().map_err(|error| error.to_string())) {
        Ok(client) => client.send(request).await,
        Err(error) => ApiResponse::failure(&request.url, error.clone(), 0.0),
    }
}

/// What Conn's `ApiRequest` schema checks, as the message of a rejected request.
fn schema_error(request: &ApiRequest) -> Option<String> {
    let method_ok = (1..=16).contains(&request.method.len())
        && request
            .method
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic());
    if !method_ok {
        return Some(format!(
            "Invalid request method \"{}\": use 1 to 16 letters.",
            request.method
        ));
    }
    if request.url.chars().count() > MAX_URL_LENGTH {
        return Some(format!(
            "The URL is longer than {MAX_URL_LENGTH} characters."
        ));
    }
    if let Some(timeout) = request.timeout_ms
        && !(1..=MAX_TIMEOUT_MS).contains(&timeout)
    {
        return Some(format!(
            "The timeout must be between 1 and {MAX_TIMEOUT_MS} ms."
        ));
    }
    None
}

/// Fetch `Headers.append` semantics: trimmed names and values, blank names skipped.
fn request_headers(rows: &[ApiHeader]) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderName, HeaderValue};
    let mut headers = reqwest::header::HeaderMap::new();
    for row in rows {
        let name = row.name.trim();
        if name.is_empty() {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid header name: \"{name}\"."))?;
        let value = row.value.trim_matches([' ', '\t', '\n', '\r']);
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| format!("Invalid value for header \"{name}\"."))?;
        headers.append(header_name, header_value);
    }
    Ok(headers)
}

/// Reads at most `max` bytes; returns them with the full size the server sent.
async fn read_body(
    response: &mut reqwest::Response,
    max: usize,
) -> Result<(Vec<u8>, u64), reqwest::Error> {
    let mut bytes = Vec::new();
    let mut size: u64 = 0;
    while let Some(chunk) = response.chunk().await? {
        size += chunk.len() as u64;
        let room = max.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
    Ok((bytes, size))
}

/// Header pairs as a fetch `Headers` iterates them: sorted lower-case names, repeated values
/// joined with `, `, except `set-cookie`, which keeps one entry per value.
fn response_headers(map: &reqwest::header::HeaderMap) -> Vec<ApiHeader> {
    let mut grouped: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (name, value) in map {
        grouped
            .entry(name.as_str())
            .or_default()
            .push(header_text(value.as_bytes()));
    }
    let mut headers = Vec::new();
    for (name, values) in grouped {
        if name == "set-cookie" {
            headers.extend(values.into_iter().map(|value| ApiHeader::new(name, value)));
        } else {
            headers.push(ApiHeader::new(name, values.join(", ")));
        }
    }
    headers
}

/// UTF-8 when valid, else Latin-1 (how browsers read header bytes).
fn header_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&byte| char::from(byte)).collect(),
    }
}

/// `TextDecoder().decode`: UTF-8 with replacement characters, leading BOM dropped.
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `/^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql))/i`
pub fn is_text_content_type(content_type: &str) -> bool {
    const SUBTYPES: [&str; 5] = [
        "json",
        "xml",
        "javascript",
        "x-www-form-urlencoded",
        "graphql",
    ];
    let lower = content_type.to_ascii_lowercase();
    if lower.starts_with("text/") {
        return true;
    }
    let Some(rest) = lower.strip_prefix("application/") else {
        return false;
    };
    let subtype_at = |index: usize| {
        SUBTYPES
            .iter()
            .any(|subtype| rest[index..].starts_with(subtype))
    };
    if subtype_at(0) {
        return true;
    }
    // A structured suffix: `[\w.+-]*` then `+`, then a known subtype.
    for (index, char) in rest.char_indices() {
        if !(char.is_ascii_alphanumeric() || matches!(char, '_' | '.' | '+' | '-')) {
            return false;
        }
        if char == '+' && subtype_at(index + 1) {
            return true;
        }
    }
    false
}

/// The error and its causes, as one line.
fn error_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

fn round_tenth(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_content_types_match_conns_pattern() {
        for text in [
            "text/html; charset=utf-8",
            "TEXT/PLAIN",
            "application/json",
            "application/problem+json",
            "application/vnd.api+json",
            "application/xml",
            "application/javascript",
            "application/x-www-form-urlencoded",
            "application/graphql-response+json",
            "application/jsonp",
        ] {
            assert!(is_text_content_type(text), "{text} is text");
        }
        for binary in [
            "image/png",
            "application/octet-stream",
            "application/pdf",
            "application/vnd.ms-excel",
            "application/x+y json",
        ] {
            assert!(!is_text_content_type(binary), "{binary} is binary");
        }
    }

    #[test]
    fn response_headers_sort_and_join_like_fetch() {
        let mut map = reqwest::header::HeaderMap::new();
        map.append("x-b", "1".parse().expect("valid header value"));
        map.append("x-b", "2".parse().expect("valid header value"));
        map.append("set-cookie", "a=1".parse().expect("valid header value"));
        map.append("set-cookie", "b=2".parse().expect("valid header value"));
        map.append(
            "content-type",
            "text/plain".parse().expect("valid header value"),
        );
        let names: Vec<String> = response_headers(&map)
            .into_iter()
            .map(|header| format!("{}: {}", header.name, header.value))
            .collect();
        assert_eq!(
            names,
            [
                "content-type: text/plain",
                "set-cookie: a=1",
                "set-cookie: b=2",
                "x-b: 1, 2"
            ],
            "sorted, joined, set-cookie kept apart"
        );
    }

    #[test]
    fn decodes_text_like_text_decoder() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFhi"), "hi", "drops the BOM");
        assert_eq!(decode_text(b"a\xFFb"), "a\u{FFFD}b", "replaces bad bytes");
    }

    #[test]
    fn serializes_with_conns_field_names() {
        let response = ApiResponse::failure("https://app.test/", "x", 1.5);
        let json = serde_json::to_value(&response).expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "error": "x", "status": 0, "statusText": "", "url": "https://app.test/",
                "headers": [], "body": "", "bodyEncoding": "text", "size": 0,
                "truncated": false, "durationMs": 1.5
            }),
            "camelCase fields"
        );
        let request: ApiRequest = serde_json::from_value(serde_json::json!({
            "method": "GET", "url": "https://app.test", "headers": [], "body": null, "timeoutMs": 5
        }))
        .expect("deserializes");
        assert_eq!(request.timeout_ms, Some(5), "timeoutMs");
    }

    #[test]
    fn schema_checks_method_url_and_timeout() {
        let request = |method: &str, timeout_ms| ApiRequest {
            method: method.to_owned(),
            url: "https://app.test".to_owned(),
            headers: Vec::new(),
            body: None,
            timeout_ms,
        };
        assert!(schema_error(&request("get", None)).is_none(), "letters ok");
        assert!(schema_error(&request("", None)).is_some(), "empty method");
        assert!(schema_error(&request("GE T", None)).is_some(), "space");
        assert!(
            schema_error(&request("GET", Some(0))).is_some(),
            "zero timeout"
        );
        assert!(
            schema_error(&request("GET", Some(600_001))).is_some(),
            "long timeout"
        );
    }
}
