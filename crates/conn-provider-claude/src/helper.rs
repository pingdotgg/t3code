//! The SDK host (`helpers/sdk-host`, protocol in its `PROTOCOL.md`): one Node process that runs
//! vendor SDKs as the T3 server does. This crate uses its `claude` driver (the official Claude
//! Agent SDK) for every Claude query of a provider.
//!
//! The helper starts with the first query and stops when the last query has ended and no
//! session-file call is running, so an idle server has no helper. Each query gets its own event
//! channel; a router task per helper process reads the helper's stdout and sends each line to
//! its query, or to the waiting call.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_provider::{ProviderError, ProviderResult};
use conn_provider_support::lines::Line;
use conn_provider_support::process::{LaunchSpec, ProcEvent, Process};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

/// A helper line longer than this is dropped. Large tool results (images as base64) stay below.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// Events buffered per query before the router waits for that query's driver.
const QUERY_EVENT_CAPACITY: usize = 256;
/// Environment variable naming the helper (a Node single executable, or an `.mjs` script).
pub const HELPER_ENV: &str = "CONN_SDK_HOST";
/// The single-executable name looked for next to the server binary.
pub const HELPER_EXECUTABLE: &str = "conn-sdk-host";

/// How to start the helper.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl HelperCommand {
    /// A helper path: a script (`.mjs`, `.js`) runs under `node` from PATH, anything else is
    /// run directly (the single executable).
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let script = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e, "mjs" | "js" | "cjs"));
        if script {
            Self {
                program: PathBuf::from("node"),
                args: vec![path.to_string_lossy().into_owned()],
            }
        } else {
            Self {
                program: path,
                args: Vec::new(),
            }
        }
    }

    /// `$CONN_SDK_HOST`, else `conn-sdk-host` next to the running binary, else the checkout's
    /// `helpers/sdk-host/index.mjs` (development).
    pub fn discover() -> Self {
        if let Some(path) = std::env::var_os(HELPER_ENV).filter(|p| !p.is_empty()) {
            return Self::from_path(PathBuf::from(path));
        }
        if let Some(beside) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(HELPER_EXECUTABLE)))
            .filter(|p| p.is_file())
        {
            return Self::from_path(beside);
        }
        Self::from_path(development_script())
    }
}

/// `helpers/sdk-host/index.mjs` in this checkout.
pub fn development_script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../helpers/sdk-host/index.mjs")
}

/// What a query's driver receives.
#[derive(Debug)]
pub enum QueryEvent {
    /// An SDK message, as the SDK yields it.
    Message(Value),
    /// The SDK called one of our callbacks; answer with [`Query::answer`].
    Request {
        id: String,
        kind: String,
        args: Value,
    },
    /// The SDK withdrew a callback (the CLI cancelled its request).
    Cancel { id: String },
    /// The query ended; no more events follow.
    End(QueryEnd),
}

/// Why a query ended.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct QueryEnd {
    /// The SDK's error (`message`, and for a CLI exit `errorClass`, `telemetryMessage`).
    pub error: Option<Value>,
    /// The CLI's exit: `{code, signal}`.
    pub exit: Option<Value>,
    /// stderr of a CLI that failed before its first message (up to 2 KiB).
    pub stderr: Option<String>,
    /// The helper could not start the CLI, or the helper itself failed.
    pub helper_error: Option<String>,
}

impl QueryEnd {
    fn helper_failed(detail: impl Into<String>) -> Self {
        Self {
            helper_error: Some(detail.into()),
            ..Self::default()
        }
    }

    fn from_line(line: &Value) -> Self {
        let helper_error = line
            .get("spawnError")
            .map(|e| e["message"].as_str().unwrap_or("spawn failed").to_string());
        Self {
            error: line.get("error").cloned(),
            exit: line.get("exit").cloned(),
            stderr: line
                .get("stderr")
                .and_then(Value::as_str)
                .map(str::to_string),
            helper_error,
        }
    }
}

/// The shared helper. Cloning shares the same process.
#[derive(Clone)]
pub struct Helper {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Helper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Helper").finish_non_exhaustive()
    }
}

/// The host driver this crate uses.
pub const DRIVER: &str = "claude";

struct Inner {
    command: HelperCommand,
    /// The provider instance, named on every message.
    instance_id: String,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    generation: u64,
    next_id: u64,
    /// Open queries by id. An entry leaves when its `end` arrives.
    queries: HashMap<String, (u64, mpsc::Sender<QueryEvent>)>,
    /// Calls waiting for a `reply`, by request id.
    replies: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    /// Session-file calls in flight; they keep the helper up.
    holds: usize,
    /// Why the current host was stopped, for the sessions it ends.
    failure: Option<String>,
}

struct Running {
    process: Process,
    generation: u64,
}

impl Helper {
    pub fn new(command: HelperCommand, instance_id: &str) -> Self {
        Self {
            inner: Arc::new(Inner {
                command,
                instance_id: instance_id.to_string(),
                state: Mutex::new(State::default()),
            }),
        }
    }

    pub fn command(&self) -> &HelperCommand {
        &self.inner.command
    }

    /// The helper's pid while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.inner.lock().running.as_ref().map(|r| r.process.pid)
    }

    /// Opens a query with this option object. `extra` holds the open command's other fields
    /// (`subagentStartContext`, `wrap`).
    pub fn open(&self, options: Value, extra: Value) -> ProviderResult<Query> {
        let (tx, events) = mpsc::channel(QUERY_EVENT_CAPACITY);
        let (id, writer) = {
            let mut state = self.inner.lock();
            let writer = self.inner.ensure_running(&mut state)?;
            state.next_id += 1;
            let id = format!("q{}", state.next_id);
            let generation = state.generation;
            state.queries.insert(id.clone(), (generation, tx));
            (id, writer)
        };
        let mut command = json!({
            "t": "open", "driver": DRIVER, "instanceId": self.inner.instance_id,
            "sessionId": id, "options": options,
        });
        if let (Some(target), Value::Object(extra)) = (command.as_object_mut(), extra) {
            target.extend(extra);
        }
        if writer
            .try_send(crate::ordered::to_string(&command))
            .is_err()
        {
            self.inner.lock().queries.remove(&id);
            return Err(helper_err("the Claude helper is not accepting input"));
        }
        Ok(Query {
            id,
            helper: self.clone(),
            events: Some(events),
        })
    }

    /// Calls one of the SDK's session-file functions (`forkSession`, `getSessionMessages`,
    /// `getSubagentMessages`, `resolveSettings`). `config_dir` is the `CLAUDE_CONFIG_DIR` it
    /// reads; `None` for the default `~/.claude`.
    pub async fn function(
        &self,
        name: &str,
        args: Value,
        config_dir: Option<&str>,
        timeout: Duration,
    ) -> ProviderResult<Value> {
        let writer = {
            let mut state = self.inner.lock();
            let writer = self.inner.ensure_running(&mut state)?;
            state.holds += 1;
            writer
        };
        let mut command = json!({
            "t": "fn", "driver": DRIVER, "instanceId": self.inner.instance_id,
            "name": name, "args": args,
        });
        if let Some(dir) = config_dir {
            command["configDir"] = json!(dir);
        }
        let result = self.inner.request(&writer, command, timeout).await;
        self.inner.lock().holds -= 1;
        self.stop_if_idle().await;
        result.map_err(|detail| ProviderError::Failed {
            operation: "claude_sdk",
            detail: format!("{name}: {detail}"),
        })
    }

    /// Stops the helper when no query is open and no call runs. Waits for it to exit.
    pub async fn stop_if_idle(&self) {
        let running = {
            let mut state = self.inner.lock();
            if !state.queries.is_empty() || state.holds > 0 {
                return;
            }
            state.running.take()
        };
        if let Some(running) = running {
            running.process.shutdown().await;
        }
    }

    /// Stops the helper now, open queries or not (server stop). Their drivers get an `End`.
    pub async fn stop(&self) {
        let running = self.inner.lock().running.take();
        if let Some(running) = running {
            running.process.shutdown().await;
        }
        let (queries, replies) = {
            let mut state = self.inner.lock();
            (
                std::mem::take(&mut state.queries),
                std::mem::take(&mut state.replies),
            )
        };
        drop(replies);
        for (_, (_, tx)) in queries {
            let _ = tx
                .send(QueryEvent::End(QueryEnd::helper_failed(
                    "the Claude helper stopped",
                )))
                .await;
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    /// The running helper's stdin, starting the helper first if needed.
    fn ensure_running(self: &Arc<Self>, state: &mut State) -> ProviderResult<mpsc::Sender<String>> {
        if let Some(running) = state.running.as_ref().filter(|r| !r.process.has_exited()) {
            return Ok(running.process.writer());
        }
        let spec = LaunchSpec {
            program: self.command.program.clone(),
            args: self.command.args.clone(),
            cwd: None,
            // A user's NODE_OPTIONS could load code into the helper or break it.
            env_remove: vec!["NODE_OPTIONS".into()],
            env_set: Vec::new(),
        };
        let (tx, rx) = mpsc::channel(QUERY_EVENT_CAPACITY);
        let process = Process::spawn(&spec, MAX_LINE_BYTES, tx).map_err(|e| {
            helper_err(format!(
                "Could not start the SDK host ({}): {e}. Set --sdk-host or {HELPER_ENV}.",
                self.command.program.display()
            ))
        })?;
        state.generation += 1;
        let generation = state.generation;
        let writer = process.writer();
        state.running = Some(Running {
            process,
            generation,
        });
        tokio::spawn(route(self.clone(), generation, rx));
        Ok(writer)
    }

    async fn request(
        &self,
        writer: &mpsc::Sender<String>,
        mut command: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (id, rx) = {
            let mut state = self.lock();
            state.next_id += 1;
            let id = state.next_id;
            let (tx, rx) = oneshot::channel();
            state.replies.insert(id, tx);
            (id, rx)
        };
        command["id"] = json!(id);
        if writer
            .send(crate::ordered::to_string(&command))
            .await
            .is_err()
        {
            self.lock().replies.remove(&id);
            return Err("the Claude helper stopped".into());
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the Claude helper stopped".into()),
            Err(_) => {
                self.lock().replies.remove(&id);
                Err("no answer in time".into())
            }
        }
    }
}

/// Reads one helper process's output until it exits.
async fn route(inner: Arc<Inner>, generation: u64, mut rx: mpsc::Receiver<ProcEvent>) {
    while let Some(event) = rx.recv().await {
        match event {
            ProcEvent::Line(Line::Text(text)) => {
                let Ok(line) = serde_json::from_str::<Value>(&text) else {
                    eprintln!("conn-provider-claude: the SDK host wrote a line that is not JSON");
                    continue;
                };
                if line["ch"] == "host" && line["t"] == "ready" {
                    check_ready(&inner, generation, &line);
                    continue;
                }
                dispatch(&inner, line).await;
            }
            ProcEvent::Line(Line::Oversized(bytes)) => {
                eprintln!("conn-provider-claude: dropped a {bytes}-byte SDK host line");
            }
            ProcEvent::Exited(info) => {
                let (queries, replies, failure) = {
                    let mut state = inner.lock();
                    let failure = state.failure.take();
                    if state
                        .running
                        .as_ref()
                        .is_some_and(|r| r.generation == generation)
                    {
                        state.running = None;
                    }
                    // Queries of a newer helper stay. Replies cannot be told apart by
                    // process; they fail only when no helper runs.
                    let queries: Vec<_> = state
                        .queries
                        .iter()
                        .filter(|(_, (g, _))| *g == generation)
                        .map(|(id, _)| id.clone())
                        .collect();
                    let queries: Vec<_> = queries
                        .into_iter()
                        .filter_map(|id| state.queries.remove(&id))
                        .collect();
                    let replies = if state.running.is_none() {
                        std::mem::take(&mut state.replies)
                    } else {
                        HashMap::new()
                    };
                    (queries, replies, failure)
                };
                drop(replies);
                if !queries.is_empty() {
                    let tail: String = info.stderr_tail.chars().rev().take(300).collect();
                    let tail: String = tail.chars().rev().collect();
                    eprintln!(
                        "conn-provider-claude: the SDK host exited ({}): {}",
                        info.describe(),
                        tail.trim()
                    );
                }
                // Every session of this host ends: its turn fails with this text. The host's
                // `claude` children lose their fd 3 pipe, so their watchers send SIGTERM to each
                // CLI's process group and SIGKILL 5 s later (`host_death_ends_sessions_and_children`).
                let detail = failure
                    .unwrap_or_else(|| format!("The SDK host exited ({}).", info.describe()));
                for (_, tx) in queries {
                    let _ = tx
                        .send(QueryEvent::End(QueryEnd::helper_failed(detail.clone())))
                        .await;
                }
                return;
            }
        }
    }
}

/// The SDK host protocol version this server speaks (`PROTOCOL.md`).
pub const PROTOCOL_VERSION: u64 = 1;

/// The host's `ready` line: a host that speaks another protocol is stopped, and its sessions
/// end with the reason.
fn check_ready(inner: &Inner, generation: u64, line: &Value) {
    let version = line["protocol"].as_u64();
    if version == Some(PROTOCOL_VERSION) {
        return;
    }
    let detail = format!(
        "The SDK host speaks protocol {}, this server {PROTOCOL_VERSION}; rebuild helpers/sdk-host.",
        version.map_or_else(|| "none".to_string(), |v| v.to_string())
    );
    eprintln!("conn-provider-claude: {detail}");
    let mut state = inner.lock();
    if let Some(running) = state
        .running
        .as_ref()
        .filter(|r| r.generation == generation)
    {
        running.process.kill();
        state.failure = Some(detail);
    }
}

async fn dispatch(inner: &Inner, mut line: Value) {
    match line["ch"].as_str().unwrap_or("") {
        "reply" => {
            let Some(id) = line["id"].as_u64() else {
                return;
            };
            let result = if line["ok"] == json!(true) {
                Ok(line
                    .get_mut("value")
                    .map(Value::take)
                    .unwrap_or(Value::Null))
            } else {
                Err(line["error"]["message"]
                    .as_str()
                    .unwrap_or("the host call failed")
                    .to_string())
            };
            if let Some(tx) = inner.lock().replies.remove(&id) {
                let _ = tx.send(result);
            }
        }
        "sdk" => dispatch_sdk(inner, line).await,
        "log" => eprintln!(
            "conn-provider-claude: {} {}",
            line["level"].as_str().unwrap_or("info"),
            line["text"].as_str().unwrap_or_default()
        ),
        // Channels added later.
        _ => {}
    }
}

/// A session's SDK message, request, cancel or end.
async fn dispatch_sdk(inner: &Inner, mut line: Value) {
    let Some(query) = line["sessionId"].as_str().map(str::to_string) else {
        return;
    };
    let event = match line["t"].as_str().unwrap_or("") {
        "msg" => QueryEvent::Message(line.get_mut("m").map(Value::take).unwrap_or(Value::Null)),
        "request" => QueryEvent::Request {
            id: line["id"].as_str().unwrap_or_default().to_string(),
            kind: line["kind"].as_str().unwrap_or_default().to_string(),
            args: line.get_mut("args").map(Value::take).unwrap_or(Value::Null),
        },
        "cancel" => QueryEvent::Cancel {
            id: line["id"].as_str().unwrap_or_default().to_string(),
        },
        "end" => QueryEvent::End(QueryEnd::from_line(&line)),
        _ => return,
    };
    let end = matches!(event, QueryEvent::End(_));
    let tx = {
        let mut state = inner.lock();
        if end {
            state.queries.remove(&query).map(|(_, tx)| tx)
        } else {
            state.queries.get(&query).map(|(_, tx)| tx.clone())
        }
    };
    if let Some(tx) = tx {
        let _ = tx.send(event).await;
    }
}

fn helper_err(detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation: "sdk_host",
        detail: detail.into(),
    }
}

/// One open SDK query.
pub struct Query {
    id: String,
    helper: Helper,
    events: Option<mpsc::Receiver<QueryEvent>>,
}

impl std::fmt::Debug for Query {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Query")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Query {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The event stream; taken once by the query's driver.
    pub fn take_events(&mut self) -> Option<mpsc::Receiver<QueryEvent>> {
        self.events.take()
    }

    pub fn handle(&self) -> QueryHandle {
        QueryHandle {
            id: self.id.clone(),
            helper: self.helper.clone(),
        }
    }
}

/// A cheap reference to a query, for calls from any task.
#[derive(Clone)]
pub struct QueryHandle {
    id: String,
    helper: Helper,
}

impl std::fmt::Debug for QueryHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryHandle")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl QueryHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn helper(&self) -> &Helper {
        &self.helper
    }

    fn writer(&self) -> Option<mpsc::Sender<String>> {
        self.helper
            .inner
            .lock()
            .running
            .as_ref()
            .map(|r| r.process.writer())
    }

    /// Whether the helper still has this query open.
    pub fn is_open(&self) -> bool {
        self.helper.inner.lock().queries.contains_key(&self.id)
    }

    /// Pushes input (a prompt or a steer, an `SDKUserMessage`) into the session.
    pub async fn input(&self, message: Value, timeout: Duration) -> ProviderResult<Value> {
        let Some(writer) = self.writer().filter(|_| self.is_open()) else {
            return Err(ProviderError::SessionStopped);
        };
        let command = json!({"t": "input", "sessionId": self.id, "message": message});
        self.helper
            .inner
            .request(&writer, command, timeout)
            .await
            .map_err(|detail| ProviderError::Failed {
                operation: "input",
                detail,
            })
    }

    /// Calls a `Query` method (`interrupt`, `setModel`, ...).
    pub async fn call(
        &self,
        method: &str,
        args: Value,
        timeout: Duration,
    ) -> ProviderResult<Value> {
        let Some(writer) = self.writer().filter(|_| self.is_open()) else {
            return Err(ProviderError::SessionStopped);
        };
        let command = json!({"t": "call", "sessionId": self.id, "method": method, "args": args});
        self.helper
            .inner
            .request(&writer, command, timeout)
            .await
            .map_err(|detail| ProviderError::Failed {
                operation: "control",
                detail: format!("{method}: {detail}"),
            })
    }

    /// Settles a callback the SDK is waiting on.
    pub async fn answer(&self, id: &str, result: Result<Value, String>) {
        let Some(writer) = self.writer() else {
            return;
        };
        let command = match result {
            Ok(value) => json!({"t": "response", "sessionId": self.id, "id": id, "value": value}),
            Err(error) => json!({"t": "response", "sessionId": self.id, "id": id, "error": error}),
        };
        let _ = writer.send(crate::ordered::to_string(&command)).await;
    }

    /// Asks the SDK to close the query (stdin EOF, then the SDK's own kill sequence). The
    /// query's `End` follows once the CLI exited.
    pub async fn close(&self) {
        if let Some(writer) = self.writer() {
            let _ = writer
                .send(json!({"t": "close", "sessionId": self.id}).to_string())
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_run_under_node_and_executables_directly() {
        let script = HelperCommand::from_path("/x/index.mjs");
        assert_eq!(script.program, PathBuf::from("node"));
        assert_eq!(script.args, ["/x/index.mjs"]);
        let sea = HelperCommand::from_path("/x/conn-sdk-host");
        assert_eq!(sea.program, PathBuf::from("/x/conn-sdk-host"));
        assert!(sea.args.is_empty());
    }

    /// The rule when the host dies: every open session ends with a helper error, and each
    /// `claude` child is stopped by its fd 3 watcher (SIGTERM, SIGKILL 5 s later). Needs `node`
    /// and `npm ci` in helpers/sdk-host; skipped without them.
    #[tokio::test(flavor = "current_thread")]
    async fn host_death_ends_sessions_and_children() {
        // `CONN_SDK_HOST` runs it on that host, such as the single executable.
        let command = if std::env::var_os(HELPER_ENV).is_some_and(|p| !p.is_empty()) {
            HelperCommand::discover()
        } else {
            let script = development_script();
            let modules = script
                .parent()
                .map(|d| d.join("node_modules/@anthropic-ai/claude-agent-sdk"));
            if !modules.is_some_and(|m| m.is_dir()) {
                eprintln!("skipped: run npm ci in helpers/sdk-host");
                return;
            }
            HelperCommand::from_path(&script)
        };
        let dir = std::env::temp_dir().join(format!("conn-host-death-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A CLI that ignores stdin and SIGTERM: only the watcher's SIGKILL can end it.
        let stub = dir.join("claude");
        let pid_file = dir.join("pid");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\necho $$ > {}\ntrap '' TERM\nwhile :; do sleep 1; done\n",
                pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let helper = Helper::new(command, "claudeAgent");
        let mut query = helper
            .open(
                json!({"model": "x", "pathToClaudeCodeExecutable": stub, "cwd": dir}),
                json!({}),
            )
            .unwrap();
        let mut events = query.take_events().unwrap();
        let mut cli = None;
        for _ in 0..100 {
            cli = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|p| p.trim().parse::<u32>().ok());
            if cli.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let cli = cli.expect("the CLI started");
        let host = helper.pid().unwrap();
        let killed = std::process::Command::new("kill")
            .args(["-KILL", &host.to_string()])
            .status()
            .unwrap();
        assert!(killed.success());
        let end = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match events.recv().await {
                    Some(QueryEvent::End(end)) => return Some(end),
                    Some(_) => continue,
                    None => return None,
                }
            }
        })
        .await
        .unwrap();
        assert!(
            end.and_then(|e| e.helper_error)
                .is_some_and(|d| d.contains("SDK host exited")),
            "the session ended with the host's death"
        );
        // SIGTERM is ignored; the watcher's SIGKILL follows 5 s later.
        let gone = conn_provider_support::process::wait_gone(cli, Duration::from_secs(9)).await;
        let _ = std::fs::remove_dir_all(&dir);
        assert!(gone, "the CLI was stopped by its watcher");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_host_with_another_protocol_is_stopped() {
        let dir = std::env::temp_dir().join(format!("conn-host-version-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("host");
        std::fs::write(
            &fake,
            "#!/bin/sh\necho '{\"ch\":\"host\",\"t\":\"ready\",\"protocol\":99}'\nexec sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let helper = Helper::new(HelperCommand::from_path(&fake), "claudeAgent");
        let mut query = helper.open(json!({}), json!({})).unwrap();
        let mut events = query.take_events().unwrap();
        let end = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let Some(QueryEvent::End(end)) = end else {
            panic!("expected the session to end");
        };
        assert!(
            end.helper_error
                .is_some_and(|d| d.contains("speaks protocol 99"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_missing_helper_is_a_provider_error() {
        let helper = Helper::new(
            HelperCommand::from_path("/nonexistent/conn-sdk-host"),
            "claudeAgent",
        );
        let error = helper.open(json!({}), json!({})).err();
        assert!(
            matches!(&error, Some(ProviderError::Failed { detail, .. }) if detail.contains("Could not start the SDK host")),
            "{error:?}"
        );
        assert_eq!(helper.pid(), None);
    }
}
