//! Recorded app-server traffic through the mapper, compared with what `CodexAdapterV2` (TS)
//! emitted for the same recording. No CLI, no network.
//!
//! `testdata/cli/*.ndjson` are the TS test kit's Codex recordings
//! (`apps/server/src/orchestration-v2/testkit/fixtures/<name>/codex_transcript.ndjson`).
//! `testdata/ts/*.json` hold the `startTurn` and `respondToRuntimeRequest` inputs and the
//! `ProviderAdapterV2Event`s the TS adapter produced when the fixture runner replayed the same
//! recording (`CodexReplayFixtures.integration.test.ts`, with the adapter's event stream and
//! calls tapped).
//!
//! The replay drives the mapper from the recording: an outbound `turn/start` begins the next
//! turn, its response registers it, an outbound `turn/interrupt` marks it, an outbound reply
//! answers the newest pending request with the decision TS was given, and every inbound frame
//! goes to the mapper. Outbound replies must equal the recorded frames.
//!
//! Normalized before comparing, both sides decoded through the contract types first:
//! - timestamps the TS harness took from a clock (its TestClock at the epoch, or wall-clock
//!   time on the capture day) become `<now>`; timestamps from Codex stay
//! - the random uuid at the end of runtime request and plan ids becomes `<uuid>`
//! - `completionWake` is dropped: Conn Server offers no background continuation

use conn_contract::from_json;
use conn_provider::{RuntimeRequestResponse, TurnInput};
use conn_provider_support::ids::FixedEnv;
use serde_json::{Value, json};

use crate::mapper::{Mapper, Out};
use crate::protocol::Inbound;

pub(crate) const FIXTURES: &[&str] = &[
    "simple",
    "multi_turn",
    "codex_model_reroute",
    "queued_turn",
    "message_steering",
    "turn_interrupt",
    "turn_interrupt_mid_tool",
    "command_output_streaming",
    "tool_call_workspace_never",
    "tool_call_read_only_on_request",
    "tool_call_restricted_granular",
    "web_search",
    "todo_list",
    "plan_questions",
    "proposed_plan",
];

fn read(path: String) -> String {
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

pub(crate) struct Replay {
    pub events: Vec<Value>,
    pub skipped: Vec<String>,
}

pub(crate) fn replay(name: &str) -> (Replay, Vec<Value>, String) {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/{name}.json"))).unwrap();
    let transcript = read(format!("{dir}/testdata/cli/{name}.ndjson"));
    let mut mapper = Mapper::new(FixedEnv::default());
    let mut events = Vec::new();
    let mut skipped = Vec::new();
    let mut turn_inputs = ts["startTurn"].as_array().unwrap().iter();
    let mut responses = ts["respond"].as_array().unwrap().iter();
    // Request id of each outbound `turn/start` → native thread id.
    let mut turn_starts: Vec<(u64, String)> = Vec::new();
    let mut pending_requests: Vec<String> = Vec::new();

    let mut take = |outs: Vec<Out>, expected_write: Option<&Value>, pending: &mut Vec<String>| {
        for out in outs {
            match out {
                Out::Event(event) => {
                    let value = serde_json::to_value(&event).unwrap();
                    if value["type"] == "runtime_request.updated"
                        && value["runtimeRequest"]["status"] == "pending"
                    {
                        pending.push(value["runtimeRequest"]["id"].as_str().unwrap().into());
                    }
                    events.push(value);
                }
                Out::Write(line) => {
                    let line: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(Some(&line), expected_write, "{name}: reply differs");
                }
                Out::Skipped(kind) => skipped.push(kind),
            }
        }
    };

    for line in transcript.lines() {
        let entry: Value = serde_json::from_str(line).unwrap();
        let frame = &entry["frame"];
        match entry["type"].as_str().unwrap() {
            "expect_outbound" => match frame["method"].as_str() {
                Some("turn/start") => {
                    let thread = frame["params"]["threadId"].as_str().unwrap().to_owned();
                    let input: TurnInput = turn_input(turn_inputs.next().unwrap());
                    mapper.begin_turn(&thread, &input);
                    turn_starts.push((frame["id"].as_u64().unwrap(), thread));
                }
                Some("turn/interrupt") => {
                    mapper.mark_interrupting(frame["params"]["turnId"].as_str().unwrap())
                }
                Some(_) => {}
                None => {
                    let request_id = pending_requests.remove(0);
                    let recorded = responses.next().unwrap();
                    let response = RuntimeRequestResponse {
                        request_id: request_id.as_str().into(),
                        decision: from_json(recorded["decision"].clone()).ok(),
                        feedback: None,
                        answers: from_json(recorded["answers"].clone()).ok(),
                    };
                    let outs = mapper.respond(&response).unwrap();
                    take(outs, Some(frame), &mut pending_requests);
                }
            },
            "emit_inbound" => {
                let inbound = Inbound::from_value(frame.clone());
                match &inbound {
                    Inbound::Response {
                        id,
                        result: Ok(result),
                    } => {
                        if let Some(i) = turn_starts.iter().position(|(rid, _)| rid == id) {
                            let (_, thread) = turn_starts.remove(i);
                            let outs = mapper.turn_start_result(&thread, result);
                            take(outs, None, &mut pending_requests);
                        }
                    }
                    Inbound::Response { .. } => {}
                    _ => take(mapper.handle(inbound), None, &mut pending_requests),
                }
            }
            _ => {}
        }
    }
    let expected = ts["events"].as_array().unwrap().clone();
    let captured_on = ts["capturedOn"].as_str().unwrap_or("2026-11-13").to_owned();
    (Replay { events, skipped }, expected, captured_on)
}

/// The TS `startTurn` input as the trait's `TurnInput`.
fn turn_input(v: &Value) -> TurnInput {
    TurnInput {
        app_thread: from_json(v["appThread"].clone()).unwrap(),
        thread_id: from_json(v["threadId"].clone()).unwrap(),
        run_id: from_json(v["runId"].clone()).unwrap(),
        run_ordinal: v["runOrdinal"].as_u64().unwrap() as u32,
        provider_turn_ordinal: v["providerTurnOrdinal"].as_u64().unwrap() as u32,
        attempt_id: from_json(v["attemptId"].clone()).unwrap(),
        root_node_id: from_json(v["rootNodeId"].clone()).unwrap(),
        provider_thread: from_json(v["providerThread"].clone()).unwrap(),
        message: conn_provider::TurnMessage {
            message_id: from_json(v["message"]["messageId"].clone()).unwrap(),
            text: v["message"]["text"].as_str().unwrap().into(),
            attachments: vec![],
        },
        model_selection: from_json(v["modelSelection"].clone()).unwrap(),
        runtime_policy: from_json(v["runtimePolicy"].clone()).unwrap(),
    }
}

/// Both sides through the contract types, then the documented normalizations.
pub(crate) fn normalize(event: &Value, captured_on: &str) -> Value {
    let typed: conn_provider::ProviderEvent = serde_json::from_value(event.clone())
        .unwrap_or_else(|e| panic!("event does not decode: {e}\n{event}"));
    let mut value = serde_json::to_value(typed).unwrap();
    scrub(&mut value, captured_on);
    value
}

fn scrub(value: &mut Value, captured_on: &str) {
    match value {
        Value::Object(map) => {
            map.remove("completionWake");
            for (key, v) in map.iter_mut() {
                if let Value::String(s) = v {
                    if (key.ends_with("At") || key == "updatedAt")
                        && (s.starts_with("1970-") || s.starts_with(&format!("{captured_on}T")))
                    {
                        *s = "<now>".into();
                    } else if (s.starts_with("runtime-request:") || s.starts_with("plan:"))
                        && s.len() > 37
                    {
                        s.replace_range(s.len() - 36.., "<uuid>");
                    } else if s.starts_with("node:runtime-request:")
                        || s.starts_with("turn-item:runtime-request:")
                    {
                        // Derived ids encode the request id, uuid included.
                        if let Some(at) = s.rfind("%3A") {
                            s.replace_range(at + 3.., "<uuid>");
                        }
                    }
                }
                scrub(v, captured_on);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| scrub(v, captured_on)),
        _ => {}
    }
}

fn compare(name: &str) -> usize {
    let (replay, expected, captured_on) = replay(name);
    let ours: Vec<Value> = replay
        .events
        .iter()
        .map(|e| normalize(e, &captured_on))
        .collect();
    let theirs: Vec<Value> = expected
        .iter()
        .map(|e| normalize(e, &captured_on))
        .collect();
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        assert_eq!(a, b, "{name}: event {i} differs\nours:   {a}\ntheirs: {b}");
    }
    assert_eq!(
        ours.len(),
        theirs.len(),
        "{name}: {} events, TS emitted {}\nextra: {}",
        ours.len(),
        theirs.len(),
        json!(if ours.len() > theirs.len() {
            &ours[theirs.len()..]
        } else {
            &theirs[ours.len()..]
        })
    );
    ours.len()
}

#[test]
fn every_recording_matches_the_ts_adapter() {
    let mut report = Vec::new();
    for name in FIXTURES {
        let count = compare(name);
        let (replay, _, _) = replay(name);
        let mut skipped = replay.skipped;
        skipped.sort();
        skipped.dedup();
        report.push(format!("{name}: {count} events, skipped {skipped:?}"));
    }
    eprintln!("{}", report.join("\n"));
}

#[test]
fn replies_carry_the_users_answers() {
    let (replay, _, _) = replay("plan_questions");
    assert!(
        replay
            .events
            .iter()
            .any(|e| e["type"] == "runtime_request.updated"
                && e["runtimeRequest"]["kind"] == "user_input")
    );
}

#[test]
fn a_frame_that_beats_the_turn_start_answer_registers_the_turn() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let completed = json!({"method": "turn/completed", "params": {"threadId": "th",
        "turn": {"id": "tu", "status": "completed", "completedAt": 3}}});
    let outs = mapper.handle(Inbound::from_value(completed));
    let kinds: Vec<Value> = outs
        .iter()
        .filter_map(|o| match o {
            Out::Event(e) => Some(serde_json::to_value(e).unwrap()["type"].clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        kinds,
        [
            json!("provider_turn.updated"),
            json!("provider_turn.updated"),
            json!("turn.terminal")
        ]
    );
    // The late answer then changes nothing.
    assert!(
        mapper
            .turn_start_result("th", &json!({"turn": {"id": "tu"}}))
            .is_empty()
    );
}

#[test]
fn a_resumed_threads_old_token_usage_does_not_bind_the_new_turn() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let stale = json!({"method": "thread/tokenUsage/updated", "params": {"threadId": "th",
        "turnId": "old", "tokenUsage": {"total": {"totalTokens": 5}, "last": {"totalTokens": 5}}}});
    assert!(mapper.handle(Inbound::from_value(stale)).is_empty());
    let outs = mapper.turn_start_result("th", &json!({"turn": {"id": "new", "startedAt": null}}));
    assert!(!outs.is_empty());
    assert_eq!(mapper.native_turn(&ids_for(&outs)), Some("new".to_owned()));
}

/// The provider turn id of the first `provider_turn.updated` in `outs`.
fn ids_for(outs: &[Out]) -> String {
    outs.iter()
        .find_map(|o| match o {
            Out::Event(e) => serde_json::to_value(e).unwrap()["providerTurn"]["id"]
                .as_str()
                .map(str::to_owned),
            _ => None,
        })
        .unwrap()
}

#[test]
fn a_request_codex_resolved_itself_gets_no_late_answer() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    let request = json!({"method": "item/commandExecution/requestApproval", "id": 0,
        "params": {"threadId": "th", "turnId": "tu", "itemId": "c1", "command": "ls"}});
    let outs = mapper.handle(Inbound::from_value(request));
    let id = outs
        .iter()
        .find_map(|o| match o {
            Out::Event(e) => {
                let v = serde_json::to_value(e).unwrap();
                (v["type"] == "runtime_request.updated")
                    .then(|| v["runtimeRequest"]["id"].as_str().unwrap().to_owned())
            }
            _ => None,
        })
        .unwrap();
    let resolved =
        json!({"method": "serverRequest/resolved", "params": {"threadId": "th", "requestId": 0}});
    mapper.handle(Inbound::from_value(resolved));
    let answer = RuntimeRequestResponse {
        request_id: id.as_str().into(),
        decision: from_json(json!("accept")).ok(),
        feedback: None,
        answers: None,
    };
    assert!(mapper.respond(&answer).is_err());
}

/// A question with an empty id shows as `question-<n>`; the answer goes back under Codex's own
/// id (`nativeQuestionIds` in T3's CodexAdapterV2). A padded id shows trimmed.
#[test]
fn answers_go_back_under_codexs_own_question_ids() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    let request = json!({"method": "item/tool/requestUserInput", "id": 7,
        "params": {"threadId": "th", "turnId": "tu", "itemId": "q", "questions": [
            {"id": "", "header": "H", "question": "Q1", "options": []},
            {"id": " pad ", "header": "H", "question": "Q2", "options": []},
            {"id": "plain", "header": "H", "question": "Q3", "options": []}]}});
    let outs = mapper.handle(Inbound::from_value(request));
    let event = |kind: &str, key: &str| {
        outs.iter()
            .find_map(|o| match o {
                Out::Event(e) => {
                    let v = serde_json::to_value(e).unwrap();
                    (v["type"] == kind).then(|| v[key].clone())
                }
                _ => None,
            })
            .unwrap()
    };
    let request = event("runtime_request.updated", "runtimeRequest");
    let item = event("turn_item.updated", "turnItem");
    let shown: Vec<&str> = item["questions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| q["id"].as_str().unwrap())
        .collect();
    assert_eq!(shown, ["question-1", "pad", "plain"], "ids the client sees");
    let answer = RuntimeRequestResponse {
        request_id: request["id"].as_str().unwrap().into(),
        decision: None,
        feedback: None,
        answers: from_json(json!({"question-1": "a", "pad": "b", "plain": "c", "other": "d"})).ok(),
    };
    let outs = mapper.respond(&answer).unwrap();
    let reply: Value = outs
        .iter()
        .find_map(|o| match o {
            Out::Write(line) => serde_json::from_str(line).ok(),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        reply["result"]["answers"],
        json!({"": {"answers": ["a"]}, " pad ": {"answers": ["b"]}, "plain": {"answers": ["c"]}}),
        "answers keyed by Codex's ids; unknown ids dropped"
    );
}

/// Hundreds of turns of every kind leave the mapper's collections at a fixed size: messages,
/// reasoning, plans, commands, approvals, usage, interrupts and failures.
#[test]
fn mapper_state_stays_bounded_over_many_turns() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    let mut sizes = Vec::new();
    for round in 0..300 {
        let turn = format!("tu{round}");
        mapper.begin_turn("th", &input);
        let _ = mapper.turn_start_result("th", &json!({"turn": {"id": turn, "startedAt": null}}));
        let frames = [
            json!({"method": "item/started", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "agentMessage", "id": format!("m{round}"), "text": "", "phase": "final_answer"}}}),
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "th", "turnId": turn,
                "itemId": format!("m{round}"), "delta": "hi"}}),
            json!({"method": "item/reasoning/summaryTextDelta", "params": {"threadId": "th", "turnId": turn,
                "itemId": format!("r{round}"), "delta": "think", "summaryIndex": 0}}),
            json!({"method": "item/plan/delta", "params": {"threadId": "th", "turnId": turn,
                "itemId": format!("p{round}"), "delta": "plan"}}),
            json!({"method": "item/started", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "commandExecution", "id": format!("c{round}"), "command": "ls", "processId": "9", "status": "inProgress"}}}),
            json!({"method": "item/commandExecution/requestApproval", "id": round,
                "params": {"threadId": "th", "turnId": turn, "itemId": format!("c{round}"), "command": "ls"}}),
            json!({"method": "serverRequest/resolved", "params": {"threadId": "th", "requestId": round}}),
            json!({"method": "thread/tokenUsage/updated", "params": {"threadId": "th", "turnId": turn,
                "tokenUsage": {"total": {"totalTokens": round}, "last": {"totalTokens": 1}}}}),
            json!({"method": "model/rerouted", "params": {"threadId": "th", "turnId": turn, "toModel": "x"}}),
            json!({"method": "item/completed", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "agentMessage", "id": format!("m{round}"), "text": "hi", "phase": "final_answer"}}}),
            json!({"method": "item/completed", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "plan", "id": format!("p{round}"), "text": "plan"}}}),
        ];
        for frame in frames {
            let _ = mapper.handle(Inbound::from_value(frame));
        }
        let _ = mapper.flush(true);
        if round % 3 == 0 {
            mapper.mark_interrupting(&turn);
        }
        let status = ["completed", "interrupted", "failed"][round % 3];
        let done = json!({"method": "turn/completed", "params": {"threadId": "th",
            "turn": {"id": turn, "status": status, "completedAt": 3}}});
        let _ = mapper.handle(Inbound::from_value(done));
        if round == 100 || round == 299 {
            sizes.push(mapper.state_sizes());
        }
    }
    assert_eq!(
        sizes[0], sizes[1],
        "mapper state grew between turn 100 and 300"
    );
    for (name, size) in &sizes[1] {
        assert!(*size <= 64, "{name} holds {size} entries");
    }
}

#[test]
fn a_failed_turns_text_loses_its_secrets() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    let done = json!({"method": "turn/completed", "params": {"threadId": "th", "turn": {"id": "tu",
        "status": "failed", "completedAt": 3,
        "error": {"message": "401 from https://u:p@api.test/v1?key=abc: Authorization: Bearer sk-abcdefghijklmnopqrst"}}}});
    let outs = mapper.handle(Inbound::from_value(done));
    let terminal = outs
        .iter()
        .find_map(|o| match o {
            Out::Event(e) => {
                let v = serde_json::to_value(e).unwrap();
                (v["type"] == "turn.terminal").then_some(v)
            }
            _ => None,
        })
        .unwrap();
    let message = terminal["failure"]["message"].as_str().unwrap();
    assert!(message.contains("https://api.test/v1"), "{message}");
    for secret in ["u:p", "key=abc", "sk-abcdefghijklmnopqrst"] {
        assert!(!message.contains(secret), "{secret} in {message}");
    }
}
