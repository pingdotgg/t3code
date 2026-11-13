//! [`CodexSession`]: one engine session on the shared app-server. It owns one native thread,
//! a [`Mapper`], and a driver task that feeds the mapper the frames routed to it, flushes
//! streamed text on a timer, and delivers events and replies in order. State sits behind one
//! `std` mutex that is never held across an `.await`.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{ProviderInstanceId, ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, InterruptInput, ProviderError, ProviderEvent, ProviderResult,
    ResumeThreadInput, RuntimeRequestResponse, Session, SteerInput, TurnInput,
};
use conn_provider_support::ids::{self, Env, SystemEnv, iso_from_ms};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::client::{AppServer, CallError, SessionMsg};
use crate::launch;
use crate::mapper::{DRIVER, Mapper, Out};

pub const EVENT_CAPACITY: usize = 256;
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const PLAN_FLUSH_INTERVAL: Duration = Duration::from_millis(400);
/// How long an interrupted turn may take to report `turn/completed` (TS: 10 s).
const INTERRUPT_WAIT: Duration = Duration::from_secs(10);

pub struct CodexSession {
    id: ProviderSessionId,
    inner: Arc<Inner>,
}

struct Inner {
    id: String,
    instance_id: String,
    server: Arc<AppServer>,
    inbox: mpsc::Sender<SessionMsg>,
    state: Mutex<State>,
    /// Signalled after every batch the driver delivers, so waiters can re-check the mapper.
    progressed: Notify,
}

struct State {
    mapper: Mapper<SystemEnv>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    /// The native thread and the app-server generation it is loaded on.
    thread: Option<(String, Option<u64>)>,
    app_thread_id: Option<String>,
    closed: bool,
    logged: HashSet<String>,
}

impl CodexSession {
    pub(crate) fn open(
        id: ProviderSessionId,
        instance_id: &ProviderInstanceId,
        server: Arc<AppServer>,
        events: mpsc::Sender<ProviderEvent>,
    ) -> Self {
        let (inbox, rx) = mpsc::channel(EVENT_CAPACITY);
        server.add_session(id.as_str(), inbox.clone());
        let inner = Arc::new(Inner {
            id: id.as_str().to_owned(),
            instance_id: instance_id.as_str().to_owned(),
            server,
            inbox,
            state: Mutex::new(State {
                mapper: Mapper::new(SystemEnv),
                events: Some(events),
                thread: None,
                app_thread_id: None,
                closed: false,
                logged: HashSet::new(),
            }),
            progressed: Notify::new(),
        });
        tokio::spawn(drive(Arc::downgrade(&inner), rx));
        Self { id, inner }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends events and replies in order. Holds no lock across a send.
    async fn deliver(&self, outs: Vec<Out>) {
        if outs.is_empty() {
            return;
        }
        let (events, generation) = {
            let state = self.lock();
            (
                state.events.clone(),
                state.thread.as_ref().and_then(|(_, g)| *g),
            )
        };
        for out in outs {
            match out {
                Out::Event(event) => {
                    if let Some(events) = &events {
                        let _ = events.send(event).await;
                    }
                }
                Out::Write(line) => {
                    if let Some(generation) = generation.or_else(|| self.server.generation()) {
                        let _ = self.server.write(generation, line).await;
                    }
                }
                Out::Skipped(kind) => {
                    let key: String = kind.chars().take(80).collect();
                    if self.lock().logged.insert(key) {
                        eprintln!("conn-provider-codex: skipped {kind}");
                    }
                }
            }
        }
        self.progressed.notify_waiters();
    }

    /// The native thread loaded on the running app-server, resuming it after a restart.
    async fn loaded_thread(
        &self,
        policy: Option<&conn_provider::RuntimePolicy>,
        model: Option<&str>,
    ) -> ProviderResult<String> {
        let (native, loaded_on) = self
            .lock()
            .thread
            .clone()
            .ok_or_else(|| failed("start_turn", "the session has no Codex thread"))?;
        let generation = self
            .server
            .ensure_started()
            .await
            .map_err(call_failed("start_turn"))?;
        if loaded_on == Some(generation) {
            return Ok(native);
        }
        let app_thread = self.lock().app_thread_id.clone();
        let cwd = policy.and_then(|p| p.cwd.clone());
        self.resume(&native, app_thread.as_deref(), cwd.as_deref(), model)
            .await?;
        Ok(native)
    }

    /// `thread/resume`, unarchiving the thread once when Codex reports it archived.
    async fn resume(
        &self,
        native: &str,
        app_thread: Option<&str>,
        cwd: Option<&str>,
        model: Option<&str>,
    ) -> ProviderResult<Value> {
        self.server.route(native, self.inbox.clone());
        let mut params = launch::thread_params(app_thread, cwd, model);
        params["threadId"] = json!(native);
        params["excludeTurns"] = json!(true);
        let result = match self.server.request("thread/resume", params.clone()).await {
            Err(CallError::Rpc(e))
                if e.message.contains("is archived") || e.message.contains("codex unarchive") =>
            {
                self.server
                    .request("thread/unarchive", json!({ "threadId": native }))
                    .await
                    .map_err(call_failed("resume_thread"))?;
                self.server.request("thread/resume", params).await
            }
            other => other,
        };
        let result = result.map_err(|e| match &e {
            CallError::Rpc(rpc) if rpc.message.contains("already has an active writer") => failed(
                "resume_thread",
                "This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.",
            ),
            _ => call_failed("resume_thread")(e),
        })?;
        let generation = self.server.generation();
        if let Some(thread) = &mut self.lock().thread {
            thread.1 = generation;
        }
        Ok(result)
    }
}

/// The driver: reads routed frames until the session closes; flushes streamed text.
async fn drive(inner: std::sync::Weak<Inner>, mut rx: mpsc::Receiver<SessionMsg>) {
    let mut last_plan_flush = tokio::time::Instant::now();
    loop {
        let Some(strong) = inner.upgrade() else {
            return;
        };
        let dirty = strong.lock().mapper.has_dirty(true);
        drop(strong);
        let msg = if dirty {
            tokio::select! {
                msg = rx.recv() => msg,
                _ = tokio::time::sleep(FLUSH_INTERVAL) => {
                    let Some(inner) = inner.upgrade() else { return };
                    let plans = last_plan_flush.elapsed() >= PLAN_FLUSH_INTERVAL;
                    if plans {
                        last_plan_flush = tokio::time::Instant::now();
                    }
                    let outs = inner.lock().mapper.flush(plans);
                    inner.deliver(outs).await;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(msg) = msg else { return };
        let Some(inner) = inner.upgrade() else { return };
        let outs = {
            let mut state = inner.lock();
            match msg {
                SessionMsg::Frame(frame) => state.mapper.handle(frame),
                SessionMsg::Exited(detail) => {
                    if let Some(thread) = &mut state.thread {
                        thread.1 = None;
                    }
                    let expected = state.closed;
                    state.mapper.on_exit(expected, &detail)
                }
            }
        };
        inner.deliver(outs).await;
    }
}

fn failed(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

fn call_failed(operation: &'static str) -> impl Fn(CallError) -> ProviderError {
    move |e| match e {
        CallError::Stopped => ProviderError::SessionStopped,
        other => failed(operation, other.to_string()),
    }
}

fn native_thread_id(thread: &ProviderThread) -> Option<String> {
    to_json(thread)["nativeThreadRef"]["nativeId"]
        .as_str()
        .map(str::to_owned)
}

/// `codexTimestamp` for thread rows.
fn codex_time(seconds: &Value) -> String {
    match seconds.as_f64() {
        Some(s) => iso_from_ms((s * 1000.0) as u64),
        None => SystemEnv.now(),
    }
}

impl Session for CodexSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let inner = &self.inner;
            if let Some(existing) = input.existing_provider_thread
                && native_thread_id(&existing).is_some()
            {
                return self
                    .resume_thread(ResumeThreadInput {
                        provider_thread: existing,
                        thread_id: Some(input.thread_id),
                        model_selection: Some(input.model_selection),
                        runtime_policy: Some(input.runtime_policy),
                    })
                    .await;
            }
            let model = launch::selection_model(&input.model_selection);
            let params = launch::thread_params(
                Some(input.thread_id.as_str()),
                input.runtime_policy.cwd.as_deref(),
                Some(&model),
            );
            let result = inner
                .server
                .request("thread/start", params)
                .await
                .map_err(call_failed("ensure_thread"))?;
            let thread = &result["thread"];
            let native = thread["id"]
                .as_str()
                .ok_or_else(|| ProviderError::Protocol {
                    detail: "thread/start answered without a thread id".into(),
                })?
                .to_owned();
            inner.server.route(&native, inner.inbox.clone());
            {
                let mut state = inner.lock();
                state.thread = Some((native.clone(), inner.server.generation()));
                state.app_thread_id = Some(input.thread_id.as_str().to_owned());
            }
            let row = json!({
                "id": ids::provider_thread_id(DRIVER, &native),
                "driver": DRIVER,
                "providerInstanceId": inner.instance_id,
                "providerSessionId": inner.id,
                "appThreadId": input.thread_id.as_str(),
                "ownerNodeId": null,
                "nativeThreadRef": {"driver": DRIVER, "nativeId": native, "strength": "strong"},
                "nativeConversationHeadRef": null,
                "status": "idle",
                "firstRunOrdinal": null,
                "lastRunOrdinal": null,
                "handoffIds": [],
                "forkedFrom": null,
                "createdAt": codex_time(&thread["createdAt"]),
                "updatedAt": codex_time(&thread["updatedAt"]),
            });
            from_json(row).map_err(|e| failed("ensure_thread", e.to_string()))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let inner = &self.inner;
            let native = native_thread_id(&input.provider_thread)
                .ok_or_else(|| failed("resume_thread", "provider thread has no native Codex id"))?;
            let row = to_json(&input.provider_thread);
            let app_thread = input
                .thread_id
                .as_ref()
                .map(|t| t.as_str().to_owned())
                .or_else(|| row["appThreadId"].as_str().map(str::to_owned));
            {
                let mut state = inner.lock();
                state.thread = Some((native.clone(), None));
                state.app_thread_id = app_thread.clone();
            }
            let model = input.model_selection.as_ref().map(launch::selection_model);
            let cwd = input.runtime_policy.as_ref().and_then(|p| p.cwd.clone());
            let result = inner
                .resume(
                    &native,
                    app_thread.as_deref(),
                    cwd.as_deref(),
                    model.as_deref(),
                )
                .await?;
            let mut row = row;
            row["providerSessionId"] = json!(inner.id);
            row["providerInstanceId"] = json!(inner.instance_id);
            row["status"] = json!("idle");
            row["nativeThreadRef"] = json!({"driver": DRIVER, "nativeId": result["thread"]["id"].as_str().unwrap_or(&native), "strength": "strong"});
            row["updatedAt"] = json!(codex_time(&result["thread"]["updatedAt"]));
            from_json(row).map_err(|e| failed("resume_thread", e.to_string()))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            if inner.lock().closed {
                return Err(ProviderError::SessionStopped);
            }
            let model = launch::selection_model(&input.model_selection);
            if inner.lock().thread.is_none() {
                let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                    failed("start_turn", "provider thread has no native Codex id")
                })?;
                let mut state = inner.lock();
                state.thread = Some((native, None));
                state.app_thread_id = Some(input.thread_id.as_str().to_owned());
            }
            let native = inner
                .loaded_thread(Some(&input.runtime_policy), Some(&model))
                .await?;
            if inner.lock().mapper.thread_busy(&native) {
                return Err(failed("start_turn", "the previous turn is still running"));
            }
            let summary = inner
                .server
                .request(
                    "config/read",
                    json!({"cwd": input.runtime_policy.cwd, "includeLayers": false}),
                )
                .await
                .ok()
                .and_then(|r| {
                    r["config"]["model_reasoning_summary"]
                        .as_str()
                        .map(str::to_owned)
                });
            let params = launch::turn_start_params(
                &native,
                launch::user_input(&input.message.text),
                &input.runtime_policy,
                &input.model_selection,
                summary.as_deref(),
            );
            inner.lock().mapper.begin_turn(&native, &input);
            match inner.server.request("turn/start", params).await {
                Ok(result) => {
                    let outs = inner.lock().mapper.turn_start_result(&native, &result);
                    inner.deliver(outs).await;
                    Ok(())
                }
                Err(e) => {
                    inner.lock().mapper.abandon_turn(&native);
                    Err(call_failed("start_turn")(e))
                }
            }
        })
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let (native_turn, native_thread) = {
                let state = inner.lock();
                (
                    state.mapper.native_turn(input.provider_turn_id.as_str()),
                    state.thread.as_ref().map(|(t, _)| t.clone()),
                )
            };
            let (Some(turn), Some(thread)) = (native_turn, native_thread) else {
                return Err(failed("steer_turn", "that turn is not running"));
            };
            inner
                .server
                .request(
                    "turn/steer",
                    json!({"expectedTurnId": turn, "input": launch::user_input(&input.message.text), "threadId": thread}),
                )
                .await
                .map(|_| ())
                .map_err(call_failed("steer_turn"))
        })
    }

    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let inner = &self.inner;
            let (native_turn, thread, processes) = {
                let mut state = inner.lock();
                let Some(turn) = state.mapper.native_turn(input.provider_turn_id.as_str()) else {
                    return Ok(());
                };
                state.mapper.mark_interrupting(&turn);
                let processes = state.mapper.running_processes(&turn);
                let thread = state
                    .thread
                    .as_ref()
                    .map(|(t, _)| t.clone())
                    .unwrap_or_default();
                (turn, thread, processes)
            };
            let sent = inner
                .server
                .request(
                    "turn/interrupt",
                    json!({"threadId": thread, "turnId": native_turn}),
                )
                .await;
            for process in processes {
                let _ = inner
                    .server
                    .request(
                        "thread/backgroundTerminals/terminate",
                        json!({"threadId": thread, "processId": process}),
                    )
                    .await;
            }
            let wait = async {
                loop {
                    let progressed = inner.progressed.notified();
                    if !inner.lock().mapper.is_active(&native_turn) {
                        return;
                    }
                    progressed.await;
                }
            };
            if tokio::time::timeout(INTERRUPT_WAIT, wait).await.is_err() {
                let outs = inner.lock().mapper.force_interrupted(&native_turn);
                inner.deliver(outs).await;
            }
            match sent {
                Ok(_) | Err(CallError::Stopped) => Ok(()),
                Err(e) => Err(failed("interrupt_turn", e.to_string())),
            }
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let outs = self.inner.lock().mapper.respond(&input)?;
            self.inner.deliver(outs).await;
            Ok(())
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let inner = &self.inner;
            let thread = {
                let mut state = inner.lock();
                state.closed = true;
                state.thread.clone()
            };
            if let Some((native, Some(generation))) = thread {
                if inner.server.generation() == Some(generation) {
                    let _ = inner
                        .server
                        .request("thread/unsubscribe", json!({ "threadId": native }))
                        .await;
                }
                inner.server.unroute(&native);
            }
            let outs = inner.lock().mapper.on_exit(true, "The session closed.");
            inner.deliver(outs).await;
            inner.lock().events = None;
            inner.server.remove_session(&inner.id).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CodexConfig, CodexProvider};
    use conn_provider::{OpenSessionInput, OpenedSession, Provider, RuntimePolicy, TurnMessage};

    /// A scripted app-server: answers by method, echoing the request id.
    const FAKE: &str = r#"
emit() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/^{"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) emit "{\"id\":$id,\"result\":{\"userAgent\":\"t3code_desktop/0.167.0 (x)\"}}" ;;
    *'"method":"model/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[],\"nextCursor\":null}}" ;;
    *'"method":"thread/start"'*) emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th1\",\"createdAt\":1,\"updatedAt\":2}}}" ;;
    *'"method":"config/read"'*) emit "{\"id\":$id,\"result\":{\"config\":{}}}" ;;
    *'"method":"turn/start"'*'approve me'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu1\",\"startedAt\":null}}}"
      emit '{"method":"item/commandExecution/requestApproval","id":0,"params":{"threadId":"th1","turnId":"tu1","itemId":"c1","command":"ls"}}' ;;
    *'"method":"turn/start"'*'stop me'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu2\",\"startedAt\":null}}}" ;;
    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"tu0\",\"startedAt\":null}}}"
      emit '{"method":"item/completed","params":{"threadId":"th1","turnId":"tu0","item":{"type":"agentMessage","id":"m1","text":"pong","phase":"final_answer"},"completedAtMs":5}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu0","status":"completed","completedAt":3}}}' ;;
    '{"id":0,"result":{"decision":"accept"}}')
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu1","status":"completed","completedAt":3}}}' ;;
    *'"method":"turn/interrupt"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"tu2","status":"interrupted","completedAt":3}}}' ;;
    *'"method":"thread/unsubscribe"'*) emit "{\"id\":$id,\"result\":{}}" ;;
  esac
done
"#;

    fn provider() -> CodexProvider {
        let dir = std::env::temp_dir().join(format!("conn-codex-fake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("codex");
        std::fs::write(&script, format!("#!/bin/sh\n{FAKE}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        CodexProvider::new(
            "codex".into(),
            CodexConfig {
                binary: script,
                home_path: Some(dir),
                ..CodexConfig::default()
            },
        )
    }

    fn policy() -> RuntimePolicy {
        from_json(json!({"runtimeMode": "approval-required", "interactionMode": "default", "cwd": "/tmp"})).unwrap()
    }

    fn turn(thread: &ProviderThread, n: u32, text: &str) -> TurnInput {
        let selection: conn_contract::ModelSelection =
            from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        TurnInput {
            app_thread: from_json(json!({
                "createdBy": "user", "creationSource": "web", "id": "t1", "projectId": "p1",
                "title": "T", "providerInstanceId": "codex", "modelSelection": to_json(&selection),
                "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
                "worktreePath": null, "activeProviderThreadId": null,
                "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t1"},
                "forkedFrom": null, "createdAt": "x", "updatedAt": "x", "archivedAt": null,
            }))
            .unwrap(),
            thread_id: "t1".into(),
            run_id: format!("r{n}").as_str().into(),
            run_ordinal: n,
            provider_turn_ordinal: n,
            attempt_id: format!("a{n}").as_str().into(),
            root_node_id: format!("n{n}").as_str().into(),
            provider_thread: thread.clone(),
            message: TurnMessage { message_id: "m".into(), text: text.into(), attachments: vec![] },
            model_selection: selection,
            runtime_policy: policy(),
        }
    }

    async fn until(events: &mut mpsc::Receiver<ProviderEvent>, kind: &str) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let event = serde_json::to_value(events.recv().await.expect("events ended")).unwrap();
            let done = event["type"] == kind;
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn turns_approvals_and_interrupts_through_a_fake_app_server() {
        tokio::time::timeout(Duration::from_secs(30), scripted_session())
            .await
            .expect("the scripted session finished within 30 s");
    }

    async fn scripted_session() {
        let provider = provider();
        let OpenedSession {
            session,
            mut events,
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                resume_from_session: None,
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "provider_session.updated").await.len(),
            1
        );
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"}))
                    .unwrap(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        assert_eq!(to_json(&thread)["nativeThreadRef"]["nativeId"], "th1");

        session.start_turn(turn(&thread, 1, "ping")).await.unwrap();
        let seen = until(&mut events, "turn.terminal").await;
        assert!(
            seen.iter()
                .any(|e| e["type"] == "message.updated" && e["message"]["text"] == "pong")
        );
        assert_eq!(seen.last().unwrap()["status"], "completed");

        session
            .start_turn(turn(&thread, 2, "approve me"))
            .await
            .unwrap();
        let seen = until(&mut events, "runtime_request.updated").await;
        let request = seen.last().unwrap()["runtimeRequest"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        session
            .respond_to_runtime_request(RuntimeRequestResponse {
                request_id: request.as_str().into(),
                decision: Some(from_json(json!("accept")).unwrap()),
                feedback: None,
                answers: None,
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "turn.terminal").await.last().unwrap()["status"],
            "completed"
        );

        session
            .start_turn(turn(&thread, 3, "stop me"))
            .await
            .unwrap();
        let running = until(&mut events, "provider_turn.updated").await;
        let provider_turn = running.last().unwrap()["providerTurn"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        session
            .interrupt_turn(InterruptInput {
                provider_thread: thread.clone(),
                provider_turn_id: provider_turn.as_str().into(),
            })
            .await
            .unwrap();
        assert_eq!(
            until(&mut events, "turn.terminal").await.last().unwrap()["status"],
            "interrupted"
        );

        let pid = provider.app_server_pid().unwrap();
        session.close().await;
        assert!(
            events.recv().await.is_none(),
            "the event channel closes after close"
        );
        assert!(provider.app_server_pid().is_none());
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "the app-server outlived its last session");
    }
}
