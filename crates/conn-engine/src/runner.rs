//! Drives providers: opens a session per thread, starts turns, and turns `ProviderEvent`s into
//! domain events.
//!
//! Streaming rows (`streaming: true` messages and turn items) are held for at most
//! `stream_flush` and only their newest version is written, as TS coalesces them on the wire.
//! When the turn ends, every row gets a final version and the streaming versions leave the log.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{ProviderThread, ProviderTurnId, from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, ProviderEvent, ResumeThreadInput,
    RuntimePolicy, RuntimeRequestResponse, Session, SteerInput, TurnInput, TurnMessage, TurnStatus,
};
use serde_json::{Value, json};
use tokio::{
    sync::mpsc,
    time::{Instant, sleep_until},
};

use crate::commands::{failure, finish_run, hold_queue, start_next_queued};
use crate::engine::Inner;
use crate::store::Draft;

/// A thread whose provider session is open.
pub(crate) struct LiveThread {
    session: Arc<dyn Session>,
    state: Mutex<LiveState>,
    /// When the session last did anything; the idle reaper closes it after `idle_session`.
    last_used: Mutex<Instant>,
    /// Ends the event pump. The pump holds this thread, whose session may hold the event
    /// sender, so a closed channel alone would never end it.
    closed: tokio::sync::Notify,
}

#[derive(Default)]
struct LiveState {
    provider_thread: Option<ProviderThread>,
    active: Option<ActiveRun>,
}

#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    root_node_id: String,
    provider_turn_id: Option<ProviderTurnId>,
}

impl LiveThread {
    fn touch(&self) {
        *lock(&self.last_used) = Instant::now();
    }

    /// Idle: no run and no provider event for `idle`.
    pub(crate) fn idle_for(&self, idle: Duration) -> bool {
        lock(&self.state).active.is_none() && lock(&self.last_used).elapsed() >= idle
    }

    fn active(&self) -> Option<ActiveRun> {
        lock(&self.state).active.clone()
    }
    fn take_active(&self) -> Option<ActiveRun> {
        lock(&self.state).active.take()
    }
}

/// A poisoned lock still holds consistent data here: every critical section only swaps values.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a turn start needs from the store.
struct TurnContext {
    thread: Value,
    run: Value,
    message: Value,
    cwd: Option<String>,
    provider_thread: Option<Value>,
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
        match self.try_start_turn(&thread_id, &run_id).await {
            Ok(()) | Err(StartError::Abandoned) => {}
            Err(StartError::Failed(message)) => {
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
    }

    fn live_thread(&self, thread_id: &str) -> Option<Arc<LiveThread>> {
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
        let next = self
            .write(move |tx| {
                finish_run(tx, &thread_id, &run_id, status, failure)?;
                // A failure holds the queue, so queued messages do not hit the same wall.
                if held_on_failure {
                    hold_queue(tx, &thread_id)?;
                }
                let mut effects = crate::families::on_run_end(tx, &thread_id, &run_id)?;
                effects.extend(start_next_queued(tx, &thread_id, None)?);
                Ok(effects)
            })
            .await;
        match next {
            Ok(effects) => effects.into_iter().for_each(|e| self.spawn_effect(e)),
            Err(e) => eprintln!("conn-engine: could not end run: {e}"),
        }
        if let Some(observer) = &self.observer {
            self.observe_end(observer.clone(), thread, run).await;
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
                    let provider_thread = match thread["activeProviderThreadId"].as_str() {
                        Some(id) => tx.entity(&tid, "providerThreads", id)?,
                        None => None,
                    };
                    Ok(Some(TurnContext {
                        thread,
                        run,
                        message,
                        cwd,
                        provider_thread,
                    }))
                })();
                tx.rollback();
                context
            })
            .await?;
        let Some(context) = context else {
            return Err(StartError::Abandoned);
        };
        if context.run["status"] != "starting" {
            return Err(StartError::Abandoned);
        }

        let model_selection: conn_contract::ModelSelection =
            from_json(context.run["modelSelection"].clone()).map_err(|e| e.to_string())?;
        let runtime_policy: RuntimePolicy = from_json(json!({
            "runtimeMode": context.thread["runtimeMode"],
            "interactionMode": context.thread["interactionMode"],
            "cwd": context.cwd,
        }))
        .map_err(|e| e.to_string())?;

        let live = match self.live_thread(thread_id) {
            Some(live) => live,
            None => {
                let instance = context.run["providerInstanceId"]
                    .as_str()
                    .unwrap_or_default();
                let provider = self
                    .providers
                    .iter()
                    .find(|p| p.instance_id().as_str() == instance)
                    .or_else(|| (self.providers.len() == 1).then(|| &self.providers[0]))
                    .cloned()
                    .ok_or_else(|| {
                        format!("No provider instance `{instance}` is configured on this server.")
                    })?;
                let opened = provider
                    .open_session(OpenSessionInput {
                        thread_id: thread_id.into(),
                        provider_session_id: format!("provider-session:{thread_id}:{run_id}")
                            .as_str()
                            .into(),
                        model_selection: model_selection.clone(),
                        runtime_policy: runtime_policy.clone(),
                        resume_from_session: None,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let live = Arc::new(LiveThread {
                    session: Arc::from(opened.session),
                    state: Mutex::new(LiveState::default()),
                    last_used: Mutex::new(Instant::now()),
                    closed: tokio::sync::Notify::new(),
                });
                lock(&self.live).insert(thread_id.to_owned(), live.clone());
                tokio::spawn(
                    self.clone()
                        .pump(thread_id.to_owned(), live.clone(), opened.events),
                );
                live
            }
        };

        live.touch();
        let known = lock(&live.state).provider_thread.clone();
        let provider_thread = match (known, context.provider_thread) {
            (Some(provider_thread), _) => provider_thread,
            (None, Some(stored)) => live
                .session
                .resume_thread(ResumeThreadInput {
                    provider_thread: from_json(stored).map_err(|e| e.to_string())?,
                    thread_id: Some(thread_id.into()),
                    model_selection: Some(model_selection.clone()),
                    runtime_policy: Some(runtime_policy.clone()),
                })
                .await
                .map_err(|e| e.to_string())?,
            (None, None) => live
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
        let root = context.run["rootNodeId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        {
            let mut state = lock(&live.state);
            state.provider_thread = Some(provider_thread.clone());
            state.active = Some(ActiveRun {
                run_id: run_id.to_owned(),
                root_node_id: root.clone(),
                provider_turn_id: None,
            });
        }

        let attempt_id = format!("{run_id}:attempt:1");
        let mut provider_thread_json = to_json(&provider_thread);
        if provider_thread_json
            .get("appThreadId")
            .is_none_or(Value::is_null)
        {
            provider_thread_json["appThreadId"] = json!(thread_id);
        }
        let (tid, rid, aid, root_id) = (
            thread_id.to_owned(),
            run_id.to_owned(),
            attempt_id.clone(),
            root.clone(),
        );
        let still_live = self
            .write(move |tx| {
                let Some(mut run) = tx.entity(&tid, "runs", &rid)? else {
                    return Ok(false);
                };
                if run["status"] != "starting" {
                    return Ok(false);
                }
                let now = tx.now().to_owned();
                let pt_id = provider_thread_json["id"].clone();
                let draft = |event_type, payload| {
                    Draft::new(&tid, event_type, payload)
                        .run(Some(&rid))
                        .node(Some(&root_id))
                };
                if provider_thread_json["id"].is_string() {
                    tx.append(Draft::new(
                        &tid,
                        "provider-thread.updated",
                        provider_thread_json.clone(),
                    ))?;
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
                tx.append(draft("run.updated", run))?;
                if let Some(mut node) = tx.entity(&tid, "nodes", &root_id)? {
                    node["status"] = json!("running");
                    node["startedAt"] = json!(now);
                    node["providerThreadId"] = pt_id;
                    tx.append(draft("node.updated", node))?;
                }
                Ok(true)
            })
            .await?;
        if !still_live {
            live.take_active();
            return Err(StartError::Abandoned);
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

        live.session
            .start_turn(TurnInput {
                app_thread: from_json(context.thread.clone()).map_err(|e| e.to_string())?,
                thread_id: thread_id.into(),
                run_id: run_id.into(),
                run_ordinal: context.run["ordinal"].as_u64().unwrap_or(1) as u32,
                provider_turn_ordinal: context.run["ordinal"].as_u64().unwrap_or(1) as u32,
                attempt_id: attempt_id.as_str().into(),
                root_node_id: root.as_str().into(),
                provider_thread,
                message: TurnMessage {
                    message_id: context.run["userMessageId"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    text: context.message["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    attachments: from_json(context.message["attachments"].clone())
                        .unwrap_or_default(),
                },
                model_selection,
                runtime_policy,
            })
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
        let mut held: Vec<(String, Draft)> = Vec::new();
        let mut deadline: Option<Instant> = None;
        loop {
            let event = match deadline {
                Some(at) => tokio::select! {
                    event = events.recv() => event,
                    () = live.closed.notified() => None,
                    () = sleep_until(at) => {
                        deadline = None;
                        self.commit(std::mem::take(&mut held).into_iter().map(|(_, d)| d).collect()).await;
                        continue;
                    }
                },
                None => tokio::select! {
                    event = events.recv() => event,
                    () = live.closed.notified() => None,
                },
            };
            let Some(event) = event else { break };
            live.touch();
            let active = live.active();
            let run_id = active.as_ref().map(|a| a.run_id.clone());
            match translate(&thread_id, active.as_ref(), event) {
                Translated::Ignore => {}
                Translated::ProviderTurn(id, draft) => {
                    if let Some(active) = lock(&live.state).active.as_mut() {
                        active.provider_turn_id = Some(id);
                    }
                    let running = draft.payload["status"] == "running";
                    self.commit_after(&mut held, &mut deadline, vec![draft])
                        .await;
                    if running && let Some(run_id) = &run_id {
                        self.deliver_deferred_steers(&thread_id, run_id).await;
                    }
                }
                Translated::Event(draft) if draft.payload["streaming"] == true => {
                    let key = format!("{}:{}", draft.event_type, draft.payload["id"]);
                    match held.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = draft,
                        None => held.push((key, draft)),
                    }
                    deadline.get_or_insert_with(|| Instant::now() + self.stream_flush);
                }
                Translated::Event(draft) => {
                    self.commit_after(&mut held, &mut deadline, vec![draft])
                        .await;
                }
                Translated::Terminal(status, failure) => {
                    self.commit_after(&mut held, &mut deadline, vec![]).await;
                    if let Some(run_id) = run_id {
                        live.take_active();
                        self.end_run(&thread_id, &run_id, status, failure).await;
                    }
                }
            }
        }
        self.commit(held.into_iter().map(|(_, d)| d).collect())
            .await;
        if let Some(active) = live.take_active() {
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

    /// Writes held streaming rows first, so the log keeps the provider's order.
    async fn commit_after(
        &self,
        held: &mut Vec<(String, Draft)>,
        deadline: &mut Option<Instant>,
        drafts: Vec<Draft>,
    ) {
        *deadline = None;
        let mut all: Vec<Draft> = std::mem::take(held).into_iter().map(|(_, d)| d).collect();
        all.extend(drafts);
        self.commit(all).await;
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
            // The provider reports the end with a terminal event.
            if interrupted.is_ok() {
                return;
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
        let run = self
            .db(move |store| -> Result<Option<Value>, String> {
                let tx = store.tx()?;
                let run = crate::commands::active_run(&tx, &tid);
                tx.rollback();
                run
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
        if let Some(live) = self.live_thread(&thread_id) {
            live.take_active();
        }
        self.close_session(&thread_id).await;
        if let Some(run_id) = run_id {
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
    async fn observe_end(
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
            .filter(|(_, live)| live.idle_for(idle))
            .map(|(id, _)| id.clone())
            .collect();
        for thread_id in idle_threads {
            self.close_session(&thread_id).await;
        }
    }

    pub(crate) async fn close_session(&self, thread_id: &str) {
        let live = lock(&self.live).remove(thread_id);
        if let Some(live) = live {
            live.session.close().await;
            // `notify_one` keeps a permit, so a pump not yet waiting still sees it.
            live.closed.notify_one();
        }
    }
}

enum Translated {
    Ignore,
    Event(Draft),
    ProviderTurn(ProviderTurnId, Draft),
    Terminal(&'static str, Option<Value>),
}

/// Maps one provider event to a domain event. Adding an event kind is one arm here.
fn translate(thread_id: &str, active: Option<&ActiveRun>, event: ProviderEvent) -> Translated {
    let run_id = active.map(|a| a.run_id.as_str());
    let root = active.map(|a| a.root_node_id.as_str());
    // Provider rows name their thread and run; fill them in when a provider leaves them out.
    let scoped = |event_type: &'static str, mut payload: Value| {
        if payload.is_object() {
            if payload["threadId"].is_null() {
                payload["threadId"] = json!(thread_id);
            }
            if payload.get("runId").is_none_or(Value::is_null) && run_id.is_some() {
                payload["runId"] = json!(run_id);
            }
        }
        let node = payload["nodeId"].as_str().map(str::to_owned);
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
        ProviderEvent::ProviderThreadUpdated { provider_thread } => Translated::Event(Draft::new(
            thread_id,
            "provider-thread.updated",
            to_json(&provider_thread),
        )),
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
            Translated::Event(scoped("subagent.updated", to_json(&subagent)))
        }
        ProviderEvent::MessageUpdated { message } => {
            Translated::Event(scoped("message.updated", to_json(&message)))
        }
        ProviderEvent::TurnItemUpdated { turn_item } => {
            Translated::Event(scoped("turn-item.updated", to_json(&turn_item)))
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
        // Live command output goes to `subscribeCommandOutput`, which this engine lacks.
        ProviderEvent::CommandOutputDelta { .. } => Translated::Ignore,
        ProviderEvent::TurnTerminal(terminal) => {
            let status = status_name(terminal.status);
            let failure = match (&terminal.status, terminal.failure) {
                (TurnStatus::Failed, Some(f)) => Some(to_json(&f)),
                (TurnStatus::Failed, None) => {
                    Some(failure("provider_error", "The provider turn failed.", None))
                }
                _ => None,
            };
            Translated::Terminal(status, failure)
        }
    }
}
