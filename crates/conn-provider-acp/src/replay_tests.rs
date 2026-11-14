//! The T3 test kit's ACP transcripts through our whole session, against an in-memory agent
//! that applies T3's replay rules (`replay_agent`), and the events compared with what T3's
//! adapter emitted for the same transcript.
//!
//! `testdata/<flavor>/<fixture>.json` comes from `tools/capture-ts-events.mjs`: the
//! transcript as T3's harness handed it to its replay agent, every adapter call the
//! orchestrator made, and every event. The test replays those calls in order: each waits until
//! the agent and the session are idle, as the orchestrator waits for the events that cause
//! it. Streamed text is held until its segment closes (`flush_interval: None`), as T3's paused
//! test clock holds it.
//!
//! Normalized before comparing (both sides): timestamps become `<now>` (T3's test clock and
//! ours differ); the random uuid in runtime request and plan ids becomes `<uuid>`.
//!
//! `testdata/<flavor>/expected-failures.txt` lists the fixtures that cannot pass yet, with the
//! reason. The test fails when a listed fixture passes or an unlisted one fails.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, InterruptInput, ProviderEvent, RuntimeRequestResponse, Session,
};
use conn_provider_support::ids::FixedEnv;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::flavor::Flavor;
use crate::replay_agent::{self, Script};
use crate::session::{self, AcpSession, Config};

fn read_golden(flavor: &str, name: &str) -> Value {
    let path = format!(
        "{}/testdata/{flavor}/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn fixtures(flavor: &str) -> Vec<String> {
    let dir = format!("{}/testdata/{flavor}", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter_map(|n| n.strip_suffix(".json").map(str::to_owned))
        .collect();
    names.sort();
    names
}

fn expected_failures(flavor: &str) -> BTreeMap<String, String> {
    let path = format!(
        "{}/testdata/{flavor}/expected-failures.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| match l.split_once(' ') {
            Some((name, reason)) => (name.to_owned(), reason.trim().to_owned()),
            None => (l.to_owned(), String::new()),
        })
        .collect()
}

pub(crate) struct Run {
    pub events: Vec<Value>,
    pub script: Arc<Mutex<Script>>,
    pub errors: Vec<String>,
}

/// T3's `release_replay_gate` after `finish_held_run`: a gate opens once its run ended.
fn release_gates(
    gates: &[(String, u64)],
    script: &Arc<Mutex<Script>>,
    events: &Arc<Mutex<Vec<Value>>>,
) {
    for (label, after_run) in gates {
        let ended = crate::lock(events).iter().any(|e| {
            e["type"] == "turn.terminal"
                && e["runOrdinal"].as_u64().is_some_and(|r| r >= *after_run)
        });
        if ended {
            crate::lock(script).release(label);
        }
    }
}

/// Waits until neither the agent's cursor nor the event count moves for a while.
async fn idle(
    gates: &[(String, u64)],
    script: &Arc<Mutex<Script>>,
    events: &Arc<Mutex<Vec<Value>>>,
) {
    let mut last = (usize::MAX, usize::MAX);
    let mut still = 0;
    for _ in 0..2_000 {
        tokio::time::sleep(Duration::from_millis(2)).await;
        release_gates(gates, script, events);
        let now = (crate::lock(script).cursor, crate::lock(events).len());
        if now == last {
            still += 1;
            if still >= 5 {
                return;
            }
        } else {
            still = 0;
            last = now;
        }
    }
}

pub(crate) async fn replay(flavor: &'static Flavor, golden: &Value) -> Run {
    let calls = golden["calls"].as_array().cloned().unwrap_or_default();
    let open = calls
        .iter()
        .find(|c| c["method"] == "openSession")
        .cloned()
        .unwrap_or(Value::Null);
    let policy = &open["input"]["runtimePolicy"];
    let workspace = policy["cwd"].as_str().unwrap_or("/workspace").to_owned();
    let entries = golden["transcripts"][0]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let script = Script::new(entries, &workspace);
    // `gates`: the labels the fixture holds, each until a run ended.
    let gates: Vec<(String, u64)> = golden["gates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((g["label"].as_str()?.to_owned(), g["afterRun"].as_u64()?)))
        .collect();
    crate::lock(&script).gates = gates.iter().map(|(label, _)| label.clone()).collect();
    let spawn_script = script.clone();
    let spawner: session::Spawner = Arc::new(move || {
        let (writer, events) = replay_agent::spawn(spawn_script.clone());
        Ok(session::Spawned {
            writer,
            events,
            stop: Box::new(|_| Box::pin(async {})),
        })
    });
    let config = Config {
        flush_interval: None,
        finalize_debounce: Duration::from_millis(5),
        flavor,
        instance_id: open["input"]["modelSelection"]["instanceId"]
            .as_str()
            .unwrap_or(flavor.driver)
            .to_owned(),
        provider_session_id: open["input"]["providerSessionId"]
            .as_str()
            .unwrap_or("s")
            .to_owned(),
        cwd: workspace.clone(),
        policy: policy.clone(),
        runtime_mode: policy["runtimeMode"]
            .as_str()
            .unwrap_or("full-access")
            .to_owned(),
        model: open["input"]["modelSelection"]["model"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        mcp_servers: Vec::new(),
        client_version: "0.0.0".into(),
    };
    let (tx, mut rx) = mpsc::channel::<ProviderEvent>(session::EVENT_CAPACITY);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            crate::lock(&sink).push(serde_json::to_value(&event).unwrap());
        }
    });
    let mut errors = Vec::new();
    let session = match AcpSession::open(config, spawner, Box::new(FixedEnv::default()), tx).await {
        Ok((session, _)) => session,
        Err(error) => {
            errors.push(format!("open: {error}"));
            return Run {
                events: Vec::new(),
                script,
                errors,
            };
        }
    };
    let mut pending_seen = 0usize;
    let mut continuations_expected = 0usize;
    for call in &calls {
        idle(&gates, &script, &events).await;
        let input = &call["input"];
        match call["method"].as_str().unwrap_or("") {
            "ensureThread" => {
                let result = session
                    .ensure_thread(EnsureThreadInput {
                        thread_id: from_json(input["threadId"].clone()).unwrap(),
                        title: input["title"].as_str().map(str::to_owned),
                        model_selection: from_json(input["modelSelection"].clone()).unwrap(),
                        runtime_policy: from_json(input["runtimePolicy"].clone()).unwrap(),
                        existing_provider_thread: None,
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("ensureThread: {e}"));
                }
            }
            "startTurn" => {
                // The orchestrator starts a turn once the last one ended; a deferred finalize
                // may still be in its (shortened) debounce.
                for _ in 0..1_000 {
                    if !session.has_turn().await {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                idle(&gates, &script, &events).await;
                if input["message"]["createdBy"] == "agent"
                    && input["message"]["creationSource"] == "provider"
                {
                    continuations_expected += 1;
                }
                if let Err(e) = session.start_turn(crate::testing::turn_input(input)).await {
                    errors.push(format!("startTurn: {e}"));
                }
            }
            // T3's orchestrator sends `/compact` through `compactThread`, which starts the turn
            // with the text `/compact`; ours sends the message through `start_turn`.
            "compactThread" => {
                let mut input = input.clone();
                input["message"]["text"] = json!("/compact");
                if let Err(e) = session.start_turn(crate::testing::turn_input(&input)).await {
                    errors.push(format!("compactThread: {e}"));
                }
            }
            "respondToRuntimeRequest" => {
                // Our request ids carry our own uuid: answer the requests in the order they came.
                let ids: Vec<String> = crate::lock(&events)
                    .iter()
                    .filter(|e| {
                        e["type"] == "runtime_request.updated"
                            && e["runtimeRequest"]["status"] == "pending"
                    })
                    .filter_map(|e| e["runtimeRequest"]["id"].as_str().map(str::to_owned))
                    .collect();
                let Some(id) = ids.get(pending_seen).cloned() else {
                    errors.push("respondToRuntimeRequest: no pending request".into());
                    continue;
                };
                pending_seen += 1;
                let result = session
                    .respond_to_runtime_request(RuntimeRequestResponse {
                        request_id: id.as_str().into(),
                        decision: from_json(input["decision"].clone()).ok(),
                        feedback: None,
                        answers: from_json(input["answers"].clone()).ok(),
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("respond: {e}"));
                }
            }
            "interruptTurn" => {
                let result = session
                    .interrupt_turn(InterruptInput {
                        provider_thread: from_json(input["providerThread"].clone()).unwrap(),
                        provider_turn_id: from_json(input["providerTurnId"].clone()).unwrap(),
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("interrupt: {e}"));
                }
            }
            "close" => session.close().await,
            "openSession" | "getModelContextWindow" => {}
            other => errors.push(format!("call {other} is not replayed")),
        }
    }
    idle(&gates, &script, &events).await;
    // The fixture's scope closes the adapter session at the end (T3 records no call for it).
    if !calls.iter().any(|c| c["method"] == "close") {
        session.close().await;
        idle(&gates, &script, &events).await;
    }
    // Nothing of a finished turn stays behind.
    if session.has_turn().await
        || session.pending_requests().await != 0
        || !session.background_state_empty().await
    {
        errors.push("state left after the last turn".into());
    }
    let events = crate::lock(&events).clone();
    // T3 offers a continuation through its own service, not the event stream: each
    // provider continuation turn of the recording must follow one request of ours.
    let requested = events
        .iter()
        .filter(|e| e["type"] == "continuation.requested")
        .count();
    if requested != continuations_expected {
        errors.push(format!(
            "{requested} continuation requests, {continuations_expected} continuation turns"
        ));
    }
    Run {
        events,
        script,
        errors,
    }
}

/// Both sides through the contract types, then the documented normalizations.
pub(crate) fn normalize(event: &Value) -> Value {
    let mut value = match serde_json::from_value::<ProviderEvent>(event.clone()) {
        Ok(typed) => serde_json::to_value(typed).unwrap(),
        Err(e) => json!({"undecodable": e.to_string(), "event": event}),
    };
    scrub(&mut value);
    value
}

fn scrub(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if let Value::String(s) = v {
                    if key.ends_with("At") && s.starts_with("1970-") {
                        *s = "<now>".into();
                    } else if (s.starts_with("runtime-request:") || s.starts_with("plan:"))
                        && s.len() > 37
                    {
                        s.replace_range(s.len() - 36.., "<uuid>");
                    } else if (s.starts_with("node:runtime-request:")
                        || s.starts_with("turn-item:runtime-request:"))
                        && let Some(at) = s.rfind("%3A")
                    {
                        s.replace_range(at + 3.., "<uuid>");
                    }
                }
                scrub(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        _ => {}
    }
}

/// The first difference between two event lists, or `None`.
pub(crate) fn compare(ours: &[Value], theirs: &[Value]) -> Option<String> {
    let ours: Vec<Value> = ours
        .iter()
        .filter(|e| e["type"] != "continuation.requested")
        .map(normalize)
        .collect();
    let theirs: Vec<Value> = theirs.iter().map(normalize).collect();
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        if a != b {
            return Some(format!("event {i} differs:\n  ours   {a}\n  theirs {b}"));
        }
    }
    if ours.len() != theirs.len() {
        let extra = if ours.len() > theirs.len() {
            format!(
                "ours has more: {}",
                ours.get(theirs.len()).unwrap_or(&Value::Null)
            )
        } else {
            format!(
                "theirs has more: {}",
                theirs.get(ours.len()).unwrap_or(&Value::Null)
            )
        };
        return Some(format!(
            "{} events here, {} from T3; {extra}",
            ours.len(),
            theirs.len()
        ));
    }
    None
}

/// Replays one fixture; `Err` holds why it does not pass.
pub(crate) async fn check_fixture(flavor: &'static Flavor, name: &str) -> Result<(), String> {
    let golden = read_golden(flavor.driver, name);
    let run = replay(flavor, &golden).await;
    let mut problems = run.errors.clone();
    {
        let script = crate::lock(&run.script);
        if let Some(failure) = &script.failure {
            problems.push(format!("frames: {failure}"));
        } else if !script.complete() {
            problems.push(format!(
                "frames: stopped at entry {} of {}: {}",
                script.cursor,
                script.entries.len(),
                script
                    .entries
                    .get(script.cursor)
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            ));
        }
    }
    let theirs = golden["events"].as_array().cloned().unwrap_or_default();
    if let Ok(dir) = std::env::var("ACP_DUMP") {
        let ours: Vec<Value> = run.events.iter().map(normalize).collect();
        let theirs: Vec<Value> = theirs.iter().map(normalize).collect();
        let _ = std::fs::write(
            format!("{dir}/{name}.ours.json"),
            serde_json::to_string_pretty(&ours).unwrap(),
        );
        let _ = std::fs::write(
            format!("{dir}/{name}.theirs.json"),
            serde_json::to_string_pretty(&theirs).unwrap(),
        );
    }
    if let Some(difference) = compare(&run.events, &theirs) {
        problems.push(format!("events: {difference}"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

async fn check_flavor(flavor: &'static Flavor) {
    let expected = expected_failures(flavor.driver);
    let mut report = Vec::new();
    let mut unexpected = Vec::new();
    for name in fixtures(flavor.driver) {
        let outcome = check_fixture(flavor, &name).await;
        let listed = expected.contains_key(&name);
        match (&outcome, listed) {
            (Ok(()), false) => report.push(format!("pass {name}")),
            (Err(_), true) => report.push(format!("expected failure {name}")),
            (Ok(()), true) => unexpected.push(format!(
                "{name} passes now: take it off expected-failures.txt"
            )),
            (Err(why), false) => unexpected.push(format!("{name} fails:\n{why}")),
        }
    }
    for name in expected.keys() {
        if !fixtures(flavor.driver).contains(name) {
            unexpected.push(format!("{name} is listed but has no golden file"));
        }
    }
    eprintln!("{}", report.join("\n"));
    assert!(unexpected.is_empty(), "{}", unexpected.join("\n\n"));
}

#[tokio::test(flavor = "current_thread")]
async fn grok_transcripts_replay_as_in_t3() {
    check_flavor(&crate::flavor::GROK).await;
}

/// One fixture with its full report: `ACP_FIXTURE=simple cargo test -p conn-provider-acp one_fixture -- --nocapture`.
#[tokio::test(flavor = "current_thread")]
async fn one_fixture() {
    let Ok(name) = std::env::var("ACP_FIXTURE") else {
        return;
    };
    let flavor = &crate::flavor::GROK;
    match check_fixture(flavor, &name).await {
        Ok(()) => eprintln!("{name}: pass"),
        Err(why) => panic!("{name}:\n{why}"),
    }
}

/// 200 turns, each with streamed text, a tool call and an approval, through one session: no
/// turn, request, pending reply or tool state is left behind.
#[tokio::test(flavor = "current_thread")]
async fn state_stays_bounded_over_many_turns() {
    let golden = read_golden("grok", "tool_call_read_only_on_request");
    let entries = golden["transcripts"][0].as_array().cloned().unwrap();
    // The handshake from the recording, then one scripted turn per round.
    let prompt_at = entries
        .iter()
        .position(|e| e["frame"]["method"] == "session/prompt")
        .unwrap();
    let mut script: Vec<Value> = entries[..prompt_at].to_vec();
    let session = "00000000-0000-4000-8000-000000000001";
    let rounds = 200;
    for round in 1..=rounds {
        let update = |u: Value| json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update", "params": {"sessionId": session, "update": u}}});
        script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/prompt", "params": "<any>"}}));
        script.push(update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})));
        script.push(update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("turn {round}")}})));
        script.push(update(json!({"sessionUpdate": "tool_call", "toolCallId": format!("t{round}"), "title": "Write", "kind": "edit", "rawInput": {"file_path": "/w/a"}})));
        script.push(json!({"type": "emit_inbound", "frame": {"kind": "request", "method": "session/request_permission", "params": {"sessionId": session, "toolCall": {"toolCallId": format!("t{round}"), "kind": "edit"}, "options": [{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"}]}}}));
        script.push(json!({"type": "expect_outbound", "frame": {"kind": "response", "method": "session/request_permission", "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}}}));
        script.push(update(json!({"sessionUpdate": "tool_call_update", "toolCallId": format!("t{round}"), "status": "completed"})));
        script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/prompt", "result": {"stopReason": "end_turn"}}}));
    }
    script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/close", "params": {"sessionId": session}}}));
    script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/close", "result": {}}}));
    let open = golden["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["method"] == "openSession")
        .unwrap()
        .clone();
    let start = golden["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["method"] == "startTurn")
        .unwrap()
        .clone();
    let mut calls = vec![
        open,
        golden["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == "ensureThread")
            .unwrap()
            .clone(),
    ];
    for round in 1..=rounds {
        let mut turn = start.clone();
        turn["input"]["providerTurnOrdinal"] = json!(round);
        turn["input"]["runOrdinal"] = json!(round);
        turn["input"]["runtimePolicy"] =
            json!({"runtimeMode": "approval-required", "interactionMode": "default", "cwd": "/w"});
        calls.push(turn);
        calls.push(json!({"method": "respondToRuntimeRequest", "input": {"decision": "accept"}}));
    }
    calls.push(json!({"method": "close"}));
    let golden = json!({"calls": calls, "transcripts": [script], "events": []});
    let run = replay(&crate::flavor::GROK, &golden).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(
        script.complete(),
        "stopped at {}: {:?}",
        script.cursor,
        script.failure
    );
    let terminals = run
        .events
        .iter()
        .filter(|e| e["type"] == "turn.terminal")
        .count();
    assert_eq!(terminals, rounds, "every turn ended");
}
