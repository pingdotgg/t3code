//! A bounded loopback server for one isolated surface's trusted host page.
//!
//! Chromium's local-network protections block a page with no network address (a `data:` page
//! counts as public) from loading a loopback or LAN `conn-server`: "initiated by a public page to
//! connect to devices or servers on your local network". Loading the host page from a real
//! loopback address gives it a loopback origin, which may load any address, so the protections
//! stay on and the guest keeps its sandbox and CSP.
//!
//! The server is as small as it can be:
//! - it binds `127.0.0.1` on an ephemeral port, and serves exactly one path, a random 128-bit
//!   token, with exactly one body (the host page, which holds no secret: the signed document
//!   URL is set by script later);
//! - it answers only a browser's own document navigation: a wrong `Host` (DNS rebinding), any
//!   `Origin` (a cross-origin fetch), or a `Sec-Fetch-Dest` that is not a document is
//!   refused, and the page forbids framing (`frame-ancestors 'none'`), so a guest cannot load it
//!   or read it;
//! - it runs on one thread and spends at most one second in total on a request (reading it and
//!   writing the answer), however slowly the peer sends or reads, and reads at most 8 KiB;
//! - dropping it never blocks the caller: it flags the thread to stop, and a detached helper
//!   wakes the thread's `accept` so it exits and closes the port.

use std::fs::File;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 8 * 1024;
/// The whole of one request: reading its head and writing the answer.
const REQUEST_BUDGET: Duration = Duration::from_secs(1);
/// How long the drop helper waits to reach the listener before it gives up.
const WAKE_TIMEOUT: Duration = Duration::from_millis(500);

/// 128 bits from the operating system's CSPRNG (`/dev/urandom`), as hex.
///
/// The host page's path and the console prefix are capabilities, so they must come from the OS
/// and never from a process-local hasher. A failure is an error: callers must not fall back to
/// anything weaker.
pub(super) fn random_hex() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Serves one page on loopback until dropped.
pub(super) struct LocalPage {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
}

impl std::fmt::Debug for LocalPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalPage")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl LocalPage {
    pub(super) fn serve(html: String) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = random_hex()?;
        let stop = Arc::new(AtomicBool::new(false));
        let path = format!("/{token}");
        let host = format!("127.0.0.1:{port}");
        let thread_stop = Arc::clone(&stop);
        // The handle is dropped on purpose: the thread ends itself once `stop` is set.
        std::thread::Builder::new()
            .name("conn-embedded-page".to_owned())
            .spawn(move || {
                for stream in listener.incoming() {
                    if thread_stop.load(Ordering::Acquire) {
                        break;
                    }
                    match stream {
                        Ok(stream) => handle(stream, &path, &host, &html),
                        Err(_) => std::thread::sleep(Duration::from_millis(50)),
                    }
                }
            })?;
        Ok(Self { port, token, stop })
    }

    /// Where the browser loads the page. The path is the token, so keep it out of logs.
    pub(super) fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }
}

impl Drop for LocalPage {
    /// Never blocks, since it can run on the GUI thread: a blocked `accept` only returns for a
    /// connection, so a detached helper makes one, and the server thread then sees `stop`.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let _ = std::thread::Builder::new()
            .name("conn-embedded-page-wake".to_owned())
            .spawn(move || {
                let _ = TcpStream::connect_timeout(&address, WAKE_TIMEOUT);
            });
    }
}

/// The time left before `deadline`, or `None` once it has passed.
fn remaining(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
}

fn handle(mut stream: TcpStream, path: &str, host: &str, html: &str) {
    let deadline = Instant::now() + REQUEST_BUDGET;
    let Some(head) = read_head(&mut stream, deadline) else {
        return;
    };
    write_all_by(&mut stream, &respond(&head, path, host, html), deadline);
}

/// Reads up to the end of the request head. The socket timeout is the time left of the whole
/// budget, so a peer that sends a byte at a time cannot keep the thread past the deadline.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        stream.set_read_timeout(Some(remaining(deadline)?)).ok()?;
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            return Some(String::from_utf8_lossy(&buffer).into_owned());
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            return None;
        }
    }
}

/// Writes `bytes` unless the budget runs out first; a peer that does not read just loses the page.
fn write_all_by(stream: &mut TcpStream, bytes: &[u8], deadline: Instant) {
    let mut sent = 0;
    while sent < bytes.len() {
        let Some(left) = remaining(deadline) else {
            return;
        };
        if stream.set_write_timeout(Some(left)).is_err() {
            return;
        }
        match stream.write(&bytes[sent..]) {
            Ok(0) | Err(_) => return,
            Ok(written) => sent += written,
        }
    }
    let _ = stream.flush();
}

fn status(code: u16, reason: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// The response to one request head. Pure, so the refusals are testable.
fn respond(head: &str, path: &str, host: &str, html: &str) -> Vec<u8> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let (method, target) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let headers: Vec<(String, &str)> = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim()))
        .collect();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| *value)
    };

    if method != "GET" {
        return status(405, "Method Not Allowed", "");
    }
    // A page on another name that resolves here (DNS rebinding) sends its own `Host`.
    if header("host") != Some(host) {
        return status(403, "Forbidden", "");
    }
    // A cross-origin fetch carries an `Origin`; a document navigation does not. A frame or
    // script load names its destination. `Sec-Fetch-Site` is not checked: the token already
    // limits who can ask, and an embedded browser's own `LoadURL` may report any site value.
    if header("origin").is_some() || header("sec-fetch-dest").is_some_and(|dest| dest != "document")
    {
        return status(403, "Forbidden", "");
    }
    if target != path {
        return status(404, "Not Found", "");
    }
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\n\
         Content-Security-Policy: frame-ancestors 'none'\r\nX-Frame-Options: DENY\r\n\
         Connection: close\r\n\r\n{html}",
        html.len()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "127.0.0.1:4000";

    fn get(extra: &str, target: &str, host: &str) -> String {
        let head = format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n");
        String::from_utf8_lossy(&respond(&head, "/tok", HOST, "<p>page</p>")).into_owned()
    }

    fn status_line(response: &str) -> &str {
        response.lines().next().unwrap_or_default()
    }

    #[test]
    fn a_navigation_to_the_token_gets_the_page() {
        let response = get(
            "Sec-Fetch-Dest: document\r\nSec-Fetch-Site: none\r\n",
            "/tok",
            HOST,
        );
        assert_eq!(
            status_line(&response),
            "HTTP/1.1 200 OK",
            "the page is served"
        );
        assert!(response.ends_with("<p>page</p>"), "the body is the page");
        assert!(
            response.contains("frame-ancestors 'none'") && response.contains("no-store"),
            "framing is forbidden and nothing is cached",
        );
        let bare = get("", "/tok", HOST);
        assert_eq!(
            status_line(&bare),
            "HTTP/1.1 200 OK",
            "no Sec-Fetch headers is still a navigation"
        );
    }

    #[test]
    fn everything_else_is_refused() {
        assert_eq!(
            status_line(&get("", "/other", HOST)),
            "HTTP/1.1 404 Not Found",
            "wrong path"
        );
        assert_eq!(
            status_line(&get("", "/tok", "evil.example:4000")),
            "HTTP/1.1 403 Forbidden",
            "a rebinding host",
        );
        assert_eq!(
            status_line(&get("Origin: null\r\n", "/tok", HOST)),
            "HTTP/1.1 403 Forbidden",
            "a cross-origin fetch",
        );
        assert_eq!(
            status_line(&get("Sec-Fetch-Dest: iframe\r\n", "/tok", HOST)),
            "HTTP/1.1 403 Forbidden",
            "a frame load",
        );
        assert_eq!(
            status_line(&get(
                "Sec-Fetch-Dest: empty\r\nSec-Fetch-Site: cross-site\r\n",
                "/tok",
                HOST
            )),
            "HTTP/1.1 403 Forbidden",
            "a script fetch",
        );
        let head = format!("POST /tok HTTP/1.1\r\nHost: {HOST}\r\n\r\n");
        assert_eq!(
            status_line(&String::from_utf8_lossy(&respond(&head, "/tok", HOST, "x"))),
            "HTTP/1.1 405 Method Not Allowed",
            "only GET",
        );
    }

    #[test]
    fn serves_over_a_real_socket_and_stops_on_drop() {
        let Ok(page) = LocalPage::serve("<p>live</p>".to_owned()) else {
            panic!("loopback should bind");
        };
        let url = page.url();
        let Some(rest) = url.strip_prefix("http://") else {
            panic!("the url is http: {url}");
        };
        let Some((host, path)) = rest.split_once('/') else {
            panic!("the url has a path");
        };
        let Ok(mut stream) = TcpStream::connect(host) else {
            panic!("the server accepts");
        };
        let request = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        assert!(
            stream.write_all(request.as_bytes()).is_ok(),
            "the request is sent"
        );
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(
            response.starts_with("HTTP/1.1 200 OK"),
            "the page is served: {response}"
        );
        assert!(response.ends_with("<p>live</p>"), "with its body");

        // Dropping returns at once; the thread then ends and the port closes.
        let dropped_at = Instant::now();
        drop(page);
        assert!(
            dropped_at.elapsed() < Duration::from_millis(250),
            "drop does not wait for the server thread",
        );
        let closed = (0..60).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            TcpStream::connect(host).is_err()
        });
        assert!(closed, "the port closes after the drop");
    }

    #[test]
    fn a_slow_sender_cannot_hold_the_server_past_its_budget() {
        let Ok(page) = LocalPage::serve("<p>live</p>".to_owned()) else {
            panic!("loopback should bind");
        };
        let url = page.url();
        let Some((host, path)) = url
            .strip_prefix("http://")
            .and_then(|rest| rest.split_once('/'))
        else {
            panic!("the url is http with a path: {url}");
        };
        let (host, path) = (host.to_owned(), path.to_owned());

        // A peer that sends one byte at a time and never finishes its head.
        let dripper_host = host.clone();
        let dripper = std::thread::spawn(move || {
            let Ok(mut stream) = TcpStream::connect(&dripper_host) else {
                return;
            };
            for _ in 0..16 {
                if stream.write_all(b"G").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
        std::thread::sleep(Duration::from_millis(100));

        let started = Instant::now();
        let Ok(mut stream) = TcpStream::connect(&host) else {
            panic!("the server accepts");
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        let request = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        assert!(
            stream.write_all(request.as_bytes()).is_ok(),
            "the request is sent"
        );
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        assert!(
            response.starts_with("HTTP/1.1 200 OK"),
            "the real request is served after the slow one is cut off: {response}",
        );
        assert!(
            started.elapsed() < Duration::from_millis(2500),
            "the drip was cut at its budget, not extended by each byte",
        );
        let _ = dripper.join();
    }

    #[test]
    fn tokens_are_long_and_distinct() {
        let (Ok(first), Ok(second)) = (random_hex(), random_hex()) else {
            panic!("the OS random source should work");
        };
        assert_eq!(first.len(), 32, "128 bits as hex");
        assert!(
            first.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "hex digits only"
        );
        assert_ne!(first, second, "each token is new");
    }
}
