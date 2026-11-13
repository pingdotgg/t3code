//! [`ClaudeSession`]: one provider session, at most one live `claude` process.
//!
//! The process starts lazily on the first turn (as T3 opens its SDK query then), and again after
//! it died or the thread, working directory or launch flags changed. A driver task per process
//! reads its output, feeds the [`Mapper`], and forwards events and replies in order. State sits
//! behind one `std` mutex that is never held across an `.await`.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, InterruptInput, ProviderError, ProviderEvent, ProviderResult,
    ResumeThreadInput, RuntimePolicy, RuntimeRequestResponse, Session, SteerInput, TurnInput,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::ids::{self, Env, SystemEnv};
use crate::launch::{self, ClaudeConfig, LaunchInput};
use crate::mapper::{Mapper, Out};
use crate::process::{ExitInfo, ProcEvent, Process};
use crate::protocol::{Inbound, control_request, user_message};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
/// The SDK leaves boot unbounded; T3 gives it about two minutes on busy hosts.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
pub const EVENT_CAPACITY: usize = 256;

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
    /// A live model or mode change the next launch must keep.
    model: Option<String>,
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
    restart_needed: bool,
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
                model: None,
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
                    if self.lock().logged_skips.insert(kind.clone()) {
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
}

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
        match event {
            Some(ProcEvent::Message(Inbound::ControlResponse { request_id, result })) => {
                if let Some(tx) = inner.lock().controls.remove(&request_id) {
                    let _ = tx.send(result);
                }
            }
            Some(ProcEvent::Message(message)) => {
                let (outs, writer) = {
                    let mut state = inner.lock();
                    (state.mapper.handle(message), writer_for(&state, generation))
                };
                inner.deliver(writer.as_ref(), outs).await;
            }
            Some(ProcEvent::Oversized(bytes)) => {
                eprintln!("conn-provider-claude: dropped a {bytes}-byte CLI line");
            }
            Some(ProcEvent::Exited(info)) => {
                on_exit(&inner, generation, &info).await;
                return;
            }
            None => return,
        }
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

fn failed(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

/// What `start_turn` must do before it writes the prompt.
enum Plan {
    Reuse {
        set_model: Option<String>,
        set_mode: Option<String>,
    },
    Launch(Box<LaunchInput>),
}

impl ClaudeSession {
    async fn start_turn_inner(&self, input: TurnInput) -> ProviderResult<()> {
        let inner = &self.inner;
        let native = native_thread_id(&input.provider_thread)
            .ok_or_else(|| failed("start_turn", "provider thread has no native Claude id"))?;
        let (model, effort) = model_effort(&input.model_selection);
        let mode = policy_mode(&input.runtime_policy).to_string();
        let cwd = input.runtime_policy.cwd.clone();
        let title = to_json(&input.app_thread)["title"]
            .as_str()
            .map(str::to_string);

        let (plan, old) = {
            let mut state = inner.lock();
            if state.closed {
                return Err(ProviderError::SessionStopped);
            }
            if state.mapper.turn_active() {
                return Err(failed("start_turn", "the previous turn is still running"));
            }
            let reusable = state.live.as_ref().is_some_and(|l| {
                !l.process.has_exited()
                    && !l.restart_needed
                    && l.native_thread_id == native
                    && l.cwd == cwd
                    && l.effort == effort
                    && (l.permission_mode == mode
                        || (mode != "bypassPermissions"
                            && l.permission_mode != "bypassPermissions"))
            });
            if reusable {
                let live = state.live.as_ref().unwrap();
                let plan = Plan::Reuse {
                    set_model: (live.model != model).then(|| model.clone()),
                    set_mode: (live.permission_mode != mode).then(|| mode.clone()),
                };
                (plan, None)
            } else {
                let resume = state.resumable.contains(&native) || input.provider_turn_ordinal > 1;
                let launch = LaunchInput {
                    thread_id: input.thread_id.as_str().into(),
                    native_thread_id: native.clone(),
                    resume,
                    model: model.clone(),
                    effort: effort.clone(),
                    permission_mode: mode.clone(),
                    cwd: cwd.clone(),
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
                set_mode,
            } => {
                if let Some(model) = set_model {
                    inner
                        .control(
                            json!({"subtype": "set_model", "model": model}),
                            CONTROL_TIMEOUT,
                        )
                        .await?;
                    if let Some(live) = &mut inner.lock().live {
                        live.model = model;
                    }
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
            }
        }

        let (outs, writer, uuid) = {
            let mut state = inner.lock();
            let writer = state
                .live
                .as_ref()
                .map(|l| l.process.writer())
                .ok_or(ProviderError::SessionStopped)?;
            let outs = state.mapper.begin_turn(&input, &mode);
            state.resumable.insert(native);
            (outs, writer, ids::SystemEnv.uuid())
        };
        inner.deliver(Some(&writer), outs).await;
        if writer
            .send(user_message(&input.message.text, &uuid))
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

    async fn launch(&self, input: LaunchInput, title: Option<&str>) -> ProviderResult<()> {
        let inner = &self.inner;
        let spec = launch::launch_spec(&inner.config, &input);
        let (tx, rx) = mpsc::channel(EVENT_CAPACITY);
        let process = Process::spawn(&spec, tx).map_err(|e| {
            failed(
                "start_turn",
                format!("Could not start Claude ({}): {e}", spec.program.display()),
            )
        })?;
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
                restart_needed: false,
            });
            generation
        };
        tokio::spawn(drive(inner.clone(), generation, rx));
        let init = launch::initialize_request(&inner.config, title);
        if let Err(error) = inner.control(init, INITIALIZE_TIMEOUT).await {
            let live = inner.lock().live.take();
            if let Some(live) = live {
                live.process.shutdown().await;
            }
            return Err(match error {
                ProviderError::SessionStopped => failed(
                    "start_turn",
                    "Claude exited before it answered initialize (an unknown --resume id, a bad flag, or no credentials)",
                ),
                other => other,
            });
        }
        Ok(())
    }
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
                return from_json(thread).map_err(|e| failed("ensure_thread", e.to_string()));
            }
            let mut env = SystemEnv;
            let native = env.uuid();
            let now = env.now();
            let thread = json!({
                "id": ids::provider_thread_id(&native),
                "driver": ids::DRIVER,
                "providerInstanceId": ids::DRIVER,
                "providerSessionId": self.id.as_str(),
                "appThreadId": input.thread_id.as_str(),
                "ownerNodeId": null,
                "nativeThreadRef": {"driver": ids::DRIVER, "nativeId": native, "strength": "strong"},
                "nativeConversationHeadRef": null,
                "status": "idle",
                "firstRunOrdinal": null,
                "lastRunOrdinal": null,
                "handoffIds": [],
                "forkedFrom": null,
                "createdAt": now,
                "updatedAt": now,
            });
            from_json(thread).map_err(|e| failed("ensure_thread", e.to_string()))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                failed("resume_thread", "provider thread has no native Claude id")
            })?;
            self.inner.lock().resumable.insert(native);
            let mut thread = to_json(&input.provider_thread);
            thread["providerSessionId"] = json!(self.id.as_str());
            thread["status"] = json!("idle");
            thread["updatedAt"] = json!(SystemEnv.now());
            from_json(thread).map_err(|e| failed("resume_thread", e.to_string()))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(self.start_turn_inner(input))
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if let Some(selection) = &input.model_selection {
                let (model, _) = model_effort(selection);
                let change = self
                    .inner
                    .lock()
                    .live
                    .as_ref()
                    .is_some_and(|l| l.model != model);
                if change {
                    self.inner
                        .control(
                            json!({"subtype": "set_model", "model": model}),
                            CONTROL_TIMEOUT,
                        )
                        .await?;
                    if let Some(live) = &mut self.inner.lock().live {
                        live.model = model;
                    }
                }
            }
            let writer = {
                let mut state = self.inner.lock();
                let writer = state
                    .live
                    .as_ref()
                    .map(|l| l.process.writer())
                    .ok_or(ProviderError::SessionStopped)?;
                if state.mapper.active_turn_id() != Some(input.provider_turn_id.as_str()) {
                    return Err(failed("steer_turn", "that turn is not running"));
                }
                state.mapper.expect_steer_result();
                writer
            };
            writer
                .send(user_message(&input.message.text, &SystemEnv.uuid()))
                .await
                .map_err(|_| ProviderError::SessionStopped)
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
        Box::pin(async move {
            let (model, effort) = model_effort(&selection);
            let live_differs = {
                let mut state = self.inner.lock();
                state.model = Some(model.clone());
                match &mut state.live {
                    Some(live) => {
                        // Effort is a launch flag; a change takes a new process next turn.
                        live.restart_needed |= live.effort != effort;
                        live.model != model
                    }
                    None => false,
                }
            };
            if live_differs {
                self.inner
                    .control(
                        json!({"subtype": "set_model", "model": model}),
                        CONTROL_TIMEOUT,
                    )
                    .await?;
                if let Some(live) = &mut self.inner.lock().live {
                    live.model = model;
                }
            }
            Ok(())
        })
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
            self.inner.lock().events = None;
        })
    }
}
