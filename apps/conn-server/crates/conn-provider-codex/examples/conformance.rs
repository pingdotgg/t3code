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
    EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, OpenSessionInput, OpenedSession,
    Provider, ProviderEvent, ResumeThreadInput, RollbackTarget, RollbackThreadInput, RuntimePolicy,
    RuntimeRequestResponse, Session, SteerInput, TurnInput, TurnMessage,
};
use conn_provider_codex::{CodexConfig, CodexProvider};
use serde_json::Value;
use tokio::sync::{Mutex, Notify};

const WAIT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Seen {
    events: Vec<Value>,
}

/// Distinct turn items by type: `turn_item.updated` rows, keyed `<type>` → item ids.
fn items_by_type<'a>(events: impl Iterator<Item = &'a Value>) -> Vec<(String, String)> {
    let mut items: Vec<(String, String)> = Vec::new();
    for e in events {
        if e["type"] != "turn_item.updated" {
            continue;
        }
        let kind = e["turnItem"]["type"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        // Command rows are what TS calls wait on (an interrupt mid-tool); other rows' ids or
        // timing differ by design and are compared by the replay tests instead.
        if kind != "command_execution" {
            continue;
        }
        let id = e["turnItem"]["id"].as_str().unwrap_or_default().to_owned();
        if !items.iter().any(|(k, i)| *k == kind && *i == id) {
            items.push((kind, id));
        }
    }
    items
}

impl Seen {
    /// Whether this side has seen every turn item TS had seen (by id) before a call.
    fn has_items(&self, wanted: &[(String, String)]) -> bool {
        let have = items_by_type(self.events.iter());
        wanted.iter().all(|w| have.contains(w))
    }

    /// The running root turn. A subagent's turn runs outside the run (`runAttemptId` null).
    fn running_turn(&self) -> Option<String> {
        let mut running = None;
        for e in &self.events {
            if e["type"] == "provider_turn.updated"
                && e["providerTurn"]["status"] == "running"
                && !e["providerTurn"]["runAttemptId"].is_null()
            {
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
                && !e["providerTurn"]["runAttemptId"].is_null()
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

/// Collects a session's events into the shared record.
fn pump(run: &Run, events: tokio::sync::mpsc::Receiver<ProviderEvent>) {
    let (seen, changed) = (run.seen.clone(), run.changed.clone());
    tokio::spawn(async move {
        let mut events = events;
        while let Some(event) = events.recv().await {
            let value = serde_json::to_value(&event).unwrap_or(Value::Null);
            seen.lock().await.events.push(value);
            changed.notify_waiters();
        }
    });
}

fn json<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("{e}: {value}"))
}

fn message(input: &Value) -> Result<TurnMessage, String> {
    let m = &input["message"];
    Ok(TurnMessage {
        created_by: conn_contract::OrchestrationV2Actor::User,
        creation_source: conn_contract::OrchestrationV2CreationSource::Web,
        scheduled_task_id: None,
        sender_thread_id: None,
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
    // The `login` scenario: the server's start-up PATH fix (`serve.rs`, T3's `fixPath`) with
    // a stand-in login shell in place of `$SHELL`.
    let login = scenario["loginShell"] == true;
    if login {
        let shell = scenario["rustShell"]
            .as_str()
            .ok_or("rustShell")?
            .to_owned();
        let applied = tokio::task::spawn_blocking(move || {
            conn_support::login_env::hydrate_from(Some(std::ffi::OsStr::new(&shell)))
        })
        .await
        .map_err(|e| e.to_string())?;
        if !applied {
            return Err("the stand-in login shell printed no PATH".into());
        }
    }
    let result = run_scenario(plan, scenario, &dir, &calls).await;
    if login {
        conn_support::login_env::clear();
    }
    result
}

async fn run_scenario(
    plan: &Value,
    scenario: &Value,
    dir: &std::path::Path,
    calls: &Value,
) -> Result<(), String> {
    // The scenario's `providerInstances` entry over its stub and home, as the server applies
    // one (`CodexConfig::with_instance`).
    let mut entry = scenario
        .get("instance")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let rust_codex = scenario["rustCodex"].as_str().ok_or("rustCodex")?;
    if entry["config"]["binaryPath"].is_null() {
        entry["config"]["binaryPath"] = serde_json::json!(rust_codex);
    }
    if entry["config"]["homePath"].is_null() {
        entry["config"]["homePath"] = plan["codexHome"].clone();
    }
    let config = CodexConfig {
        attachments_dir: plan["attachmentsDir"].as_str().map(PathBuf::from),
        ..CodexConfig::default()
    }
    .with_instance(Some(&entry));
    if let Some(title) = scenario.get("title") {
        return run_title(&config, title, dir, calls).await;
    }
    let mut provider = Arc::new(CodexProvider::new("codex".into(), config.clone()));
    let mut session: Option<Box<dyn Session>> = None;
    let mut thread: Option<ProviderThread> = None;
    let run = Run {
        name: scenario["name"].as_str().unwrap_or("?").to_owned(),
        seen: Arc::new(Mutex::new(Seen::default())),
        changed: Arc::new(Notify::new()),
    };
    let mut answered = 0usize;
    let mut session_thread: Option<String> = None;
    let mut parked: Vec<Box<dyn Session>> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut turns = 0usize;
    let log = calls["log"].as_array().cloned().unwrap_or_default();
    for (index, entry) in log.iter().enumerate() {
        if entry["kind"] != "call" {
            continue;
        }
        let input = &entry["input"];
        let method = entry["method"].as_str().unwrap_or_default();
        // The turn items TS had seen when it made this call (an interrupt can wait for a
        // command row); ids derive from Codex's item ids, so both sides name them alike.
        let before = items_by_type(
            log.iter()
                .take(index)
                .filter(|e| e["kind"] == "event")
                .map(|e| &e["event"]),
        );
        if !matches!(method, "openSession" | "normalizeThreadLoadModelSelection") {
            run.wait_until("the turn items TS had seen", |s| s.has_items(&before))
                .await;
        }
        match method {
            "openSession" => {
                if let Some(old) = session.take() {
                    // TS released the idle session; a new process serves the next one.
                    session_thread = None;
                    old.close().await;
                    provider = Arc::new(CodexProvider::new("codex".into(), config.clone()));
                }
                let OpenedSession {
                    session: opened,
                    events,
                    ..
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
                        // What the engine passes when the thread has T3's MCP session; the
                        // TS side gets the same endpoint and token from its McpProviderSessions.
                        mcp_servers: if scenario["mcp"] == true {
                            vec![McpServer {
                                name: "t3-code".into(),
                                url: "http://127.0.0.1:3773/mcp".into(),
                                headers: vec![(
                                    "Authorization".into(),
                                    "Bearer conformance-token".into(),
                                )],
                            }]
                        } else {
                            vec![]
                        },
                        host: None,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                pump(&run, events);
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
                session_thread = to_json(&row)["nativeThreadRef"]["nativeId"]
                    .as_str()
                    .map(str::to_owned);
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
                session_thread = to_json(&row)["nativeThreadRef"]["nativeId"]
                    .as_str()
                    .map(str::to_owned);
                thread = Some(row);
            }
            "startTurn" => {
                let done = turns;
                run.wait_until("the previous turn to end", |s| s.terminals() >= done)
                    .await;
                turns += 1;
                // A turn on another native thread (a fork target) gets its own session on the
                // same app-server, as the engine opens one session per app thread.
                let native = input["providerThread"]["nativeThreadRef"]["nativeId"]
                    .as_str()
                    .map(str::to_owned);
                if native.is_some() && session_thread.is_some() && native != session_thread {
                    if let Some(old) = session.take() {
                        parked.push(old);
                    }
                    let OpenedSession {
                        session: opened,
                        events,
                        ..
                    } = provider
                        .open_session(OpenSessionInput {
                            thread_id: input["threadId"].as_str().unwrap_or("t").into(),
                            provider_session_id: "provider-session:second".into(),
                            model_selection: json(&input["modelSelection"])?,
                            runtime_policy: json(&input["runtimePolicy"])?,
                            resume_from_session: None,
                            mcp_servers: vec![],
                            host: None,
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    pump(&run, events);
                    session = Some(opened);
                }
                session_thread = native.or(session_thread);
                let s = session.as_ref().ok_or("no session")?;
                let provider_thread: ProviderThread = json(&input["providerThread"])
                    .ok()
                    .or_else(|| thread.clone())
                    .ok_or("no thread")?;
                let model_selection: ModelSelection = json(&input["modelSelection"])?;
                let runtime_policy: RuntimePolicy = json(&input["runtimePolicy"])?;
                s.start_turn(TurnInput {
                    native_thread_has_turns: None,
                    restart_continuation_of_run_id: None,
                    app_context: vec![],
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
                // T3 stops after the stub sent what comes before the Stop (a subagent's turn
                // among it), so the lineage it interrupts is complete; wait the same way.
                quiet(&dir.join("rust/stub.ndjson")).await;
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
            "rollbackThread" => {
                let s = session.as_ref().ok_or("no session")?;
                let target = &input["target"];
                let checkpoint_id = target["checkpointId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let target = if target["type"] == "provider_turn" {
                    RollbackTarget::ProviderTurn {
                        checkpoint_id,
                        app_run_ordinal: target["appRunOrdinal"].as_u64().unwrap_or(0) as u32,
                        provider_turn: json(&target["providerTurn"])?,
                    }
                } else {
                    RollbackTarget::ThreadStart { checkpoint_id }
                };
                let snapshot = s
                    .rollback_thread(RollbackThreadInput {
                        provider_thread: json(&input["providerThread"])?,
                        target,
                        provider_thread_turns: json(&input["providerThreadTurns"])?,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                results.push(serde_json::json!({
                    "method": "rollbackThread",
                    "output": {
                        "providerThread": to_json(&snapshot.provider_thread),
                        "providerTurns": snapshot.provider_turns.len(),
                        "messages": snapshot.messages.len(),
                        "runtimeRequests": snapshot.runtime_requests.len(),
                    },
                }));
            }
            "forkThread" => {
                let s = session.as_ref().ok_or("no session")?;
                let forked = s
                    .fork_thread(ForkThreadInput {
                        source_provider_thread: json(&input["sourceProviderThread"])?,
                        source_provider_turns: json(&input["sourceProviderTurns"])
                            .unwrap_or_default(),
                        provider_turn_id: input["providerTurnId"].as_str().map(Into::into),
                        target_thread_id: input["targetThreadId"].as_str().unwrap_or("t").into(),
                        owner_node_id: input["ownerNodeId"].as_str().map(Into::into),
                        model_selection: json(&input["modelSelection"])?,
                        runtime_policy: json(&input["runtimePolicy"])?,
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                results
                    .push(serde_json::json!({"method": "forkThread", "output": to_json(&forked)}));
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
    // The TS harness tears its session down about 150 ms after the last turn, so requests a
    // server sends in the background (a subagent's model read) reach the stub first. Give
    // ours the same chance.
    quiet(&dir.join("rust/stub.ndjson")).await;
    for s in parked.into_iter().chain(session.take()) {
        s.close().await;
    }
    let _ = to_json(&thread);
    let events = Value::Array(run.seen.lock().await.events.clone());
    std::fs::write(dir.join("rust/events.json"), events.to_string()).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("rust/results.json"),
        Value::Array(results).to_string(),
    )
    .map_err(|e| e.to_string())?;
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

/// A title scenario: T3's prompt and schema (from the TS side's request) through
/// [`Provider::generate_text`], as the title code calls it.
async fn run_title(
    config: &CodexConfig,
    title: &Value,
    dir: &std::path::Path,
    calls: &Value,
) -> Result<(), String> {
    let config = CodexConfig {
        launch_args: title["launchArgs"].as_str().unwrap_or_default().to_owned(),
        ..config.clone()
    };
    let provider = CodexProvider::new("codex".into(), config);
    let request = conn_provider::TextGenerationRequest {
        operation: "generateThreadTitle".into(),
        cwd: dir.to_string_lossy().into_owned(),
        prompt: calls["request"]["prompt"]
            .as_str()
            .ok_or("no prompt from TS")?
            .to_owned(),
        output_schema: calls["request"]["outputSchema"]
            .as_str()
            .ok_or("no schema from TS")?
            .to_owned(),
        model_selection: json(&title["modelSelection"])?,
        image_paths: Vec::new(),
        timeout: None,
        investigate: false,
    };
    let output = provider
        .generate_text(request)
        .await
        .map_err(|e| e.to_string());
    let results = serde_json::json!([{
        "method": "generateThreadTitle",
        "output": output.as_ref().ok(),
    }]);
    std::fs::write(dir.join("rust/results.json"), results.to_string())
        .map_err(|e| e.to_string())?;
    output.map(|_| ())
}

/// Returns once the stub's log has not grown for 100 ms (at most 4 s).
async fn quiet(log: &std::path::Path) {
    let size = || std::fs::metadata(log).map(|m| m.len()).unwrap_or(0);
    let mut last = size();
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let now = size();
        if now == last {
            return;
        }
        last = now;
    }
}
