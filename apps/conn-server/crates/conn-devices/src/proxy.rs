//! The rules of the device hub proxy (`DeviceHubProxy.ts`): which hub paths a client may reach,
//! with which methods and scope, and the MJPEG still-frame repeat. The HTTP side lives in the
//! server's route.

use std::sync::OnceLock;

use regex_automata::meta::Regex;

use crate::generated::{
    HUB_ALLOWED_PATHS, HUB_DROPPED_REQUEST_HEADERS, HUB_MUTABLE_PATHS, HUB_WS_PATHS,
};

fn compiled(
    patterns: &'static [&'static str],
    cell: &'static OnceLock<Vec<Regex>>,
) -> &'static [Regex] {
    cell.get_or_init(|| patterns.iter().filter_map(|p| Regex::new(p).ok()).collect())
}

fn matches(
    patterns: &'static [&'static str],
    cell: &'static OnceLock<Vec<Regex>>,
    path: &str,
) -> bool {
    compiled(patterns, cell).iter().any(|r| r.is_match(path))
}

static ALLOWED: OnceLock<Vec<Regex>> = OnceLock::new();
static MUTABLE: OnceLock<Vec<Regex>> = OnceLock::new();
static WS: OnceLock<Vec<Regex>> = OnceLock::new();

/// What the proxy does with a request for `hub_path`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    NotFound,
    MethodNotAllowed,
    /// Forward it; `operate` when it controls the device (input, stream tuning).
    Forward {
        operate: bool,
    },
}

pub fn decide(hub_path: &str, method: &str, upgrade: bool) -> Decision {
    let allowed = matches(HUB_ALLOWED_PATHS, &ALLOWED, hub_path);
    let mutable = matches(HUB_MUTABLE_PATHS, &MUTABLE, hub_path);
    if upgrade {
        if !matches(HUB_WS_PATHS, &WS, hub_path) {
            return Decision::NotFound;
        }
        return Decision::Forward {
            operate: hub_path != "/api/devices/ws",
        };
    }
    if !allowed && !mutable {
        return Decision::NotFound;
    }
    let read_only = method == "GET" || method == "HEAD";
    if !(if read_only { allowed } else { mutable }) {
        return Decision::MethodNotAllowed;
    }
    let tuning = ["/api/stream-mode", "/api/stream-settings", "/api/fold"]
        .iter()
        .any(|suffix| hub_path.ends_with(suffix));
    Decision::Forward {
        operate: !read_only && tuning,
    }
}

pub fn drops_request_header(name: &str) -> bool {
    HUB_DROPPED_REQUEST_HEADERS.contains(&name)
}

/// Response headers the proxy never passes on; an upstream cookie would land on our origin.
pub fn drops_response_header(name: &str) -> bool {
    matches!(
        name,
        "content-encoding" | "transfer-encoding" | "connection" | "set-cookie"
    )
}

const MAX_HEADER_BYTES: usize = 16 * 1024;
/// Simulator frames are far smaller; a larger claim is unknown framing, not something to keep.
const MAX_PART_BYTES: usize = 16 * 1024 * 1024;

/// Follows the hub's MJPEG part framing (`--frame`, `Content-Length`, CRLF CRLF, body, CRLF)
/// and keeps the last complete part as the chunks it came in (no copy of frame bytes). Any
/// other framing turns tracking off and the rest passes through (`mjpegStillFrame.ts`).
#[derive(Debug, Default)]
pub struct PartTracker {
    pieces: Vec<bytes_like::Chunk>,
    size: usize,
    part_end: Option<usize>,
    off: bool,
    /// The last complete part, while the stream sits at a part boundary.
    pub still: Option<Vec<bytes_like::Chunk>>,
}

/// A cheap-to-clone chunk of the forwarded body.
pub mod bytes_like {
    pub type Chunk = hyper::body::Bytes;
}

fn part_length(headers: &[u8]) -> Option<usize> {
    if !headers.starts_with(b"--") {
        return None;
    }
    let text = String::from_utf8_lossy(headers);
    for line in text.split("\r\n").flat_map(|l| l.split('\n')) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim_end().eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
                return value.parse::<usize>().ok().filter(|n| *n <= MAX_PART_BYTES);
            }
        }
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

impl PartTracker {
    pub fn feed(&mut self, chunk: &bytes_like::Chunk) {
        if self.off {
            return;
        }
        let mut rest = chunk.clone();
        let mut part: Option<Vec<bytes_like::Chunk>> = None;
        while !rest.is_empty() {
            if self.part_end.is_none() {
                // A header split across chunks is scanned again per chunk; only a header-sized
                // prefix of the new chunk joins the scan.
                let mut head: Vec<u8> = Vec::new();
                for piece in &self.pieces {
                    head.extend_from_slice(piece);
                }
                let take = rest.len().min(MAX_HEADER_BYTES + 4);
                head.extend_from_slice(rest.get(..take).unwrap_or_default());
                let header_end = find(&head, b"\r\n\r\n");
                if header_end.is_none() && head.len() <= MAX_HEADER_BYTES {
                    self.size += rest.len();
                    self.pieces.push(rest);
                    break;
                }
                let length = header_end
                    .filter(|end| *end <= MAX_HEADER_BYTES)
                    .and_then(|end| part_length(head.get(..end).unwrap_or_default()));
                let (Some(end), Some(length)) = (header_end, length) else {
                    self.off = true;
                    break;
                };
                self.part_end = Some(end + 4 + length + 2);
            }
            let part_end = self.part_end.unwrap_or(0);
            let want = part_end.saturating_sub(self.size).min(rest.len());
            let taken = rest.split_to(want);
            self.size += taken.len();
            self.pieces.push(taken);
            if self.size < part_end {
                break;
            }
            let complete = std::mem::take(&mut self.pieces);
            let tail: Vec<u8> = complete
                .iter()
                .flat_map(|c| c.iter().copied())
                .rev()
                .take(2)
                .collect();
            if tail != *b"\n\r" {
                self.off = true;
                break;
            }
            part = Some(complete);
            self.size = 0;
            self.part_end = None;
        }
        if self.off {
            self.pieces.clear();
            self.still = None;
            return;
        }
        if self.size == 0 {
            if let Some(part) = part {
                self.still = Some(part);
            }
        } else {
            self.still = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decides_like_t3() {
        assert_eq!(
            decide("/api/devices", "GET", false),
            Decision::Forward { operate: false },
            "list"
        );
        assert_eq!(
            decide("/api/devices", "POST", false),
            Decision::MethodNotAllowed,
            "post list"
        );
        assert_eq!(
            decide("/api/devices/boot", "POST", false),
            Decision::NotFound,
            "boot"
        );
        assert_eq!(
            decide("/vendor/serve-sim/helper/abc/stream.mjpeg", "GET", false),
            Decision::Forward { operate: false },
            "mjpeg"
        );
        assert_eq!(
            decide("/vendor/serve-emu/api/fold", "POST", false),
            Decision::Forward { operate: true },
            "fold"
        );
        assert_eq!(
            decide("/vendor/serve-sim/helper/ws", "GET", true),
            Decision::Forward { operate: true },
            "ws"
        );
        assert_eq!(
            decide("/api/devices/ws", "GET", true),
            Decision::Forward { operate: false },
            "device ws"
        );
        assert!(drops_request_header("authorization"), "auth dropped");
    }

    #[test]
    fn keeps_the_last_complete_part() {
        let part = |n: u8| {
            let body = vec![n; 5];
            let mut out = format!(
                "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .into_bytes();
            out.extend(body);
            out.extend(b"\r\n");
            hyper::body::Bytes::from(out)
        };
        let mut tracker = PartTracker::default();
        let first = part(1);
        let (a, b) = (first.slice(..10), first.slice(10..));
        tracker.feed(&a);
        assert!(tracker.still.is_none(), "mid part");
        tracker.feed(&b);
        let still: Vec<u8> = tracker.still.clone().unwrap_or_default().concat();
        assert_eq!(still, first.to_vec(), "still part");
        tracker.feed(&hyper::body::Bytes::from_static(
            b"garbage without framing\r\n\r\n",
        ));
        assert!(tracker.still.is_none(), "off");
    }
}
