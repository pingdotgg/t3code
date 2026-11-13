//! One `codex app-server` process shared by every session of a provider instance, as the TS
//! server shares one per instance. It numbers requests, matches responses, and routes
//! notifications and server requests to the session that owns their native thread.
//!
//! The process starts on first use and is stopped when the last session closes. If it dies,
//! sessions get [`SessionMsg::Exited`], and the next request starts a new process; sessions
//! resume their thread on it (see `generation`).

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_provider_support::{
    lines::Line,
    process::{ExitInfo, LaunchSpec, ProcEvent, Process},
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::launch;
use crate::protocol::{Inbound, RpcError, notification, reply_error, request};

/// A line longer than this is dropped. Tool results with inline images stay below it.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The CLI release this crate was checked against: its printed schema (0.167.0) and the TS
/// recordings (0.156.1). Newer releases still work while the fields read here keep their
/// names; unknown methods and items are skipped and logged.
pub const TESTED_CLI_VERSION: &str = "0.167.0";
const SESSION_INBOX: usize = 256;

/// `(slug, display name)` pairs from `model/list`.
pub type ModelList = Vec<(String, String)>;
type OnModels = Box<dyn Fn(ModelList) + Send + Sync>;

#[derive(Debug)]
pub enum SessionMsg {
    Frame(Inbound),
    /// The app-server exited; open turns end.
    Exited(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The app-server is not running, or died before it answered.
    Stopped,
    Rpc(RpcError),
    Timeout,
    Spawn(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => f.write_str("the Codex app-server stopped"),
            Self::Rpc(e) => write!(f, "{e}"),
            Self::Timeout => f.write_str("the Codex app-server did not answer in time"),
            Self::Spawn(e) => write!(f, "could not start the Codex app-server: {e}"),
        }
    }
}

struct Live {
    process: Process,
    generation: u64,
    initialized: bool,
}

#[derive(Default)]
struct State {
    live: Option<Live>,
    generation: u64,
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>,
    routes: HashMap<String, mpsc::Sender<SessionMsg>>,
    /// Every open session's inbox, for exit notices; keyed by session id.
    sessions: HashMap<String, mpsc::Sender<SessionMsg>>,
    /// Set from the `initialize` answer.
    version: Option<String>,
}

pub struct AppServer {
    spec: LaunchSpec,
    state: Mutex<State>,
    /// Serializes start-up and `initialize`; never held by notification routing.
    starting: tokio::sync::Mutex<()>,
    /// Called once per process with the `model/list` entries.
    on_models: OnModels,
}

impl AppServer {
    pub fn new(
        spec: LaunchSpec,
        on_models: impl Fn(Vec<(String, String)>) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            spec,
            state: Mutex::new(State::default()),
            starting: tokio::sync::Mutex::new(()),
            on_models: Box::new(on_models),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn add_session(&self, session_id: &str, inbox: mpsc::Sender<SessionMsg>) {
        self.lock().sessions.insert(session_id.to_owned(), inbox);
    }

    /// Forgets a session; stops the process when it was the last one.
    pub async fn remove_session(&self, session_id: &str) {
        let live = {
            let mut state = self.lock();
            if let Some(inbox) = state.sessions.remove(session_id) {
                state.routes.retain(|_, r| !r.same_channel(&inbox));
            }
            if state.sessions.is_empty() {
                state.live.take()
            } else {
                None
            }
        };
        if let Some(live) = live {
            live.process.shutdown().await;
        }
    }

    pub fn route(&self, native_thread_id: &str, inbox: mpsc::Sender<SessionMsg>) {
        self.lock()
            .routes
            .insert(native_thread_id.to_owned(), inbox);
    }

    pub fn unroute(&self, native_thread_id: &str) {
        self.lock().routes.remove(native_thread_id);
    }

    /// The running process's generation, starting and initializing one when none runs.
    pub async fn ensure_started(self: &Arc<Self>) -> Result<u64, CallError> {
        let _guard = self.starting.lock().await;
        if let Some(live) = &self.lock().live
            && live.initialized
            && !live.process.has_exited()
        {
            return Ok(live.generation);
        }
        let (tx, rx) = mpsc::channel(SESSION_INBOX);
        let process = Process::spawn(&self.spec, MAX_LINE_BYTES, tx)
            .map_err(|e| CallError::Spawn(format!("{}: {e}", self.spec.program.display())))?;
        let generation = {
            let mut state = self.lock();
            state.generation += 1;
            let generation = state.generation;
            state.live = Some(Live {
                process,
                generation,
                initialized: false,
            });
            generation
        };
        tokio::spawn(self.clone().read(generation, rx));
        let init = match self
            .request_on(generation, "initialize", launch::initialize_params())
            .await
        {
            Ok(result) => Some(result),
            Err(CallError::Rpc(e)) if e.message == "Already initialized" => None,
            Err(e) => {
                let live = self.lock().live.take();
                if let Some(live) = live {
                    live.process.shutdown().await;
                }
                return Err(e);
            }
        };
        self.write(generation, notification("initialized")).await?;
        let version = init
            .as_ref()
            .and_then(|r| r["userAgent"].as_str())
            .and_then(|ua| ua.split('/').nth(1))
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned);
        if let Some(v) = &version
            && newer_minor(v, TESTED_CLI_VERSION)
        {
            eprintln!(
                "conn-provider-codex: codex {v} is newer than the tested {TESTED_CLI_VERSION}; unknown frames will be skipped"
            );
        }
        {
            let mut state = self.lock();
            state.version = version;
            if let Some(live) = state.live.as_mut().filter(|l| l.generation == generation) {
                live.initialized = true;
            }
        }
        tokio::spawn(self.clone().list_models(generation));
        Ok(generation)
    }

    pub fn version(&self) -> Option<String> {
        self.lock().version.clone()
    }

    async fn list_models(self: Arc<Self>, generation: u64) {
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let params = if cursor.is_null() {
                serde_json::json!({})
            } else {
                serde_json::json!({ "cursor": cursor })
            };
            let Ok(page) = self.request_on(generation, "model/list", params).await else {
                return;
            };
            for model in page["data"].as_array().into_iter().flatten() {
                if model["hidden"] == true {
                    continue;
                }
                if let Some(slug) = model["model"].as_str().or(model["id"].as_str()) {
                    let name = model["displayName"].as_str().unwrap_or(slug);
                    models.push((slug.to_owned(), name.to_owned()));
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() || models.len() > 500 {
                break;
            }
        }
        if !models.is_empty() {
            (self.on_models)(models);
        }
    }

    /// A request on the current process, starting it when needed.
    pub async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<Value, CallError> {
        let generation = self.ensure_started().await?;
        self.request_on(generation, method, params).await
    }

    async fn request_on(
        &self,
        generation: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, CallError> {
        let (id, rx) = {
            let mut state = self.lock();
            state.next_id += 1;
            let id = state.next_id;
            let (tx, rx) = oneshot::channel();
            state.pending.insert(id, tx);
            (id, rx)
        };
        if let Err(e) = self.write(generation, request(id, method, params)).await {
            self.lock().pending.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(e))) => Err(CallError::Rpc(e)),
            Ok(Err(_)) => Err(CallError::Stopped),
            Err(_) => {
                self.lock().pending.remove(&id);
                Err(CallError::Timeout)
            }
        }
    }

    /// Writes one line to the process of `generation`.
    pub async fn write(&self, generation: u64, line: String) -> Result<(), CallError> {
        let writer = self
            .lock()
            .live
            .as_ref()
            .filter(|l| l.generation == generation)
            .map(|l| l.process.writer())
            .ok_or(CallError::Stopped)?;
        writer.send(line).await.map_err(|_| CallError::Stopped)
    }

    pub fn generation(&self) -> Option<u64> {
        self.lock()
            .live
            .as_ref()
            .filter(|l| l.initialized && !l.process.has_exited())
            .map(|l| l.generation)
    }

    pub fn pid(&self) -> Option<u32> {
        self.lock().live.as_ref().map(|l| l.process.pid)
    }

    /// The router: one per process, ends after its exit.
    async fn read(self: Arc<Self>, generation: u64, mut rx: mpsc::Receiver<ProcEvent>) {
        let mut logged_oversized = false;
        while let Some(event) = rx.recv().await {
            match event {
                ProcEvent::Line(Line::Text(text)) => {
                    self.dispatch(generation, Inbound::decode(&text)).await
                }
                ProcEvent::Line(Line::Oversized(bytes)) => {
                    if !logged_oversized {
                        eprintln!("conn-provider-codex: dropped a {bytes}-byte app-server line");
                        logged_oversized = true;
                    }
                }
                ProcEvent::Exited(info) => {
                    self.on_exit(generation, &info).await;
                    return;
                }
            }
        }
    }

    async fn dispatch(&self, generation: u64, inbound: Inbound) {
        let target = match &inbound {
            Inbound::Response { id, result } => {
                if let Some(tx) = self.lock().pending.remove(id) {
                    let _ = tx.send(result.clone());
                }
                return;
            }
            Inbound::Notification { params, .. } | Inbound::Request { params, .. } => {
                let thread = params["threadId"]
                    .as_str()
                    .or_else(|| params["conversationId"].as_str());
                thread.and_then(|t| self.lock().routes.get(t).cloned())
            }
            Inbound::Invalid(_) => None,
        };
        match (target, inbound) {
            (Some(inbox), inbound) => {
                let _ = inbox.send(SessionMsg::Frame(inbound)).await;
            }
            (None, Inbound::Request { id, method, .. }) => {
                let line = reply_error(
                    &id,
                    -32603,
                    &format!("Conn Server has no session for {method}"),
                );
                let _ = self.write(generation, line).await;
            }
            _ => {}
        }
    }

    async fn on_exit(&self, generation: u64, info: &ExitInfo) {
        let inboxes: Vec<mpsc::Sender<SessionMsg>> = {
            let mut state = self.lock();
            let current = state
                .live
                .as_ref()
                .is_some_and(|l| l.generation == generation);
            if current {
                state.live = None;
            }
            // Requests waiting on the dead process fail with `Stopped`.
            state.pending.clear();
            state.sessions.values().cloned().collect()
        };
        let detail = format!(
            "The Codex app-server exited unexpectedly ({}).",
            info.describe()
        );
        for inbox in inboxes {
            let _ = inbox.send(SessionMsg::Exited(detail.clone())).await;
        }
    }
}

/// Whether `version` has a higher major or minor than `tested`.
fn newer_minor(version: &str, tested: &str) -> bool {
    let parse = |v: &str| -> (u64, u64) {
        let mut parts = v.split('.').map(|p| p.parse().unwrap_or(0));
        (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    };
    parse(version) > parse(tested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fake app-server in sh: answers `initialize` and one request, emits a notification for
    /// thread `t1`, then exits.
    fn fake(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            ..LaunchSpec::default()
        }
    }

    const FAKE: &str = r#"
read init
echo '{"id":1,"result":{"userAgent":"t3code_desktop/0.167.0 (x)"}}'
read initialized
read models
echo '{"id":2,"result":{"data":[{"model":"gpt-6-luna","displayName":"GPT-6-Luna","hidden":false}],"nextCursor":null}}'
read start
echo '{"method":"thread/started","params":{"threadId":"t1"}}'
echo '{"id":3,"result":{"thread":{"id":"t1"}}}'
read never
"#;

    #[tokio::test(flavor = "current_thread")]
    async fn routes_responses_and_notifications_then_reports_exit() {
        let models = Arc::new(Mutex::new(Vec::new()));
        let seen = models.clone();
        let server = AppServer::new(fake(FAKE), move |m| *seen.lock().unwrap() = m);
        let (tx, mut inbox) = mpsc::channel(8);
        server.add_session("s1", tx.clone());
        server.route("t1", tx);
        let generation = server.ensure_started().await.unwrap();
        assert_eq!(server.version().as_deref(), Some("0.167.0"));
        // Let the model listing take id 2 before the thread request.
        while models.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        assert_eq!(models.lock().unwrap()[0].0, "gpt-6-luna");
        let result = server
            .request_on(generation, "thread/start", json!({}))
            .await
            .unwrap();
        assert_eq!(result["thread"]["id"], "t1");
        let Some(SessionMsg::Frame(Inbound::Notification { method, .. })) = inbox.recv().await
        else {
            panic!("expected the routed notification")
        };
        assert_eq!(method, "thread/started");
        let pid = server.pid().unwrap();
        server.remove_session("s1").await;
        assert!(server.generation().is_none());
        let alive = conn_provider_support::process::pid_alive(pid);
        assert!(!alive, "the app-server outlived its last session");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_crash_fails_pending_requests_and_tells_sessions() {
        let server = AppServer::new(
            fake(
                r#"read init; echo '{"id":1,"result":{}}'; read initialized; read models; read req; exit 7"#,
            ),
            |_| {},
        );
        let (tx, mut inbox) = mpsc::channel(8);
        server.add_session("s1", tx);
        let generation = server.ensure_started().await.unwrap();
        let err = server
            .request_on(generation, "turn/start", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err, CallError::Stopped);
        let Some(SessionMsg::Exited(detail)) = inbox.recv().await else {
            panic!("expected an exit notice")
        };
        assert!(detail.contains("exit code 7"), "{detail}");
    }

    #[test]
    fn version_comparison() {
        assert!(newer_minor("0.168.0", "0.167.0"));
        assert!(!newer_minor("0.167.9", "0.167.0"));
        assert!(!newer_minor("0.156.1", "0.167.0"));
    }
}
