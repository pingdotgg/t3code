//! One `codex app-server` process shared by every session of a provider instance, as the TS
//! server shares one per instance. It numbers requests, matches responses, and routes
//! notifications and server requests to the session that owns their native thread.
//!
//! The process starts on first use and is stopped when the last session closes. If it dies,
//! sessions get [`SessionMsg::Exited`], and the next request starts a new process; sessions
//! resume their thread on it (see `generation`).

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_provider_support::{
    lines::Line,
    process::{ExitInfo, LaunchSpec, ProcEvent, Process},
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{Inbound, RpcError, notification, reply_error, request};
use crate::{launch, network_gate};

/// A line longer than this is dropped. Tool results with inline images stay below it.
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// SIGTERM, then SIGKILL after this (`CODEX_APP_SERVER_FORCE_KILL_AFTER` in TS).
pub const FORCE_KILL_AFTER: Duration = Duration::from_secs(2);
/// The CLI release this crate was checked against: its printed schema (0.167.0) and the TS
/// recordings (0.156.1). Newer releases still work while the fields read here keep their
/// names; unknown methods and items are skipped and logged.
pub const TESTED_CLI_VERSION: &str = "0.167.0";
const SESSION_INBOX: usize = 256;
/// Frames of threads no session owns yet, kept for the session whose frame names the thread
/// later: a subagent's `turn/started` and MCP start-up status can come before the frame that
/// names the child (T3 sees every frame and holds such turns in `pendingSubagentTurns`).
const UNROUTED_KEPT: usize = 32;

/// The child threads a frame names (`withCodexReplayChildMetadata` reads the same fields): a
/// `subAgentActivity` item's agent thread, a `collabAgentToolCall` item's receivers.
fn named_children(params: &Value) -> Vec<String> {
    let item = &params["item"];
    match item["type"].as_str() {
        Some("subAgentActivity") => item["agentThreadId"]
            .as_str()
            .map(str::to_owned)
            .into_iter()
            .collect(),
        Some("collabAgentToolCall") => item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

#[derive(Debug)]
pub enum SessionMsg {
    Frame(Inbound),
    /// The app-server exited; open turns end.
    Exited(String),
    /// The answer to a child thread's metadata read (`Value::Null` when none came).
    ChildMetadata {
        thread: String,
        response: Value,
    },
    /// What Codex says about a closed session's silent subagent thread.
    ChildRead {
        thread: String,
        read: ChildRead,
    },
    /// A held goal run's grace ran out ([`crate::mapper::Out::GoalHeld`]).
    GoalGrace {
        thread: String,
        seq: u64,
    },
    /// The answer to the pause that ends a goal Codex did not continue (`None`: none came).
    GoalPaused {
        thread: String,
        response: Option<Value>,
    },
}

/// A closed session's check of a silent subagent thread with Codex (`thread/read` with turns).
#[derive(Debug)]
pub enum ChildRead {
    /// Codex answered: a turn it reports ended ends here with that status.
    Turns(Value),
    /// Codex does not know the thread (`isCodexThreadNotFoundError`), so nothing runs there.
    Missing,
}

/// How [`AppServer::claim_route`] found a native thread's route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    /// It had none; the claimant routes it now.
    Taken,
    /// It already led to the claimant.
    Held,
    /// It leads to another session, which keeps it until the claimant takes it over.
    Elsewhere,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CallError {
    /// The app-server is not running, or died before it answered.
    #[error("the Codex app-server stopped")]
    Stopped,
    #[error(transparent)]
    Rpc(RpcError),
    #[error("the Codex app-server did not answer in time")]
    Timeout,
    #[error("could not start the Codex app-server: {0}")]
    Spawn(String),
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
    /// Deltas dropped because a session's inbox was full (logged once).
    dropped_deltas: u64,
    /// Native threads loaded on a process (started, resumed or forked there), by generation.
    loaded: HashMap<String, u64>,
    /// At most [`UNROUTED_KEPT`] frames, oldest first, with the native thread they name.
    unrouted: VecDeque<(String, Inbound)>,
    /// Closed sessions that wait for their subagents, by session id: the process generation
    /// they wait on and their inbox. That process's exit ends them. At most one per session.
    detached: HashMap<String, (u64, mpsc::Sender<SessionMsg>)>,
}

pub struct AppServer {
    spec: LaunchSpec,
    /// The Orbit MCP network wait, run once before the first spawn.
    gate: Option<network_gate::Gate>,
    gate_done: tokio::sync::OnceCell<()>,
    state: Mutex<State>,
    /// Serializes start-up and `initialize`; never held by notification routing.
    starting: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for AppServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppServer").finish_non_exhaustive()
    }
}

impl AppServer {
    /// The T3 server sends a session's app-server nothing beyond `initialize` until a thread
    /// call (no `model/list`: its model catalog comes from a separate status probe).
    pub fn new(spec: LaunchSpec) -> Arc<Self> {
        Self::with_gate(spec, None)
    }

    pub fn with_gate(spec: LaunchSpec, gate: Option<network_gate::Gate>) -> Arc<Self> {
        Arc::new(Self {
            spec,
            gate,
            gate_done: tokio::sync::OnceCell::new(),
            state: Mutex::new(State::default()),
            starting: tokio::sync::Mutex::new(()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    pub fn add_session(&self, session_id: &str, inbox: mpsc::Sender<SessionMsg>) {
        self.lock().sessions.insert(session_id.to_owned(), inbox);
    }

    /// Forgets a session; stops the process when it was the last one. True when a running
    /// process keeps serving other sessions. `keep` names native threads whose frames still
    /// go to the session's inbox: subagents that may outlive it on a shared process, as T3
    /// keeps their turn contexts after a release. They end with their own frames or the exit.
    pub async fn remove_session(&self, session_id: &str, keep: &[String]) -> bool {
        let process = self.detach(session_id, keep);
        let shared = {
            let state = self.lock();
            !state.sessions.is_empty() && state.live.is_some()
        };
        if let Some(process) = process {
            process.terminate(FORCE_KILL_AFTER).await;
        }
        shared
    }

    /// Forgets a session without waiting: the sync half of [`Self::remove_session`]. Returns
    /// the process to stop when no session is left.
    pub(crate) fn detach_session(&self, session_id: &str) -> Option<Process> {
        self.detach(session_id, &[])
    }

    fn detach(&self, session_id: &str, keep: &[String]) -> Option<Process> {
        let mut state = self.lock();
        if let Some(inbox) = state.sessions.remove(session_id) {
            state
                .routes
                .retain(|thread, r| !r.same_channel(&inbox) || keep.contains(thread));
            if !keep.is_empty()
                && !state.sessions.is_empty()
                && let Some(generation) = state.live.as_ref().map(|l| l.generation)
            {
                state
                    .detached
                    .insert(session_id.to_owned(), (generation, inbox));
            }
        }
        if state.sessions.is_empty() {
            state.live.take().map(|live| live.process)
        } else {
            None
        }
    }

    /// Records that `native` is loaded on the running process.
    pub fn mark_loaded(&self, native: &str) {
        let mut state = self.lock();
        if let Some(generation) = state.live.as_ref().map(|l| l.generation) {
            state.loaded.insert(native.to_owned(), generation);
        }
    }

    /// Whether the running process holds `native`, so a session can use it without
    /// `thread/resume` (TS starts a turn on a thread it forked without resuming it).
    pub fn is_loaded(&self, native: &str) -> bool {
        let state = self.lock();
        let live = state
            .live
            .as_ref()
            .filter(|l| l.initialized && !l.process.has_exited());
        live.is_some_and(|l| state.loaded.get(native) == Some(&l.generation))
    }

    pub fn forget_loaded(&self, native: &str) {
        self.lock().loaded.remove(native);
    }

    /// How many sessions share the process.
    pub fn session_count(&self) -> usize {
        self.lock().sessions.len()
    }

    pub fn route(&self, native_thread_id: &str, inbox: mpsc::Sender<SessionMsg>) {
        self.lock()
            .routes
            .insert(native_thread_id.to_owned(), inbox);
    }

    /// Routes `native_thread_id` to `inbox` unless another session owns it: that session keeps
    /// its frames until the claimant takes the thread over ([`Self::route`]).
    pub fn claim_route(&self, native_thread_id: &str, inbox: &mpsc::Sender<SessionMsg>) -> Claim {
        let mut state = self.lock();
        match state.routes.get(native_thread_id) {
            Some(r) if r.same_channel(inbox) => Claim::Held,
            Some(_) => Claim::Elsewhere,
            None => {
                state
                    .routes
                    .insert(native_thread_id.to_owned(), inbox.clone());
                Claim::Taken
            }
        }
    }

    /// Removes the route of `native_thread_id` while it leads to `inbox`.
    pub fn unroute_from(&self, native_thread_id: &str, inbox: &mpsc::Sender<SessionMsg>) {
        let mut state = self.lock();
        if state
            .routes
            .get(native_thread_id)
            .is_some_and(|r| r.same_channel(inbox))
        {
            state.routes.remove(native_thread_id);
        }
    }

    /// A closed session stopped waiting for its subagents.
    pub fn forget_detached(&self, session_id: &str) {
        self.lock().detached.remove(session_id);
    }

    pub fn unroute(&self, native_thread_id: &str) {
        self.lock().routes.remove(native_thread_id);
    }

    /// Removes every route that leads to `inbox`.
    pub fn unroute_inbox(&self, inbox: &mpsc::Sender<SessionMsg>) {
        self.lock().routes.retain(|_, r| !r.same_channel(inbox));
    }

    /// The running process's generation, starting and initializing one when none runs.
    pub async fn ensure_started(self: &Arc<Self>) -> Result<u64, CallError> {
        let _guard = self.starting.lock().await;
        // A call that outlived its session (Stop during a turn start) must not start a
        // process that no session owns and nothing would stop.
        if self.lock().sessions.is_empty() {
            return Err(CallError::Stopped);
        }
        if let Some(live) = &self.lock().live
            && live.initialized
            && !live.process.has_exited()
        {
            return Ok(live.generation);
        }
        if let Some(gate) = &self.gate {
            self.gate_done
                .get_or_init(|| async {
                    let result = gate.wait().await;
                    if !result.ready || result.waited >= Duration::from_secs(1) {
                        eprintln!(
                            "conn-provider-codex: Orbit MCP hosts {} after {} ms: {:?}{}",
                            if result.ready {
                                "reachable"
                            } else {
                                "unreachable, starting anyway"
                            },
                            result.waited.as_millis(),
                            result.hosts,
                            if result.pending.is_empty() {
                                String::new()
                            } else {
                                format!(", pending {:?}", result.pending)
                            },
                        );
                    }
                })
                .await;
        }
        let (tx, rx) = mpsc::channel(SESSION_INBOX);
        let process = Process::spawn(&self.spec, MAX_LINE_BYTES, tx)
            .map_err(|e| CallError::Spawn(format!("{}: {e}", self.spec.program.display())))?;
        let generation = {
            let mut state = self.lock();
            state.generation += 1;
            let generation = state.generation;
            state.loaded.clear();
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
                    live.process.terminate(FORCE_KILL_AFTER).await;
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
        Ok(generation)
    }

    pub fn version(&self) -> Option<String> {
        self.lock().version.clone()
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

    /// Writes a request and returns its answer as a [`Reply`] that owns everything it needs,
    /// so the wait can move to another task. Once this returns, the line is on its way to
    /// the process: a caller that gives up on the answer knows the request went out.
    pub async fn send(self: &Arc<Self>, method: &str, params: Value) -> Result<Reply, CallError> {
        let generation = self.ensure_started().await?;
        let (id, rx) = self.open_slot();
        let reply = Reply {
            server: Arc::clone(self),
            id,
            rx: Some(rx),
        };
        self.write(generation, request(id, method, params)).await?;
        Ok(reply)
    }

    fn open_slot(&self) -> (u64, oneshot::Receiver<Result<Value, RpcError>>) {
        let mut state = self.lock();
        state.next_id += 1;
        let id = state.next_id;
        let (tx, rx) = oneshot::channel();
        state.pending.insert(id, tx);
        (id, rx)
    }

    async fn request_on(
        &self,
        generation: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, CallError> {
        let (id, rx) = self.open_slot();
        // A caller that gives up (a Stop abandons a start) takes its pending slot with it; a
        // late answer then finds none and is dropped.
        let _slot = PendingSlot { server: self, id };
        self.write(generation, request(id, method, params)).await?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(e))) => Err(CallError::Rpc(e)),
            Ok(Err(_)) => Err(CallError::Stopped),
            Err(_) => Err(CallError::Timeout),
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
        // Frames of child threads that came before this frame named them.
        let mut early = Vec::new();
        let target = match &inbound {
            Inbound::Response { id, result } => {
                if let Some(tx) = self.lock().pending.remove(id) {
                    let _ = tx.send(result.clone());
                }
                return;
            }
            Inbound::Notification { method, params } => {
                let Some(thread) = params["threadId"]
                    .as_str()
                    .or_else(|| params["conversationId"].as_str())
                else {
                    return;
                };
                let mut state = self.lock();
                let route = state.routes.get(thread).cloned();
                match &route {
                    // A subagent's child thread belongs to the session of the thread that
                    // names it, from this frame on, so its frames keep their order.
                    Some(inbox) => {
                        for child in named_children(params) {
                            if state.routes.contains_key(&child) {
                                continue;
                            }
                            state.routes.insert(child.clone(), inbox.clone());
                            state.unrouted.retain(|(t, frame)| {
                                let take = *t == child;
                                if take {
                                    early.push(frame.clone());
                                }
                                !take
                            });
                        }
                    }
                    None if matches!(
                        method.as_str(),
                        "turn/started" | "mcpServer/startupStatus/updated"
                    ) =>
                    {
                        if state.unrouted.len() >= UNROUTED_KEPT {
                            state.unrouted.pop_front();
                        }
                        state
                            .unrouted
                            .push_back((thread.to_owned(), inbound.clone()));
                    }
                    None => {}
                }
                route
            }
            Inbound::Request { params, .. } => {
                let thread = params["threadId"]
                    .as_str()
                    .or_else(|| params["conversationId"].as_str());
                thread.and_then(|t| self.lock().routes.get(t).cloned())
            }
            Inbound::Invalid(_) => None,
        };
        match (target, inbound) {
            (Some(inbox), inbound) => {
                let early_inbox = (!early.is_empty()).then(|| inbox.clone());
                // One reader serves every session: a session whose inbox is full must not
                // hold back the others' frames and responses. Streamed deltas are dropped
                // then (the item's completion carries the whole text, and command output
                // deltas are not persisted); every other frame waits for room.
                match inbox.try_send(SessionMsg::Frame(inbound)) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(SessionMsg::Frame(frame)))
                        if is_delta(&frame) =>
                    {
                        let mut state = self.lock();
                        state.dropped_deltas = state.dropped_deltas.saturating_add(1);
                        if state.dropped_deltas == 1 {
                            eprintln!(
                                "conn-provider-codex: a session's inbox is full; dropping streamed deltas for it"
                            );
                        }
                    }
                    Err(mpsc::error::TrySendError::Full(msg)) => {
                        let _ = inbox.send(msg).await;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {}
                }
                if let Some(inbox) = early_inbox {
                    for frame in early {
                        let _ = inbox.send(SessionMsg::Frame(frame)).await;
                    }
                }
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
            let mut inboxes: Vec<mpsc::Sender<SessionMsg>> =
                state.sessions.values().cloned().collect();
            // Closed sessions that wait on this process's subagents end with it, whatever
            // their routes say now.
            let ended: Vec<String> = state
                .detached
                .iter()
                .filter(|(_, (g, _))| *g == generation)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ended {
                if let Some((_, inbox)) = state.detached.remove(&id)
                    && !inboxes.iter().any(|i| i.same_channel(&inbox))
                {
                    inboxes.push(inbox);
                }
            }
            // Their child routes go with the process.
            let state = &mut *state;
            let sessions = &state.sessions;
            state
                .routes
                .retain(|_, r| sessions.values().any(|s| s.same_channel(r)));
            inboxes
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

/// Pure streaming notifications whose content the item's `item/completed` repeats.
fn is_delta(frame: &Inbound) -> bool {
    matches!(
        frame,
        Inbound::Notification { method, .. } if matches!(
            method.as_str(),
            "item/agentMessage/delta"
                | "item/reasoning/summaryTextDelta"
                | "item/reasoning/textDelta"
                | "item/plan/delta"
                | "item/commandExecution/outputDelta"
        )
    )
}

/// Whether `version` has a higher major or minor than `tested`.
fn newer_minor(version: &str, tested: &str) -> bool {
    let parse = |v: &str| -> (u64, u64) {
        let mut parts = v.split('.').map(|p| p.parse().unwrap_or(0));
        (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    };
    parse(version) > parse(tested)
}

/// The answer to a request [`AppServer::send`] wrote. Dropping it forgets the request, so a
/// late answer is dropped.
pub struct Reply {
    server: Arc<AppServer>,
    id: u64,
    rx: Option<oneshot::Receiver<Result<Value, RpcError>>>,
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reply").field("id", &self.id).finish()
    }
}

impl Reply {
    /// Waits for the answer, at most [`REQUEST_TIMEOUT`].
    pub async fn wait(mut self) -> Result<Value, CallError> {
        let Some(rx) = self.rx.take() else {
            return Err(CallError::Stopped);
        };
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(e))) => Err(CallError::Rpc(e)),
            Ok(Err(_)) => Err(CallError::Stopped),
            Err(_) => Err(CallError::Timeout),
        }
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        self.server.lock().pending.remove(&self.id);
    }
}

/// Removes a request's pending slot when the request ends or is dropped.
struct PendingSlot<'a> {
    server: &'a AppServer,
    id: u64,
}

impl Drop for PendingSlot<'_> {
    fn drop(&mut self) {
        self.server.lock().pending.remove(&self.id);
    }
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
read start
echo '{"method":"thread/started","params":{"threadId":"t1"}}'
echo '{"id":2,"result":{"thread":{"id":"t1"}}}'
read never
"#;

    #[tokio::test(flavor = "current_thread")]
    async fn routes_responses_and_notifications_then_reports_exit() {
        let server = AppServer::new(fake(FAKE));
        let (tx, mut inbox) = mpsc::channel(8);
        server.add_session("s1", tx.clone());
        server.route("t1", tx);
        let generation = server.ensure_started().await.unwrap();
        assert_eq!(server.version().as_deref(), Some("0.167.0"));
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
        server.remove_session("s1", &[]).await;
        assert!(server.generation().is_none());
        let alive = conn_provider_support::process::pid_alive(pid);
        assert!(!alive, "the app-server outlived its last session");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_crash_fails_pending_requests_and_tells_sessions() {
        let server = AppServer::new(fake(
            r#"read init; echo '{"id":1,"result":{}}'; read initialized; read req; exit 7"#,
        ));
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

    /// A session that does not read its inbox must not stall responses: streamed deltas
    /// for it are dropped once its inbox is full.
    #[tokio::test(flavor = "current_thread")]
    async fn a_full_inbox_does_not_stall_responses() {
        let mut script =
            String::from(r#"read init; echo '{"id":1,"result":{}}'; read initialized; read req; "#);
        for _ in 0..(SESSION_INBOX + 50) {
            script.push_str(r#"echo '{"method":"item/agentMessage/delta","params":{"threadId":"slow","turnId":"t","itemId":"i","delta":"x"}}'; "#);
        }
        script.push_str(r#"echo '{"id":2,"result":{"ok":true}}'; read never"#);
        let server = AppServer::new(fake(&script));
        let (slow_tx, mut slow_rx) = mpsc::channel(SESSION_INBOX);
        server.add_session("slow", slow_tx.clone());
        server.route("slow", slow_tx);
        let generation = server.ensure_started().await.unwrap();
        let answer = tokio::time::timeout(
            Duration::from_secs(5),
            server.request_on(generation, "turn/interrupt", json!({})),
        )
        .await;
        assert_eq!(
            answer,
            Ok(Ok(json!({"ok": true}))),
            "the response waited on a full inbox"
        );
        let mut deltas = 0;
        while slow_rx.try_recv().is_ok() {
            deltas += 1;
        }
        assert_eq!(
            deltas, SESSION_INBOX,
            "the overflow was dropped, not queued"
        );
        server.remove_session("slow", &[]).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_process_starts_without_a_session() {
        let server = AppServer::new(fake("read never"));
        assert_eq!(server.ensure_started().await, Err(CallError::Stopped));
        assert!(server.pid().is_none());
    }

    #[test]
    fn version_comparison() {
        assert!(newer_minor("0.168.0", "0.167.0"));
        assert!(!newer_minor("0.167.9", "0.167.0"));
        assert!(!newer_minor("0.156.1", "0.167.0"));
    }
}
