//! The MCP panel's sessions (Conn's `apps/desktop/src/ipc/methods/mcp.ts`).
//!
//! One [`McpSessions`] belongs to one window, as Conn keys sessions by the window that opened
//! them: a window never reaches another window's session. Every JSON-RPC message and the
//! server's stderr go out on the event channel for the panel's Log tab.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::events::Emitter;
use super::rpc::{Rpc, dispatch};
use super::shell_env::login_shell_environment;
use super::transport::{
    HttpTransport, SpawnError, SseTransport, StdioSpawn, StdioTransport, Transport, header_map,
    parse_server_url,
};
use super::types::{
    MAX_COMMAND_CHARS, MAX_URL_CHARS, McpCapabilities, McpConnectRequest, McpConnectResponse,
    McpEvent, McpEventKind, McpMethod, McpRequest, McpResponse, McpServer, McpServerInfo,
};

/// How long `initialize` (and starting the transport) may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a tool call, resource read, or prompt get may take.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long any other request may take (the SDK's default).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The most pages a list request follows through `nextCursor`.
pub const MAX_LIST_PAGES: usize = 50;

/// The protocol version the panel asks for, and the ones it accepts back.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

const CONNECT_TIMEOUT_ERROR: &str = "The server did not finish connecting within 30 seconds.";
const NOT_CONNECTED: &str = "The server is not connected.";

/// How the panel names itself to servers, and the environment stdio servers start from.
#[derive(Debug, Clone)]
pub struct McpOptions {
    /// `clientInfo.name`; Conn sends `t3code-mcp-panel`.
    pub client_name: String,
    /// `clientInfo.version`: the app's version.
    pub client_version: String,
    /// The base environment for stdio servers. `None` reads the login shell's (once).
    pub environment: Option<HashMap<String, String>>,
    /// The event channel's capacity.
    pub event_capacity: usize,
}

impl Default for McpOptions {
    fn default() -> Self {
        Self {
            client_name: "t3code-mcp-panel".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            environment: None,
            event_capacity: 1_024,
        }
    }
}

#[derive(Debug)]
struct Session {
    serial: u64,
    rpc: Arc<Rpc>,
    stderr_tail: Arc<Mutex<String>>,
}

impl Session {
    async fn shutdown(&self) {
        self.rpc.emitter().retire();
        self.rpc.transport.close().await;
        self.rpc.fail_pending();
    }
}

#[derive(Debug)]
struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    events: mpsc::Sender<McpEvent>,
    options: McpOptions,
    next_serial: AtomicU64,
}

impl Inner {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Session>>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Removes the session if it is still the one with `serial`.
    fn take(&self, session_id: &str, serial: u64) -> Option<Arc<Session>> {
        let mut sessions = self.sessions();
        if sessions.get(session_id)?.serial != serial {
            return None;
        }
        sessions.remove(session_id)
    }

    /// The transport ended on its own: retire the session, tell the panel, stop the server.
    fn closed(self: &Arc<Self>, session_id: &str, serial: u64) {
        let Some(session) = self.take(session_id, serial) else {
            return;
        };
        if !session.rpc.emitter().retire() {
            return;
        }
        tokio::spawn(async move {
            session
                .rpc
                .emitter()
                .emit_always(McpEventKind::Closed)
                .await;
            session.shutdown().await;
        });
    }
}

/// One window's MCP sessions. Cheap to clone; clones share the sessions.
#[derive(Debug, Clone)]
pub struct McpSessions {
    inner: Arc<Inner>,
}

impl McpSessions {
    /// Sessions with Conn's defaults, and the receiver of their events. Keep draining the
    /// receiver: the channel is bounded, so an undrained one stalls the sessions' traffic.
    pub fn new() -> (Self, mpsc::Receiver<McpEvent>) {
        Self::with_options(McpOptions::default())
    }

    pub fn with_options(options: McpOptions) -> (Self, mpsc::Receiver<McpEvent>) {
        let (events, receiver) = mpsc::channel(options.event_capacity.max(1));
        let inner = Arc::new(Inner {
            sessions: Mutex::new(HashMap::new()),
            events,
            options,
            next_serial: AtomicU64::new(1),
        });
        (Self { inner }, receiver)
    }

    /// True while `session_id` has a live session.
    pub fn is_connected(&self, session_id: &str) -> bool {
        self.inner.sessions().contains_key(session_id)
    }

    /// True while any session is live.
    pub fn has_sessions(&self) -> bool {
        !self.inner.sessions().is_empty()
    }

    /// Connects `request.server` under `request.session_id`, replacing a session with that id.
    /// Never fails: the response carries `error` or `info`.
    pub async fn connect(&self, request: McpConnectRequest) -> McpConnectResponse {
        let started = Instant::now();
        self.disconnect(&request.session_id).await;
        let serial = self.inner.next_serial.fetch_add(1, Ordering::SeqCst);
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let outcome = tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.open(&request, serial, Arc::clone(&stderr_tail)),
        )
        .await;
        let message = match outcome {
            Ok(Ok(info)) => {
                return McpConnectResponse {
                    error: None,
                    info: Some(info),
                    duration_ms: elapsed_ms(started),
                };
            }
            Ok(Err(message)) => message,
            Err(_) => CONNECT_TIMEOUT_ERROR.to_owned(),
        };
        if let Some(session) = self.inner.take(&request.session_id, serial) {
            if session.rpc.is_closed() {
                session.rpc.transport.settle_stderr().await;
            }
            session.shutdown().await;
        }
        let stderr = stderr_tail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .trim()
            .to_owned();
        McpConnectResponse {
            error: Some(if stderr.is_empty() {
                message
            } else {
                format!("{message}\n\n{stderr}")
            }),
            info: None,
            duration_ms: elapsed_ms(started),
        }
    }

    async fn open(
        &self,
        request: &McpConnectRequest,
        serial: u64,
        stderr_tail: Arc<Mutex<String>>,
    ) -> Result<McpServerInfo, String> {
        let emitter = Emitter::new(self.inner.events.clone(), request.session_id.clone());
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let transport = match &request.server {
            McpServer::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                if command.chars().count() > MAX_COMMAND_CHARS {
                    return Err(format!(
                        "The command is longer than {MAX_COMMAND_CHARS} characters."
                    ));
                }
                let cwd = stdio_cwd(cwd.as_deref())?;
                let mut environment = match &self.inner.options.environment {
                    Some(environment) => environment.clone(),
                    None => login_shell_environment().await,
                };
                // The server must not inherit an Electron-as-Node switch.
                environment.remove("ELECTRON_RUN_AS_NODE");
                environment.extend(
                    env.iter()
                        .map(|(name, value)| (name.clone(), value.clone())),
                );
                let spawned = StdioTransport::spawn(
                    StdioSpawn {
                        command,
                        args,
                        env: environment,
                        cwd: &cwd,
                    },
                    inbound_tx,
                    emitter.clone(),
                    Arc::clone(&stderr_tail),
                );
                match spawned {
                    Ok(transport) => Transport::Stdio(transport),
                    Err(SpawnError::NotFound) => {
                        return Err(format!("{command} was not found on this machine's PATH."));
                    }
                    Err(SpawnError::Other(message)) => return Err(message),
                }
            }
            McpServer::Http { url, headers } => {
                check_url_length(url)?;
                let url = parse_server_url(url)?;
                Transport::Http(HttpTransport::new(url, header_map(headers)?, inbound_tx)?)
            }
            McpServer::Sse { url, headers } => {
                check_url_length(url)?;
                let url = parse_server_url(url)?;
                Transport::Sse(SseTransport::connect(url, header_map(headers)?, inbound_tx).await?)
            }
        };
        let rpc = Arc::new(Rpc::new(transport, emitter));
        let session = Arc::new(Session {
            serial,
            rpc: Arc::clone(&rpc),
            stderr_tail,
        });
        self.inner
            .sessions()
            .insert(request.session_id.clone(), session);
        let inner: Weak<Inner> = Arc::downgrade(&self.inner);
        let session_id = request.session_id.clone();
        tokio::spawn(dispatch(Arc::downgrade(&rpc), inbound_rx, move || {
            if let Some(inner) = inner.upgrade() {
                inner.closed(&session_id, serial);
            }
        }));
        initialize(&rpc, &self.inner.options).await
    }

    /// Calls one of the panel's methods. List methods follow `nextCursor` (up to
    /// [`MAX_LIST_PAGES`]) and answer with the whole list. Never fails: the response carries
    /// `error` or `result`.
    pub async fn request(&self, request: McpRequest) -> McpResponse {
        let started = Instant::now();
        let session = self.inner.sessions().get(&request.session_id).cloned();
        let Some(session) = session else {
            return McpResponse::failed(NOT_CONNECTED, 0.0);
        };
        match call(&session.rpc, request.method, request.params).await {
            Ok(result) => McpResponse {
                error: None,
                result,
                duration_ms: elapsed_ms(started),
            },
            Err(error) => McpResponse::failed(error, elapsed_ms(started)),
        }
    }

    /// Ends the session and stops its server. Unknown ids are ignored.
    pub async fn disconnect(&self, session_id: &str) {
        let session = self.inner.sessions().remove(session_id);
        if let Some(session) = session {
            session.shutdown().await;
        }
    }

    /// Ends every session, as Conn does when its window closes or reloads.
    pub async fn disconnect_all(&self) {
        let sessions: Vec<Arc<Session>> = self.inner.sessions().drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.shutdown().await;
        }
    }

    /// The last stderr of a stdio session (up to 2,000 characters).
    pub fn stderr_tail(&self, session_id: &str) -> Option<String> {
        let session = self.inner.sessions().get(session_id).cloned()?;
        let tail = session
            .stderr_tail
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Some(tail)
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

fn check_url_length(url: &str) -> Result<(), String> {
    if url.chars().count() > MAX_URL_CHARS {
        return Err(format!(
            "The URL is longer than {MAX_URL_CHARS} characters."
        ));
    }
    Ok(())
}

/// The folder a stdio server runs in: the given one, else the home folder.
fn stdio_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let cwd = match cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => PathBuf::from(cwd),
        None => std::env::home_dir().unwrap_or_else(|| PathBuf::from("/")),
    };
    if !cwd.exists() {
        return Err(format!(
            "The folder {} is not on this machine. Set the server's folder.",
            cwd.display()
        ));
    }
    Ok(cwd)
}

async fn initialize(rpc: &Rpc, options: &McpOptions) -> Result<McpServerInfo, String> {
    let result = rpc
        .request(
            "initialize",
            Some(json!({
                "protocolVersion": LATEST_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": options.client_name, "version": options.client_version },
            })),
            REQUEST_TIMEOUT,
        )
        .await?;
    let protocol_version = result
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match protocol_version.as_deref() {
        Some(version) if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) => {
            rpc.transport.set_protocol_version(version);
        }
        other => {
            return Err(format!(
                "Server's protocol version is not supported: {}",
                other.unwrap_or("none")
            ));
        }
    }
    rpc.notify("notifications/initialized", None).await?;
    Ok(server_info(&result, protocol_version))
}

fn server_info(result: &Value, protocol_version: Option<String>) -> McpServerInfo {
    let server = result.get("serverInfo");
    let text = |name: &str| {
        server
            .and_then(|server| server.get(name))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let capabilities = result.get("capabilities");
    let has =
        |name: &str| capabilities.is_some_and(|capabilities| capabilities.get(name).is_some());
    McpServerInfo {
        name: text("name").unwrap_or_else(|| "MCP server".into()),
        title: text("title"),
        version: text("version").unwrap_or_default(),
        protocol_version,
        instructions: result
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::to_owned),
        capabilities: McpCapabilities {
            tools: has("tools"),
            resources: has("resources"),
            prompts: has("prompts"),
            logging: has("logging"),
        },
    }
}

async fn call(rpc: &Rpc, method: McpMethod, params: Value) -> Result<Value, String> {
    if let Some(key) = method.list_key() {
        return list_all(rpc, method, key).await;
    }
    match method {
        McpMethod::Ping => rpc.request("ping", None, REQUEST_TIMEOUT).await,
        _ => {
            rpc.request(method.as_str(), Some(params), CALL_TIMEOUT)
                .await
        }
    }
}

/// Follows `nextCursor` so the panel gets the whole list in one result.
async fn list_all(rpc: &Rpc, method: McpMethod, key: &str) -> Result<Value, String> {
    let mut items: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_LIST_PAGES {
        let params = cursor.take().map(|cursor| json!({ "cursor": cursor }));
        let result = rpc
            .request(method.as_str(), params, REQUEST_TIMEOUT)
            .await?;
        if let Some(Value::Array(page)) = result.get(key) {
            items.extend(page.iter().cloned());
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(json!({ key: items }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_server_info() {
        let info = server_info(
            &json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {}, "logging": {} },
                "serverInfo": { "name": "demo", "version": "1.0.0" },
                "instructions": "Be nice."
            }),
            Some("2025-06-18".into()),
        );
        assert_eq!(info.name, "demo", "name");
        assert_eq!(info.title, None, "title");
        assert!(info.capabilities.tools && info.capabilities.logging, "caps");
        assert!(
            !info.capabilities.resources && !info.capabilities.prompts,
            "no caps"
        );
        assert_eq!(
            info.instructions.as_deref(),
            Some("Be nice."),
            "instructions"
        );
    }

    #[test]
    fn rejects_a_missing_folder() {
        assert_eq!(
            stdio_cwd(Some("/definitely/not/here")).err().as_deref(),
            Some(
                "The folder /definitely/not/here is not on this machine. Set the server's folder."
            ),
            "missing folder"
        );
        assert!(stdio_cwd(Some("  ")).is_ok(), "blank is home");
    }

    #[tokio::test]
    async fn unknown_sessions_are_not_connected() {
        let (sessions, _events) = McpSessions::new();
        let response = sessions
            .request(McpRequest {
                session_id: "nope".into(),
                method: McpMethod::Ping,
                params: Value::Null,
            })
            .await;
        assert_eq!(response.error.as_deref(), Some(NOT_CONNECTED), "error");
        assert_eq!(response.duration_ms, 0.0, "duration");
    }
}
