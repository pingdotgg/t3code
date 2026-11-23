//! Device hub ticket minting and authenticated URL/header builders.
//!
//! Mirrors Conn's `resolveDeviceHubAccess` and `withDeviceHubQuery`:
//! `POST /api/auth/websocket-ticket/media` with `Authorization: Bearer <token>` mints a
//! short-lived media ticket passed as `wsTicket` (alongside optional `hostId`) on HTTP, SSE,
//! and WebSocket requests under `/api/device-hub/vendor/{serve-sim,serve-emu}`.

pub mod input;
pub mod mjpeg;
pub mod sse;
pub mod video;

use std::fmt;
use std::time::Duration;

use conn_contract::DevicePlatform;
use serde::Deserialize;
use url::Url;

pub use self::input::{
    DeviceInputCommand, DeviceInputEvent, DeviceScreenConfig, HardwareButton, IOS_MSG_BUTTON,
    IOS_MSG_HINGE, IOS_MSG_KEY, IOS_MSG_ORIENTATION, IOS_MSG_TOUCH, IOS_TAG_CONTROL_REPLY,
    IOS_TAG_INPUT_ADMITTED, IOS_TAG_SCREEN_CONFIG, InputWsError, IosServerPacket, KeyPhase,
    TouchPhase, android_keycode_for_key, chunk_android_text, decode_ios_server_packet,
    device_input_ws_url, encode_android_command, encode_ios_button, encode_ios_hinge,
    encode_ios_key, encode_ios_orientation, encode_ios_touch, encode_tagged_json,
    hid_usage_for_key, prime_ios_helper, raw_ios_point, run_device_input_ws,
};
pub use self::mjpeg::{MjpegParser, MjpegStreamError, mjpeg_stream_url, stream_mjpeg_frames};
pub use self::sse::{
    DEVICE_EVENT_LOG_LIMIT, DeviceEventLogEntry, DeviceForegroundInfo, DeviceHubHttpError,
    SseEvent, SseParser, append_device_event_log, capture_device_screenshot,
    stream_device_event_log, stream_device_foreground,
};
pub use self::video::{
    AvccChunk, AvccConfig, AvccDemuxer, AvccStreamError, ParsedAnnexBAccessUnit, SEMU_FLAG_KEY,
    SEMU_HEADER_BYTES, SEMU_MAGIC, SemuPacket, annex_b_to_avcc, avcc_stream_url,
    normalize_avcc_to_4byte_lengths, parse_avcc_record, parse_semu_packet, split_annex_b_nals,
    stream_avcc_chunks,
};

use crate::ClientError;

/// Default device hub proxy prefix on the server (`DEVICE_HUB_ROUTE_PREFIX`).
pub const DEFAULT_DEVICE_HUB_BASE_PATH: &str = "/api/device-hub";

/// Timeout for minting a media ticket (`TICKET_TIMEOUT_MS` in Conn's `deviceHubAccess.ts`).
const TICKET_TIMEOUT: Duration = Duration::from_secs(8);

/// Which upstream device hub vendor serves a device's stream and control endpoints.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeviceHubVendor {
    /// iOS simulators (and Simlock hosts on either platform): `/vendor/serve-sim`.
    ServeSim,
    /// Android emulators: `/vendor/serve-emu`.
    ServeEmu,
}

impl DeviceHubVendor {
    /// Resolves the vendor proxy prefix for `platform` and whether the host is `serve-sim`-only
    /// (Simlock).
    #[must_use]
    pub const fn for_device(platform: DevicePlatform, serve_sim_only: bool) -> Self {
        if serve_sim_only || matches!(platform, DevicePlatform::Ios) {
            Self::ServeSim
        } else {
            Self::ServeEmu
        }
    }

    /// Proxy path segment under the device hub base path.
    #[must_use]
    pub const fn path_prefix(self) -> &'static str {
        match self {
            Self::ServeSim => "/vendor/serve-sim",
            Self::ServeEmu => "/vendor/serve-emu",
        }
    }
}

/// Authenticated access handle for a server's device hub proxy.
///
/// Carries the HTTP and WebSocket base URLs, the minted short-lived media ticket (`wsTicket`),
/// optional `hostId` query parameter, and optional bearer header for direct HTTP/SSE requests.
#[derive(Clone)]
pub struct DeviceHubAccess {
    http_base: Url,
    ws_base: Url,
    ticket: String,
    expires_at: Option<String>,
    host_id: Option<String>,
    bearer_token: Option<String>,
}

impl fmt::Debug for DeviceHubAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceHubAccess")
            .field("http_base", &self.http_base.as_str())
            .field("ws_base", &self.ws_base.as_str())
            .field("ticket", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("host_id", &self.host_id)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl DeviceHubAccess {
    /// Builds a [`DeviceHubAccess`] from an already-minted ticket and server HTTP base URL.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::InvalidUrl`] or [`ClientError::Connection`] if `http_base_url` has
    /// an unsupported scheme or cannot form valid HTTP/WebSocket hub URLs, or [`ClientError::Auth`]
    /// if `ticket` is empty.
    pub fn from_ticket(
        http_base_url: &Url,
        hub_base_path: &str,
        ticket: String,
        expires_at: Option<String>,
        host_id: Option<String>,
        bearer_token: Option<String>,
    ) -> Result<Self, ClientError> {
        if ticket.trim().is_empty() {
            return Err(ClientError::Auth(
                "server returned empty media ticket".to_owned(),
            ));
        }

        let http_base = build_hub_http_base(http_base_url, hub_base_path)?;
        let ws_base = to_ws_url(&http_base)?;

        Ok(Self {
            http_base,
            ws_base,
            ticket,
            expires_at,
            host_id: host_id.filter(|id| !id.trim().is_empty()),
            bearer_token: bearer_token.filter(|t| !t.trim().is_empty()),
        })
    }

    /// HTTP(S) base URL of the device hub proxy (no trailing slash).
    #[must_use]
    pub fn http_base(&self) -> &Url {
        &self.http_base
    }

    /// WS(S) base URL of the device hub proxy (no trailing slash).
    #[must_use]
    pub fn ws_base(&self) -> &Url {
        &self.ws_base
    }

    /// Short-lived media ticket (`wsTicket`).
    #[must_use]
    pub fn ticket(&self) -> &str {
        &self.ticket
    }

    /// ISO-8601 expiry timestamp reported by the server, if any.
    #[must_use]
    pub fn expires_at(&self) -> Option<&str> {
        self.expires_at.as_deref()
    }

    /// Target host ID (`hostId` query param), if scoped to a specific device host.
    #[must_use]
    pub fn host_id(&self) -> Option<&str> {
        self.host_id.as_deref()
    }

    /// Returns a clone scoped to `host_id` (matching Conn's `useDeviceHubAccess`).
    #[must_use]
    pub fn with_host_id(&self, host_id: impl Into<String>) -> Self {
        let host_id = host_id.into();
        let mut next = self.clone();
        next.host_id = (!host_id.trim().is_empty()).then_some(host_id);
        next
    }

    /// Query parameters attached to every device hub HTTP, SSE, and WebSocket request.
    #[must_use]
    pub fn query_params(&self) -> Vec<(&'static str, &str)> {
        let mut params = Vec::with_capacity(2);
        params.push(("wsTicket", self.ticket.as_str()));
        if let Some(host_id) = self.host_id.as_deref() {
            params.push(("hostId", host_id));
        }
        params
    }

    /// Headers suitable for authenticated HTTP and SSE requests to the device hub proxy.
    #[must_use]
    pub fn http_headers(&self) -> Vec<(&'static str, String)> {
        let mut headers = Vec::with_capacity(2);
        headers.push(("cache-control", "no-store".to_owned()));
        if let Some(bearer) = self.bearer_token.as_deref() {
            headers.push(("authorization", format!("Bearer {bearer}")));
        }
        headers
    }

    /// Builds an authenticated HTTP(S) URL for `path` relative to [`Self::http_base`].
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::InvalidUrl`] if the combined URL cannot be parsed.
    pub fn http_url(&self, path: &str, extra_query: &[(&str, &str)]) -> Result<Url, ClientError> {
        append_hub_path_and_query(&self.http_base, path, extra_query, &self.query_params())
    }

    /// Builds an authenticated WS(S) URL for `path` relative to [`Self::ws_base`].
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::InvalidUrl`] if the combined URL cannot be parsed.
    pub fn ws_url(&self, path: &str, extra_query: &[(&str, &str)]) -> Result<Url, ClientError> {
        append_hub_path_and_query(&self.ws_base, path, extra_query, &self.query_params())
    }

    /// Builds an authenticated HTTP(S) URL under `vendor` (`/vendor/serve-sim` or `/vendor/serve-emu`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::InvalidUrl`] if the combined URL cannot be parsed.
    pub fn vendor_http_url(
        &self,
        vendor: DeviceHubVendor,
        path: &str,
        extra_query: &[(&str, &str)],
    ) -> Result<Url, ClientError> {
        let full_path = join_vendor_path(vendor, path);
        self.http_url(&full_path, extra_query)
    }

    /// Builds an authenticated WS(S) URL under `vendor` (`/vendor/serve-sim` or `/vendor/serve-emu`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::InvalidUrl`] if the combined URL cannot be parsed.
    pub fn vendor_ws_url(
        &self,
        vendor: DeviceHubVendor,
        path: &str,
        extra_query: &[(&str, &str)],
    ) -> Result<Url, ClientError> {
        let full_path = join_vendor_path(vendor, path);
        self.ws_url(&full_path, extra_query)
    }

    /// Percent-encodes a single URL path segment (matching JS `encodeURIComponent` for path use).
    #[must_use]
    pub fn encode_path_segment(segment: &str) -> String {
        let mut out = String::with_capacity(segment.len());
        for byte in segment.bytes() {
            let unreserved = byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
                );
            if unreserved {
                out.push(char::from(byte));
            } else {
                use std::fmt::Write as _;
                let _ = write!(out, "%{byte:02X}");
            }
        }
        out
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    #[serde(default)]
    expires_at: Option<String>,
}

/// Mints a short-lived `media` WebSocket/HTTP ticket via
/// `POST /api/auth/websocket-ticket/media` using `bearer_token` and returns a
/// [`DeviceHubAccess`] configured for `hub_base_path` and optional `host_id`.
///
/// # Errors
///
/// Returns [`ClientError::Auth`] if the server rejects the bearer token (HTTP 401/403) or returns
/// an empty ticket, [`ClientError::InvalidUrl`] if URL construction fails, [`ClientError::Codec`]
/// if the JSON response cannot be parsed, or [`ClientError::Connection`] for network or non-auth
/// HTTP errors.
pub async fn mint_device_hub_access(
    http: &reqwest::Client,
    http_base_url: &Url,
    bearer_token: &str,
    hub_base_path: &str,
    host_id: Option<&str>,
) -> Result<DeviceHubAccess, ClientError> {
    if bearer_token.trim().is_empty() {
        return Err(ClientError::Auth(
            "cannot mint device hub ticket without a bearer token".to_owned(),
        ));
    }

    let ticket_url = http_base_url.join("api/auth/websocket-ticket/media")?;
    let response = http
        .post(ticket_url)
        .timeout(TICKET_TIMEOUT)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {bearer_token}"),
        )
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|err| ClientError::Connection(format!("device hub ticket request: {err}")))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        let body = response.text().await.unwrap_or_default();
        let msg = if body.is_empty() {
            format!("device hub ticket unauthorized (HTTP {status})")
        } else {
            format!("device hub ticket unauthorized (HTTP {status}): {body}")
        };
        return Err(ClientError::Auth(msg));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let msg = if body.is_empty() {
            format!("device hub ticket failed with HTTP {status}")
        } else {
            format!("device hub ticket failed with HTTP {status}: {body}")
        };
        return Err(ClientError::Connection(msg));
    }

    let body = response.text().await.map_err(|err| {
        ClientError::Connection(format!("device hub ticket response body: {err}"))
    })?;
    let parsed: TicketResponse = serde_json::from_str(&body)?;

    DeviceHubAccess::from_ticket(
        http_base_url,
        hub_base_path,
        parsed.ticket,
        parsed.expires_at,
        host_id.map(str::to_owned),
        Some(bearer_token.to_owned()),
    )
}

fn build_hub_http_base(http_base_url: &Url, hub_base_path: &str) -> Result<Url, ClientError> {
    let raw_path = if hub_base_path.trim().is_empty() {
        DEFAULT_DEVICE_HUB_BASE_PATH
    } else {
        hub_base_path.trim()
    };
    let normalized = raw_path.trim_end_matches('/');
    let rel = normalized.trim_start_matches('/');
    let mut url = if rel.is_empty() {
        http_base_url.clone()
    } else {
        http_base_url.join(rel)?
    };
    url.set_query(None);
    url.set_fragment(None);
    let trimmed_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&trimmed_path);
    Ok(url)
}

fn to_ws_url(http_url: &Url) -> Result<Url, ClientError> {
    let mut ws_url = http_url.clone();
    let scheme = match ws_url.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => {
            return Err(ClientError::Connection(format!(
                "unsupported device hub url scheme: {other}"
            )));
        }
    };
    ws_url
        .set_scheme(scheme)
        .map_err(|()| ClientError::Connection(format!("failed to set scheme {scheme}")))?;
    Ok(ws_url)
}

fn join_vendor_path(vendor: DeviceHubVendor, path: &str) -> String {
    let suffix = path.trim_start_matches('/');
    if suffix.is_empty() {
        vendor.path_prefix().to_owned()
    } else {
        format!("{}/{suffix}", vendor.path_prefix())
    }
}

fn append_hub_path_and_query(
    base: &Url,
    path: &str,
    extra_query: &[(&str, &str)],
    auth_query: &[(&str, &str)],
) -> Result<Url, ClientError> {
    let mut url = base.clone();
    let (raw_path, inline_query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    let base_path = url.path().trim_end_matches('/');
    let suffix = raw_path.trim_start_matches('/');
    let combined_path = if suffix.is_empty() {
        base_path.to_owned()
    } else {
        format!("{base_path}/{suffix}")
    };
    url.set_path(&combined_path);

    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        if let Some(raw_q) = inline_query {
            for (k, v) in url::form_urlencoded::parse(raw_q.as_bytes()) {
                pairs.append_pair(&k, &v);
            }
        }
        for &(k, v) in extra_query {
            pairs.append_pair(k, v);
        }
        for &(k, v) in auth_query {
            pairs.append_pair(k, v);
        }
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::{Connection, Credential, ServerConfig};

    async fn spawn_fake_ticket_server(
        status_line: &'static str,
        body: &'static str,
    ) -> Result<(Url, tokio::sync::oneshot::Receiver<String>), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (req_tx, req_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let request_text = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = req_tx.send(request_text);

            let response = format!(
                "{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        Ok((Url::parse(&format!("http://{addr}"))?, req_rx))
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn mints_media_ticket_and_builds_authenticated_urls()
    -> Result<(), Box<dyn std::error::Error>> {
        let (base_url, req_rx) = spawn_fake_ticket_server(
            "HTTP/1.1 200 OK",
            r#"{"ticket":"media-ticket-123","expiresAt":"2026-11-21T12:15:00.000Z"}"#,
        )
        .await?;

        let http = reqwest::Client::new();
        let access = mint_device_hub_access(
            &http,
            &base_url,
            "my-bearer-token",
            DEFAULT_DEVICE_HUB_BASE_PATH,
            Some("ssh-mac"),
        )
        .await?;

        let raw_req = tokio::time::timeout(Duration::from_secs(2), req_rx).await??;
        assert!(
            raw_req.starts_with("POST /api/auth/websocket-ticket/media HTTP/1.1\r\n"),
            "must POST to /api/auth/websocket-ticket/media, got: {raw_req}"
        );
        assert!(
            raw_req
                .to_ascii_lowercase()
                .contains("authorization: bearer my-bearer-token\r\n"),
            "must send Authorization Bearer header, got: {raw_req}"
        );

        assert_eq!(
            access.http_base().as_str(),
            format!("{}api/device-hub", base_url),
            "http_base must resolve hub_base_path without trailing slash"
        );
        assert_eq!(
            access.ws_base().scheme(),
            "ws",
            "http base must map to ws scheme"
        );
        assert_eq!(
            access.ticket(),
            "media-ticket-123",
            "must keep minted ticket"
        );
        assert_eq!(
            access.expires_at(),
            Some("2026-11-21T12:15:00.000Z"),
            "must keep expiresAt"
        );
        assert_eq!(access.host_id(), Some("ssh-mac"), "must keep host_id");

        let debug_str = format!("{access:?}");
        assert!(
            !debug_str.contains("media-ticket-123") && !debug_str.contains("my-bearer-token"),
            "Debug impl must redact ticket and bearer token: {debug_str}"
        );

        let mjpeg = access.vendor_http_url(
            DeviceHubVendor::ServeSim,
            &format!(
                "/helper/{}/stream.mjpeg",
                DeviceHubAccess::encode_path_segment("device id/1")
            ),
            &[],
        )?;
        assert_eq!(
            mjpeg.path(),
            "/api/device-hub/vendor/serve-sim/helper/device%20id%2F1/stream.mjpeg",
            "encoded device id must use %20/%2F in path segment"
        );
        assert_eq!(
            mjpeg.query(),
            Some("wsTicket=media-ticket-123&hostId=ssh-mac"),
            "HTTP URL must attach wsTicket and hostId query params"
        );

        let ios_ws = access.vendor_ws_url(
            DeviceHubVendor::ServeSim,
            "/helper/ws",
            &[("device", "UDID-1")],
        )?;
        assert_eq!(ios_ws.scheme(), "ws", "WS URL must use ws scheme");
        assert_eq!(
            ios_ws.path(),
            "/api/device-hub/vendor/serve-sim/helper/ws",
            "WS path must match Conn"
        );
        assert_eq!(
            ios_ws.query(),
            Some("device=UDID-1&wsTicket=media-ticket-123&hostId=ssh-mac"),
            "WS URL must preserve device param and append auth params"
        );

        let sse = access.vendor_http_url(
            DeviceHubVendor::ServeSim,
            "/api/event-log/events",
            &[("device", "UDID-1"), ("limit", "100")],
        )?;
        assert_eq!(
            sse.query(),
            Some("device=UDID-1&limit=100&wsTicket=media-ticket-123&hostId=ssh-mac"),
            "SSE URL must include extra query and auth query"
        );

        let headers = access.http_headers();
        assert!(
            headers
                .iter()
                .any(|(k, v)| *k == "authorization" && v == "Bearer my-bearer-token"),
            "http_headers must include Bearer authorization"
        );
        assert!(
            headers
                .iter()
                .any(|(k, v)| *k == "cache-control" && v == "no-store"),
            "http_headers must include cache-control: no-store"
        );

        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn handles_unauthorized_server_error_and_empty_ticket()
    -> Result<(), Box<dyn std::error::Error>> {
        let http = reqwest::Client::new();

        let (unauth_url, _rx) =
            spawn_fake_ticket_server("HTTP/1.1 401 Unauthorized", r#"{"error":"invalid"}"#).await?;
        let err = mint_device_hub_access(&http, &unauth_url, "bad-token", "/api/device-hub", None)
            .await
            .err();
        assert!(
            matches!(err, Some(ClientError::Auth(_))),
            "401 must map to ClientError::Auth, got {err:?}"
        );

        let (fail_url, _rx) =
            spawn_fake_ticket_server("HTTP/1.1 500 Internal Server Error", "boom").await?;
        let err = mint_device_hub_access(&http, &fail_url, "token", "/api/device-hub", None)
            .await
            .err();
        assert!(
            matches!(err, Some(ClientError::Connection(_))),
            "500 must map to ClientError::Connection, got {err:?}"
        );

        let (empty_url, _rx) =
            spawn_fake_ticket_server("HTTP/1.1 200 OK", r#"{"ticket":"   "}"#).await?;
        let err = mint_device_hub_access(&http, &empty_url, "token", "/api/device-hub", None)
            .await
            .err();
        assert!(
            matches!(err, Some(ClientError::Auth(_))),
            "empty ticket must map to ClientError::Auth, got {err:?}"
        );

        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn connection_mints_device_hub_access_from_its_config()
    -> Result<(), Box<dyn std::error::Error>> {
        let (base_url, _rx) =
            spawn_fake_ticket_server("HTTP/1.1 200 OK", r#"{"ticket":"conn-ticket-42"}"#).await?;

        let (conn, _events) = Connection::start(
            ServerConfig {
                http_base_url: base_url,
                credential: Credential::Bearer("conn-bearer".to_owned()),
            },
            &tokio::runtime::Handle::current(),
        );

        let access = conn
            .mint_device_hub_access(DEFAULT_DEVICE_HUB_BASE_PATH, Some("local"))
            .await?;
        assert_eq!(
            access.ticket(),
            "conn-ticket-42",
            "Connection::mint_device_hub_access must return server ticket"
        );
        assert_eq!(
            access.host_id(),
            Some("local"),
            "Connection::mint_device_hub_access must preserve host_id"
        );

        conn.close();
        Ok(())
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn maps_https_to_wss_and_selects_vendor() -> Result<(), Box<dyn std::error::Error>> {
        let https = Url::parse("https://conn.example.com/env/")?;
        let access = DeviceHubAccess::from_ticket(
            &https,
            "/api/device-hub",
            "tok".to_owned(),
            None,
            None,
            None,
        )?;
        assert_eq!(
            access.http_base().as_str(),
            "https://conn.example.com/env/api/device-hub",
            "https base with subpath must preserve prefix"
        );
        assert_eq!(
            access.ws_base().as_str(),
            "wss://conn.example.com/env/api/device-hub",
            "https must map to wss"
        );
        assert_eq!(
            DeviceHubVendor::for_device(DevicePlatform::Ios, false),
            DeviceHubVendor::ServeSim,
            "iOS must use ServeSim"
        );
        assert_eq!(
            DeviceHubVendor::for_device(DevicePlatform::Android, false),
            DeviceHubVendor::ServeEmu,
            "Android must use ServeEmu"
        );
        assert_eq!(
            DeviceHubVendor::for_device(DevicePlatform::Android, true),
            DeviceHubVendor::ServeSim,
            "Simlock Android must use ServeSim"
        );
        let scoped = access.with_host_id("host-2");
        assert_eq!(
            scoped.host_id(),
            Some("host-2"),
            "with_host_id must override host_id"
        );
        Ok(())
    }
}
