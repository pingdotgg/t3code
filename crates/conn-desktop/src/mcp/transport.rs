//! The three MCP transports: stdio, Streamable HTTP, and legacy HTTP+SSE. Each one writes
//! messages out and feeds every message it reads into one inbound channel.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use url::Url;

use super::events::Emitter;
use super::sse::SseParser;
use super::types::{McpEventKind, McpHeader};

/// How much stderr is kept to explain a failed connect.
const STDERR_TAIL_CHARS: usize = 2_000;
/// How long a stdio server gets to exit after its stdin closes, and again after SIGTERM.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// How long a failed connect waits for the last stderr of a server that exited.
const STDERR_SETTLE: Duration = Duration::from_millis(250);

const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

/// What a transport hands the dispatcher.
#[derive(Debug)]
pub(crate) enum Inbound {
    Message(Value),
    Closed,
}

pub(crate) type InboundTx = mpsc::UnboundedSender<Inbound>;

/// Sends a message, or each message of a batch, to the dispatcher.
fn deliver(inbound: &InboundTx, value: Value) {
    match value {
        Value::Array(messages) => {
            for message in messages {
                let _ = inbound.send(Inbound::Message(message));
            }
        }
        message => {
            let _ = inbound.send(Inbound::Message(message));
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One session's connection to its server.
#[derive(Debug)]
pub(crate) enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
    Sse(SseTransport),
}

impl Transport {
    pub(crate) async fn send(&self, message: &Value) -> Result<(), String> {
        match self {
            Self::Stdio(transport) => transport.send(message).await,
            Self::Http(transport) => transport.send(message).await,
            Self::Sse(transport) => transport.send(message).await,
        }
    }

    /// Tells HTTP transports the negotiated protocol version, for the `MCP-Protocol-Version` header.
    pub(crate) fn set_protocol_version(&self, version: &str) {
        let Ok(value) = HeaderValue::from_str(version) else {
            return;
        };
        match self {
            Self::Stdio(_) => {}
            Self::Http(transport) => *lock(&transport.protocol) = Some(value),
            Self::Sse(transport) => *lock(&transport.protocol) = Some(value),
        }
    }

    /// Stops the server or drops the connection.
    pub(crate) async fn close(&self) {
        match self {
            Self::Stdio(transport) => transport.close().await,
            Self::Http(transport) => transport.abort_tasks(),
            Self::Sse(transport) => transport.reader.abort(),
        }
    }

    /// Lets a stdio server's last stderr arrive before a failed connect reports it.
    pub(crate) async fn settle_stderr(&self) {
        if let Self::Stdio(transport) = self {
            let handle = lock(&transport.stderr_reader).take();
            if let Some(handle) = handle {
                let _ = tokio::time::timeout(STDERR_SETTLE, handle).await;
            }
        }
    }
}

// ─── stdio ──────────────────────────────────────────────────────────────────

/// Why a stdio server did not start.
#[derive(Debug)]
pub(crate) enum SpawnError {
    NotFound,
    Other(String),
}

/// A local server process in its own process group.
#[derive(Debug)]
pub(crate) struct StdioTransport {
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    child: tokio::sync::Mutex<Option<Child>>,
    pgid: Option<i32>,
    stopped: AtomicBool,
    stdout_reader: JoinHandle<()>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
}

/// What a stdio server runs.
#[derive(Debug)]
pub(crate) struct StdioSpawn<'a> {
    pub(crate) command: &'a str,
    pub(crate) args: &'a [String],
    pub(crate) env: HashMap<String, String>,
    pub(crate) cwd: &'a Path,
}

impl StdioTransport {
    pub(crate) fn spawn(
        spec: StdioSpawn<'_>,
        inbound: InboundTx,
        emitter: Emitter,
        stderr_tail: Arc<Mutex<String>>,
    ) -> Result<Self, SpawnError> {
        let mut command = Command::new(spec.command);
        command
            .args(spec.args)
            .env_clear()
            .envs(spec.env)
            .current_dir(spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SpawnError::NotFound
            } else {
                SpawnError::Other(error.to_string())
            }
        })?;
        let pgid = child.id().and_then(|pid| i32::try_from(pid).ok());
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SpawnError::Other("The server has no stdout.".into()))?;
        let stderr = child.stderr.take();

        let stdout_reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                // Like the SDK, a line that is not JSON-RPC is skipped.
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    deliver(&inbound, value);
                }
            }
            let _ = inbound.send(Inbound::Closed);
        });
        let stderr_reader = stderr.map(|mut stderr| {
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 8_192];
                let mut carry: Vec<u8> = Vec::new();
                while let Ok(read) = stderr.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    carry.extend_from_slice(&buffer[..read]);
                    let text = take_utf8(&mut carry);
                    if text.is_empty() {
                        continue;
                    }
                    push_tail(&stderr_tail, &text);
                    emitter.emit(McpEventKind::Stderr { text }).await;
                }
                if !carry.is_empty() {
                    let text = String::from_utf8_lossy(&carry).into_owned();
                    push_tail(&stderr_tail, &text);
                    emitter.emit(McpEventKind::Stderr { text }).await;
                }
            })
        });
        Ok(Self {
            stdin: tokio::sync::Mutex::new(stdin),
            child: tokio::sync::Mutex::new(Some(child)),
            pgid,
            stopped: AtomicBool::new(false),
            stdout_reader,
            stderr_reader: Mutex::new(stderr_reader),
        })
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let Some(stdin) = stdin.as_mut() else {
            return Err("Not connected".into());
        };
        let mut line = message.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }

    /// Closes stdin, then SIGTERM and SIGKILL to the process group if the server lingers, and
    /// SIGTERM to whatever it left in its group.
    async fn close(&self) {
        drop(self.stdin.lock().await.take());
        let child = self.child.lock().await.take();
        if let Some(mut child) = child
            && tokio::time::timeout(EXIT_GRACE, child.wait())
                .await
                .is_err()
        {
            signal_group(self.pgid, GroupSignal::Terminate);
            if tokio::time::timeout(EXIT_GRACE, child.wait())
                .await
                .is_err()
            {
                signal_group(self.pgid, GroupSignal::Kill);
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        signal_group(self.pgid, GroupSignal::Terminate);
        self.stopped.store(true, Ordering::SeqCst);
        self.stdout_reader.abort();
        if let Some(handle) = lock(&self.stderr_reader).take() {
            handle.abort();
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        if !self.stopped.load(Ordering::SeqCst) {
            signal_group(self.pgid, GroupSignal::Terminate);
        }
        self.stdout_reader.abort();
        if let Some(handle) = lock(&self.stderr_reader).take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum GroupSignal {
    Terminate,
    Kill,
}

#[cfg(unix)]
fn signal_group(pgid: Option<i32>, signal: GroupSignal) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    let Some(pgid) = pgid.filter(|pgid| *pgid > 1) else {
        return;
    };
    let signal = match signal {
        GroupSignal::Terminate => Signal::SIGTERM,
        GroupSignal::Kill => Signal::SIGKILL,
    };
    let _ = killpg(Pid::from_raw(pgid), signal);
}

#[cfg(not(unix))]
fn signal_group(_pgid: Option<i32>, _signal: GroupSignal) {}

/// The valid UTF-8 prefix of `bytes`, leaving an incomplete trailing character for later.
fn take_utf8(bytes: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => {
            let text = String::from_utf8_lossy(bytes).into_owned();
            bytes.clear();
            return text;
        }
    };
    let rest = bytes.split_off(valid);
    let text = String::from_utf8_lossy(bytes).into_owned();
    *bytes = rest;
    text
}

fn push_tail(tail: &Mutex<String>, text: &str) {
    let mut tail = lock(tail);
    tail.push_str(text);
    let chars = tail.chars().count();
    if chars > STDERR_TAIL_CHARS {
        let cut = tail
            .char_indices()
            .nth(chars - STDERR_TAIL_CHARS)
            .map_or(0, |(index, _)| index);
        tail.drain(..cut);
    }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

/// Parses and checks a server URL with Conn's messages.
pub(crate) fn parse_server_url(url: &str) -> Result<Url, String> {
    let url = Url::parse(url).map_err(|_| "Enter a full URL, such as https://app.test/mcp.")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https URLs can be used.".into());
    }
    Ok(url)
}

/// The user's headers; rows without a name are skipped.
pub(crate) fn header_map(headers: &[McpHeader]) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for header in headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("{name} is not a valid header name."))?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|_| format!("The {name} header has a value that cannot be sent."))?;
        map.append(name, value);
    }
    Ok(map)
}

pub(crate) fn http_client() -> Result<Client, String> {
    Client::builder()
        .build()
        .map_err(|error| format!("Could not set up HTTP: {error}"))
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
}

fn error_text(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// Reads JSON-RPC messages from an event stream until it ends. `endpoint` takes the legacy
/// transport's `endpoint` event.
async fn read_event_stream(
    mut response: reqwest::Response,
    inbound: &InboundTx,
    mut endpoint: Option<oneshot::Sender<String>>,
) {
    let mut parser = SseParser::default();
    while let Ok(Some(chunk)) = response.chunk().await {
        for event in parser.push(&chunk) {
            match event.event.as_str() {
                "endpoint" => {
                    if let Some(sender) = endpoint.take() {
                        let _ = sender.send(event.data);
                    }
                }
                "" | "message" => {
                    if let Ok(value) = serde_json::from_str::<Value>(&event.data) {
                        deliver(inbound, value);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Streamable HTTP: each message is a POST; answers come back as JSON or an event stream.
#[derive(Debug)]
pub(crate) struct HttpTransport {
    client: Client,
    url: Url,
    headers: HeaderMap,
    session: Mutex<Option<HeaderValue>>,
    protocol: Mutex<Option<HeaderValue>>,
    inbound: InboundTx,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl HttpTransport {
    pub(crate) fn new(url: Url, headers: HeaderMap, inbound: InboundTx) -> Result<Self, String> {
        Ok(Self {
            client: http_client()?,
            url,
            headers,
            session: Mutex::new(None),
            protocol: Mutex::new(None),
            inbound,
            tasks: Mutex::new(Vec::new()),
        })
    }

    fn request_headers(&self) -> HeaderMap {
        let mut headers = self.headers.clone();
        if let Some(session) = lock(&self.session).clone() {
            headers.insert(SESSION_HEADER, session);
        }
        if let Some(protocol) = lock(&self.protocol).clone() {
            headers.insert(PROTOCOL_HEADER, protocol);
        }
        headers
    }

    fn track(&self, handle: JoinHandle<()>) {
        let mut tasks = lock(&self.tasks);
        tasks.retain(|task| !task.is_finished());
        tasks.push(handle);
    }

    fn abort_tasks(&self) {
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let response = self
            .client
            .post(self.url.clone())
            .headers(self.request_headers())
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .body(message.to_string())
            .send()
            .await
            .map_err(|error| error_text(&error))?;
        if let Some(session) = response.headers().get(SESSION_HEADER) {
            *lock(&self.session) = Some(session.clone());
        }
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Error POSTing to endpoint (HTTP {}): {text}",
                status.as_u16()
            ));
        }
        if status == StatusCode::ACCEPTED {
            if message.get("method").and_then(Value::as_str) == Some("notifications/initialized") {
                self.open_get_stream();
            }
            return Ok(());
        }
        let is_request = message.get("method").is_some() && message.get("id").is_some();
        if is_event_stream(response.headers()) {
            let inbound = self.inbound.clone();
            self.track(tokio::spawn(async move {
                read_event_stream(response, &inbound, None).await;
            }));
            return Ok(());
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if content_type.starts_with("application/json") {
            let body = response.text().await.map_err(|error| error_text(&error))?;
            let value: Value = serde_json::from_str(&body)
                .map_err(|error| format!("The server sent invalid JSON: {error}"))?;
            deliver(&self.inbound, value);
            return Ok(());
        }
        if is_request {
            return Err(format!("Unexpected content type: {content_type}"));
        }
        Ok(())
    }

    /// The optional GET stream for messages the server starts; a 405 means it has none.
    fn open_get_stream(&self) {
        let request = self
            .client
            .get(self.url.clone())
            .headers(self.request_headers())
            .header(ACCEPT, "text/event-stream");
        let inbound = self.inbound.clone();
        self.track(tokio::spawn(async move {
            let Ok(response) = request.send().await else {
                return;
            };
            if response.status().is_success() && is_event_stream(response.headers()) {
                read_event_stream(response, &inbound, None).await;
            }
        }));
    }
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        self.abort_tasks();
    }
}

/// Legacy HTTP+SSE: one GET event stream for everything the server sends, and POSTs to the
/// endpoint its first event names.
#[derive(Debug)]
pub(crate) struct SseTransport {
    client: Client,
    endpoint: Url,
    headers: HeaderMap,
    protocol: Mutex<Option<HeaderValue>>,
    reader: JoinHandle<()>,
}

impl SseTransport {
    pub(crate) async fn connect(
        url: Url,
        headers: HeaderMap,
        inbound: InboundTx,
    ) -> Result<Self, String> {
        let client = http_client()?;
        let response = client
            .get(url.clone())
            .headers(headers.clone())
            .header(ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|error| format!("SSE error: {}", error_text(&error)))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "SSE error: Non-200 status code ({})",
                status.as_u16()
            ));
        }
        let (endpoint_tx, endpoint_rx) = oneshot::channel();
        let reader = tokio::spawn(async move {
            read_event_stream(response, &inbound, Some(endpoint_tx)).await;
            let _ = inbound.send(Inbound::Closed);
        });
        let Ok(path) = endpoint_rx.await else {
            reader.abort();
            return Err("SSE error: the stream ended before the server named its endpoint.".into());
        };
        let endpoint = match url.join(&path) {
            Ok(endpoint) if endpoint.origin() == url.origin() => endpoint,
            Ok(endpoint) => {
                reader.abort();
                return Err(format!(
                    "Endpoint origin does not match connection origin: {}",
                    endpoint.origin().ascii_serialization()
                ));
            }
            Err(error) => {
                reader.abort();
                return Err(format!("SSE error: bad endpoint {path}: {error}"));
            }
        };
        Ok(Self {
            client,
            endpoint,
            headers,
            protocol: Mutex::new(None),
            reader,
        })
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let mut headers = self.headers.clone();
        if let Some(protocol) = lock(&self.protocol).clone() {
            headers.insert(PROTOCOL_HEADER, protocol);
        }
        let response = self
            .client
            .post(self.endpoint.clone())
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .body(message.to_string())
            .send()
            .await
            .map_err(|error| error_text(&error))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "Error POSTing to endpoint (HTTP {}): {text}",
                status.as_u16()
            ));
        }
        Ok(())
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_utf8_for_the_next_chunk() {
        let mut bytes = "é".as_bytes()[..1].to_vec();
        assert_eq!(take_utf8(&mut bytes), "", "nothing yet");
        bytes.extend_from_slice(&"é".as_bytes()[1..]);
        bytes.extend_from_slice(b"x");
        assert_eq!(take_utf8(&mut bytes), "éx", "whole char");
        assert!(bytes.is_empty(), "drained");
    }

    #[test]
    fn keeps_the_stderr_tail() {
        let tail = Mutex::new(String::new());
        push_tail(&tail, &"a".repeat(1_500));
        push_tail(&tail, &"b".repeat(1_000));
        let tail = lock(&tail);
        assert_eq!(tail.len(), STDERR_TAIL_CHARS, "capped");
        assert!(tail.ends_with('b') && tail.starts_with('a'), "newest kept");
    }

    #[test]
    fn checks_urls_and_headers() {
        assert_eq!(
            parse_server_url("app.test/mcp").err().as_deref(),
            Some("Enter a full URL, such as https://app.test/mcp."),
            "relative"
        );
        assert_eq!(
            parse_server_url("ftp://x/").err().as_deref(),
            Some("Only http and https URLs can be used."),
            "scheme"
        );
        let headers = header_map(&[
            McpHeader {
                name: " Authorization ".into(),
                value: "Bearer t".into(),
            },
            McpHeader {
                name: " ".into(),
                value: "skipped".into(),
            },
        ])
        .expect("headers");
        assert_eq!(headers.len(), 1, "blank name skipped");
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer t"),
            "trimmed name"
        );
    }
}
