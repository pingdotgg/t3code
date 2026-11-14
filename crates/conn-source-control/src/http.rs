//! One HTTPS request at a time to a host's API, as the T3 server's drivers send them.
//!
//! Each request opens its own connection and closes it after the answer: no pool, no
//! keep-alive, nothing held between calls. The answer's body is read up to the caller's cap;
//! the rest is dropped and the response is marked truncated, as `collectUint8StreamText` does.
//! TLS is rustls with Mozilla's roots (the set Node bundles). Plain `http://` exists for tests
//! against a local fake server and for a host the user configured with an `http` base URL.

use std::{
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    sync::OnceLock,
    time::Duration,
};

use http_body_util::{BodyExt, Full};
use hyper::{
    Request,
    body::{Bytes, Incoming},
    header::{HeaderName, HeaderValue},
};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpStream, lookup_host};

use crate::secret::Secret;

/// `DEFAULT_MAX_RESPONSE_BYTES` in `GitHubRest.ts`.
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// The T3 server's REST default.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    fn as_hyper(self) -> hyper::Method {
        match self {
            Method::Get => hyper::Method::GET,
            Method::Post => hyper::Method::POST,
            Method::Put => hyper::Method::PUT,
            Method::Patch => hyper::Method::PATCH,
            Method::Delete => hyper::Method::DELETE,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// A header value: plain text, or a credential that only the wire sees.
#[derive(Clone, Debug)]
pub enum HeaderText {
    Plain(String),
    /// Sent as `<prefix><secret>`, e.g. `Bearer ` and a token.
    Secret {
        prefix: &'static str,
        secret: Secret,
    },
}

/// Whether a request may dial a link-local address (169.254.0.0/16, fe80::/10), where a cloud
/// host answers with its metadata and credentials.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LinkLocal {
    #[default]
    Allow,
    /// Checked on the addresses the host name resolves to, and only the addresses that pass
    /// are dialled, so a second lookup cannot change the answer.
    Refuse,
}

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: Method,
    /// `https://host[:port]/path?query`.
    pub url: String,
    pub headers: Vec<(&'static str, HeaderText)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_response_bytes: usize,
    pub link_local: LinkLocal,
}

impl HttpRequest {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            timeout: DEFAULT_TIMEOUT,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            link_local: LinkLocal::Allow,
        }
    }

    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, HeaderText::Plain(value.into())));
        self
    }

    pub fn secret_header(
        mut self,
        name: &'static str,
        prefix: &'static str,
        secret: Secret,
    ) -> Self {
        self.headers
            .push((name, HeaderText::Secret { prefix, secret }));
        self
    }

    pub fn body(mut self, body: Vec<u8>) -> Self {
        self.body = Some(body);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Clone, Debug, Default)]
pub struct HttpResponse {
    pub status: u16,
    /// Lowercase names, in the order the server sent them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Why a request got no answer. The texts name the host, never a header or a token.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HttpError {
    #[error("Invalid request URL.")]
    InvalidUrl,
    #[error("Could not connect to {host}: {message}")]
    Connect { host: String, message: String },
    #[error("The request to {host} timed out.")]
    Timeout { host: String },
    #[error("The request to {host} failed: {message}")]
    Transport { host: String, message: String },
}

struct Target<'a> {
    tls: bool,
    host: &'a str,
    port: u16,
    authority: &'a str,
    path: &'a str,
}

fn parse_url(url: &str) -> Result<Target<'_>, HttpError> {
    let (tls, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return Err(HttpError::InvalidUrl);
    };
    let split = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(split);
    if authority.is_empty() || authority.contains('@') {
        return Err(HttpError::InvalidUrl);
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !host.ends_with(']') || host.starts_with('[') => {
            match port.parse::<u16>() {
                Ok(port) => (host, port),
                Err(_) if host.starts_with('[') => (authority, if tls { 443 } else { 80 }),
                Err(_) => return Err(HttpError::InvalidUrl),
            }
        }
        _ => (authority, if tls { 443 } else { 80 }),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Err(HttpError::InvalidUrl);
    }
    Ok(Target {
        tls,
        host,
        port,
        authority,
        path: if path.is_empty() { "/" } else { path },
    })
}

/// Built once: the roots and the provider are the same for every request.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let mut config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .with_root_certificates(roots)
                .with_no_client_auth();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Ok(Arc::new(config))
        })
        .clone()
}

/// Sends one request and reads its answer, bounded by `max_response_bytes` and `timeout`.
pub async fn send(request: HttpRequest) -> Result<HttpResponse, HttpError> {
    let target = parse_url(&request.url)?;
    let host = target.host.to_owned();
    match tokio::time::timeout(request.timeout, exchange(&target, &request)).await {
        Ok(result) => result,
        Err(_) => Err(HttpError::Timeout { host }),
    }
}

/// `fetch` with its default `redirect: "follow"`: up to 20 redirects, a 301 or 302 after a POST
/// and a 303 after anything but GET become a GET without a body, and the `authorization`
/// header is dropped once the origin changes. The deadline covers every hop.
pub async fn send_following_redirects(request: HttpRequest) -> Result<HttpResponse, HttpError> {
    let host = parse_url(&request.url)?.host.to_owned();
    let deadline = request.timeout;
    match tokio::time::timeout(deadline, follow(request)).await {
        Ok(result) => result,
        Err(_) => Err(HttpError::Timeout { host }),
    }
}

async fn follow(mut request: HttpRequest) -> Result<HttpResponse, HttpError> {
    const MAX_REDIRECTS: usize = 20;
    for _ in 0..MAX_REDIRECTS {
        let target = parse_url(&request.url)?;
        let response = exchange(&target, &request).await?;
        let location = response
            .header("location")
            .filter(|_| matches!(response.status, 301 | 302 | 303 | 307 | 308));
        let Some(location) = location else {
            return Ok(response);
        };
        let next = resolve_location(&request.url, location).ok_or(HttpError::InvalidUrl)?;
        let to_get = (matches!(response.status, 301 | 302) && request.method == Method::Post)
            || (response.status == 303 && request.method != Method::Get);
        if to_get {
            request.method = Method::Get;
            request.body = None;
            request.headers.retain(|(name, _)| {
                !matches!(
                    *name,
                    "content-type" | "content-encoding" | "content-language" | "content-location"
                )
            });
        }
        if origin_of(&next) != origin_of(&request.url) {
            request.headers.retain(|(name, _)| *name != "authorization");
        }
        request.url = next;
    }
    Err(HttpError::InvalidUrl)
}

/// `new URL(location, base)` for an `http`/`https` location: absolute, root-relative or
/// relative to the base's folder. Anything else is refused.
fn resolve_location(base: &str, location: &str) -> Option<String> {
    let lower = location
        .get(..8)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(location.to_owned());
    }
    if location.contains("://") {
        return None;
    }
    let origin = origin_of(base)?;
    if let Some(rest) = location.strip_prefix("//") {
        let scheme = base.split_once("://")?.0;
        return Some(format!("{scheme}://{rest}"));
    }
    if location.starts_with('/') {
        return Some(format!("{origin}{location}"));
    }
    let path = base.get(origin.len()..)?.split(['?', '#']).next()?;
    let folder = path.rsplit_once('/').map_or("", |(head, _)| head);
    Some(format!("{origin}{folder}/{location}"))
}

/// The scheme and authority of a URL, in lower case.
fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        rest.get(..end)?.to_ascii_lowercase()
    ))
}

async fn exchange(target: &Target<'_>, request: &HttpRequest) -> Result<HttpResponse, HttpError> {
    let host = target.host.to_owned();
    let connect = |message: String| HttpError::Connect {
        host: host.clone(),
        message,
    };
    let tcp = dial(target, request.link_local)
        .await
        .map_err(|e| connect(e.to_string()))?;
    let _ = tcp.set_nodelay(true);
    let built = build_request(target, request)?;
    if target.tls {
        let name = rustls::pki_types::ServerName::try_from(target.host.to_owned())
            .map_err(|_| HttpError::InvalidUrl)?;
        let stream = tokio_rustls::TlsConnector::from(tls_config().map_err(connect)?)
            .connect(name, tcp)
            .await
            .map_err(|e| connect(e.to_string()))?;
        round_trip(
            TokioIo::new(stream),
            built,
            request.max_response_bytes,
            &host,
        )
        .await
    } else {
        round_trip(TokioIo::new(tcp), built, request.max_response_bytes, &host).await
    }
}

/// 169.254.0.0/16, fe80::/10, and an IPv4-mapped IPv6 form of the first.
fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local(),
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map_or_else(|| v6.is_unicast_link_local(), |v4| v4.is_link_local()),
    }
}

/// Opens the connection, trying each address the host resolves to in turn, as
/// `TcpStream::connect` does; with [`LinkLocal::Refuse`] a link-local address is skipped.
async fn dial(target: &Target<'_>, link_local: LinkLocal) -> io::Result<TcpStream> {
    if link_local == LinkLocal::Allow {
        return TcpStream::connect((target.host, target.port)).await;
    }
    let addresses: Vec<SocketAddr> = lookup_host((target.host, target.port)).await?.collect();
    let mut last = None;
    for address in addresses {
        if is_link_local(address.ip()) {
            last.get_or_insert_with(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "link-local addresses are refused",
                )
            });
            continue;
        }
        match TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the host has no address")))
}

fn build_request(
    target: &Target<'_>,
    request: &HttpRequest,
) -> Result<Request<Full<Bytes>>, HttpError> {
    let mut builder = Request::builder()
        .method(request.method.as_hyper())
        .uri(target.path)
        .header(hyper::header::HOST, target.authority);
    for (name, value) in &request.headers {
        let name = HeaderName::from_static(name);
        let value = match value {
            HeaderText::Plain(text) => HeaderValue::from_str(text),
            HeaderText::Secret { prefix, secret } => {
                HeaderValue::from_str(&format!("{prefix}{}", secret.expose())).map(|mut v| {
                    v.set_sensitive(true);
                    v
                })
            }
        }
        .map_err(|_| HttpError::InvalidUrl)?;
        builder = builder.header(name, value);
    }
    let body = request.body.clone().unwrap_or_default();
    if request.body.is_some() {
        builder = builder.header(hyper::header::CONTENT_LENGTH, body.len());
    }
    builder
        .body(Full::new(Bytes::from(body)))
        .map_err(|_| HttpError::InvalidUrl)
}

async fn round_trip<S>(
    io: TokioIo<S>,
    request: Request<Full<Bytes>>,
    max_bytes: usize,
    host: &str,
) -> Result<HttpResponse, HttpError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let transport = |e: hyper::Error| HttpError::Transport {
        host: host.to_owned(),
        message: e.to_string(),
    };
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(transport)?;
    // The connection task ends with the response or when this future is dropped: it is local.
    let drive = async {
        let _ = connection.await;
    };
    let exchange = async {
        let response = sender.send_request(request).await.map_err(transport)?;
        read_response(response, max_bytes, host).await
    };
    tokio::pin!(drive);
    tokio::pin!(exchange);
    // The connection must keep running while the body is read; it may finish first (the
    // server closed after the last byte), and then the body reads what hyper already holds.
    let mut driving = true;
    loop {
        tokio::select! {
            result = &mut exchange => return result,
            () = &mut drive, if driving => driving = false,
        }
    }
}

async fn read_response(
    response: hyper::Response<Incoming>,
    max_bytes: usize,
    host: &str,
) -> Result<HttpResponse, HttpError> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let mut body = response.into_body();
    let mut out = Vec::new();
    let mut truncated = false;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| HttpError::Transport {
            host: host.to_owned(),
            message: e.to_string(),
        })?;
        if let Ok(data) = frame.into_data() {
            let room = max_bytes.saturating_sub(out.len());
            if data.len() > room {
                out.extend_from_slice(data.get(..room).unwrap_or_default());
                truncated = true;
                // Stop reading: the connection is dropped with the rest unread.
                break;
            }
            out.extend_from_slice(&data);
        }
    }
    Ok(HttpResponse {
        status,
        headers,
        body: out,
        truncated,
    })
}

#[cfg(test)]
pub(crate) mod fake {
    //! A local HTTP/1.1 server that records each request and answers from a script.

    use std::sync::{Arc, Mutex};

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[derive(Clone, Debug, Default)]
    pub(crate) struct Recorded {
        pub(crate) method: String,
        pub(crate) path: String,
        /// Lowercase names. `authorization` is kept so a test can check its shape.
        pub(crate) headers: Vec<(String, String)>,
        pub(crate) body: String,
    }

    #[derive(Debug)]
    pub(crate) struct FakeServer {
        pub(crate) base: String,
        pub(crate) requests: Arc<Mutex<Vec<Recorded>>>,
    }

    /// Answers each request with `answer(&request) -> (status, body)`.
    pub(crate) async fn serve(
        answer: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static,
    ) -> FakeServer {
        serve_with_headers(move |r| {
            let (status, body) = answer(r);
            (status, Vec::new(), body)
        })
        .await
    }

    /// Answers each request with `(status, extra headers, body)`.
    pub(crate) async fn serve_with_headers(
        answer: impl Fn(&Recorded) -> (u16, Vec<(String, String)>, String) + Send + Sync + 'static,
    ) -> FakeServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let log = log.clone();
                let answer = answer.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head_end, content_length) = loop {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (end + 4, length);
                        }
                    };
                    while buf.len() < head_end + content_length {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    let mut lines = head.split("\r\n");
                    let mut first = lines.next().unwrap_or_default().split(' ');
                    let method = first.next().unwrap_or_default().to_owned();
                    let path = first.next().unwrap_or_default().to_owned();
                    let headers = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned()))
                        .collect();
                    let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
                    let recorded = Recorded {
                        method,
                        path,
                        headers,
                        body,
                    };
                    let (status, extra, text) = answer(&recorded);
                    log.lock().expect("lock").push(recorded);
                    let extra: String = extra
                        .iter()
                        .map(|(name, value)| format!("{name}: {value}\r\n"))
                        .collect();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        FakeServer { base, requests }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_redirect_locations_as_url_does() {
        let base = "http://127.0.0.1:9/2.0/repositories/ws/old?x=1";
        assert_eq!(
            resolve_location(base, "/2.0/a").as_deref(),
            Some("http://127.0.0.1:9/2.0/a")
        );
        assert_eq!(
            resolve_location(base, "new").as_deref(),
            Some("http://127.0.0.1:9/2.0/repositories/ws/new")
        );
        assert_eq!(
            resolve_location(base, "//other.test/x").as_deref(),
            Some("http://other.test/x")
        );
        assert_eq!(resolve_location(base, "ftp://x/y"), None);
        assert_eq!(
            origin_of("HTTPS://Api.Bitbucket.org/2.0").as_deref(),
            Some("https://api.bitbucket.org")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn drops_the_credential_when_a_redirect_leaves_the_origin() {
        let other = fake::serve(|_| (200, "{}".into())).await;
        let target = format!("{}/landing", other.base);
        let first = fake::serve_with_headers(move |_| {
            (
                302,
                vec![("location".into(), target.clone())],
                String::new(),
            )
        })
        .await;
        let request = HttpRequest::new(Method::Get, format!("{}/start", first.base)).secret_header(
            "authorization",
            "Bearer ",
            Secret::new("t"),
        );
        let response = send_following_redirects(request).await.expect("followed");
        assert_eq!(response.status, 200);
        let seen = other.requests.lock().expect("lock").clone();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0]
                .headers
                .iter()
                .all(|(name, _)| name != "authorization"),
            "no credential on another origin"
        );
    }

    #[test]
    fn link_local_means_169_254_and_fe80_only() {
        for ip in [
            "169.254.169.254",
            "169.254.0.1",
            "fe80::1",
            "febf::1",
            "::ffff:169.254.1.1",
        ] {
            assert!(is_link_local(ip.parse().expect("ip")), "{ip}");
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fec0::1",
            "8.8.8.8",
        ] {
            assert!(!is_link_local(ip.parse().expect("ip")), "{ip}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_link_local_address_is_never_dialled() {
        for url in ["http://169.254.169.254/latest", "http://[fe80::1]:9/x"] {
            let request = HttpRequest {
                link_local: LinkLocal::Refuse,
                ..HttpRequest::new(Method::Get, url).timeout(Duration::from_secs(20))
            };
            let started = std::time::Instant::now();
            let error = send(request).await.expect_err("refused");
            assert!(
                matches!(&error, HttpError::Connect { message, .. } if message == "link-local addresses are refused"),
                "{url}: {error:?}"
            );
            assert!(started.elapsed() < Duration::from_secs(5), "no dial: {url}");
        }
        // Loopback stays reachable, for a local model server.
        let server = fake::serve(|_| (200, "{}".into())).await;
        let request = HttpRequest {
            link_local: LinkLocal::Refuse,
            ..HttpRequest::new(Method::Get, format!("{}/v1/models", server.base))
        };
        assert_eq!(send(request).await.expect("answer").status, 200);
    }

    #[test]
    fn parses_urls() {
        let t = parse_url("https://api.github.com/user?x=1").expect("parses");
        assert!(t.tls, "https");
        assert_eq!(
            (t.host, t.port, t.path),
            ("api.github.com", 443, "/user?x=1")
        );
        let t = parse_url("http://127.0.0.1:8080").expect("parses");
        assert_eq!((t.host, t.port, t.path), ("127.0.0.1", 8080, "/"));
        assert!(
            parse_url("https://user:pw@host/").is_err(),
            "no credentials in URLs"
        );
        assert!(parse_url("ftp://host/").is_err(), "only http and https");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sends_headers_and_bounds_the_body() {
        let server = fake::serve(|_| (200, "x".repeat(100))).await;
        let request = HttpRequest {
            max_response_bytes: 10,
            ..HttpRequest::new(Method::Post, format!("{}/a/b?c=d", server.base))
                .header("accept", "application/json")
                .secret_header("authorization", "Bearer ", Secret::new("tok"))
                .body(b"{}".to_vec())
        };
        let response = send(request).await.expect("answer");
        assert_eq!(response.status, 200, "status");
        assert_eq!(response.body.len(), 10, "capped");
        assert!(response.truncated, "marked truncated");
        let recorded = server.requests.lock().expect("lock").clone();
        let first = recorded.first().expect("one request");
        assert_eq!(
            (first.method.as_str(), first.path.as_str()),
            ("POST", "/a/b?c=d")
        );
        assert!(
            first
                .headers
                .contains(&("authorization".into(), "Bearer tok".into())),
            "the wire carries the token"
        );
        assert_eq!(first.body, "{}", "body");
    }
}
