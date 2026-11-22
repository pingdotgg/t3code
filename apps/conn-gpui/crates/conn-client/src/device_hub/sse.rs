//! Device hub HTTP & SSE endpoints: screenshots, foreground app SSE, and event log SSE.
//!
//! Mirrors Conn's `device/screenshot.ts` and `components/device/deviceHubApi.ts`.

use std::time::Duration;

use conn_contract::DevicePlatform;
use serde_json::Value;
use thiserror::Error;

use crate::ClientError;
use crate::device_hub::{DeviceHubAccess, DeviceHubVendor};

/// Maximum number of retained device event log entries (`DEVICE_EVENT_LOG_LIMIT` in Conn).
pub const DEVICE_EVENT_LOG_LIMIT: usize = 100;

/// Timeout for `POST /api/screenshot` (`screenshot.ts`).
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(20);

/// Foreground app update delivered over `/vendor/serve-sim/appstate` SSE.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceForegroundInfo {
    pub id: String,
    pub label: Option<String>,
    pub pid: Option<i64>,
    pub is_react_native: Option<bool>,
}

/// One event log row delivered over `/vendor/serve-sim/api/event-log/events` SSE.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceEventLogEntry {
    pub id: i64,
    pub timestamp: String,
    pub kind: String,
    pub summary: String,
}

/// Errors returned by device hub HTTP and SSE endpoints.
#[derive(Debug, Error)]
pub enum DeviceHubHttpError {
    #[error("invalid device hub url: {0}")]
    InvalidUrl(#[from] ClientError),
    #[error("device hub request unauthorized")]
    Unauthorized,
    #[error("device hub request failed with HTTP {0}")]
    HttpStatus(u16),
    #[error("the device returned an empty screenshot")]
    EmptyResponse,
    #[error("device hub network error: {0}")]
    Network(String),
}

/// Parsed W3C Server-Sent Event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Incremental W3C Server-Sent Events parser.
#[derive(Debug, Default)]
pub struct SseParser {
    line_buf: Vec<u8>,
    event_name: Option<String>,
    data_lines: Vec<String>,
}

impl SseParser {
    /// Creates an empty SSE parser.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds raw HTTP response bytes and returns every complete [`SseEvent`] dispatched so far.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                let line_bytes = if self.line_buf.last() == Some(&b'\r') {
                    &self.line_buf[..self.line_buf.len() - 1]
                } else {
                    &self.line_buf[..]
                };
                let line = String::from_utf8_lossy(line_bytes).into_owned();
                self.line_buf.clear();
                if let Some(ev) = self.process_line(&line) {
                    events.push(ev);
                }
            } else {
                self.line_buf.push(byte);
            }
        }
        events
    }

    fn process_line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            if self.data_lines.is_empty() {
                self.event_name = None;
                return None;
            }
            let event = self
                .event_name
                .take()
                .unwrap_or_else(|| "message".to_owned());
            let data = self.data_lines.join("\n");
            self.data_lines.clear();
            return Some(SseEvent { event, data });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, raw_value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => {
                self.event_name = Some(raw_value.to_owned());
            }
            "data" => {
                self.data_lines.push(raw_value.to_owned());
            }
            _ => {}
        }
        None
    }
}

/// Merges an incoming event log batch into `current`, capping to [`DEVICE_EVENT_LOG_LIMIT`]
/// newest entries (`appendDeviceEventLog` in Conn's `deviceHubApi.ts`).
pub fn append_device_event_log(
    current: &mut Vec<DeviceEventLogEntry>,
    incoming: Vec<DeviceEventLogEntry>,
    reset: bool,
) {
    if reset {
        *current = incoming;
    } else {
        current.extend(incoming);
    }
    if current.len() > DEVICE_EVENT_LOG_LIMIT {
        let drop_count = current.len() - DEVICE_EVENT_LOG_LIMIT;
        current.drain(..drop_count);
    }
}

/// Captures a PNG screenshot from the device hub (`POST /vendor/{serve-sim|serve-emu}/api/screenshot`).
///
/// # Errors
///
/// Returns [`DeviceHubHttpError::Unauthorized`] on HTTP 401/403,
/// [`DeviceHubHttpError::HttpStatus`] on other non-2xx status codes,
/// [`DeviceHubHttpError::EmptyResponse`] if the body is empty, or
/// [`DeviceHubHttpError::Network`] on transport failures.
pub async fn capture_device_screenshot(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    platform: DevicePlatform,
    device_id: &str,
) -> Result<Vec<u8>, DeviceHubHttpError> {
    let vendor = DeviceHubVendor::for_device(platform, false);
    let url = access.vendor_http_url(vendor, "/api/screenshot", &[("device", device_id)])?;
    let mut request = http.post(url).timeout(SCREENSHOT_TIMEOUT);
    for (name, value) in access.http_headers() {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|err| DeviceHubHttpError::Network(err.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(DeviceHubHttpError::Unauthorized);
    }
    if !status.is_success() {
        return Err(DeviceHubHttpError::HttpStatus(status.as_u16()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| DeviceHubHttpError::Network(err.to_string()))?;
    if bytes.is_empty() {
        return Err(DeviceHubHttpError::EmptyResponse);
    }
    Ok(bytes.to_vec())
}

/// Subscribes to iOS foreground app SSE updates (`GET /vendor/serve-sim/appstate?device=...`).
///
/// Invokes `on_change` for each valid `message` event until the stream ends or `on_change` returns
/// `false`.
///
/// # Errors
///
/// Returns [`DeviceHubHttpError::Unauthorized`] on HTTP 401/403,
/// [`DeviceHubHttpError::HttpStatus`] on non-2xx responses, or [`DeviceHubHttpError::Network`] on
/// transport errors.
pub async fn stream_device_foreground<F>(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    device_id: &str,
    mut on_change: F,
) -> Result<(), DeviceHubHttpError>
where
    F: FnMut(Option<DeviceForegroundInfo>) -> bool,
{
    let url = access.vendor_http_url(
        DeviceHubVendor::ServeSim,
        "/appstate",
        &[("device", device_id)],
    )?;
    stream_sse(http, access, url, |event| {
        if event.event != "message" {
            return true;
        }
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            return true;
        };
        if let Some(parsed) = parse_foreground_payload(&value) {
            return on_change(parsed);
        }
        true
    })
    .await
}

/// Subscribes to iOS device event log SSE updates
/// (`GET /vendor/serve-sim/api/event-log/events?device=...&limit=100`).
///
/// Invokes `on_events(entries, reset)` for each batch/entry until the stream ends or `on_events`
/// returns `false`.
///
/// # Errors
///
/// Returns [`DeviceHubHttpError::Unauthorized`] on HTTP 401/403,
/// [`DeviceHubHttpError::HttpStatus`] on non-2xx responses, or [`DeviceHubHttpError::Network`] on
/// transport errors.
pub async fn stream_device_event_log<F>(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    device_id: &str,
    mut on_events: F,
) -> Result<(), DeviceHubHttpError>
where
    F: FnMut(Vec<DeviceEventLogEntry>, bool) -> bool,
{
    let limit = DEVICE_EVENT_LOG_LIMIT.to_string();
    let url = access.vendor_http_url(
        DeviceHubVendor::ServeSim,
        "/api/event-log/events",
        &[("device", device_id), ("limit", &limit)],
    )?;
    stream_sse(http, access, url, |event| {
        if event.event != "message" {
            return true;
        }
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
            return true;
        };
        if let Some((entries, reset)) = parse_event_log_payload(&value) {
            return on_events(entries, reset);
        }
        true
    })
    .await
}

async fn stream_sse<F>(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    url: url::Url,
    mut on_event: F,
) -> Result<(), DeviceHubHttpError>
where
    F: FnMut(SseEvent) -> bool,
{
    let mut request = http
        .get(url)
        .header(reqwest::header::ACCEPT, "text/event-stream");
    for (name, value) in access.http_headers() {
        request = request.header(name, value);
    }
    let mut response = request
        .send()
        .await
        .map_err(|err| DeviceHubHttpError::Network(err.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(DeviceHubHttpError::Unauthorized);
    }
    if !status.is_success() {
        return Err(DeviceHubHttpError::HttpStatus(status.as_u16()));
    }

    let mut parser = SseParser::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| DeviceHubHttpError::Network(err.to_string()))?
    {
        for event in parser.push(&chunk) {
            if !on_event(event) {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Parses a foreground app SSE payload (`subscribeDeviceForeground` in `deviceHubApi.ts`).
/// Returns `Some(None)` when `bundleId` is explicitly `null` or `""` (home screen).
#[must_use]
fn parse_foreground_payload(value: &Value) -> Option<Option<DeviceForegroundInfo>> {
    let obj = value.as_object()?;
    let bundle = obj.get("bundleId")?;
    if bundle.is_null() {
        return Some(None);
    }
    let id = bundle.as_str()?;
    if id.is_empty() {
        return Some(None);
    }
    Some(Some(DeviceForegroundInfo {
        id: id.to_owned(),
        label: obj.get("label").and_then(Value::as_str).map(str::to_owned),
        pid: obj.get("pid").and_then(Value::as_i64),
        is_react_native: obj.get("isReactNative").and_then(Value::as_bool),
    }))
}

fn parse_event_log_entry(raw: &Value) -> Option<DeviceEventLogEntry> {
    let obj = raw.as_object()?;
    let id = obj.get("id")?.as_i64()?;
    let timestamp = obj
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let summary = obj
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| obj.get("msg").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned();
    Some(DeviceEventLogEntry {
        id,
        timestamp,
        kind,
        summary,
    })
}

fn parse_event_log_payload(value: &Value) -> Option<(Vec<DeviceEventLogEntry>, bool)> {
    let obj = value.as_object()?;
    if let Some(arr) = obj.get("events").and_then(Value::as_array) {
        let entries = arr.iter().filter_map(parse_event_log_entry).collect();
        return Some((entries, true));
    }
    let entry = parse_event_log_entry(obj.get("event")?)?;
    Some((vec![entry], false))
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    use super::*;

    #[test]
    fn parses_sse_events_across_arbitrary_splits() {
        let mut parser = SseParser::new();
        let raw =
            b": keepalive\r\ndata: {\"a\":1}\r\n\r\nevent: custom\ndata: line1\ndata: line2\n\n";
        let mut got = Vec::new();
        for chunk in raw.chunks(5) {
            got.extend(parser.push(chunk));
        }
        assert_eq!(
            got,
            vec![
                SseEvent {
                    event: "message".to_owned(),
                    data: "{\"a\":1}".to_owned(),
                },
                SseEvent {
                    event: "custom".to_owned(),
                    data: "line1\nline2".to_owned(),
                },
            ],
            "SSE parser must ignore comments and join multiline data"
        );
    }

    #[test]
    fn append_device_event_log_resets_and_caps_at_limit() {
        let mut log = Vec::new();
        let batch: Vec<DeviceEventLogEntry> = (0..120)
            .map(|id| DeviceEventLogEntry {
                id,
                timestamp: "2026-11-21T12:00:00Z".to_owned(),
                kind: "log".to_owned(),
                summary: format!("msg {id}"),
            })
            .collect();
        append_device_event_log(&mut log, batch, true);
        assert_eq!(
            log.len(),
            DEVICE_EVENT_LOG_LIMIT,
            "event log must cap at 100 entries"
        );
        assert_eq!(log[0].id, 20, "oldest entries must be trimmed");
        assert_eq!(log[99].id, 119, "newest entry must be retained");
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn captures_screenshot_from_fake_server() -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let body = png_bytes.clone();
        let (req_tx, req_rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let _ = req_tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-shot".to_owned(),
            None,
            Some("local".to_owned()),
            None,
        )?;

        let got = capture_device_screenshot(
            &reqwest::Client::new(),
            &access,
            DevicePlatform::Ios,
            "UDID-7",
        )
        .await?;
        assert_eq!(got, png_bytes, "must return PNG bytes from hub");
        let raw_req = req_rx.await?;
        assert!(
            raw_req.starts_with(
                "POST /api/device-hub/vendor/serve-sim/api/screenshot?device=UDID-7&wsTicket=t-shot&hostId=local HTTP/1.1\r\n"
            ),
            "must POST to serve-sim screenshot route, got: {raw_req}"
        );
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn streams_event_log_and_foreground_sse_from_fake_server()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let sse_body = if req.contains("/appstate") {
                    concat!(
                        "data: {\"bundleId\":\"com.example.demo\",\"pid\":42,\"isReactNative\":true}\n\n",
                        "data: {\"bundleId\":null}\n\n"
                    )
                } else {
                    concat!(
                        "data: {\"events\":[{\"id\":1,\"timestamp\":\"2026-11-21T12:01:02Z\",\"kind\":\"hid\",\"summary\":\"tap\"}]}\n\n",
                        "data: {\"event\":{\"id\":2,\"timestamp\":\"2026-11-21T12:01:03Z\",\"kind\":\"hid\",\"msg\":\"home\"}}\n\n"
                    )
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{sse_body}"
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-sse".to_owned(),
            None,
            None,
            None,
        )?;
        let http = reqwest::Client::new();

        let mut fg_updates = Vec::new();
        stream_device_foreground(&http, &access, "UDID-1", |app| {
            fg_updates.push(app);
            true
        })
        .await?;
        assert_eq!(
            fg_updates,
            vec![
                Some(DeviceForegroundInfo {
                    id: "com.example.demo".to_owned(),
                    label: None,
                    pid: Some(42),
                    is_react_native: Some(true),
                }),
                None,
            ],
            "foreground SSE must decode bundleId and null clearing"
        );

        let mut log = Vec::new();
        stream_device_event_log(&http, &access, "UDID-1", |entries, reset| {
            append_device_event_log(&mut log, entries, reset);
            true
        })
        .await?;
        assert_eq!(
            log.len(),
            2,
            "event log SSE must decode reset + incremental entry"
        );
        assert_eq!(log[0].summary, "tap", "first event summary");
        assert_eq!(log[1].summary, "home", "second event falls back to msg");
        Ok(())
    }
}
