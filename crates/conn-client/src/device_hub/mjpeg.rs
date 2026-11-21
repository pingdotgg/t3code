//! Incremental `multipart/x-mixed-replace` MJPEG stream parser and HTTP reader.
//!
//! Mirrors Conn's `serve-sim` MJPEG fallback (`/vendor/serve-sim/helper/{device}/stream.mjpeg`).

use thiserror::Error;
use url::Url;

use crate::ClientError;
use crate::device_hub::{DeviceHubAccess, DeviceHubVendor};

/// Maximum multipart header size (16 KiB, matching Conn's `mjpegStillFrame.ts`).
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Maximum single JPEG frame size (16 MiB, matching Conn's `mjpegStillFrame.ts`).
const MAX_PART_BYTES: usize = 16 * 1024 * 1024;

/// Errors returned while reading a device MJPEG stream.
#[derive(Debug, Error)]
pub enum MjpegStreamError {
    #[error("invalid mjpeg url: {0}")]
    InvalidUrl(#[from] ClientError),
    #[error("mjpeg stream unauthorized")]
    Unauthorized,
    #[error("device hub requires WebRTC streaming")]
    TransportLockedWebRtc,
    #[error("mjpeg stream returned HTTP {0}")]
    HttpStatus(u16),
    #[error("mjpeg stream network error: {0}")]
    Network(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParserState {
    SeekBoundary,
    ReadHeaders,
    ReadBodyFixed(usize),
    ReadBodyUntilBoundary,
}

/// Incremental `multipart/x-mixed-replace` parser that yields raw JPEG payloads.
///
/// Supports both `Content-Length`-framed parts (the fast path used by `serve-sim`) and
/// boundary-delimited parts without `Content-Length`, and tolerates arbitrary chunk splits.
#[derive(Debug)]
pub struct MjpegParser {
    delimiter: Option<Vec<u8>>,
    buf: Vec<u8>,
    state: ParserState,
}

impl MjpegParser {
    /// Creates a parser optionally initialized from the HTTP `Content-Type` header value.
    #[must_use]
    pub fn new(content_type: Option<&str>) -> Self {
        let delimiter = content_type
            .and_then(extract_boundary)
            .map(|b| format!("--{b}").into_bytes());
        Self {
            delimiter,
            buf: Vec::with_capacity(64 * 1024),
            state: ParserState::SeekBoundary,
        }
    }

    /// Feeds raw HTTP body bytes and returns every complete JPEG frame extracted so far.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        if !bytes.is_empty() {
            self.buf.extend_from_slice(bytes);
        }
        let mut frames = Vec::new();
        loop {
            match self.state {
                ParserState::SeekBoundary => {
                    if !self.step_seek_boundary() {
                        break;
                    }
                }
                ParserState::ReadHeaders => {
                    if !self.step_read_headers() {
                        break;
                    }
                }
                ParserState::ReadBodyFixed(length) => {
                    if self.buf.len() < length {
                        break;
                    }
                    let frame: Vec<u8> = self.buf.drain(..length).collect();
                    if !frame.is_empty() {
                        frames.push(frame);
                    }
                    self.state = ParserState::SeekBoundary;
                }
                ParserState::ReadBodyUntilBoundary => {
                    let Some(delim) = self.delimiter.as_deref() else {
                        self.buf.clear();
                        self.state = ParserState::SeekBoundary;
                        break;
                    };
                    if let Some(pos) = find_bytes(&self.buf, delim) {
                        let mut end = pos;
                        if end >= 2 && &self.buf[end - 2..end] == b"\r\n" {
                            end -= 2;
                        } else if end >= 1 && self.buf[end - 1] == b'\n' {
                            end -= 1;
                        }
                        if end > 0 {
                            frames.push(self.buf[..end].to_vec());
                        }
                        self.buf.drain(..pos);
                        self.state = ParserState::SeekBoundary;
                    } else {
                        if self.buf.len() > MAX_PART_BYTES {
                            self.buf.clear();
                            self.state = ParserState::SeekBoundary;
                        }
                        break;
                    }
                }
            }
        }
        frames
    }

    fn step_seek_boundary(&mut self) -> bool {
        if let Some(delim) = self.delimiter.clone() {
            let Some(pos) = find_bytes(&self.buf, &delim) else {
                // Keep enough trailing bytes to match a boundary split across chunks.
                let keep = delim.len().saturating_sub(1);
                if self.buf.len() > keep {
                    let drop_len = self.buf.len() - keep;
                    self.buf.drain(..drop_len);
                }
                return false;
            };
            let after_delim = pos + delim.len();
            // Need the rest of the boundary line to know whether it's closing (`--`) and skip EOL.
            let Some(rel_nl) = find_byte(&self.buf[after_delim..], b'\n') else {
                if pos > 0 {
                    self.buf.drain(..pos);
                }
                if self.buf.len() > MAX_HEADER_BYTES {
                    self.buf.clear();
                }
                return false;
            };
            let line_rest = &self.buf[after_delim..after_delim + rel_nl];
            let is_closing = line_rest.starts_with(b"--");
            self.buf.drain(..after_delim + rel_nl + 1);
            if is_closing {
                return true;
            }
            self.state = ParserState::ReadHeaders;
            return true;
        }

        // Auto-detect boundary from the first `--<token>\n` line.
        let Some(pos) = find_bytes(&self.buf, b"--") else {
            let keep = usize::from(!self.buf.is_empty());
            if self.buf.len() > keep {
                let drop_len = self.buf.len() - keep;
                self.buf.drain(..drop_len);
            }
            return false;
        };
        let Some(rel_nl) = find_byte(&self.buf[pos..], b'\n') else {
            if pos > 0 {
                self.buf.drain(..pos);
            }
            if self.buf.len() > MAX_HEADER_BYTES {
                self.buf.clear();
            }
            return false;
        };
        let mut line_end = pos + rel_nl;
        if line_end > pos && self.buf[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line = &self.buf[pos..line_end];
        if line.len() > 2 && !line.ends_with(b"--") {
            self.delimiter = Some(line.to_vec());
            self.buf.drain(..pos + rel_nl + 1);
            self.state = ParserState::ReadHeaders;
            true
        } else {
            self.buf.drain(..pos + rel_nl + 1);
            true
        }
    }

    fn step_read_headers(&mut self) -> bool {
        let header_sep = find_bytes(&self.buf, b"\r\n\r\n")
            .map(|p| (p, 4usize))
            .or_else(|| find_bytes(&self.buf, b"\n\n").map(|p| (p, 2usize)));

        let Some((header_end, sep_len)) = header_sep else {
            if self.buf.len() > MAX_HEADER_BYTES {
                self.buf.clear();
                self.state = ParserState::SeekBoundary;
            }
            return false;
        };

        let header_text = String::from_utf8_lossy(&self.buf[..header_end]);
        let content_length = parse_content_length(&header_text);
        self.buf.drain(..header_end + sep_len);

        match content_length {
            Some(0) => {
                self.state = ParserState::SeekBoundary;
            }
            Some(len) if len <= MAX_PART_BYTES => {
                self.state = ParserState::ReadBodyFixed(len);
            }
            Some(_) => {
                self.buf.clear();
                self.state = ParserState::SeekBoundary;
            }
            None => {
                self.state = ParserState::ReadBodyUntilBoundary;
            }
        }
        true
    }
}

/// Builds the authenticated MJPEG stream URL for a `serve-sim` device.
///
/// # Errors
///
/// Returns [`ClientError::InvalidUrl`] if URL construction fails.
pub fn mjpeg_stream_url(access: &DeviceHubAccess, device_id: &str) -> Result<Url, ClientError> {
    let encoded = DeviceHubAccess::encode_path_segment(device_id);
    access.vendor_http_url(
        DeviceHubVendor::ServeSim,
        &format!("/helper/{encoded}/stream.mjpeg"),
        &[],
    )
}

/// Opens the authenticated `multipart/x-mixed-replace` MJPEG stream for `device_id` and invokes
/// `on_frame` for each extracted JPEG frame until the stream ends or `on_frame` returns `false`.
///
/// # Errors
///
/// Returns [`MjpegStreamError::Unauthorized`] on HTTP 401/403,
/// [`MjpegStreamError::TransportLockedWebRtc`] on HTTP 409 (`stream_transport_locked`),
/// [`MjpegStreamError::HttpStatus`] on other non-2xx responses, or [`MjpegStreamError::Network`]
/// on transport errors.
pub async fn stream_mjpeg_frames<F>(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    device_id: &str,
    mut on_frame: F,
) -> Result<(), MjpegStreamError>
where
    F: FnMut(Vec<u8>) -> bool,
{
    let url = mjpeg_stream_url(access, device_id)?;
    let mut request = http.get(url);
    for (name, value) in access.http_headers() {
        request = request.header(name, value);
    }

    let mut response = request
        .send()
        .await
        .map_err(|err| MjpegStreamError::Network(err.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(MjpegStreamError::Unauthorized);
    }
    if status == reqwest::StatusCode::CONFLICT {
        return Err(MjpegStreamError::TransportLockedWebRtc);
    }
    if !status.is_success() {
        return Err(MjpegStreamError::HttpStatus(status.as_u16()));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut parser = MjpegParser::new(content_type.as_deref());

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| MjpegStreamError::Network(err.to_string()))?
    {
        for frame in parser.push(&chunk) {
            if !on_frame(frame) {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn extract_boundary(content_type: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        let trimmed = part.trim();
        let Some((key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("boundary") {
            let unquoted = raw_value.trim().trim_matches('"').trim_start_matches("--");
            if !unquoted.is_empty() {
                return Some(unquoted.to_owned());
            }
        }
    }
    None
}

fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length")
            && let Ok(len) = value.trim().parse::<usize>()
        {
            return Some(len);
        }
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn find_byte(haystack: &[u8], byte: u8) -> Option<usize> {
    haystack.iter().position(|&b| b == byte)
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn parses_content_length_parts_across_split_chunks() {
        let mut parser = MjpegParser::new(Some("multipart/x-mixed-replace; boundary=--frame"));
        let frame1 = vec![0xFF, 0xD8, 0x01, 0x02, 0xFF, 0xD9];
        let frame2 = vec![0xFF, 0xD8, 0xAA, 0xBB, 0xCC, 0xFF, 0xD9];
        let mut raw = Vec::new();
        raw.extend_from_slice(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n");
        raw.extend_from_slice(&frame1);
        raw.extend_from_slice(
            b"\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 7\r\n\r\n",
        );
        raw.extend_from_slice(&frame2);
        raw.extend_from_slice(b"\r\n");

        let mut got = Vec::new();
        for chunk in raw.chunks(5) {
            got.extend(parser.push(chunk));
        }
        assert_eq!(
            got,
            vec![frame1, frame2],
            "parser must extract both Content-Length frames across small chunk splits"
        );
    }

    #[test]
    fn parses_boundary_delimited_parts_without_content_length() {
        let mut parser = MjpegParser::new(Some(r#"multipart/x-mixed-replace; boundary="jpgpart""#));
        let frame1 = vec![0xFF, 0xD8, 0x10, 0x20, 0xFF, 0xD9];
        let frame2 = vec![0xFF, 0xD8, 0x30, 0x40, 0xFF, 0xD9];
        let mut raw = Vec::new();
        raw.extend_from_slice(b"preamble\r\n--jpgpart\r\nContent-Type: image/jpeg\r\n\r\n");
        raw.extend_from_slice(&frame1);
        raw.extend_from_slice(b"\r\n--jpgpart\r\nContent-Type: image/jpeg\r\n\r\n");
        raw.extend_from_slice(&frame2);
        raw.extend_from_slice(b"\r\n--jpgpart--\r\n");

        let mut got = Vec::new();
        for chunk in raw.chunks(7) {
            got.extend(parser.push(chunk));
        }
        assert_eq!(
            got,
            vec![frame1, frame2],
            "parser must extract boundary-delimited frames without Content-Length"
        );
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn streams_mjpeg_frames_from_fake_server() -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;

        let expected1 = vec![0xFF, 0xD8, 0x11, 0x22, 0xFF, 0xD9];
        let expected2 = vec![0xFF, 0xD8, 0x33, 0x44, 0x55, 0xFF, 0xD9];
        let f1 = expected1.clone();
        let f2 = expected2.clone();

        let (req_tx, req_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut req_buf = [0u8; 4096];
            let n = socket.read(&mut req_buf).await.unwrap_or(0);
            let _ = req_tx.send(String::from_utf8_lossy(&req_buf[..n]).into_owned());

            let header = "HTTP/1.1 200 OK\r\ncontent-type: multipart/x-mixed-replace; boundary=frame\r\nconnection: close\r\n\r\n";
            let _ = socket.write_all(header.as_bytes()).await;

            let p1 = format!(
                "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                f1.len()
            );
            let _ = socket.write_all(p1.as_bytes()).await;
            let _ = socket.write_all(&f1).await;
            let _ = socket.write_all(b"\r\n").await;

            let p2 = format!(
                "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                f2.len()
            );
            let _ = socket.write_all(p2.as_bytes()).await;
            let _ = socket.write_all(&f2).await;
            let _ = socket.write_all(b"\r\n").await;
            let _ = socket.shutdown().await;
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-mjpeg".to_owned(),
            None,
            Some("local".to_owned()),
            Some("bearer-1".to_owned()),
        )?;

        let http = reqwest::Client::new();
        let mut received = Vec::new();
        stream_mjpeg_frames(&http, &access, "UDID-99", |frame| {
            received.push(frame);
            true
        })
        .await?;

        let raw_req = req_rx.await?;
        assert!(
            raw_req.starts_with(
                "GET /api/device-hub/vendor/serve-sim/helper/UDID-99/stream.mjpeg?wsTicket=t-mjpeg&hostId=local HTTP/1.1\r\n"
            ),
            "must request authenticated serve-sim MJPEG path, got: {raw_req}"
        );
        assert_eq!(
            received,
            vec![expected1, expected2],
            "must yield both JPEG frames from fake MJPEG server"
        );
        Ok(())
    }
}
