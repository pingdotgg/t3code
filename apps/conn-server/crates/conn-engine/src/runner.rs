//! Drives providers: opens a session per thread, starts turns, and turns `ProviderEvent`s into
//! domain events.
//!
//! Streamed assistant text goes through T3's buffered delivery ([`crate::streaming`]): a
//! running assistant node is never stored, and a streaming message or turn item is stored only
//! at a Markdown boundary or after it was idle. What is stored stays in the log.

use std::{
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

use conn_contract::{ProviderThread, ProviderTurnId, from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, ProviderEvent, ResumeThreadInput,
    RuntimePolicy, RuntimeRequestResponse, Session, SteerInput, SteerStatus, ThreadDisposition,
    TurnInput, TurnMessage, TurnStatus,
};
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, sleep_until},
};

use crate::commands::{failure, finish_run_as, hold_queue, start_next_queued};
use crate::engine::Inner;
use crate::lock;
use crate::store::Draft;
use crate::streaming::AssistantStreaming;

/// A thread whose provider session is open.
pub(crate) struct LiveThread {
    session: Arc<dyn Session>,
    /// The provider instance the session belongs to. A run on another instance reopens.
    instance: String,
    state: Mutex<LiveState>,
    /// When the session last did anything; the idle reaper closes it after `idle_session`.
    /// Milliseconds by the engine's clock.
    last_used: Mutex<u64>,
    /// Ends the event pump. The pump holds this thread, whose session may hold the event
    /// sender, so a closed channel alone would never end it.
    closed: tokio::sync::Notify,
    /// Waiters for the pump to store the events already sent ([`Inner::events_stored`]).
    stored_waiters: Mutex<Vec<oneshot::Sender<()>>>,
    stored_wanted: tokio::sync::Notify,
    /// Since when background work has kept this idle session open.
    held_since: Mutex<Option<u64>>,
    /// The provider session's id, for its provider threads.
    provider_session_id: String,
    /// `backgroundTasksEndWithProcess`: releasing the session clears its threads' rosters.
    background_tasks_end_with_process: bool,
    /// Revokes the agent tools this session got ([`crate::EngineHost::session_closed`]).
    tools_key: Option<String>,
    /// What the session last loaded for this thread (`providerThreadLoadKey` in T3's
    /// `ProviderSessionManager`): a turn start resumes the native thread when it differs.
    loaded_key: Mutex<Option<String>>,
}

#[derive(Default)]
struct LiveState {
    provider_thread: Option<ProviderThread>,
    active: Option<ActiveRun>,
    /// Provider turns whose work goes on after their terminal (`background_work.updated`).
    /// Bounded by [`MAX_BACKGROUND_TURNS`].
    background_turns: std::collections::HashSet<String>,
    /// `responseStreamingMode` of the run's project, read at each turn start, as T3's
    /// `RunExecutionService` reads it per run.
    streaming_mode: crate::ResponseStreamingMode,
}

/// At most this many provider turns are tracked as having background work; a provider that
/// never clears them cannot grow the set without bound.
const MAX_BACKGROUND_TURNS: usize = 64;
/// How many waiting events the pump reads ahead for continuation requests: one channel's worth.
const LOOKAHEAD: usize = 256;

#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    /// The run's ordinal, which its turn's terminal names.
    ordinal: u64,
    root_node_id: String,
    provider_turn_id: Option<ProviderTurnId>,
}

impl LiveThread {
    pub(crate) fn touch(&self, now: u64) {
        *lock(&self.last_used) = now;
    }

    pub(crate) fn session(&self) -> &Arc<dyn Session> {
        &self.session
    }

    pub(crate) fn instance(&self) -> &str {
        &self.instance
    }

    /// The provider thread the session's next turn continues (after a rollback or a fork).
    pub(crate) fn set_provider_thread(&self, thread: ProviderThread) {
        lock(&self.state).provider_thread = Some(thread);
    }

    /// Idle: no run and no provider event for `idle`, and no background work, which holds the
    /// session at most `max_hold` past that (T3's idle pin).
    pub(crate) fn idle_for(&self, now: u64, idle: Duration, max_hold: Duration) -> bool {
        let elapsed = |since: u64| Duration::from_millis(now.saturating_sub(since));
        if lock(&self.state).active.is_some() || elapsed(*lock(&self.last_used)) < idle {
            return false;
        }
        let mut held = lock(&self.held_since);
        let reported = !lock(&self.state).background_turns.is_empty();
        if !reported && !self.session.has_pending_background_work() {
            *held = None;
            return true;
        }
        elapsed(*held.get_or_insert(now)) >= max_hold
    }

    fn active(&self) -> Option<ActiveRun> {
        lock(&self.state).active.clone()
    }
    fn take_active(&self) -> Option<ActiveRun> {
        lock(&self.state).active.take()
    }
}

/// What a turn start needs from the store.
struct TurnContext {
    thread: Value,
    run: Value,
    message: Value,
    cwd: Option<String>,
    provider_thread: Option<Value>,
    /// The source to fork natively, on a fork's first turn.
    fork: Option<crate::fork::NativeFork>,
    /// The run starts a new provider conversation (`freshContext`).
    fresh: bool,
    /// The run goes back to the thread's own conversation past a scheduled fresh run's, so
    /// the session that holds the schedule's conversation is released first.
    leaves_side_conversation: bool,
}

enum StartError {
    /// The run ended before the provider took it (an interrupt or a delete).
    Abandoned,
    Failed(String),
}

impl From<String> for StartError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

fn status_name(status: TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::Cancelled => "cancelled",
        TurnStatus::Failed => "failed",
    }
}

impl Inner {
    pub(crate) async fn start_turn(self: Arc<Self>, thread_id: String, run_id: String) {
        let result = self.try_start_turn(&thread_id, &run_id).await;
        // One write decides, under the store lock, whether Stop got here first: a Stop that
        // commits later sees the start accepted and interrupts the provider turn instead.
        let accepted = result.is_ok();
        let (tid, rid) = (thread_id.clone(), run_id.clone());
        let abandoned = self
            .write(move |tx| {
                let abandoned = tx.start_abandoned(&rid, true);
                if accepted && !abandoned {
                    tx.accept_start(&tid, &rid)?;
                }
                Ok(abandoned)
            })
            .await
            .unwrap_or_else(|e| {
                eprintln!("conn-engine: could not record a turn start: {e}");
                false
            });
        if abandoned {
            self.after_abandoned_start(&thread_id, &run_id, accepted)
                .await;
            return;
        }
        if let Err(StartError::Failed(message)) = result {
            if let Some(live) = self.live_thread(&thread_id) {
                live.take_active();
            }
            self.end_run(
                &thread_id,
                &run_id,
                "failed",
                Some(failure("provider_error", &message, None)),
            )
            .await;
        }
    }

    /// `AbandonStart`: Stop ended the run before the provider accepted its turn. The live
    /// session stops sending the run's events to it and gets `abandon_turn_start`, as T3's
    /// worker interrupts the running start; the start's own effect cleans up after it.
    pub(crate) async fn abandon_start(&self, thread_id: &str, run_id: &str) {
        let Some(live) = self.live_thread(thread_id) else {
            return;
        };
        {
            let mut state = lock(&live.state);
            if state.active.as_ref().is_some_and(|a| a.run_id == run_id) {
                state.active = None;
            }
        }
        live.session
            .abandon_turn_start(conn_provider::AbandonTurnStartInput {
                thread_id: thread_id.into(),
                run_id: run_id.into(),
            })
            .await;
    }

    /// The start of a run Stop ended returned. A turn the provider accepted anyway gets
    /// `interrupt_turn`, as T3 interrupts a provider turn that starts after Stop
    /// (`RunExecutionService`, `shouldStartProviderTurn`). The turn observer hears of the end
    /// when it heard of the start.
    async fn after_abandoned_start(
        self: &Arc<Self>,
        thread_id: &str,
        run_id: &str,
        accepted: bool,
    ) {
        if accepted {
            self.events_stored(thread_id).await;
        }
        let live = self.live_thread(thread_id);
        if let Some(live) = &live {
            let mut state = lock(&live.state);
            if state.active.as_ref().is_some_and(|a| a.run_id == run_id) {
                state.active = None;
            }
        }
        if accepted && let Some(live) = live {
            let (tid, rid) = (thread_id.to_owned(), run_id.to_owned());
            let reported = self
                .db(move |store| -> Result<Option<(Value, Value)>, String> {
                    let tx = store.tx()?;
                    let found = (|| {
                        let Some(run) = tx.entity(&tid, "runs", &rid)? else {
                            return Ok(None);
                        };
                        let turn = tx
                            .entities(&tid, "providerTurns")?
                            .into_iter()
                            .filter(|t| {
                                t["runAttemptId"] == run["activeAttemptId"]
                                    && t["status"] == "running"
                            })
                            .max_by_key(|t| t["ordinal"].as_u64().unwrap_or(0));
                        let Some(turn) = turn else { return Ok(None) };
                        let thread = tx
                            .entities(&tid, "providerThreads")?
                            .into_iter()
                            .find(|pt| pt["id"] == turn["providerThreadId"]);
                        Ok(thread.map(|pt| (pt, turn)))
                    })();
                    tx.rollback();
                    found
                })
                .await
                .ok()
                .flatten();
            if let Some((provider_thread, turn)) = reported
                && let (Ok(provider_thread), Ok(provider_turn_id)) =
                    (from_json(provider_thread), from_json(turn["id"].clone()))
                && let Err(e) = live
                    .session
                    .interrupt_turn(InterruptInput {
                        provider_thread,
                        provider_turn_id,
                    })
                    .await
            {
                eprintln!("conn-engine: could not interrupt a turn that started after Stop: {e}");
            }
        }
        if let Some(observer) = &self.observer {
            self.observe_end(observer.clone(), thread_id.to_owned(), run_id.to_owned())
                .await;
        }
    }

    /// Waits until the thread's event pump stored every event its session had sent when this
    /// was called. T3's adapters run ahead of its store, and a capture there completes the run
    /// after the events already sent (`claude_background_subagent_after_root`). It never
    /// waits for an event not sent yet.
    pub(crate) async fn events_stored(&self, thread_id: &str) {
        let Some(live) = self.live_thread(thread_id) else {
            return;
        };
        let (done, stored) = oneshot::channel();
        lock(&live.stored_waiters).push(done);
        live.stored_wanted.notify_one();
        drop(live);
        // A pump that ended drops the sender.
        let _ = stored.await;
    }

    pub(crate) fn live_thread(&self, thread_id: &str) -> Option<Arc<LiveThread>> {
        lock(&self.live).get(thread_id).cloned()
    }

    async fn end_run(
        self: &Arc<Self>,
        thread_id: &str,
        run_id: &str,
        status: &'static str,
        failure: Option<Value>,
    ) {
        let (thread, run) = (thread_id.to_owned(), run_id.to_owned());
        let (thread_id, run_id) = (thread_id.to_owned(), run_id.to_owned());
        let held_on_failure = failure
            .as_ref()
            .is_some_and(|f| f["class"] != "validation_error");
        let checkpointing = self.checkpoints.is_some();
        let inner = self.clone();
        let next = self
            .write(move |tx| {
                // A run with a checkpoint scope is captured first (`checkpoint.capture`): a
                // completed one waits, and what follows its end runs after the capture.
                let captured = checkpointing
                    && matches!(status, "completed" | "interrupted" | "cancelled")
                    && tx
                        .entity(&thread_id, "runs", &run_id)?
                        .and_then(|run| run["rootNodeId"].as_str().map(str::to_owned))
                        .map(|root| tx.entity(&thread_id, "nodes", &root))
                        .transpose()?
                        .flatten()
                        .is_some_and(|node| node["checkpointScopeId"].is_string());
                let persisted = if captured && status == "completed" {
                    "waiting"
                } else {
                    status
                };
                let ended = finish_run_as(
                    tx,
                    &thread_id,
                    &run_id,
                    status,
                    persisted,
                    failure,
                    crate::commands::IdleWrite::TurnEnd,
                )?;
                // A failure holds the queue, so queued messages do not hit the same wall. A
                // late end of a run that already ended (a start failing after Force stop)
                // holds nothing.
                if held_on_failure && ended {
                    hold_queue(tx, &thread_id)?;
                }
                // `checkpoint.capture` waits in the thread's lane, as T3's effect: a rollback
                // admitted meanwhile runs after it and sees the run completed. The capture ends
                // the run's end.
                let effects = if captured {
                    vec![crate::commands::Effect::CaptureCheckpoint {
                        thread_id: thread_id.clone(),
                        run_id: run_id.clone(),
                    }]
                } else {
                    let mut effects = crate::families::on_run_end(tx, &thread_id, &run_id)?;
                    effects.extend(start_next_queued(tx, &thread_id, None)?);
                    effects
                };
                // Lane slots are taken under the store lock, so lane order is commit order.
                let reserved = effects
                    .into_iter()
                    .map(|effect| inner.reserve_effect(effect))
                    .collect::<Vec<_>>();
                Ok((reserved, captured))
            })
            .await;
        match next {
            Ok((reserved, captured)) => {
                reserved
                    .into_iter()
                    .for_each(crate::engine::ReservedEffect::start);
                if captured {
                    return;
                }
            }
            Err(e) => eprintln!("conn-engine: could not end run: {e}"),
        }
        if let Some(observer) = &self.observer {
            self.observe_end(observer.clone(), thread, run).await;
        }
    }

    /// A terminal whose native thread cannot take another turn leaves the provider thread
    /// `error` (`finalProviderThreadStatus`).
    async fn mark_thread_broken(&self, thread_id: &str, run_id: &str) {
        let (tid, rid) = (thread_id.to_owned(), run_id.to_owned());
        let result = self
            .write(move |tx| match tx.entity(&tid, "runs", &rid)? {
                Some(run) => crate::commands::settle_provider_thread(
                    tx,
                    &tid,
                    &run,
                    "error",
                    crate::commands::IdleWrite::TurnEnd,
                ),
                None => Ok(()),
            })
            .await;
        if let Err(e) = result {
            eprintln!("conn-engine: could not mark a provider thread broken: {e}");
        }
    }

    /// Opens a provider session for the thread on `instance` and makes it the thread's live
    /// one. `None`: shutdown began, or another session for the thread won the race.
    pub(crate) async fn open_live(
        self: &Arc<Self>,
        thread_id: &str,
        instance: &str,
        session_id: &str,
        model_selection: &conn_contract::ModelSelection,
        runtime_policy: &RuntimePolicy,
        thread: &Value,
    ) -> Result<Option<Arc<LiveThread>>, String> {
        let subagent = thread["lineage"]["relationshipToParent"] == "subagent";
        // Only a run that names no instance may go to the one configured provider.
        let provider = self.providers.resolve(instance).ok_or_else(|| {
            format!("No provider instance `{instance}` is configured on this server.")
        })?;
        let tools = self.host.as_ref().and_then(|host| {
            host.agent_tools(crate::AgentSession {
                thread_id: thread_id.to_owned(),
                project_id: thread
                    .get("projectId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                provider_instance_id: provider.instance_id().as_str().to_owned(),
                subagent,
            })
        });
        let opened = provider
            .open_session(OpenSessionInput {
                thread_id: thread_id.into(),
                provider_session_id: session_id.into(),
                model_selection: model_selection.clone(),
                runtime_policy: runtime_policy.clone(),
                resume_from_session: None,
                mcp_servers: tools
                    .as_ref()
                    .map(|tools| tools.servers.clone())
                    .unwrap_or_default(),
                host: self.host.as_ref().and_then(|host| {
                    host.provider_host(crate::AgentSession {
                        thread_id: thread_id.to_owned(),
                        project_id: thread
                            .get("projectId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        provider_instance_id: provider.instance_id().as_str().to_owned(),
                        subagent,
                    })
                }),
            })
            .await
            .map_err(|e| {
                self.revoke_tools(tools.as_ref().map(|t| t.key.as_str()));
                e.to_string()
            })?;
        let session: Arc<dyn Session> = Arc::from(opened.session);
        let provider_session = to_json(&opened.provider_session);
        // `open_session` must not yield before the session is in
        // `live`: on the one runtime thread, nothing else can then open a session for
        // this thread or begin shutdown in between. Check again anyway, so a provider
        // that does yield never leaks a session or overwrites one.
        let raced = self.live_thread(thread_id);
        if raced.is_some() || self.shutting_down() {
            self.revoke_tools(tools.as_ref().map(|t| t.key.as_str()));
            session.close().await;
            match raced {
                Some(live) if !self.shutting_down() && live.instance == instance => Ok(Some(live)),
                _ => Ok(None),
            }
        } else {
            let live = Arc::new(LiveThread {
                session,
                instance: instance.to_owned(),
                state: Mutex::new(LiveState::default()),
                last_used: Mutex::new(self.clock.now_millis()),
                closed: tokio::sync::Notify::new(),
                stored_waiters: Mutex::new(Vec::new()),
                stored_wanted: tokio::sync::Notify::new(),
                held_since: Mutex::new(None),
                provider_session_id: provider_session["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                background_tasks_end_with_process: opened.background_tasks_end_with_process,
                tools_key: tools.map(|t| t.key),
                loaded_key: Mutex::new(None),
            });
            lock(&self.live).insert(thread_id.to_owned(), live.clone());
            // The session's row, from `open_session` (T3: the runtime's
            // `providerSession`), before any of its events.
            let tid = thread_id.to_owned();
            self.write(move |tx| {
                tx.append(Draft::new(
                    &tid,
                    "provider-session.updated",
                    provider_session,
                ))
            })
            .await?;
            tokio::spawn(
                self.clone()
                    .pump(thread_id.to_owned(), live.clone(), opened.events),
            );
            Ok(Some(live))
        }
    }

    async fn try_start_turn(
        self: &Arc<Self>,
        thread_id: &str,
        run_id: &str,
    ) -> Result<(), StartError> {
        let (tid, rid) = (thread_id.to_owned(), run_id.to_owned());
        let context = self
            .db(move |store| -> Result<Option<TurnContext>, String> {
                let tx = store.tx()?;
                let context = (|| {
                    let Some(thread) = tx.thread(&tid)? else {
                        return Ok(None);
                    };
                    let Some(run) = tx.entity(&tid, "runs", &rid)? else {
                        return Ok(None);
                    };
                    let message_id = run["userMessageId"].as_str().unwrap_or_default();
                    let message = tx
                        .entity(&tid, "messages", message_id)?
                        .unwrap_or(Value::Null);
                    let project = tx.project(thread["projectId"].as_str().unwrap_or_default())?;
                    let cwd = thread["worktreePath"]
                        .as_str()
                        .or_else(|| project.as_ref().and_then(|p| p["workspaceRoot"].as_str()))
                        .map(str::to_owned);
                    let instance = run["providerInstanceId"].as_str().unwrap_or_default();
                    let same_instance =
                        |pt: &Value| pt["providerInstanceId"].as_str() == Some(instance);
                    // Never resume a provider thread of another instance. Without an active one
                    // of this instance, take its newest root thread (`rootProviderThreadsForProvider`).
                    let fresh = run["freshContext"] == true;
                    let active = match thread["activeProviderThreadId"].as_str() {
                        Some(id) => tx
                            .entity(&tid, "providerThreads", id)?
                            .filter(|pt| same_instance(pt)),
                        None => None,
                    };
                    // A wake acts on the active session; a message continues the conversation,
                    // past a scheduled fresh run's side conversation (`dispatchProviderThread`).
                    let wake = message["notification"].is_object()
                        || message["delegatedCompletion"].is_object();
                    let active_id = thread["activeProviderThreadId"].clone();
                    let active = match active {
                        Some(pt) if !wake => {
                            Some(crate::fresh::conversation_thread(&tx, &tid, pt)?)
                        }
                        other => other,
                    };
                    let leaves_side_conversation =
                        !fresh && active.as_ref().is_some_and(|pt| pt["id"] != active_id);
                    let provider_thread = match active {
                        _ if fresh => None,
                        Some(pt) => Some(pt),
                        None => tx
                            .entities_where(
                                &tid,
                                "providerThreads",
                                "providerInstanceId",
                                instance,
                            )?
                            .into_iter()
                            .filter(|pt| {
                                pt["ownerNodeId"].is_null()
                                    && pt["appThreadId"].as_str().is_none_or(|a| a == tid)
                            })
                            .max_by_key(|pt| {
                                (
                                    pt["lastRunOrdinal"].as_u64().unwrap_or(0),
                                    pt["updatedAt"].as_str().unwrap_or_default().to_owned(),
                                )
                            }),
                    };
                    let fork = match provider_thread {
                        Some(_) => None,
                        None if fresh => None,
                        None => crate::fork::native_fork_input(&tx, &tid)?,
                    };
                    Ok(Some(TurnContext {
                        thread,
                        run,
                        message,
                        cwd,
                        provider_thread,
                        fork,
                        fresh,
                        leaves_side_conversation,
                    }))
                })();
                tx.rollback();
                context
            })
            .await?;
        let Some(mut context) = context else {
            return Err(StartError::Abandoned);
        };
        if let Some(cwd) = self.policy_override.as_ref().and_then(|p| p.cwd.clone()) {
            context.cwd = Some(cwd);
        }
        if context.run["status"] != "starting" {
            return Err(StartError::Abandoned);
        }

        let model_selection: conn_contract::ModelSelection =
            from_json(context.run["modelSelection"].clone()).map_err(|e| e.to_string())?;
        let mut runtime_policy: RuntimePolicy = from_json(json!({
            "runtimeMode": context.thread["runtimeMode"],
            "interactionMode": context.thread["interactionMode"],
            "cwd": context.cwd,
        }))
        .map_err(|e| e.to_string())?;
        if let Some(policy) = &self.policy_override {
            policy.apply(&mut runtime_policy);
        }

        let instance = context.run["providerInstanceId"]
            .as_str()
            .unwrap_or_default();
        // A live session of another instance closes; the run opens one on its own instance.
        // A fresh run releases the session too: each holds one native conversation
        // (`sessionsReleasedByFreshContext`).
        if let Some(live) = self.live_thread(thread_id)
            && (live.instance != instance || context.fresh || context.leaves_side_conversation)
        {
            self.close_session(thread_id).await;
        }
        let live = match self.live_thread(thread_id) {
            Some(live) => live,
            // The run stays `starting`; the next server start picks it up (`restart.rs`).
            None if self.shutting_down() => return Err(StartError::Abandoned),
            None => {
                match self
                    .open_live(
                        thread_id,
                        instance,
                        &format!("provider-session:{thread_id}:{run_id}"),
                        &model_selection,
                        &runtime_policy,
                        &context.thread,
                    )
                    .await?
                {
                    Some(live) => live,
                    None => return Err(StartError::Abandoned),
                }
            }
        };

        live.touch(self.clock.now_millis());
        let known = lock(&live.state).provider_thread.clone();
        let stored = match (known, context.provider_thread) {
            (Some(known), _) => Some(known),
            (None, Some(stored)) => Some(from_json(stored).map_err(|e| e.to_string())?),
            (None, None) => None,
        };
        let load_key = |thread: &ProviderThread| {
            thread_load_key(
                live.session.as_ref(),
                thread,
                &model_selection,
                &runtime_policy,
            )
        };
        // T3's `ProviderTurnStartService` resumes a thread with a native id at every turn
        // start; its session manager skips the load when the session already loaded that
        // native thread with this selection and policy. A rollback's own resume does not
        // count, so a send after a rollback on a new process resumes again.
        let provider_thread = match stored {
            Some(stored) if stored.native_thread_ref.is_some() => {
                let key = load_key(&stored);
                if lock(&live.loaded_key).as_deref() == Some(key.as_str()) {
                    stored
                } else {
                    let resumed = live
                        .session
                        .resume_thread(ResumeThreadInput {
                            provider_thread: stored,
                            thread_id: Some(thread_id.into()),
                            model_selection: Some(model_selection.clone()),
                            runtime_policy: Some(runtime_policy.clone()),
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    *lock(&live.loaded_key) = Some(load_key(&resumed));
                    resumed
                }
            }
            stored => {
                let thread = match stored {
                    Some(existing) => live
                        .session
                        .ensure_thread(EnsureThreadInput {
                            thread_id: thread_id.into(),
                            title: context.thread["title"].as_str().map(str::to_owned),
                            model_selection: model_selection.clone(),
                            runtime_policy: runtime_policy.clone(),
                            existing_provider_thread: Some(existing),
                        })
                        .await
                        .map_err(|e| e.to_string())?,
                    // A fork's first turn: the provider forks the source's native thread.
                    None if context.fork.is_some() => {
                        let fork = context.fork.as_mut().map(|f| {
                            f.input.model_selection = Some(model_selection.clone());
                            f.input.runtime_policy = Some(runtime_policy.clone());
                            f.input.clone()
                        });
                        match fork {
                            Some(input) => live.session.fork_thread(input).await.map_err(|e| {
                                StartError::Failed(format!("The native fork failed: {e}"))
                            })?,
                            None => return Err(StartError::Abandoned),
                        }
                    }
                    None => live
                        .session
                        .ensure_thread(EnsureThreadInput {
                            thread_id: thread_id.into(),
                            title: context.thread["title"].as_str().map(str::to_owned),
                            model_selection: model_selection.clone(),
                            runtime_policy: runtime_policy.clone(),
                            existing_provider_thread: None,
                        })
                        .await
                        .map_err(|e| e.to_string())?,
                };
                *lock(&live.loaded_key) = Some(load_key(&thread));
                thread
            }
        };
        let root = context.run["rootNodeId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let attempt_id = format!("{run_id}:attempt:1");
        let mut provider_thread_json = to_json(&provider_thread);
        if provider_thread_json.is_object() {
            provider_thread_json["providerInstanceId"] = json!(instance);
            // `runningProviderThread` in T3's `ProviderTurnStartService`.
            let ordinal = context.run["ordinal"].clone();
            if provider_thread_json["firstRunOrdinal"].is_null() {
                provider_thread_json["firstRunOrdinal"] = ordinal.clone();
            }
            provider_thread_json["lastRunOrdinal"] = ordinal;
            // T3 marks it `active` here; the run's end marks it `idle` again
            // (`RunExecutionService`, `finalProviderThreadStatus`). `updatedAt` is the
            // write's time.
            provider_thread_json["status"] = json!("active");
        }
        if provider_thread_json
            .get("appThreadId")
            .is_none_or(Value::is_null)
        {
            provider_thread_json["appThreadId"] = json!(thread_id);
        }
        // The provider gets the running row and echoes it, as T3's `startTurn` input.
        let provider_thread: ProviderThread =
            from_json(provider_thread_json.clone()).unwrap_or(provider_thread);
        {
            let mut state = lock(&live.state);
            state.provider_thread = Some(provider_thread.clone());
            state.streaming_mode = self
                .host
                .as_ref()
                .map_or_else(crate::ResponseStreamingMode::default, |host| {
                    host.response_streaming_mode(context.thread["projectId"].as_str())
                });
            state.active = Some(ActiveRun {
                run_id: run_id.to_owned(),
                ordinal: context.run["ordinal"].as_u64().unwrap_or(1),
                root_node_id: root.clone(),
                provider_turn_id: None,
            });
        }
        let (tid, rid, aid, root_id) = (
            thread_id.to_owned(),
            run_id.to_owned(),
            attempt_id.clone(),
            root.clone(),
        );
        let fork_transfer = context.fork.as_ref().map(|f| f.transfer.clone());
        let checkpoint_cwd = self
            .checkpoints
            .as_ref()
            .and(context.cwd.clone())
            .filter(|_| context.thread["lineage"]["sideChat"] != true);
        let started = self
            .write(move |tx| {
                let Some(mut run) = tx.entity(&tid, "runs", &rid)? else {
                    return Ok(None);
                };
                if run["status"] != "starting" {
                    return Ok(None);
                }
                let now = tx.now().to_owned();
                let pt_id = provider_thread_json["id"].clone();
                let draft = |event_type, payload| {
                    Draft::new(&tid, event_type, payload)
                        .run(Some(&rid))
                        .node(Some(&root_id))
                };
                if provider_thread_json["id"].is_string() {
                    let mut running = provider_thread_json.clone();
                    running["updatedAt"] = json!(now);
                    tx.append(Draft::new(&tid, "provider-thread.updated", running))?;
                }
                if let Some(transfer) = &fork_transfer {
                    tx.append(
                        Draft::new(
                            &tid,
                            "context-transfer.updated",
                            crate::fork::consumed(transfer, &provider_thread_json, &run, &now),
                        )
                        .run(Some(&rid)),
                    )?;
                }
                if let Some(mut thread) = tx.thread(&tid)?
                    && thread["activeProviderThreadId"] != pt_id
                {
                    thread["activeProviderThreadId"] = pt_id.clone();
                    tx.append(Draft::new(&tid, "thread.metadata-updated", thread))?;
                }
                tx.append(draft(
                    "run-attempt.created",
                    json!({
                        "id": aid,
                        "runId": rid,
                        "attemptOrdinal": 1,
                        "rootNodeId": root_id,
                        "providerInstanceId": run["providerInstanceId"],
                        "providerThreadId": pt_id,
                        "providerTurnId": null,
                        "reason": "initial",
                        "status": "running",
                        "startedAt": now,
                        "completedAt": null,
                    }),
                ))?;
                run["status"] = json!("running");
                run["startedAt"] = json!(now);
                run["activeAttemptId"] = json!(aid);
                run["providerThreadId"] = pt_id.clone();
                tx.append(draft("run.updated", run.clone()))?;
                let mut scope = None;
                if let Some(mut node) = tx.entity(&tid, "nodes", &root_id)? {
                    if let Some(cwd) = &checkpoint_cwd {
                        scope = Some(crate::checkpoint::ensure_scope(
                            tx, &tid, &run, &mut node, &pt_id, cwd,
                        )?);
                    }
                    node["status"] = json!("running");
                    node["startedAt"] = json!(now);
                    node["providerThreadId"] = pt_id;
                    tx.append(draft("node.updated", node))?;
                }
                Ok(Some(scope))
            })
            .await?;
        let Some(scope) = started else {
            live.take_active();
            return Err(StartError::Abandoned);
        };
        // The baseline holds no change of this turn: the provider has not had the message.
        if let Some((scope_id, cwd)) = scope {
            self.capture_baseline(
                &scope_id,
                &cwd,
                context.run["ordinal"].as_u64().unwrap_or(1),
            )
            .await;
        }
        if let Some(observer) = &self.observer {
            observer
                .turn_started(crate::TurnPoint {
                    thread_id: thread_id.to_owned(),
                    run_id: run_id.to_owned(),
                    run_ordinal: context.run["ordinal"].as_u64().unwrap_or(1),
                    root_node_id: root.clone(),
                    cwd: context.cwd.clone(),
                })
                .await;
        }

        let input = TurnInput {
            // The provider decides from the turn ordinal, as before.
            native_thread_has_turns: None,
            restart_continuation_of_run_id: context.run["restartContinuationOfRunId"]
                .as_str()
                .map(Into::into),
            app_context: self
                .app_context(thread_id.to_owned())
                .await
                .unwrap_or_default(),
            app_thread: from_json(context.thread.clone()).map_err(|e| e.to_string())?,
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            run_ordinal: context.run["ordinal"].as_u64().unwrap_or(1) as u32,
            provider_turn_ordinal: context.run["ordinal"].as_u64().unwrap_or(1) as u32,
            attempt_id: attempt_id.as_str().into(),
            root_node_id: root.as_str().into(),
            provider_thread,
            message: TurnMessage {
                created_by: from_json(context.message["createdBy"].clone())
                    .unwrap_or(conn_contract::OrchestrationV2Actor::User),
                creation_source: from_json(context.message["creationSource"].clone())
                    .unwrap_or(conn_contract::OrchestrationV2CreationSource::Web),
                scheduled_task_id: context.message["scheduledTaskId"]
                    .as_str()
                    .map(str::to_owned),
                sender_thread_id: context.message["senderThreadId"]
                    .as_str()
                    .map(str::to_owned),
                message_id: context.run["userMessageId"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                text: context.message["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                attachments: from_json(context.message["attachments"].clone()).unwrap_or_default(),
            },
            model_selection,
            runtime_policy,
        };
        // A Stop that ended the run meanwhile abandoned it; the provider never hears of it.
        let rid = run_id.to_owned();
        let abandoned = self
            .db(move |store| store.tx().map(|mut tx| tx.start_abandoned(&rid, false)))
            .await
            .unwrap_or(false);
        if abandoned {
            return Err(StartError::Abandoned);
        }
        // A run the provider asked for (`continuation.requested`) is an agent message with
        // `creationSource: provider`; the provider shows the output it holds for it.
        live.session
            .start_turn(input)
            .await
            .map_err(|e| StartError::Failed(e.to_string()))
    }

    /// Reads one session's events until it closes. Ends a run the session leaves open.
    async fn pump(
        self: Arc<Self>,
        thread_id: String,
        live: Arc<LiveThread>,
        mut events: mpsc::Receiver<ProviderEvent>,
    ) {
        let mut streaming = AssistantStreaming::new(lock(&live.state).streaming_mode);
        // Held turn items whose position is taken (T3's `reservedHeldTurnItemIds`).
        let mut reserved: Vec<(String, String)> = Vec::new();
        // Events read ahead of the one being stored, to find continuation requests among them.
        let mut ahead: std::collections::VecDeque<ProviderEvent> =
            std::collections::VecDeque::new();
        // Events taken so far, and who waits for the count to reach a mark.
        let mut taken: u64 = 0;
        let mut marks: Vec<(u64, oneshot::Sender<()>)> = Vec::new();
        loop {
            // A held snapshot is stored once its message was idle long enough. The timer
            // only runs on a clock that moves by itself; on a `ManualClock` a snapshot comes
            // due when the clock is moved, as a sleep on T3's `TestClock`.
            let wake = streaming
                .next_idle_flush_at()
                .filter(|_| self.clock.timers_fire())
                .map(|at| {
                    let wait = at.saturating_sub(self.clock.now_millis());
                    (at, Instant::now() + Duration::from_millis(wait))
                });
            // Every event before the mark is stored: its waiter goes on.
            for (_, waiter) in marks.extract_if(.., |(mark, _)| *mark <= taken) {
                let _ = waiter.send(());
            }
            let event = match (ahead.pop_front(), wake) {
                (Some(event), _) => Some(event),
                (None, Some((at, when))) => tokio::select! {
                    event = events.recv() => event,
                    () = live.closed.notified() => None,
                    () = live.stored_wanted.notified() => {
                        let waiting = (ahead.len() + events.len()) as u64;
                        let new = std::mem::take(&mut *lock(&live.stored_waiters));
                        marks.extend(new.into_iter().map(|w| (taken + waiting, w)));
                        continue;
                    }
                    () = sleep_until(when) => {
                        // The timer slept until `at`; the clock may read a little earlier.
                        let now = self.clock.now_millis().max(at);
                        self.commit(streaming.take_idle_flushes(now)).await;
                        continue;
                    }
                },
                (None, None) => tokio::select! {
                    event = events.recv() => event,
                    () = live.closed.notified() => None,
                    () = live.stored_wanted.notified() => {
                        let waiting = (ahead.len() + events.len()) as u64;
                        let new = std::mem::take(&mut *lock(&live.stored_waiters));
                        marks.extend(new.into_iter().map(|w| (taken + waiting, w)));
                        continue;
                    }
                },
            };
            let Some(event) = event else { break };
            let event = self.capture_app_event(&live, event).await;
            taken += 1;
            // T3's adapters offer a continuation to `ProviderContinuationRequests`, a queue apart
            // from their event stream, and `ProviderContinuationService` dispatches it at once:
            // ahead of the events the adapter sent before it that are not stored yet. Those
            // are the ones already in the channel.
            while ahead.len() < LOOKAHEAD
                && let Ok(next) = events.try_recv()
            {
                ahead.push_back(next);
            }
            if !self.shutting_down() {
                let mut kept = std::collections::VecDeque::with_capacity(ahead.len());
                for next in ahead.drain(..) {
                    match next {
                        ProviderEvent::ContinuationRequested(request) => {
                            self.request_continuation(
                                &thread_id,
                                request.detail,
                                request.notification,
                                request.delivery,
                            )
                            .await;
                        }
                        other => kept.push_back(other),
                    }
                }
                ahead = kept;
            }
            // Once shutdown began, nothing a closing session reports is stored: T3 writes
            // nothing after its runtime is interrupted, and the next start recovers the live
            // run (`restart.rs`). Stored, the close's turn end would end the run here.
            if self.shutting_down() {
                break;
            }
            let now = self.clock.now_millis();
            live.touch(now);
            // Snapshots that came due before this event go first, as T3's idle tick would.
            if streaming.next_idle_flush_at().is_some_and(|at| at <= now) {
                self.commit(streaming.take_idle_flushes(now)).await;
            }
            streaming.set_mode(lock(&live.state).streaming_mode);
            // Live command output goes to the hub, not the store.
            if let ProviderEvent::CommandOutputDelta {
                thread_id: output_thread,
                item_id,
                chunk,
            } = &event
            {
                self.command_output
                    .append(output_thread.as_str(), item_id.as_str(), chunk);
                if let Some(tap) = &self.output_tap {
                    tap(item_id.as_str(), chunk);
                }
                continue;
            }
            // Not persisted (`ProviderEventIngestor`); it holds the idle session while any
            // provider turn has work left (`RunExecutionService` pendingBackgroundProviderTurns).
            if let ProviderEvent::BackgroundWorkUpdated {
                provider_turn_id,
                pending,
            } = &event
            {
                let mut state = lock(&live.state);
                if *pending {
                    if state.background_turns.len() < MAX_BACKGROUND_TURNS {
                        state
                            .background_turns
                            .insert(provider_turn_id.as_str().to_owned());
                    }
                } else {
                    state.background_turns.remove(provider_turn_id.as_str());
                }
                continue;
            }
            let active = live.active();
            let run_id = active.as_ref().map(|a| a.run_id.clone());
            let mut translated = translate(&thread_id, active.as_ref(), event);
            // A session belongs to one instance, so its provider threads do too. The engine sets
            // it, as `Orchestrator.ts` builds provider threads from the run's instance.
            if let Translated::Event(draft) = &mut translated
                && draft.event_type == "provider-thread.updated"
                && draft.payload.is_object()
            {
                draft.payload["providerInstanceId"] = json!(live.instance);
                // A broken thread loads again at the next turn start (T3 forgets its load).
                if draft.payload["status"] == "error" {
                    *lock(&live.loaded_key) = None;
                }
            }
            // A settled command's stored item has its output; its live tail goes.
            if let Translated::Event(draft) = &translated
                && draft.event_type == "turn-item.updated"
                && draft.payload["type"] == "command_execution"
                && !matches!(
                    draft.payload["status"].as_str(),
                    Some("running" | "pending" | "waiting")
                )
                && let Some(item_id) = draft.payload["id"].as_str()
            {
                self.command_output.finish(&draft.thread_id, item_id);
            }
            // A finished push can start new checks on the thread's watched pull requests
            // (`PullRequestSyncReactor.reopenWatchedChecks`).
            let pushed = match &translated {
                Translated::Event(draft)
                    if draft.event_type == "turn-item.updated"
                        && draft.payload["type"] == "command_execution"
                        && !matches!(
                            draft.payload["status"].as_str(),
                            Some("running" | "pending" | "waiting" | "idle")
                        )
                        && draft.payload["input"]
                            .as_str()
                            .is_some_and(crate::push::is_push_command) =>
                {
                    draft.payload["id"].as_str().map(|item| {
                        json!({
                            "type": "thread.pull-request-watch.checks-reopen",
                            // Stable per command: a repeated settlement clears an answer once.
                            "commandId": format!("server:pr-push-checks:{}:{item}", draft.thread_id),
                            "threadId": draft.thread_id,
                        })
                    })
                }
                _ => None,
            };
            if matches!(translated, Translated::Terminal(..)) {
                self.command_output.finish_thread(&thread_id);
            }
            match translated {
                Translated::Ignore => {}
                Translated::ProviderTurn(id, draft) => {
                    if let Some(active) = lock(&live.state).active.as_mut() {
                        active.provider_turn_id = Some(id);
                    }
                    let running = draft.payload["status"] == "running";
                    self.commit(vec![draft]).await;
                    if running && let Some(run_id) = &run_id {
                        self.deliver_deferred_steers(&thread_id, run_id).await;
                    }
                }
                Translated::Event(draft) => {
                    let held_item = (draft.event_type == "turn-item.updated"
                        && draft.payload["streaming"] == true)
                        .then(|| {
                            (
                                draft.thread_id.clone(),
                                draft.payload["id"].as_str().unwrap_or_default().to_owned(),
                            )
                        });
                    match streaming.filter(draft, self.clock.now_millis()) {
                        Some(draft) => self.commit(vec![draft]).await,
                        // Held text writes nothing, so its item would take a position only
                        // when written, behind every item that began after it.
                        None => {
                            if let Some(key) = held_item
                                && !key.1.is_empty()
                                && !reserved.contains(&key)
                            {
                                self.reserve_position(&key.0, &key.1).await;
                                if reserved.len() >= crate::streaming::MAX_TRACKS {
                                    reserved.remove(0);
                                }
                                reserved.push(key);
                            }
                        }
                    }
                }
                Translated::CreateThread(thread) => {
                    self.create_provider_thread(thread).await;
                }
                Translated::Subagent(draft, subagent) => {
                    self.commit(vec![draft]).await;
                    self.sync_subagent_thread_model(subagent).await;
                }
                Translated::Steer { message_id, status } => {
                    self.steer_updated(&thread_id, message_id, status).await;
                }
                Translated::Continuation(detail, notification, delivery) => {
                    self.request_continuation(&thread_id, detail, notification, delivery)
                        .await;
                }
                Translated::Terminal(status, failure, broken) => {
                    // The root run's messages are closed; none of its text is flushed later.
                    streaming.forget_thread(&thread_id);
                    reserved.retain(|(tid, _)| *tid != thread_id);
                    if let Some(run_id) = run_id {
                        live.take_active();
                        self.end_run(&thread_id, &run_id, status, failure).await;
                        if broken {
                            self.mark_thread_broken(&thread_id, &run_id).await;
                        }
                    }
                }
            }
            if let Some(command) = pushed
                && let Err(
                    crate::engine::DispatchError::Rejected(e)
                    | crate::engine::DispatchError::Internal(e),
                ) = self.dispatch_value(command).await
            {
                eprintln!("conn-engine: could not reopen watched checks after a push: {e}");
            }
        }
        if !self.shutting_down()
            && let Some(active) = live.take_active()
        {
            self.end_run(
                &thread_id,
                &active.run_id,
                "failed",
                Some(failure(
                    "provider_error",
                    "The provider session ended during the turn.",
                    None,
                )),
            )
            .await;
        }
        let mut map = lock(&self.live);
        if map
            .get(&thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, &live))
        {
            map.remove(&thread_id);
        }
    }

    /// `app_thread.created`: the child thread a subagent's rows are written to. Created once;
    /// a provider that announces it again changes nothing.
    async fn create_provider_thread(&self, thread: Value) {
        let Some(id) = thread["id"].as_str().map(str::to_owned) else {
            return;
        };
        let result = self
            .write(move |tx| {
                if tx.thread(&id)?.is_none() {
                    tx.append(Draft::new(&id, "thread.created", thread))?;
                }
                Ok(())
            })
            .await;
        if let Err(e) = result {
            eprintln!("conn-engine: could not create a provider thread: {e}");
        }
    }

    /// `syncSubagentThreadModel` (`ProviderEventIngestor`): a provider reveals a native
    /// subagent's model late, and its child thread takes it.
    async fn sync_subagent_thread_model(&self, subagent: Value) {
        if subagent["origin"] != "provider_native" {
            return;
        }
        let Some(child) = subagent["childThreadId"].as_str().map(str::to_owned) else {
            return;
        };
        let model = subagent["model"].as_str().map(str::to_owned);
        let selection = subagent
            .get("modelSelection")
            .filter(|s| s.is_object())
            .cloned();
        if model.is_none() && selection.is_none() {
            return;
        }
        let result = self
            .write(move |tx| {
                let Some(mut thread) = tx.thread(&child)? else {
                    return Ok(());
                };
                let current = thread["modelSelection"].clone();
                let reported = match (selection, model) {
                    (Some(selection), _) => selection,
                    (None, Some(model)) if current["model"] != model.as_str() => {
                        json!({"instanceId": current["instanceId"], "model": model})
                    }
                    _ => current.clone(),
                };
                if reported == current {
                    return Ok(());
                }
                thread["modelSelection"] = reported;
                thread["updatedAt"] = json!(tx.now());
                tx.append(Draft::new(&child, "thread.model-selection-updated", thread))?;
                Ok(())
            })
            .await;
        if let Err(e) = result {
            eprintln!("conn-engine: could not update a subagent thread's model: {e}");
        }
    }

    /// `steer.updated`: the steered message's turn item takes the provider's status, as
    /// `ProviderEventIngestor` does; only a pending or completed item changes.
    async fn steer_updated(&self, thread_id: &str, message_id: String, status: &'static str) {
        let tid = thread_id.to_owned();
        let result = self
            .write(move |tx| {
                let item_id = format!("turn-item:{message_id}");
                let Some(mut item) = tx.entity(&tid, "turnItems", &item_id)? else {
                    return Ok(());
                };
                if item["type"] != "user_message"
                    || item["status"] == status
                    || !(item["status"] == "pending" || item["status"] == "completed")
                {
                    return Ok(());
                }
                let now = tx.now().to_owned();
                item["status"] = json!(status);
                item["completedAt"] = if status == "pending" {
                    Value::Null
                } else {
                    json!(now)
                };
                item["updatedAt"] = json!(now);
                let run = item["runId"].as_str().map(str::to_owned);
                let node = item["nodeId"].as_str().map(str::to_owned);
                tx.append(
                    Draft::new(&tid, "turn-item.updated", item)
                        .run(run.as_deref())
                        .node(node.as_deref()),
                )?;
                Ok(())
            })
            .await;
        if let Err(e) = result {
            eprintln!("conn-engine: could not record a steer: {e}");
        }
    }

    /// `continuation.requested`: a queued agent message whose run starts the provider's
    /// continuation turn (`ProviderContinuationService`), so it runs after any active run.
    async fn request_continuation(
        self: &Arc<Self>,
        thread_id: &str,
        detail: Option<String>,
        notification: Option<Value>,
        delivery: Option<String>,
    ) {
        // Only buffered wakes come from the provider; a wake whose text is the whole message
        // (`delivery: "message_text"`, Codex) is the server's.
        let creation_source = if delivery.as_deref() == Some("message_text") {
            "server"
        } else {
            "provider"
        };
        let message_id = format!(
            "message:provider-continuation:{}",
            crate::time::unique_suffix()
        );
        let command = json!({
            "type": "message.dispatch",
            "commandId": format!("provider-continuation:{message_id}"),
            "threadId": thread_id,
            "messageId": message_id,
            "text": detail.unwrap_or_else(|| "Background task completed.".to_owned()),
            // The provider's notice, else `ProviderContinuationService`'s default.
            "notification": notification.unwrap_or_else(|| json!({
                "source": {"kind": "background_task"},
                "outcome": "updated",
                "summary": "Background activity updated",
            })),
            "attachments": [],
            "dispatchMode": {"type": "queue_after_active"},
            "createdBy": "agent",
            "creationSource": creation_source,
        });
        if let Err(
            crate::engine::DispatchError::Rejected(e) | crate::engine::DispatchError::Internal(e),
        ) = self.dispatch_value(command).await
        {
            eprintln!("conn-engine: could not start a continuation turn: {e}");
        }
    }

    /// Takes the next position for a held turn item (T3's `TurnItemPositionStore.allocate`).
    async fn reserve_position(&self, thread_id: &str, item_id: &str) {
        let (tid, iid) = (thread_id.to_owned(), item_id.to_owned());
        if let Err(e) = self
            .write(move |tx| tx.reserve_turn_item_position(&tid, &iid))
            .await
        {
            eprintln!("conn-engine: could not reserve a turn item position: {e}");
        }
    }

    async fn commit(&self, drafts: Vec<Draft>) {
        if drafts.is_empty() {
            return;
        }
        if let Err(e) = self
            .write(move |tx| {
                for draft in drafts {
                    tx.append(draft)?;
                }
                Ok(())
            })
            .await
        {
            eprintln!("conn-engine: could not record provider events: {e}");
        }
    }

    pub(crate) async fn interrupt(self: Arc<Self>, thread_id: String, run_id: String) {
        let live = self.live_thread(&thread_id);
        let target = live.as_ref().and_then(|live| {
            let state = lock(&live.state);
            let active = state.active.as_ref().filter(|a| a.run_id == run_id)?;
            Some((
                state.provider_thread.clone()?,
                active.provider_turn_id.clone()?,
            ))
        });
        if let (Some(live), Some((provider_thread, provider_turn_id))) = (&live, target) {
            let interrupted = live
                .session
                .interrupt_turn(InterruptInput {
                    provider_thread,
                    provider_turn_id,
                })
                .await;
            match interrupted {
                // The provider reports the end with a terminal event.
                Ok(()) => return,
                // The agent may still run: settling here would end a run that is not over.
                // The Stop shows as unresponsive and the user decides with Force stop
                // (`EffectWorker.ts`, `thread.interrupt.unresponsive`).
                Err(conn_provider::ProviderError::InterruptTimeout { .. }) => {
                    let (tid, rid) = (thread_id.clone(), run_id.clone());
                    if let Err(e) = self
                        .write(move |tx| crate::commands::mark_stop_unresponsive(tx, &tid, &rid))
                        .await
                    {
                        eprintln!("conn-engine: could not mark a Stop unresponsive: {e}");
                    }
                    return;
                }
                Err(_) => {}
            }
        }
        // No provider turn to stop: end the run here, and drop a session that may still run it.
        if let Some(live) = live
            && live.active().is_some_and(|a| a.run_id == run_id)
        {
            live.take_active();
            self.close_session(&thread_id).await;
        }
        self.end_run(&thread_id, &run_id, "interrupted", None).await;
    }

    /// Stop with no active run (`ProviderTurnControlService.interrupt` on a settled turn):
    /// the live session gets the run's provider thread and its latest provider turn, and ends
    /// the background work it holds. With no live session nothing runs anymore.
    pub(crate) async fn stop_background_work(self: Arc<Self>, thread_id: String, run_id: String) {
        let Some(live) = self.live_thread(&thread_id) else {
            return;
        };
        if live.active().is_some() {
            return;
        }
        let (tid, rid) = (thread_id.clone(), run_id);
        let target = self
            .db(move |store| -> Result<Option<(Value, Value)>, String> {
                let tx = store.tx()?;
                let Some(run) = tx.entity(&tid, "runs", &rid)? else {
                    tx.rollback();
                    return Ok(None);
                };
                let provider_thread_id = run["providerThreadId"].clone();
                let provider_thread = tx
                    .entities(&tid, "providerThreads")?
                    .into_iter()
                    .find(|pt| pt["id"] == provider_thread_id);
                let turn = tx
                    .entities(&tid, "providerTurns")?
                    .into_iter()
                    .filter(|t| t["providerThreadId"] == provider_thread_id)
                    .max_by_key(|t| t["ordinal"].as_u64().unwrap_or(0));
                tx.rollback();
                Ok(provider_thread.zip(turn))
            })
            .await
            .ok()
            .flatten();
        let Some((provider_thread, turn)) = target else {
            return;
        };
        let (Ok(provider_thread), Ok(provider_turn_id)) =
            (from_json(provider_thread), from_json(turn["id"].clone()))
        else {
            return;
        };
        if let Err(e) = live
            .session
            .stop_background_work(InterruptInput {
                provider_thread,
                provider_turn_id,
            })
            .await
        {
            eprintln!("conn-engine: the provider did not stop its background work: {e}");
        }
    }

    /// `ProviderTurnControlService.applyModelSelection`: only a running provider turn on the
    /// live session gets the selection. A provider that cannot apply it live keeps it for the
    /// next turn, which carries the thread's selection anyway.
    pub(crate) async fn apply_model_selection(&self, thread_id: &str, selection: Value) {
        let Some(live) = self.live_thread(thread_id) else {
            return;
        };
        let provider_thread = {
            let state = lock(&live.state);
            let running = state
                .active
                .as_ref()
                .is_some_and(|a| a.provider_turn_id.is_some());
            match (&state.provider_thread, running) {
                (Some(thread), true) => thread.clone(),
                _ => return,
            }
        };
        let selection: conn_contract::ModelSelection = match from_json(selection) {
            Ok(selection) => selection,
            Err(e) => {
                eprintln!("conn-engine: a model selection does not decode: {e}");
                return;
            }
        };
        match live
            .session
            .apply_model_selection(provider_thread, selection)
            .await
        {
            Ok(()) | Err(conn_provider::ProviderError::Unsupported { .. }) => {}
            Err(e) => eprintln!("conn-engine: the provider did not take the model change: {e}"),
        }
    }

    /// Turns the messages that waited for this run's provider turn into steers, in queue order.
    async fn deliver_deferred_steers(self: &Arc<Self>, thread_id: &str, run_id: &str) {
        let (tid, rid) = (thread_id.to_owned(), run_id.to_owned());
        let waiting = self
            .db(move |store| -> Result<Vec<String>, String> {
                let tx = store.tx()?;
                let runs = crate::commands::queued_runs(&tx, &tid);
                tx.rollback();
                Ok(runs?
                    .into_iter()
                    .filter(|r| r["steerWhenReadyRunId"] == rid.as_str())
                    .filter_map(|r| r["id"].as_str().map(str::to_owned))
                    .collect())
            })
            .await
            .unwrap_or_default();
        for queued in waiting {
            let command = json!({
                "type": "queued-message.promote-to-steer",
                "commandId": format!("steer-when-ready:{queued}"),
                "threadId": thread_id,
                "queuedRunId": queued,
                "targetRunId": run_id,
            });
            if let Err(
                crate::engine::DispatchError::Rejected(e)
                | crate::engine::DispatchError::Internal(e),
            ) = self.dispatch_value(command).await
            {
                eprintln!("conn-engine: a waiting steer stays queued: {e}");
            }
        }
    }

    /// Delivers a steer to the running provider turn. When the provider declines or the turn
    /// already ended, the message goes to the queue instead (`EffectWorker.ts` follow-up).
    pub(crate) async fn steer(
        self: Arc<Self>,
        thread_id: String,
        run_id: String,
        message_id: String,
    ) {
        let (tid, mid) = (thread_id.clone(), message_id.clone());
        let message = self
            .db(move |store| -> Result<Option<Value>, String> {
                let tx = store.tx()?;
                let message = tx.entity(&tid, "messages", &mid);
                tx.rollback();
                message
            })
            .await
            .ok()
            .flatten();
        let live = self.live_thread(&thread_id);
        let target = live.as_ref().and_then(|live| {
            let state = lock(&live.state);
            let active = state.active.as_ref().filter(|a| a.run_id == run_id)?;
            Some((
                state.provider_thread.clone()?,
                active.provider_turn_id.clone()?,
            ))
        });
        let delivered = match (live, target, &message) {
            (Some(live), Some((provider_thread, provider_turn_id)), Some(message)) => live
                .session
                .steer_turn(SteerInput {
                    thread_id: thread_id.as_str().into(),
                    run_id: run_id.as_str().into(),
                    provider_thread,
                    provider_turn_id,
                    message: TurnMessage {
                        created_by: from_json(message["createdBy"].clone())
                            .unwrap_or(conn_contract::OrchestrationV2Actor::User),
                        creation_source: from_json(message["creationSource"].clone())
                            .unwrap_or(conn_contract::OrchestrationV2CreationSource::Web),
                        scheduled_task_id: message["scheduledTaskId"].as_str().map(str::to_owned),
                        sender_thread_id: message["senderThreadId"].as_str().map(str::to_owned),
                        message_id: message_id.as_str().into(),
                        text: message["text"].as_str().unwrap_or_default().to_owned(),
                        attachments: from_json(message["attachments"].clone()).unwrap_or_default(),
                    },
                    model_selection: None,
                })
                .await
                .is_ok(),
            _ => false,
        };
        if delivered {
            return;
        }
        let Some(message) = message else { return };
        let mut command = json!({
            "type": "message.dispatch",
            "commandId": format!("command:steer-follow-up:{message_id}"),
            "threadId": thread_id,
            "messageId": message_id,
            "text": message["text"],
            "attachments": message["attachments"],
            "dispatchMode": {"type": "queue_after_active"},
            "steerFollowUpOfRunId": run_id,
            "createdBy": message["createdBy"],
            "creationSource": message["creationSource"],
        });
        if message["context"].is_object() {
            command["context"] = message["context"].clone();
        }
        if let Err(
            crate::engine::DispatchError::Rejected(e) | crate::engine::DispatchError::Internal(e),
        ) = self.dispatch_value(command).await
        {
            eprintln!("conn-engine: could not queue a declined steer: {e}");
        }
    }

    /// `forceStopThread`: ends the provider process without waiting for it, then ends the
    /// active run as interrupted. Used when Stop was ignored.
    pub(crate) async fn force_stop(
        self: &Arc<Self>,
        input: Value,
    ) -> Result<Value, crate::EngineError<Value>> {
        let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
        let wanted = input["runId"].as_str().map(str::to_owned);
        let tid = thread_id.clone();
        let (run, accepted) = self
            .db(move |store| -> Result<(Option<Value>, bool), String> {
                let tx = store.tx()?;
                let run = crate::commands::active_run(&tx, &tid)?;
                let accepted = run
                    .as_ref()
                    .and_then(|r| r["id"].as_str())
                    .is_some_and(|id| tx.start_accepted(id));
                tx.rollback();
                Ok((run, accepted))
            })
            .await
            .map_err(crate::EngineError::Internal)?;
        let error = |reason: Option<&str>| {
            let mut e =
                json!({"_tag": "OrchestrationV2ForceStopThreadError", "threadId": thread_id});
            if let Some(reason) = reason {
                e["reason"] = json!(reason);
            }
            crate::EngineError::Rejected(e)
        };
        let run_id = run
            .as_ref()
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned);
        if let (Some(wanted), Some(active)) = (&wanted, &run_id)
            && wanted != active
        {
            return Err(error(Some("superseded")));
        }
        // Before the provider accepted the turn, T3 dispatches `run.interrupt` with the Force
        // stop reason, which ends the run "before provider start" and abandons the start; then
        // the session is released.
        if let Some(run_id) = &run_id
            && !accepted
            && run.as_ref().is_some_and(|r| {
                matches!(
                    r["status"].as_str(),
                    Some("preparing" | "starting" | "running")
                )
            })
        {
            let command = json!({
                "type": "run.interrupt",
                "commandId": format!("server:force-stop:{run_id}:{}", self.clock.now_millis()),
                "threadId": thread_id,
                "runId": run_id,
                "reason": crate::commands::FORCE_STOP_REASON,
            });
            if let Err(
                crate::engine::DispatchError::Rejected(e)
                | crate::engine::DispatchError::Internal(e),
            ) = self.dispatch_value(command).await
            {
                eprintln!("conn-engine: Force stop could not end the run: {e}");
            }
            self.close_session(&thread_id).await;
            return Ok(json!({"outcome": "killed", "sharedWithThreadIds": []}));
        }
        if let Some(live) = self.live_thread(&thread_id) {
            live.take_active();
        }
        self.close_session(&thread_id).await;
        if let Some(run_id) = run_id {
            // The Stop result says Force stop ended it.
            let (tid, run) = (thread_id.clone(), run.clone().unwrap_or_default());
            if let Err(e) = self
                .write(move |tx| {
                    crate::commands::write_interrupt_result(
                        tx,
                        &tid,
                        &run,
                        Some(crate::commands::FORCE_STOP_REASON),
                    )
                })
                .await
            {
                eprintln!("conn-engine: could not record the Force stop: {e}");
            }
            self.end_run(&thread_id, &run_id, "interrupted", None).await;
        }
        Ok(json!({"outcome": "killed", "sharedWithThreadIds": []}))
    }

    pub(crate) async fn respond(self: Arc<Self>, thread_id: String, request: Value) {
        let response = (|| -> Result<RuntimeRequestResponse, String> {
            Ok(RuntimeRequestResponse {
                request_id: from_json(request["requestId"].clone()).map_err(|e| e.to_string())?,
                decision: match &request["decision"] {
                    Value::Null => None,
                    decision => Some(from_json(decision.clone()).map_err(|e| e.to_string())?),
                },
                feedback: request["feedback"].as_str().map(str::to_owned),
                answers: match &request["answers"] {
                    Value::Null => None,
                    answers => Some(from_json(answers.clone()).map_err(|e| e.to_string())?),
                },
            })
        })();
        let delivered = match (self.live_thread(&thread_id), response) {
            (Some(live), Ok(response)) => live
                .session
                .respond_to_runtime_request(response)
                .await
                .is_ok(),
            _ => false,
        };
        if !delivered {
            let request_id = request["requestId"].as_str().unwrap_or_default().to_owned();
            let _ = self
                .write(move |tx| {
                    if let Some(mut row) = tx.entity(&thread_id, "runtimeRequests", &request_id)? {
                        row["status"] = json!("expired");
                        tx.append(Draft::new(&thread_id, "runtime-request.updated", row))?;
                    }
                    Ok(())
                })
                .await;
        }
    }

    /// Tells the observer a run ended, when it started (an attempt exists) and is now final.
    pub(crate) async fn observe_end(
        &self,
        observer: Arc<dyn crate::TurnObserver>,
        thread_id: String,
        run_id: String,
    ) {
        let (tid, rid) = (thread_id.clone(), run_id.clone());
        let read = self
            .db(
                move |store| -> Result<Option<(Value, Option<String>)>, String> {
                    let tx = store.tx()?;
                    let found = (|| {
                        let Some(run) = tx.entity(&tid, "runs", &rid)? else {
                            return Ok(None);
                        };
                        let thread = tx.thread(&tid)?;
                        let project = match &thread {
                            Some(t) => tx.project(t["projectId"].as_str().unwrap_or_default())?,
                            None => None,
                        };
                        let cwd = thread
                            .as_ref()
                            .and_then(|t| t["worktreePath"].as_str())
                            .or_else(|| project.as_ref().and_then(|p| p["workspaceRoot"].as_str()))
                            .map(str::to_owned);
                        Ok(Some((run, cwd)))
                    })();
                    tx.rollback();
                    found
                },
            )
            .await;
        let Ok(Some((run, cwd))) = read else { return };
        if run["activeAttemptId"].is_null() || crate::commands::is_live(&run) {
            return;
        }
        let point = crate::TurnPoint {
            thread_id,
            run_id,
            run_ordinal: run["ordinal"].as_u64().unwrap_or(1),
            root_node_id: run["rootNodeId"].as_str().unwrap_or_default().to_owned(),
            cwd,
        };
        let status = run["status"].as_str().unwrap_or("failed").to_owned();
        tokio::spawn(async move { observer.turn_ended(point, status).await });
    }

    /// Closes provider sessions idle for `idle`, so an idle thread does not keep a provider
    /// process. The next turn opens a session and resumes the stored provider thread.
    pub(crate) async fn reap_idle(&self, idle: Duration) {
        let idle_threads: Vec<String> = lock(&self.live)
            .iter()
            .filter(|(_, live)| live.idle_for(self.clock.now_millis(), idle, self.idle_max_hold))
            .map(|(id, _)| id.clone())
            .collect();
        for thread_id in idle_threads {
            self.close_session(&thread_id).await;
        }
    }

    fn revoke_tools(&self, key: Option<&str>) {
        if let (Some(host), Some(key)) = (&self.host, key) {
            host.session_closed(key);
        }
    }

    /// Closes every provider session, side by side, ending its process and what the process
    /// started. The server calls this before it exits. No session opens after it began.
    pub(crate) async fn close_all_sessions(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let closing: Vec<(String, Arc<LiveThread>)> = lock(&self.live).drain().collect();
        let mut closes = Vec::with_capacity(closing.len());
        for (thread_id, live) in closing {
            self.command_output.finish_thread(&thread_id);
            self.revoke_tools(live.tools_key.as_deref());
            closes.push(tokio::spawn(async move {
                live.session.close().await;
                live.closed.notify_one();
            }));
        }
        for close in closes {
            let _ = close.await;
        }
    }

    fn shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub(crate) async fn close_session(&self, thread_id: &str) {
        self.close_session_inner(thread_id, true).await;
    }

    pub(crate) async fn close_workspace_session(&self, thread_id: &str) {
        self.close_session_inner(thread_id, false).await;
    }

    async fn close_session_inner(&self, thread_id: &str, revoke_tools: bool) {
        let live = lock(&self.live).remove(thread_id);
        if let Some(live) = live {
            self.command_output.finish_thread(thread_id);
            if revoke_tools {
                self.revoke_tools(live.tools_key.as_deref());
            }
            live.session.close().await;
            // `notify_one` keeps a permit, so a pump not yet waiting still sees it.
            live.closed.notify_one();
            if !self.shutting_down() {
                self.record_release(thread_id, &live.provider_session_id)
                    .await;
            }
            if live.background_tasks_end_with_process && !self.shutting_down() {
                self.clear_released_rosters(thread_id, &live.provider_session_id)
                    .await;
            }
        }
    }

    /// `writeReleasedSessionEvents` and `writeReleasedRuntimeRequestEvents` in T3's
    /// `ProviderSessionManager.ts`: the session's row says `stopped`, and the requests it
    /// alone could answer (`responseCapability.type: live`) are `expired`.
    async fn record_release(&self, thread_id: &str, provider_session_id: &str) {
        let (tid, sid) = (thread_id.to_owned(), provider_session_id.to_owned());
        let written = self
            .write(move |tx| {
                let now = tx.now().to_owned();
                if let Some(mut session) = tx.entity(&tid, "providerSessions", &sid)?
                    && !matches!(session["status"].as_str(), Some("stopped" | "error"))
                {
                    session["status"] = json!("stopped");
                    if session.get("extensionStatuses").is_some() {
                        session["extensionStatuses"] = json!([]);
                    }
                    session["updatedAt"] = json!(now);
                    session["lastError"] = Value::Null;
                    tx.append(Draft::new(&tid, "provider-session.updated", session))?;
                }
                for mut request in tx.entities(&tid, "runtimeRequests")? {
                    let live = request["responseCapability"]["type"] == "live"
                        && request["responseCapability"]["providerSessionId"] == sid.as_str();
                    if request["status"] == "pending" && live {
                        request["status"] = json!("expired");
                        tx.append(Draft::new(&tid, "runtime-request.updated", request))?;
                    }
                }
                Ok(())
            })
            .await;
        if let Err(e) = written {
            eprintln!("conn-engine: could not record a released session: {e}");
        }
    }

    /// `readReleasedProviderThreads`: the session's background tasks ended with its process,
    /// so its provider threads' rosters (`pendingBackgroundTasks`) are cleared.
    async fn clear_released_rosters(&self, thread_id: &str, provider_session_id: &str) {
        let (tid, sid) = (thread_id.to_owned(), provider_session_id.to_owned());
        let cleared = self
            .write(move |tx| {
                for mut thread in tx.entities(&tid, "providerThreads")? {
                    let held = thread["pendingBackgroundTasks"]
                        .as_array()
                        .is_some_and(|tasks| !tasks.is_empty());
                    if thread["providerSessionId"] == sid.as_str() && held {
                        thread["pendingBackgroundTasks"] = json!([]);
                        tx.append(Draft::new(&tid, "provider-thread.updated", thread))?;
                    }
                }
                Ok(())
            })
            .await;
        if let Err(e) = cleared {
            eprintln!("conn-engine: could not clear released background tasks: {e}");
        }
    }
}

enum Translated {
    Ignore,
    Event(Draft),
    ProviderTurn(ProviderTurnId, Draft),
    /// The status, the failure, and whether the native thread is broken.
    Terminal(&'static str, Option<Value>, bool),
    /// A provider-made thread (a subagent's child): created once, never overwritten.
    CreateThread(Value),
    /// A steer was taken or dropped: the user message's turn item follows.
    Steer {
        message_id: String,
        status: &'static str,
    },
    /// The provider has output with no turn running and asks for one.
    Continuation(Option<String>, Option<Value>, Option<String>),
    /// `subagent.updated`, then the child thread follows the subagent's model.
    Subagent(Draft, Value),
}

/// `providerThreadLoadKey`: the native thread, the provider's load part of the selection,
/// and the runtime policy.
fn thread_load_key(
    session: &dyn Session,
    thread: &ProviderThread,
    selection: &conn_contract::ModelSelection,
    policy: &RuntimePolicy,
) -> String {
    let native = thread.native_thread_ref.as_ref().map_or_else(
        || to_json(&thread.id),
        |native| {
            let native = to_json(native);
            json!(format!(
                "{}:{}",
                native["driver"].as_str().unwrap_or_default(),
                native["nativeId"].as_str().unwrap_or_default()
            ))
        },
    );
    json!({
        "providerThread": native,
        "modelSelection": to_json(&session.thread_load_model_selection(selection)),
        "runtimePolicy": to_json(policy),
    })
    .to_string()
}

/// Maps one provider event to a domain event. Adding an event kind is one arm here.
fn translate(thread_id: &str, active: Option<&ActiveRun>, event: ProviderEvent) -> Translated {
    let run_id = active.map(|a| a.run_id.as_str());
    let root = active.map(|a| a.root_node_id.as_str());
    // Provider rows name their thread and run; fill them in when a provider leaves them out.
    // A row of another thread (a subagent's child thread) goes to that thread, without the
    // parent's run.
    let scoped = |event_type: &'static str, mut payload: Value| {
        let node = payload["nodeId"].as_str().map(str::to_owned);
        if let Some(child) = payload["threadId"].as_str().filter(|t| *t != thread_id) {
            let child = child.to_owned();
            let run = payload["runId"].as_str().map(str::to_owned);
            return Draft::new(&child, event_type, payload)
                .run(run.as_deref())
                .node(node.as_deref());
        }
        if payload.is_object() {
            if payload["threadId"].is_null() {
                payload["threadId"] = json!(thread_id);
            }
            if payload.get("runId").is_none_or(Value::is_null) && run_id.is_some() {
                payload["runId"] = json!(run_id);
            }
        }
        Draft::new(thread_id, event_type, payload)
            .run(run_id)
            .node(node.as_deref().or(root))
    };
    match event {
        ProviderEvent::ProviderSessionUpdated { provider_session } => {
            Translated::Event(Draft::new(
                thread_id,
                "provider-session.updated",
                to_json(&provider_session),
            ))
        }
        // T3's `ProviderEventIngestor`: a provider thread goes to its app thread (a subagent's
        // child thread has its own).
        ProviderEvent::ProviderThreadUpdated { provider_thread } => {
            let payload = to_json(&provider_thread);
            let target = payload["appThreadId"]
                .as_str()
                .unwrap_or(thread_id)
                .to_owned();
            Translated::Event(Draft::new(&target, "provider-thread.updated", payload))
        }
        // A provider turn of another thread (a subagent's turn on its child thread) goes to
        // that thread, under its own node, outside the run.
        ProviderEvent::ProviderTurnUpdated {
            thread_id: Some(other),
            provider_turn,
        } if other.as_str() != thread_id => {
            let payload = to_json(&provider_turn);
            let node = payload["nodeId"].as_str().map(str::to_owned);
            Translated::Event(
                Draft::new(other.as_str(), "provider-turn.updated", payload).node(node.as_deref()),
            )
        }
        ProviderEvent::ProviderTurnUpdated { provider_turn, .. } => {
            let payload = to_json(&provider_turn);
            let id = from_json(payload["id"].clone());
            let draft = Draft::new(thread_id, "provider-turn.updated", payload)
                .run(run_id)
                .node(root);
            match id {
                Ok(id) => Translated::ProviderTurn(id, draft),
                Err(_) => Translated::Event(draft),
            }
        }
        ProviderEvent::NodeUpdated { node } => {
            Translated::Event(scoped("node.updated", to_json(&node)))
        }
        ProviderEvent::SubagentUpdated { subagent } => {
            let payload = to_json(&subagent);
            Translated::Subagent(scoped("subagent.updated", payload.clone()), payload)
        }
        ProviderEvent::MessageUpdated { message } => {
            Translated::Event(scoped("message.updated", to_json(&message)))
        }
        ProviderEvent::TurnItemUpdated { turn_item }
        | ProviderEvent::McpAppCapture { turn_item, .. } => {
            Translated::Event(scoped("turn-item.updated", to_json(&turn_item)))
        }
        ProviderEvent::RuntimeRequestUpdated {
            thread_id: Some(other),
            runtime_request,
        } if other.as_str() != thread_id => {
            let payload = to_json(&runtime_request);
            let node = payload["nodeId"].as_str().map(str::to_owned);
            Translated::Event(
                Draft::new(other.as_str(), "runtime-request.updated", payload)
                    .node(node.as_deref()),
            )
        }
        ProviderEvent::RuntimeRequestUpdated {
            runtime_request, ..
        } => Translated::Event(
            Draft::new(
                thread_id,
                "runtime-request.updated",
                to_json(&runtime_request),
            )
            .run(run_id)
            .node(root),
        ),
        ProviderEvent::PlanUpdated { plan } => {
            Translated::Event(scoped("plan.updated", to_json(&plan)))
        }
        // The pump sends live command output to the hub before it translates.
        ProviderEvent::CommandOutputDelta { .. } => Translated::Ignore,
        // An earlier run's terminal that comes late (an abandoned start's) ends that turn only:
        // T3 routes a terminal to the run whose turn it ends, never to the next one.
        ProviderEvent::TurnTerminal(terminal)
            if active.is_some_and(|a| a.ordinal != u64::from(terminal.run_ordinal)) =>
        {
            Translated::Ignore
        }
        ProviderEvent::TurnTerminal(terminal) => {
            let status = status_name(terminal.status);
            let failure = match (&terminal.status, terminal.failure) {
                (TurnStatus::Failed, Some(f)) => Some(to_json(&f)),
                (TurnStatus::Failed, None) => {
                    Some(failure("provider_error", "The provider turn failed.", None))
                }
                _ => None,
            };
            Translated::Terminal(
                status,
                failure,
                terminal.thread_disposition == ThreadDisposition::Broken,
            )
        }
        ProviderEvent::AppThreadCreated { app_thread, .. } => {
            Translated::CreateThread(to_json(&app_thread))
        }
        ProviderEvent::SteerUpdated {
            message_id, status, ..
        } => Translated::Steer {
            message_id: message_id.as_str().to_owned(),
            status: match status {
                SteerStatus::Pending => "pending",
                SteerStatus::Completed => "completed",
                SteerStatus::Cancelled => "cancelled",
            },
        },
        ProviderEvent::ContinuationRequested(request) => {
            Translated::Continuation(request.detail, request.notification, request.delivery)
        }
        // Handled before translation.
        ProviderEvent::BackgroundWorkUpdated { .. } => Translated::Ignore,
    }
}
