//! [`ClaudeSession`]: one provider session, at most one live `claude` process.
//!
//! The process starts lazily on the first turn (as T3 opens its SDK query then), and again after
//! it died, went idle, or the thread, working directory or launch flags changed. A driver task
//! per process reads its output, feeds the [`Mapper`], and forwards events and replies in order.
//! An idle watcher per process ends it after [`ClaudeConfig::idle_timeout`]; the next turn
//! resumes the conversation with `--resume`. State sits behind one `std` mutex that is never
//! held across an `.await`.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use conn_contract::{ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, ProviderError,
    ProviderEvent, ProviderResult, ResumeThreadInput, RollbackTarget, RollbackThreadInput,
    RuntimePolicy, RuntimeRequestResponse, Session, SteerInput, ThreadSnapshot, TurnInput,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::DRIVER;
use crate::attachments;
use crate::ids::{self, Env, SystemEnv};
use crate::launch::{self, ClaudeConfig, LaunchInput, T3_MCP_SERVER};
use crate::mapper::{Mapper, Out};
use crate::protocol::{Delivery, Inbound, control_request, user_message};
use conn_provider_support::lines::Line;
use conn_provider_support::process::{ExitInfo, ProcEvent, Process};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
/// The SDK leaves boot unbounded; T3 gives it about two minutes on busy hosts.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
/// `CLAUDE_MCP_REGISTRATION_TIMEOUT`.
const MCP_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(90);
/// `CLAUDE_T3_MCP_TOOL_TIMEOUT_MS`.
const MCP_TOOL_TIMEOUT_MS: u64 = 65 * 60 * 1000;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
pub const EVENT_CAPACITY: usize = 256;
const LOGGED_SKIPS_CAP: usize = 64;

pub struct ClaudeSession {
    id: ProviderSessionId,
    inner: Arc<Inner>,
}

struct Inner {
    config: ClaudeConfig,
    state: Mutex<State>,
}

struct State {
    mapper: Mapper<SystemEnv>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    live: Option<Live>,
    generation: u64,
    /// Native ids that have a conversation on disk, so the next process uses `--resume`.
    resumable: HashSet<String>,
    controls: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    next_control: u64,
    mcp_servers: Vec<McpServer>,
    /// Inline attachment bytes sent so far (`claudeAttachmentBudget`).
    attachment_bytes: u64,
    closed: bool,
    logged_skips: HashSet<String>,
}

struct Live {
    process: Process,
    generation: u64,
    native_thread_id: String,
    cwd: Option<String>,
    permission_mode: String,
    model: String,
    effort: Option<String>,
    /// The MCP servers this process got; a different list needs `mcp_set_servers`.
    mcp_servers: Vec<McpServer>,
    /// `--allowedTools` is a launch flag: gaining or losing the T3 server needs a new process.
    t3_mcp: bool,
    restart_needed: bool,
    last_activity: Instant,
    /// Since when background work keeps this idle process alive.
    held_since: Option<Instant>,
}

impl ClaudeSession {
    pub(crate) fn open(
        id: ProviderSessionId,
        config: ClaudeConfig,
        events: mpsc::Sender<ProviderEvent>,
    ) -> Self {
        let mapper = Mapper::new(SystemEnv, id.as_str());
        let inner = Arc::new(Inner {
            config,
            state: Mutex::new(State {
                mapper,
                events: Some(events),
                live: None,
                generation: 0,
                resumable: HashSet::new(),
                controls: HashMap::new(),
                next_control: 0,
                mcp_servers: Vec::new(),
                attachment_bytes: 0,
                closed: false,
                logged_skips: HashSet::new(),
            }),
        });
        Self { id, inner }
    }

    #[cfg(test)]
    pub(crate) fn live_pid(&self) -> Option<u32> {
        self.inner.lock().live.as_ref().map(|l| l.process.pid)
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends events and CLI replies in order. Holds no lock.
    async fn deliver(&self, writer: Option<&mpsc::Sender<String>>, outs: Vec<Out>) {
        if outs.is_empty() {
            return;
        }
        let events = self.lock().events.clone();
        for out in outs {
            match out {
                Out::Event(event) => {
                    if let Some(events) = &events {
                        let _ = events.send(event).await;
                    }
                }
                Out::Write(line) => {
                    if let Some(writer) = writer {
                        let _ = writer.send(line).await;
                    }
                }
                Out::Skipped(kind) => {
                    let mut state = self.lock();
                    // Kinds come from the CLI; remember a bounded number of them.
                    let new = state.logged_skips.len() < LOGGED_SKIPS_CAP
                        && state.logged_skips.insert(kind.clone());
                    drop(state);
                    if new {
                        eprintln!("conn-provider-claude: skipped CLI message kind `{kind}`");
                    }
                }
            }
        }
    }

    async fn control(&self, request: Value, timeout: Duration) -> ProviderResult<Value> {
        let subtype = request["subtype"].as_str().unwrap_or("control").to_string();
        let (id, rx, writer) = {
            let mut state = self.lock();
            let Some(live) = &state.live else {
                return Err(ProviderError::SessionStopped);
            };
            let writer = live.process.writer();
            state.next_control += 1;
            let id = format!("conn_{}", state.next_control);
            let (tx, rx) = oneshot::channel();
            state.controls.insert(id.clone(), tx);
            (id, rx, writer)
        };
        if writer.send(control_request(&id, request)).await.is_err() {
            self.lock().controls.remove(&id);
            return Err(ProviderError::SessionStopped);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(detail))) => Err(ProviderError::Failed {
                operation: "control",
                detail: format!("{subtype}: {detail}"),
            }),
            Ok(Err(_)) => Err(ProviderError::SessionStopped),
            Err(_) => {
                self.lock().controls.remove(&id);
                Err(ProviderError::Failed {
                    operation: "control",
                    detail: format!("{subtype}: no answer from Claude"),
                })
            }
        }
    }

    /// `mcp_set_servers`, as the TS query runner sends it after `initialize`. Credentials stay
    /// out of argv. Servers that fail to connect are logged by name only, as TS does.
    async fn set_mcp_servers(&self, servers: &[McpServer]) -> ProviderResult<()> {
        let mut map = serde_json::Map::new();
        for server in servers {
            let headers: serde_json::Map<String, Value> = server
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect();
            map.insert(
                server.name.clone(),
                json!({"type": "http", "url": server.url, "headers": headers, "timeout": MCP_TOOL_TIMEOUT_MS}),
            );
        }
        let answer = self
            .control(
                json!({"subtype": "mcp_set_servers", "servers": map}),
                MCP_REGISTRATION_TIMEOUT,
            )
            .await;
        let failed: Vec<String> = match &answer {
            Ok(value) => value["errors"]
                .as_object()
                .map(|e| e.keys().cloned().collect())
                .unwrap_or_default(),
            Err(ProviderError::Failed { detail, .. })
                if detail.ends_with("no answer from Claude") =>
            {
                return Err(failed_err(
                    "set_mcp_servers",
                    "Claude did not register the MCP servers in time.",
                ));
            }
            Err(ProviderError::SessionStopped) => return Err(ProviderError::SessionStopped),
            Err(_) => servers.iter().map(|s| s.name.clone()).collect(),
        };
        if !failed.is_empty() {
            eprintln!(
                "conn-provider-claude: MCP servers unavailable: {}",
                failed.join(", ")
            );
        }
        if let Some(live) = &mut self.lock().live {
            live.mcp_servers = servers.to_vec();
        }
        Ok(())
    }
}

/// A process event with its stdout line already decoded.
#[allow(clippy::large_enum_variant)] // Moved once per line; boxing adds an allocation each.
enum Event {
    Message(Inbound),
    Oversized(usize),
    Exited(ExitInfo),
}

/// A line longer than this is dropped. Large tool results (images as base64) stay below it.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// The driver: one per process, ends after the process's `Exited`.
async fn drive(inner: Arc<Inner>, generation: u64, mut rx: mpsc::Receiver<ProcEvent>) {
    loop {
        let dirty = inner.lock().mapper.has_dirty_streams();
        let event = if dirty {
            tokio::select! {
                event = rx.recv() => event,
                _ = tokio::time::sleep(FLUSH_INTERVAL) => {
                    let (outs, writer) = {
                        let mut state = inner.lock();
                        (state.mapper.flush(), writer_for(&state, generation))
                    };
                    inner.deliver(writer.as_ref(), outs).await;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let event = event.map(|event| match event {
            ProcEvent::Line(Line::Text(text)) => Event::Message(Inbound::decode(&text)),
            ProcEvent::Line(Line::Oversized(bytes)) => Event::Oversized(bytes),
            ProcEvent::Exited(info) => Event::Exited(info),
        });
        if matches!(event, Some(Event::Message(_))) {
            touch(&mut inner.lock(), Some(generation));
        }
        match event {
            Some(Event::Message(Inbound::ControlResponse { request_id, result })) => {
                if let Some(tx) = inner.lock().controls.remove(&request_id) {
                    let _ = tx.send(result);
                }
            }
            Some(Event::Message(message)) => {
                let (outs, writer) = {
                    let mut state = inner.lock();
                    (state.mapper.handle(message), writer_for(&state, generation))
                };
                inner.deliver(writer.as_ref(), outs).await;
            }
            Some(Event::Oversized(bytes)) => {
                eprintln!("conn-provider-claude: dropped a {bytes}-byte CLI line");
            }
            Some(Event::Exited(info)) => {
                on_exit(&inner, generation, &info).await;
                return;
            }
            None => return,
        }
    }
}

/// Marks the live process (of `generation`, if given) as active now.
fn touch(state: &mut State, generation: Option<u64>) {
    if let Some(live) = state
        .live
        .as_mut()
        .filter(|l| generation.is_none_or(|g| l.generation == g))
    {
        live.last_activity = Instant::now();
        live.held_since = None;
    }
}

/// Ends the process after `timeout` without a turn or output. Background work (a running
/// subagent, output held for a continuation) holds it up to `max_hold`, as T3's session
/// manager does with `hasPendingBackgroundWork`.
async fn idle_watch(inner: Arc<Inner>, generation: u64, timeout: Duration, max_hold: Duration) {
    loop {
        let wait = {
            let mut state = inner.lock();
            let busy = state.mapper.turn_active() || !state.controls.is_empty();
            let background = state.mapper.has_pending_background_work();
            let Some(live) = state.live.as_mut().filter(|l| l.generation == generation) else {
                return;
            };
            let idle_for = live.last_activity.elapsed();
            if busy {
                Some(timeout)
            } else if idle_for < timeout {
                Some(timeout - idle_for)
            } else if background
                && live.held_since.get_or_insert_with(Instant::now).elapsed() < max_hold
            {
                Some(timeout.min(max_hold))
            } else {
                None
            }
        };
        match wait {
            Some(duration) => tokio::time::sleep(duration).await,
            None => break,
        }
    }
    let live = {
        let mut state = inner.lock();
        match &state.live {
            Some(l) if l.generation == generation => state.live.take(),
            _ => return,
        }
    };
    if let Some(live) = live {
        live.process.shutdown().await;
    }
}

/// The process's stdin, looked up per use: a clone held for the process's life would keep
/// stdin open after `close` and turn every graceful shutdown into a kill.
fn writer_for(state: &State, generation: u64) -> Option<mpsc::Sender<String>> {
    state
        .live
        .as_ref()
        .filter(|l| l.generation == generation)
        .map(|l| l.process.writer())
}

async fn on_exit(inner: &Inner, generation: u64, info: &ExitInfo) {
    let outs = {
        let mut state = inner.lock();
        let current = state
            .live
            .as_ref()
            .is_some_and(|l| l.generation == generation);
        if !current {
            return;
        }
        let expected = state.closed;
        state.live = None;
        // Fail requests still waiting for the dead process.
        state.controls.clear();
        let detail = exit_detail(info);
        state.mapper.on_exit(expected, &detail)
    };
    inner.deliver(None, outs).await;
}

/// What the user sees for a process that died mid-turn. stderr can hold private text, so only
/// known lines are passed on, as the TS adapter does.
fn exit_detail(info: &ExitInfo) -> String {
    let known = info
        .stderr_tail
        .lines()
        .find(|l| l.contains("No conversation found with session ID"));
    match known {
        Some(line) => format!("Claude exited ({}): {}", info.describe(), line.trim()),
        None => format!(
            "The Claude process exited unexpectedly ({}).",
            info.describe()
        ),
    }
}

fn model_effort(selection: &conn_contract::ModelSelection) -> (String, Option<String>) {
    let value = to_json(selection);
    let model = value["model"].as_str().unwrap_or("default").to_string();
    let effort = value["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|o| o["id"] == "effort")
        .and_then(|o| o["value"].as_str())
        .map(|e| if e == "ultrathink" { "high" } else { e })
        .filter(|e| matches!(*e, "low" | "medium" | "high" | "xhigh" | "max"))
        .map(str::to_string);
    (model, effort)
}

fn policy_mode(policy: &RuntimePolicy) -> &'static str {
    let runtime = to_json(&policy.runtime_mode);
    let interaction = to_json(&policy.interaction_mode);
    launch::permission_mode(
        runtime.as_str().unwrap_or("full-access"),
        interaction.as_str().unwrap_or("default"),
    )
}

fn native_thread_id(thread: &ProviderThread) -> Option<String> {
    to_json(thread)["nativeThreadRef"]["nativeId"]
        .as_str()
        .map(str::to_string)
}

/// The message to resume at after a rollback (`getNativeConversationHeadId`).
fn conversation_head(thread: &Value) -> Option<String> {
    thread["nativeConversationHeadRef"]["nativeId"]
        .as_str()
        .map(str::to_string)
}

/// A fork that has not run yet: its source's native id.
fn pending_fork_source(thread: &Value) -> Option<String> {
    if !thread["lastRunOrdinal"].is_null() {
        return None;
    }
    thread["forkedFrom"]["providerThreadId"]
        .as_str()?
        .strip_prefix(&format!(
            "provider-thread:provider:{}:native-thread:",
            DRIVER
        ))
        .map(str::to_string)
}

/// A turn cursor the CLI can resume at: an assistant message uuid, not the `turn:` stand-in.
fn turn_cursor(turn: &Value) -> Option<String> {
    let id = turn["nativeTurnRef"]["nativeId"].as_str()?;
    (!id.starts_with("turn:")).then(|| id.to_string())
}

fn failed_err(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

/// What a turn must do before it writes the prompt.
enum Plan {
    Reuse {
        set_model: Option<String>,
        set_effort: Option<String>,
        set_mode: Option<String>,
        set_mcp: bool,
    },
    Launch(Box<LaunchInput>),
}

impl ClaudeSession {
    /// Ensures a process for the turn's thread, with its model, effort, mode and MCP servers.
    /// Returns the permission mode in force.
    async fn prepare(&self, input: &TurnInput) -> ProviderResult<String> {
        let inner = &self.inner;
        let native = native_thread_id(&input.provider_thread)
            .ok_or_else(|| failed_err("start_turn", "provider thread has no native Claude id"))?;
        let (model, effort) = model_effort(&input.model_selection);
        let mode = policy_mode(&input.runtime_policy).to_string();
        let cwd = input.runtime_policy.cwd.clone();
        let thread = to_json(&input.provider_thread);
        let title = to_json(&input.app_thread)["title"]
            .as_str()
            .map(str::to_string);

        let (plan, old) = {
            let mut state = inner.lock();
            if state.closed {
                return Err(ProviderError::SessionStopped);
            }
            let t3_mcp = state.mcp_servers.iter().any(|s| s.name == T3_MCP_SERVER);
            let reusable = state.live.as_ref().is_some_and(|l| {
                !l.process.has_exited()
                    && !l.restart_needed
                    && l.native_thread_id == native
                    && l.cwd == cwd
                    && (l.effort == effort || effort.is_some())
                    && l.t3_mcp == t3_mcp
                    && (l.permission_mode == mode
                        || (mode != "bypassPermissions"
                            && l.permission_mode != "bypassPermissions"))
            });
            if let Some(live) = state.live.as_ref().filter(|_| reusable) {
                let plan = Plan::Reuse {
                    set_model: (live.model != model).then(|| model.clone()),
                    set_effort: effort.clone().filter(|e| live.effort.as_ref() != Some(e)),
                    set_mode: (live.permission_mode != mode).then(|| mode.clone()),
                    set_mcp: live.mcp_servers != state.mcp_servers,
                };
                (plan, None)
            } else {
                let fork_from =
                    pending_fork_source(&thread).filter(|_| !state.resumable.contains(&native));
                let resume = state.resumable.contains(&native) || input.provider_turn_ordinal > 1;
                let launch = LaunchInput {
                    thread_id: input.thread_id.as_str().into(),
                    native_thread_id: native.clone(),
                    resume: resume || fork_from.is_some(),
                    model: model.clone(),
                    effort: effort.clone(),
                    permission_mode: mode.clone(),
                    cwd: cwd.clone(),
                    resume_at: conversation_head(&thread),
                    fork_from,
                    allowed_tools: if t3_mcp {
                        vec![format!("mcp__{T3_MCP_SERVER}__*")]
                    } else {
                        Vec::new()
                    },
                };
                (Plan::Launch(Box::new(launch)), state.live.take())
            }
        };
        if let Some(old) = old {
            old.process.shutdown().await;
        }

        match plan {
            Plan::Launch(launch) => self.launch(*launch, title.as_deref()).await?,
            Plan::Reuse {
                set_model,
                set_effort,
                set_mode,
                set_mcp,
            } => {
                if let Some(model) = set_model {
                    self.apply_model(model).await?;
                }
                if let Some(effort) = set_effort {
                    self.apply_effort(effort).await?;
                }
                if let Some(mode) = set_mode {
                    inner
                        .control(
                            json!({"subtype": "set_permission_mode", "mode": mode}),
                            CONTROL_TIMEOUT,
                        )
                        .await?;
                    if let Some(live) = &mut inner.lock().live {
                        live.permission_mode = mode;
                    }
                }
                if set_mcp {
                    let servers = inner.lock().mcp_servers.clone();
                    inner.set_mcp_servers(&servers).await?;
                }
            }
        }
        let mut state = inner.lock();
        state.resumable.insert(native);
        touch(&mut state, None);
        Ok(mode)
    }

    async fn apply_model(&self, model: String) -> ProviderResult<()> {
        self.inner
            .control(
                json!({"subtype": "set_model", "model": model}),
                CONTROL_TIMEOUT,
            )
            .await?;
        if let Some(live) = &mut self.inner.lock().live {
            live.model = model;
        }
        Ok(())
    }

    /// `applyFlagSettings({effortLevel})`: effort changes without a new process.
    async fn apply_effort(&self, effort: String) -> ProviderResult<()> {
        self.inner
            .control(
                json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": effort}}),
                CONTROL_TIMEOUT,
            )
            .await?;
        if let Some(live) = &mut self.inner.lock().live {
            live.effort = Some(effort);
        }
        Ok(())
    }

    /// Applies a selection to the live process: model by `set_model`, a new effort by
    /// `apply_flag_settings`. Clearing an effort needs a new process.
    async fn apply_selection(
        &self,
        selection: &conn_contract::ModelSelection,
    ) -> ProviderResult<()> {
        let (model, effort) = model_effort(selection);
        let (model_change, effort_change) = {
            let mut state = self.inner.lock();
            match &mut state.live {
                Some(live) => {
                    live.restart_needed |= effort.is_none() && live.effort.is_some();
                    (
                        live.model != model,
                        effort.clone().filter(|e| live.effort.as_ref() != Some(e)),
                    )
                }
                None => (false, None),
            }
        };
        if model_change {
            self.apply_model(model).await?;
        }
        if let Some(effort) = effort_change {
            self.apply_effort(effort).await?;
        }
        Ok(())
    }

    async fn start_turn_inner(&self, input: TurnInput) -> ProviderResult<()> {
        if self.inner.lock().mapper.turn_active() {
            return Err(failed_err(
                "start_turn",
                "the previous turn is still running",
            ));
        }
        let mode = self.prepare(&input).await?;
        let content = self
            .content(&input.message.text, &input.message.attachments)
            .await;
        let inner = &self.inner;
        let (outs, writer, uuid) = {
            let mut state = inner.lock();
            let writer = state
                .live
                .as_ref()
                .map(|l| l.process.writer())
                .ok_or(ProviderError::SessionStopped)?;
            let outs = state.mapper.begin_turn(&input, &mode);
            (outs, writer, SystemEnv.uuid())
        };
        inner.deliver(Some(&writer), outs).await;
        if writer
            .send(user_message(content, &uuid, Delivery::Turn))
            .await
            .is_err()
        {
            let outs = inner
                .lock()
                .mapper
                .on_exit(false, "The Claude process stopped before the turn started.");
            inner.deliver(None, outs).await;
            return Err(ProviderError::SessionStopped);
        }
        Ok(())
    }

    /// The prompt content with attachments. Files are read off the runtime thread.
    async fn content(&self, text: &str, list: &[conn_contract::ChatAttachment]) -> Value {
        if list.is_empty() {
            return json!(text);
        }
        let dir = self.inner.config.attachments_dir.clone();
        let used = self.inner.lock().attachment_bytes;
        let (owned_text, owned_list) = (text.to_string(), list.to_vec());
        let built = tokio::task::spawn_blocking(move || {
            let mut used = used;
            let content =
                attachments::prompt_content(&owned_text, &owned_list, dir.as_deref(), &mut used);
            (content, used)
        })
        .await;
        match built {
            Ok((content, used)) => {
                self.inner.lock().attachment_bytes = used;
                content
            }
            Err(_) => json!(text),
        }
    }

    async fn launch(&self, input: LaunchInput, title: Option<&str>) -> ProviderResult<()> {
        let inner = &self.inner;
        let spec = launch::launch_spec(&inner.config, &input);
        let (tx, rx) = mpsc::channel(EVENT_CAPACITY);
        let process = Process::spawn(&spec, MAX_LINE_BYTES, tx).map_err(|e| {
            failed_err(
                "start_turn",
                format!("Could not start Claude ({}): {e}", spec.program.display()),
            )
        })?;
        let t3_mcp = !input.allowed_tools.is_empty();
        let generation = {
            let mut state = inner.lock();
            state.generation += 1;
            let generation = state.generation;
            state.live = Some(Live {
                process,
                generation,
                native_thread_id: input.native_thread_id.clone(),
                cwd: input.cwd.clone(),
                permission_mode: input.permission_mode.clone(),
                model: input.model.clone(),
                effort: input.effort.clone(),
                mcp_servers: Vec::new(),
                t3_mcp,
                restart_needed: false,
                last_activity: Instant::now(),
                held_since: None,
            });
            generation
        };
        tokio::spawn(drive(inner.clone(), generation, rx));
        if let Some(timeout) = inner.config.idle_timeout {
            tokio::spawn(idle_watch(
                inner.clone(),
                generation,
                timeout,
                inner.config.idle_max_hold,
            ));
        }
        let extra = inner.config.mcp_instructions.as_deref().filter(|_| t3_mcp);
        let init = launch::initialize_request(&inner.config, title, extra);
        let mut result = inner.control(init, INITIALIZE_TIMEOUT).await.map(|_| ());
        let servers = inner.lock().mcp_servers.clone();
        if result.is_ok() && !servers.is_empty() {
            result = inner.set_mcp_servers(&servers).await;
        }
        if let Err(error) = result {
            let live = inner.lock().live.take();
            if let Some(live) = live {
                live.process.shutdown().await;
            }
            return Err(match error {
                ProviderError::SessionStopped => failed_err(
                    "start_turn",
                    "Claude exited before it answered initialize (an unknown --resume id, a bad flag, or no credentials)",
                ),
                other => other,
            });
        }
        Ok(())
    }

    /// Ends the live process if it serves `native`; the next turn starts a new one.
    async fn release(&self, native: &str) {
        let live = {
            let mut state = self.inner.lock();
            if state
                .live
                .as_ref()
                .is_some_and(|l| l.native_thread_id == native)
            {
                state.live.take()
            } else {
                None
            }
        };
        if let Some(live) = live {
            live.process.shutdown().await;
        }
    }

    fn require_idle(&self, operation: &'static str) -> ProviderResult<()> {
        if self.inner.lock().mapper.turn_active() {
            return Err(ProviderError::Protocol {
                detail: format!("Claude cannot {operation} while a turn is running."),
            });
        }
        Ok(())
    }
}

fn new_thread(
    session: &str,
    app_thread_id: Value,
    native: &str,
    owner: Value,
    forked_from: Value,
    head: Value,
) -> Value {
    let now = SystemEnv.now();
    json!({
        "id": ids::provider_thread_id(DRIVER, native),
        "driver": DRIVER,
        "providerInstanceId": DRIVER,
        "providerSessionId": session,
        "appThreadId": app_thread_id,
        "ownerNodeId": owner,
        "nativeThreadRef": {"driver": DRIVER, "nativeId": native, "strength": "strong"},
        "nativeConversationHeadRef": head,
        "status": "idle",
        "firstRunOrdinal": null,
        "lastRunOrdinal": null,
        "handoffIds": [],
        "forkedFrom": forked_from,
        "createdAt": now,
        "updatedAt": now,
    })
}

impl Session for ClaudeSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            if let Some(existing) = input.existing_provider_thread
                && native_thread_id(&existing).is_some()
            {
                let mut thread = to_json(&existing);
                thread["providerSessionId"] = json!(self.id.as_str());
                return from_json(thread).map_err(|e| failed_err("ensure_thread", e.to_string()));
            }
            let native = SystemEnv.uuid();
            let thread = new_thread(
                self.id.as_str(),
                json!(input.thread_id.as_str()),
                &native,
                Value::Null,
                Value::Null,
                Value::Null,
            );
            from_json(thread).map_err(|e| failed_err("ensure_thread", e.to_string()))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                failed_err("resume_thread", "provider thread has no native Claude id")
            })?;
            let mut thread = to_json(&input.provider_thread);
            // A fork that never ran has no conversation of its own yet.
            if pending_fork_source(&thread).is_none() {
                self.inner.lock().resumable.insert(native);
            }
            thread["providerSessionId"] = json!(self.id.as_str());
            thread["status"] = json!("idle");
            thread["updatedAt"] = json!(SystemEnv.now());
            from_json(thread).map_err(|e| failed_err("resume_thread", e.to_string()))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(self.start_turn_inner(input))
    }

    fn start_continuation_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let (outs, writer) = {
                let mut state = self.inner.lock();
                if state.mapper.turn_active() {
                    return Err(failed_err("start_continuation_turn", "a turn is running"));
                }
                let Some(live) = &state.live else {
                    return Err(ProviderError::SessionStopped);
                };
                let writer = live.process.writer();
                let mode = live.permission_mode.clone();
                (state.mapper.begin_continuation(&input, &mode), writer)
            };
            self.inner.deliver(Some(&writer), outs).await;
            Ok(())
        })
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if let Some(selection) = &input.model_selection {
                self.apply_selection(selection).await?;
            }
            let content = self
                .content(&input.message.text, &input.message.attachments)
                .await;
            let uuid = SystemEnv.uuid();
            let (writer, outs) = {
                let mut state = self.inner.lock();
                let writer = state
                    .live
                    .as_ref()
                    .map(|l| l.process.writer())
                    .ok_or(ProviderError::SessionStopped)?;
                if state.mapper.active_turn_id() != Some(input.provider_turn_id.as_str()) {
                    return Err(failed_err("steer_turn", "that turn is not running"));
                }
                touch(&mut state, None);
                let outs = state
                    .mapper
                    .steer_sent(&uuid, input.message.message_id.as_str());
                (writer, outs)
            };
            self.inner.deliver(Some(&writer), outs).await;
            if writer
                .send(user_message(content, &uuid, Delivery::Steer))
                .await
                .is_err()
            {
                let outs = self.inner.lock().mapper.steer_failed(&uuid);
                self.inner.deliver(None, outs).await;
                return Err(ProviderError::SessionStopped);
            }
            Ok(())
        })
    }

    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            {
                let mut state = self.inner.lock();
                if state.live.is_none()
                    || state.mapper.active_turn_id() != Some(input.provider_turn_id.as_str())
                {
                    return Ok(());
                }
                state.mapper.mark_interrupted();
            }
            self.inner
                .control(json!({"subtype": "interrupt"}), CONTROL_TIMEOUT)
                .await
                .map(|_| ())
        })
    }

    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        selection: conn_contract::ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move { self.apply_selection(&selection).await })
    }

    fn apply_runtime_policy(
        &self,
        _thread: ProviderThread,
        policy: RuntimePolicy,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let mode = policy_mode(&policy).to_string();
            {
                let mut state = self.inner.lock();
                let Some(live) = &mut state.live else {
                    return Ok(());
                };
                if live.permission_mode == mode {
                    return Ok(());
                }
                // Bypass needs a launch flag, so entering or leaving it takes a new process.
                if mode == "bypassPermissions" || live.permission_mode == "bypassPermissions" {
                    live.restart_needed = true;
                    return Err(ProviderError::Unsupported {
                        operation: "apply_runtime_policy",
                    });
                }
            }
            self.inner
                .control(
                    json!({"subtype": "set_permission_mode", "mode": mode}),
                    CONTROL_TIMEOUT,
                )
                .await?;
            let mut state = self.inner.lock();
            if let Some(live) = &mut state.live {
                live.permission_mode = mode.clone();
            }
            state.mapper.set_permission_mode(&mode);
            Ok(())
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let (outs, writer) = {
                let mut state = self.inner.lock();
                let writer = state.live.as_ref().map(|l| l.process.writer());
                let Some(writer) = writer else {
                    return Err(ProviderError::SessionStopped);
                };
                (state.mapper.respond(&input)?, writer)
            };
            self.inner.deliver(Some(&writer), outs).await;
            Ok(())
        })
    }

    fn set_mcp_servers(&self, servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let live_update = {
                let mut state = self.inner.lock();
                state.mcp_servers = servers.clone();
                let t3 = servers.iter().any(|s| s.name == T3_MCP_SERVER);
                match &mut state.live {
                    // The T3 allow rule is a launch flag; a change waits for a new process.
                    Some(live) if live.t3_mcp != t3 => {
                        live.restart_needed = true;
                        false
                    }
                    Some(live) => live.mcp_servers != servers,
                    None => false,
                }
            };
            if live_update {
                self.inner.set_mcp_servers(&servers).await?;
            }
            Ok(())
        })
    }

    fn rollback_thread(
        &self,
        input: RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        Box::pin(async move {
            self.require_idle("roll back")?;
            let thread = to_json(&input.provider_thread);
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                failed_err("rollback_thread", "provider thread has no native Claude id")
            })?;
            self.release(&native).await;
            let rolled = match input.target {
                RollbackTarget::ThreadStart { .. } => {
                    // A new native session; the old transcript stays on disk.
                    let mut fresh = new_thread(
                        self.id.as_str(),
                        thread["appThreadId"].clone(),
                        &SystemEnv.uuid(),
                        thread["ownerNodeId"].clone(),
                        thread["forkedFrom"].clone(),
                        Value::Null,
                    );
                    fresh["handoffIds"] = thread["handoffIds"].clone();
                    fresh
                }
                RollbackTarget::ProviderTurn {
                    app_run_ordinal,
                    provider_turn,
                    ..
                } => {
                    let target = to_json(&provider_turn);
                    let later_turns = input.provider_thread_turns.iter().any(|t| {
                        let t = to_json(t);
                        t["ordinal"].as_i64() > target["ordinal"].as_i64()
                            && t["providerThreadId"] == thread["id"]
                    });
                    let head = match turn_cursor(&target) {
                        Some(cursor) => {
                            json!({"driver": DRIVER, "nativeId": cursor, "strength": "weak"})
                        }
                        None if !later_turns => Value::Null,
                        None => {
                            return Err(failed_err(
                                "rollback_thread",
                                "no Claude message cursor was recorded for that turn",
                            ));
                        }
                    };
                    let mut rolled = thread.clone();
                    rolled["providerSessionId"] = json!(self.id.as_str());
                    rolled["nativeConversationHeadRef"] = head;
                    rolled["status"] = json!("idle");
                    rolled["lastRunOrdinal"] = json!(app_run_ordinal);
                    rolled["updatedAt"] = json!(SystemEnv.now());
                    self.inner.lock().resumable.insert(native);
                    rolled
                }
            };
            Ok(ThreadSnapshot {
                provider_thread: from_json(rolled)
                    .map_err(|e| failed_err("rollback_thread", e.to_string()))?,
                provider_turns: Vec::new(),
                messages: Vec::new(),
                runtime_requests: Vec::new(),
            })
        })
    }

    /// Lazy: the new thread records its source and cut point, and its first turn starts the
    /// CLI with `--resume <source> --fork-session --session-id <new> [--resume-session-at]`.
    /// The SDK's `forkSession` copies the transcript file; the CLI makes the same copy.
    fn fork_thread(&self, input: ForkThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            self.require_idle("fork")?;
            let source = to_json(&input.source_provider_thread);
            let source_native =
                native_thread_id(&input.source_provider_thread).ok_or_else(|| {
                    failed_err("fork_thread", "provider thread has no native Claude id")
                })?;
            self.release(&source_native).await;
            let up_to = match &input.provider_turn_id {
                None => conversation_head(&source),
                Some(turn_id) => {
                    let mut turns: Vec<Value> = input
                        .source_provider_turns
                        .iter()
                        .map(to_json)
                        .filter(|t| t["providerThreadId"] == source["id"])
                        .collect();
                    turns.sort_by_key(|t| t["ordinal"].as_i64());
                    let index = turns
                        .iter()
                        .position(|t| t["id"] == json!(turn_id.as_str()))
                        .ok_or_else(|| {
                            failed_err("fork_thread", "the fork turn is not on that thread")
                        })?;
                    match turns.get(index).and_then(turn_cursor) {
                        Some(cursor) => Some(cursor),
                        None if index + 1 == turns.len() => conversation_head(&source),
                        None => {
                            return Err(failed_err(
                                "fork_thread",
                                "no Claude message cursor was recorded for that turn",
                            ));
                        }
                    }
                }
            };
            let mut forked_from = json!({"providerThreadId": source["id"]});
            if let Some(turn_id) = &input.provider_turn_id {
                forked_from["providerTurnId"] = json!(turn_id.as_str());
            }
            let head = up_to
                .map(|id| json!({"driver": DRIVER, "nativeId": id, "strength": "weak"}))
                .unwrap_or(Value::Null);
            let thread = new_thread(
                self.id.as_str(),
                json!(input.target_thread_id.as_str()),
                &SystemEnv.uuid(),
                input
                    .owner_node_id
                    .as_ref()
                    .map_or(Value::Null, |n| json!(n.as_str())),
                forked_from,
                head,
            );
            from_json(thread).map_err(|e| failed_err("fork_thread", e.to_string()))
        })
    }

    fn has_pending_background_work(&self) -> bool {
        self.inner.lock().mapper.has_pending_background_work()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let live = {
                let mut state = self.inner.lock();
                state.closed = true;
                state.live.take()
            };
            if let Some(live) = live {
                live.process.shutdown().await;
            }
            // A turn still open ends as interrupted; then the event channel closes.
            let outs = self
                .inner
                .lock()
                .mapper
                .on_exit(true, "The session closed.");
            self.inner.deliver(None, outs).await;
            let mut state = self.inner.lock();
            state.events = None;
            state.controls.clear();
        })
    }
}
