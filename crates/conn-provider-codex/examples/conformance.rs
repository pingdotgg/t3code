//! The Rust half of `tools/conformance.mjs`: replays the adapter calls the TS server made in
//! each scenario into [`CodexProvider`], against the same stub `codex` and transcript.
//!
//! `cargo run -p conn-provider-codex --example conformance -- <plan.json>`
//!
//! A call waits for the state the TS call saw: a turn waits until the previous one ended, an
//! answer waits for its runtime request, an interrupt waits for a running turn. Ids come from
//! this side's own events (the k-th answer goes to the k-th request).

use std::{path::PathBuf, sync::Arc, time::Duration};

use conn_contract::{ModelSelection, ProviderThread, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, McpServer, OpenSessionInput, OpenedSession, Provider,
    ProviderEvent, ResumeThreadInput, RuntimePolicy, RuntimeRequestResponse, Session, SteerInput,
    TurnInput, TurnMessage,
};
use conn_provider_codex::{CodexConfig, CodexProvider};
use serde_json::Value;
use tokio::sync::{Mutex, Notify};

const WAIT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Seen {
    events: Vec<Value>,
}

impl Seen {
    fn running_turn(&self) -> Option<String> {
        let mut running = None;
        for e in &self.events {
            if e["type"] == "provider_turn.updated" && e["providerTurn"]["status"] == "running" {
                running = e["providerTurn"]["id"].as_str().map(str::to_owned);
            }
            if e["type"] == "turn.terminal" {
                running = None;
            }
        }
        running
    }
    /// Turns seen starting: a running update after no turn ran (ids can repeat on a new
    /// process, since they follow the turn ordinal).
    fn started_turns(&self) -> usize {
        let (mut started, mut running) = (0, false);
        for e in &self.events {
            if e["type"] == "provider_turn.updated"
                && e["providerTurn"]["status"] == "running"
                && !running
            {
                started += 1;
                running = true;
            }
            if e["type"] == "turn.terminal" {
                running = false;
            }
        }
        started
    }
    fn terminals(&self) -> usize {
        self.events
            .iter()
            .filter(|e| e["type"] == "turn.terminal")
            .count()
    }
    fn requests(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for e in &self.events {
            if e["type"] == "runtime_request.updated"
                && e["runtimeRequest"]["status"] == "pending"
                && let Some(id) = e["runtimeRequest"]["id"].as_str()
                && !out.iter().any(|o| o == id)
            {
                out.push(id.to_owned());
            }
        }
        out
    }
}

struct Run {
    name: String,
    seen: Arc<Mutex<Seen>>,
    changed: Arc<Notify>,
}

impl Run {
    async fn wait_until(&self, what: &str, mut ok: impl FnMut(&Seen) -> bool) {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let notified = self.changed.notified();
            if ok(&*self.seen.lock().await) {
                return;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                eprintln!("conformance: {}: gave up waiting for {what}", self.name);
                return;
            }
        }
    }
}

fn json<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("{e}: {value}"))
}

fn message(input: &Value) -> Result<TurnMessage, String> {
    let m = &input["message"];
    Ok(TurnMessage {
        message_id: m["messageId"].as_str().unwrap_or("m").into(),
        text: m["text"].as_str().unwrap_or_default().to_owned(),
        attachments: json(&m["attachments"]).unwrap_or_default(),
    })
}

async fn scenario(plan: &Value, scenario: &Value) -> Result<(), String> {
    let dir = PathBuf::from(scenario["dir"].as_str().ok_or("scenario dir")?);
    let calls: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("ts/calls.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let env: serde_json::Map<String, Value> = std::env::vars()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    std::fs::write(
        dir.join("rust/env.json"),
        Value::Object(env).to_string().as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    let config = CodexConfig {
        binary: PathBuf::from(scenario["rustCodex"].as_str().ok_or("rustCodex")?),
        home_path: plan["codexHome"].as_str().map(PathBuf::from),
        attachments_dir: plan["attachmentsDir"].as_str().map(PathBuf::from),
        ..CodexConfig::default()
    };
    let mut provider = Arc::new(CodexProvider::new("codex".into(), config.clone()));
    let mut session: Option<Box<dyn Session>> = None;
    let mut thread: Option<ProviderThread> = None;
    let run = Run {
        name: scenario["name"].as_str().unwrap_or("?").to_owned(),
        seen: Arc::new(Mutex::new(Seen::default())),
        changed: Arc::new(Notify::new()),
    };
    let mut answered = 0usize;
    let mut turns = 0usize;
    let log = calls["log"].as_array().cloned().unwrap_or_default();
    for entry in log.iter().filter(|e| e["kind"] == "call") {
        let input = &entry["input"];
        let method = entry["method"].as_str().unwrap_or_default();
        match method {
            "openSession" => {
                if let Some(old) = session.take() {
                    // TS released the idle session; a new process serves the next one.
                    old.close().await;
                    provider = Arc::new(CodexProvider::new("codex".into(), config.clone()));
                }
                let OpenedSession {
                    session: opened,
                    events,
                } = provider
                    .open_session(OpenSessionInput {
                        thread_id: input["threadId"].as_str().unwrap_or("t").into(),
                        provider_session_id: input["providerSessionId"]
                            .as_str()
                            .unwrap_or("s")
                            .into(),
                        model_selection: json(&input["modelSelection"])?,
                        runtime_policy: json(&input["runtimePolicy"])?,
                        resume_from_session: None,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                let (seen, changed) = (run.seen.clone(), run.changed.clone());
                tokio::spawn(async move {
                    let mut events = events;
                    while let Some(event) = events.recv().await {
                        let value = serde_json::to_value(&event).unwrap_or(Value::Null);
                        let _: &ProviderEvent = &event;
                        seen.lock().await.events.push(value);
                        changed.notify_waiters();
                    }
                });
                if scenario["mcp"] == true {
                    // What the engine passes when the thread has T3's MCP session; the TS
                    // side gets the same endpoint and token from its McpProviderSessions.
                    opened
                        .set_mcp_servers(vec![McpServer {
                            name: "t3-code".into(),
                            url: "http://127.0.0.1:3773/mcp".into(),
                            headers: vec![(
                                "Authorization".into(),
                                "Bearer conformance-token".into(),
                            )],
                        }])
                        .await
                        .map_err(|e| e.to_string())?;
                }
                session = Some(opened);
            }
            "ensureThread" => {
                let s = session.as_ref().ok_or("no session")?;
                let row = s
                    .ensure_thread(EnsureThreadInput {
                        thread_id: input["threadId"].as_str().unwrap_or("t").into(),
                        title: input["title"].as_str().map(str::to_owned),
                        model_selection: json(&input["modelSelection"])?,
                        runtime_policy: json(&input["runtimePolicy"])?,
                        existing_provider_thread: json(&input["existingProviderThread"]).ok(),
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                thread = Some(row);
            }
            "resumeThread" => {
                let s = session.as_ref().ok_or("no session")?;
                let row = s
                    .resume_thread(ResumeThreadInput {
                        provider_thread: json(&input["providerThread"])?,
                        thread_id: input["threadId"].as_str().map(Into::into),
                        model_selection: json(&input["modelSelection"]).ok(),
                        runtime_policy: json(&input["runtimePolicy"]).ok(),
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                thread = Some(row);
            }
            "startTurn" => {
                let done = turns;
                run.wait_until("the previous turn to end", |s| s.terminals() >= done)
                    .await;
                turns += 1;
                let s = session.as_ref().ok_or("no session")?;
                let provider_thread: ProviderThread = json(&input["providerThread"])
                    .ok()
                    .or_else(|| thread.clone())
                    .ok_or("no thread")?;
                let model_selection: ModelSelection = json(&input["modelSelection"])?;
                let runtime_policy: RuntimePolicy = json(&input["runtimePolicy"])?;
                s.start_turn(TurnInput {
                    app_thread: json(&input["appThread"])?,
                    thread_id: input["threadId"].as_str().unwrap_or("t").into(),
                    run_id: input["runId"].as_str().unwrap_or("r").into(),
                    run_ordinal: input["runOrdinal"].as_u64().unwrap_or(1) as u32,
                    provider_turn_ordinal: input["providerTurnOrdinal"].as_u64().unwrap_or(1)
                        as u32,
                    attempt_id: input["attemptId"].as_str().unwrap_or("a").into(),
                    root_node_id: input["rootNodeId"].as_str().unwrap_or("n").into(),
                    provider_thread,
                    message: message(input)?,
                    model_selection,
                    runtime_policy,
                })
                .await
                .map_err(|e| e.to_string())?;
                let started = turns;
                run.wait_until("the turn to start", |s| s.started_turns() >= started)
                    .await;
            }
            "steerTurn" => {
                run.wait_until("a running turn", |s| s.running_turn().is_some())
                    .await;
                let turn = run.seen.lock().await.running_turn().unwrap_or_default();
                let s = session.as_ref().ok_or("no session")?;
                s.steer_turn(SteerInput {
                    thread_id: input["threadId"].as_str().unwrap_or("t").into(),
                    run_id: input["runId"].as_str().unwrap_or("r").into(),
                    provider_thread: json(&input["providerThread"])?,
                    provider_turn_id: turn.as_str().into(),
                    message: message(input)?,
                    model_selection: json(&input["modelSelection"]).ok(),
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            "interruptTurn" => {
                run.wait_until("a running turn", |s| s.running_turn().is_some())
                    .await;
                let turn = run.seen.lock().await.running_turn().unwrap_or_default();
                let s = session.as_ref().ok_or("no session")?;
                s.interrupt_turn(InterruptInput {
                    provider_thread: json(&input["providerThread"])?,
                    provider_turn_id: turn.as_str().into(),
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            "respondToRuntimeRequest" => {
                let k = answered;
                run.wait_until("the runtime request", |s| s.requests().len() > k)
                    .await;
                answered += 1;
                let id = run
                    .seen
                    .lock()
                    .await
                    .requests()
                    .get(k)
                    .cloned()
                    .unwrap_or_default();
                let s = session.as_ref().ok_or("no session")?;
                s.respond_to_runtime_request(RuntimeRequestResponse {
                    request_id: id.as_str().into(),
                    decision: json(&input["decision"]).ok(),
                    feedback: input["feedback"].as_str().map(str::to_owned),
                    answers: json(&input["answers"]).ok(),
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            "applyModelSelection" => {
                let s = session.as_ref().ok_or("no session")?;
                let _ = s
                    .apply_model_selection(
                        json(&input["providerThread"])?,
                        json(&input["modelSelection"])?,
                    )
                    .await;
            }
            // Reads with no wire effect on either side.
            "normalizeThreadLoadModelSelection"
            | "hasPendingBackgroundWork"
            | "hasPendingBackgroundWorkForThread"
            | "getModelContextWindow"
            | "canReuseContextUsage" => {}
            other => eprintln!("conformance: {other} is not replayed"),
        }
    }
    let done = turns;
    run.wait_until("every turn to end", |s| s.terminals() >= done)
        .await;
    if let Some(s) = session.take() {
        s.close().await;
    }
    let _ = to_json(&thread);
    let events = Value::Array(run.seen.lock().await.events.clone());
    std::fs::write(dir.join("rust/events.json"), events.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: conformance <plan.json>");
        std::process::exit(2);
    };
    let plan: Value = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(plan) => plan,
        Err(e) => {
            eprintln!("conformance: {path}: {e}");
            std::process::exit(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("conformance: {e}");
            std::process::exit(1);
        }
    };
    let mut failed = false;
    for s in plan["scenarios"].as_array().into_iter().flatten() {
        let name = s["name"].as_str().unwrap_or("?");
        if let Err(e) = runtime.block_on(scenario(&plan, s)) {
            eprintln!("conformance: {name}: {e}");
            failed = true;
        }
    }
    std::process::exit(i32::from(failed));
}
