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
    "subagent",
    "subagent_continue",
    "subagent_v2",
    "subagent_v2_approval",
    "subagent_v2_nested",
    "subagent_v2_nested_approval",
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
                // One mapper sees every frame here; the TS test kit answers child reads
                // itself (`withCodexReplayChildMetadata`) with no model.
                Out::ChildMetadata(_)
                | Out::InterruptChild { .. }
                | Out::InterruptAbandoned { .. } => {}
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
        native_thread_has_turns: None,
        restart_continuation_of_run_id: None,
        app_context: vec![],
        app_thread: from_json(v["appThread"].clone()).unwrap(),
        thread_id: from_json(v["threadId"].clone()).unwrap(),
        run_id: from_json(v["runId"].clone()).unwrap(),
        run_ordinal: v["runOrdinal"].as_u64().unwrap() as u32,
        provider_turn_ordinal: v["providerTurnOrdinal"].as_u64().unwrap() as u32,
        attempt_id: from_json(v["attemptId"].clone()).unwrap(),
        root_node_id: from_json(v["rootNodeId"].clone()).unwrap(),
        provider_thread: from_json(v["providerThread"].clone()).unwrap(),
        message: conn_provider::TurnMessage::user(
            from_json(v["message"]["messageId"].clone()).unwrap(),
            v["message"]["text"].as_str().unwrap().into(),
            vec![],
        ),
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
        // A subagent each round (it runs a turn and ends), and a child turn of a thread no
        // frame ever names.
        let child = format!("child{round}");
        let child_frames = [
            json!({"method": "item/started", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "subAgentActivity", "id": format!("a{round}"), "kind": "started",
                    "agentThreadId": child, "agentPath": "/root/x"}}}),
            json!({"method": "turn/started", "params": {"threadId": child,
                "turn": {"id": format!("ct{round}"), "status": "inProgress", "startedAt": 1}}}),
            json!({"method": "turn/completed", "params": {"threadId": child,
                "turn": {"id": format!("ct{round}"), "status": "completed", "completedAt": 2}}}),
            json!({"method": "item/completed", "params": {"threadId": "th", "turnId": turn,
                "item": {"type": "subAgentActivity", "id": format!("d{round}"), "kind": "completed",
                    "agentThreadId": child, "agentPath": "/root/x"}}}),
            json!({"method": "turn/started", "params": {"threadId": format!("stray{round}"),
                "turn": {"id": format!("st{round}"), "status": "inProgress", "startedAt": 1}}}),
        ];
        for frame in child_frames {
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
    // Tables keyed by native thread hold the root thread and at most 64 subagents' threads.
    for (name, size) in &sizes[1] {
        assert!(*size <= 65, "{name} holds {size} entries");
    }
    let subagents = sizes[1].iter().find(|(name, _)| *name == "subagents");
    assert_eq!(
        subagents.map(|(_, n)| *n),
        Some(64),
        "settled subagents are forgotten at 64"
    );
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

/// An MCP elicitation is an approval with the app's name and its persistence choices; the
/// answer goes back as the form's option (`CodexMcpElicitation.ts`). One an approval cannot
/// answer is cancelled at once.
#[test]
fn an_mcp_elicitation_is_an_approval_answered_with_the_forms_option() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let mut ts: Value =
        serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    // Full access answers by itself (below); this turn asks.
    ts["startTurn"][0]["runtimePolicy"]["runtimeMode"] = json!("auto-accept-edits");
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    let reply_of = |outs: &[Out]| -> Option<Value> {
        outs.iter().find_map(|o| match o {
            Out::Write(line) => serde_json::from_str(line).ok(),
            _ => None,
        })
    };

    let url = json!({"method": "mcpServer/elicitation/request", "id": 3, "params": {
        "threadId": "th", "turnId": "tu", "serverName": "s", "mode": "url",
        "message": "Sign in", "elicitationId": "e1", "url": "https://example.com"}});
    let outs = mapper.handle(Inbound::from_value(url));
    assert_eq!(
        reply_of(&outs).unwrap(),
        json!({"id": 3, "result": {"action": "cancel"}})
    );

    let form = json!({"method": "mcpServer/elicitation/request", "id": 4, "params": {
        "threadId": "th", "turnId": "tu", "serverName": "computer-use", "mode": "form",
        "message": "Allow ChatGPT to use Safari?",
        "_meta": {"persist": ["session"]},
        "requestedSchema": {"type": "object", "properties": {"approval": {"type": "string",
            "enum": ["once", "session"]}}, "required": ["approval"]}}});
    let outs = mapper.handle(Inbound::from_value(form));
    assert!(reply_of(&outs).is_none(), "waits for the user");
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
    let item = event("turn_item.updated", "turnItem");
    assert_eq!(item["requestKind"], "mcp-elicitation");
    assert_eq!(item["appName"], "Safari");
    assert_eq!(item["prompt"], "Allow ChatGPT to use Safari?");
    let decisions: Vec<&str> = item["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["decision"].as_str().unwrap())
        .collect();
    assert_eq!(
        decisions,
        ["cancel", "decline", "acceptForSession", "accept"]
    );
    let request = event("runtime_request.updated", "runtimeRequest");
    assert_eq!(
        request["nativeRequestRef"]["nativeId"],
        "mcp-elicitation:computer-use"
    );
    let answer = RuntimeRequestResponse {
        request_id: request["id"].as_str().unwrap().into(),
        decision: from_json(json!("acceptForSession")).ok(),
        feedback: None,
        answers: None,
    };
    let outs = mapper.respond(&answer).unwrap();
    assert_eq!(
        reply_of(&outs).unwrap(),
        json!({"id": 4, "result": {"action": "accept", "_meta": {"persist": "session"},
            "content": {"approval": "session"}}})
    );
}

/// In full access T3 accepts an MCP access prompt without asking (`never` would have rejected
/// it before the client saw it), also one whose turn id is null: it finds the thread's turn.
#[test]
fn full_access_accepts_an_mcp_access_prompt_without_asking() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    for (id, turn) in [(5, json!("tu")), (6, Value::Null)] {
        let prompt = json!({"method": "mcpServer/elicitation/request", "id": id, "params": {
            "threadId": "th", "turnId": turn, "serverName": "browser", "mode": "form",
            "message": "Allow ChatGPT to use Google Chrome?",
            "requestedSchema": {"type": "object", "properties": {"approval": {"type": "string",
                "enum": ["once", "always"]}}, "required": ["approval"]}}});
        let outs = mapper.handle(Inbound::from_value(prompt));
        let reply: Value = outs
            .iter()
            .find_map(|o| match o {
                Out::Write(line) => serde_json::from_str(line).ok(),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            reply,
            json!({"id": id, "result": {"action": "accept", "content": {"approval": "once"}}})
        );
        assert!(
            !outs.iter().any(|o| matches!(o, Out::Event(_))),
            "no prompt"
        );
    }
}

/// T3's Codex adapter never reports a broken thread: every `turn.terminal` it emits says
/// `reusable`, a crash of the app-server included, so the engine never writes the provider
/// thread's `error` status for Codex (`finalProviderThreadStatus`).
#[test]
fn every_codex_turn_end_leaves_the_thread_reusable() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    let input = turn_input(&ts["startTurn"][0]);
    let terminals = |outs: Vec<Out>| -> Vec<Value> {
        outs.into_iter()
            .filter_map(|o| match o {
                Out::Event(e) => Some(serde_json::to_value(e).unwrap()),
                _ => None,
            })
            .filter(|v| v["type"] == "turn.terminal")
            .collect()
    };
    let mut seen = Vec::new();
    for status in ["completed", "interrupted", "failed"] {
        let mut mapper = Mapper::new(FixedEnv::default());
        mapper.begin_turn("th", &input);
        let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
        let done = json!({"method": "turn/completed", "params": {"threadId": "th",
            "turn": {"id": "tu", "status": status, "completedAt": 3}}});
        seen.extend(terminals(mapper.handle(Inbound::from_value(done))));
    }
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn("th", &input);
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    seen.extend(terminals(
        mapper.on_exit(false, "The Codex app-server exited unexpectedly."),
    ));
    assert_eq!(seen.len(), 4);
    for terminal in seen {
        assert_eq!(terminal["threadDisposition"], "reusable", "{terminal}");
    }
}

/// The `continuation.requested` events among `outs`.
fn wakes(outs: &[Out]) -> Vec<Value> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Event(e) => Some(serde_json::to_value(e).unwrap()),
            _ => None,
        })
        .filter(|e| e["type"] == "continuation.requested")
        .collect()
}

fn feed(mapper: &mut Mapper<FixedEnv>, frames: &[Value]) -> Vec<Out> {
    frames
        .iter()
        .flat_map(|f| mapper.handle(Inbound::from_value(f.clone())))
        .collect()
}

/// A root turn on `th` with command `c1` running.
fn turn_with_command(mapper: &mut Mapper<FixedEnv>) {
    let dir = env!("CARGO_MANIFEST_DIR");
    let ts: Value = serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
    mapper.begin_turn("th", &turn_input(&ts["startTurn"][0]));
    let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
    let _ = feed(
        mapper,
        &[
            json!({"method": "item/started", "params": {"threadId": "th", "turnId": "tu",
            "item": {"type": "commandExecution", "id": "c1", "command": "npm test", "processId": "9", "status": "inProgress"}}}),
        ],
    );
}

/// `codexBackgroundCommandDetail` and the command wake: a command that ends after its
/// completed turn shows its late output and end, and asks for one continuation turn.
#[test]
fn a_command_that_ends_after_its_turn_wakes_the_agent_once() {
    let mut mapper = Mapper::new(FixedEnv::default());
    turn_with_command(&mut mapper);
    let outs = feed(
        &mut mapper,
        &[
            json!({"method": "turn/completed", "params": {"threadId": "th",
            "turn": {"id": "tu", "status": "completed", "completedAt": 3}}}),
        ],
    );
    assert!(wakes(&outs).is_empty(), "no wake while the command runs");
    let late = [
        json!({"method": "item/commandExecution/outputDelta", "params": {"threadId": "th", "turnId": "tu",
            "itemId": "c1", "delta": "boom\n"}}),
        json!({"method": "item/completed", "params": {"threadId": "th", "turnId": "tu",
            "item": {"type": "commandExecution", "id": "c1", "command": "npm test", "status": "failed",
                "exitCode": 1, "aggregatedOutput": "boom\n"}}}),
    ];
    let outs = feed(&mut mapper, &late);
    let kinds: Vec<String> = outs
        .iter()
        .filter_map(|o| match o {
            Out::Event(e) => Some(
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()?
                    .to_owned(),
            ),
            _ => None,
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "command_output.delta",
            "node.updated",
            "turn_item.updated",
            "continuation.requested"
        ]
    );
    let wake = &wakes(&outs)[0];
    assert_eq!(
        wake["detail"],
        "Background command completed (exit 1): npm test\n\nOutput tail:\nboom"
    );
    assert_eq!(wake["delivery"], "message_text");
    assert_eq!(
        wake["notification"],
        json!({"source": {"kind": "command"}, "outcome": "failed",
            "summary": "Command \"npm test\" failed (exit 1)", "detail": "npm test"})
    );
    // Its turn is gone: a repeated end shows nothing and asks for nothing.
    assert!(feed(&mut mapper, &late[1..]).is_empty());
    assert!(mapper.state_sizes().contains(&("settled", 0)));
}

/// A stopped turn's commands end with it (`terminalizeRunningCommandItems`); no wake.
#[test]
fn a_stopped_turns_command_asks_for_no_wake() {
    let mut mapper = Mapper::new(FixedEnv::default());
    turn_with_command(&mut mapper);
    let outs = feed(
        &mut mapper,
        &[
            json!({"method": "turn/completed", "params": {"threadId": "th",
                "turn": {"id": "tu", "status": "interrupted", "completedAt": 3}}}),
            json!({"method": "item/completed", "params": {"threadId": "th", "turnId": "tu",
                "item": {"type": "commandExecution", "id": "c1", "command": "npm test", "status": "completed", "exitCode": 0}}}),
        ],
    );
    assert!(wakes(&outs).is_empty());
    assert!(mapper.state_sizes().contains(&("settled", 0)));
}

/// `thread/closed`: a settled turn's running commands end as interrupted, with no wake.
#[test]
fn a_closed_thread_ends_a_settled_turns_commands() {
    let mut mapper = Mapper::new(FixedEnv::default());
    turn_with_command(&mut mapper);
    let outs = feed(
        &mut mapper,
        &[
            json!({"method": "turn/completed", "params": {"threadId": "th",
                "turn": {"id": "tu", "status": "completed", "completedAt": 3}}}),
            json!({"method": "thread/closed", "params": {"threadId": "th"}}),
        ],
    );
    assert!(wakes(&outs).is_empty());
    let row = outs
        .iter()
        .filter_map(|o| match o {
            Out::Event(e) => Some(serde_json::to_value(e).unwrap()),
            _ => None,
        })
        .find(|e| e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "command_execution")
        .expect("the command row ends");
    assert_eq!(row["turnItem"]["status"], "interrupted");
    assert!(mapper.state_sizes().contains(&("settled", 0)));
}

/// A subagent that ends while its root turn still runs asks for no wake: the root turn gets
/// the result itself. Nor does one whose root turn was stopped.
#[test]
fn a_subagent_wakes_its_parent_only_after_a_completed_root_turn() {
    for (root_end_first, root_status, wake) in [
        (false, "completed", false),
        (true, "interrupted", false),
        (true, "completed", true),
    ] {
        let mut mapper = Mapper::new(FixedEnv::default());
        let dir = env!("CARGO_MANIFEST_DIR");
        let ts: Value =
            serde_json::from_str(&read(format!("{dir}/testdata/ts/simple.json"))).unwrap();
        mapper.begin_turn("th", &turn_input(&ts["startTurn"][0]));
        let _ = mapper.turn_start_result("th", &json!({"turn": {"id": "tu", "startedAt": null}}));
        let _ = feed(
            &mut mapper,
            &[
                json!({"method": "item/started", "params": {"threadId": "th", "turnId": "tu",
                    "item": {"type": "subAgentActivity", "id": "a1", "kind": "started",
                        "agentThreadId": "child", "agentPath": "/root/helper"}}}),
                json!({"method": "turn/started", "params": {"threadId": "child",
                    "turn": {"id": "ct", "status": "inProgress", "startedAt": 1}}}),
            ],
        );
        let root_end = json!({"method": "turn/completed", "params": {"threadId": "th",
            "turn": {"id": "tu", "status": root_status, "completedAt": 3}}});
        let child_end = json!({"method": "turn/completed", "params": {"threadId": "child",
            "turn": {"id": "ct", "status": "completed", "completedAt": 4}}});
        let frames = if root_end_first {
            vec![root_end, child_end]
        } else {
            vec![child_end, root_end]
        };
        let found = wakes(&feed(&mut mapper, &frames));
        assert_eq!(
            found.len(),
            usize::from(wake),
            "{root_end_first} {root_status}: {found:?}"
        );
        if wake {
            assert_eq!(found[0]["detail"], "Subagent completed: /root/helper");
            assert_eq!(
                found[0]["notification"]["summary"],
                "Subagent \"/root/helper\" finished"
            );
            assert_eq!(found[0]["delivery"], "message_text");
        }
    }
}

#[test]
fn deferred_mcp_app_uses_t3s_failed_cli_result() {
    let recording: Value = serde_json::from_str(include_str!("../testdata/mcp-app.json")).unwrap();
    let saved: Value = serde_json::from_str(include_str!("../testdata/ts/simple.json")).unwrap();
    let input = turn_input(&saved["startTurn"][0]);
    let entries = recording["transcript"]["entries"].as_array().unwrap();
    let native = entries
        .iter()
        .find(|entry| entry["frame"]["method"] == "turn/start")
        .unwrap()["frame"]["params"]["threadId"]
        .as_str()
        .unwrap();
    let mut mapper = Mapper::new(FixedEnv::default());
    mapper.begin_turn(native, &input);
    let mut captures = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| entry["type"] == "emit_inbound" && entry["frame"]["method"].is_string())
    {
        for output in mapper.handle(Inbound::from_value(entry["frame"].clone())) {
            if let Out::Event(conn_provider::ProviderEvent::McpAppCapture { turn_item, source }) =
                output
            {
                captures.push((turn_item, source));
            }
        }
    }
    assert_eq!(
        captures.len(),
        1,
        "the recorded failed result still requests App capture"
    );
    let (item, source) = &captures[0];
    let item = conn_contract::to_json(item);
    assert_eq!(item["status"], "failed");
    assert_eq!(source.resource_uri, "ui://weather/dashboard");
    assert_eq!(
        item["output"]["structuredContent"],
        recording["result"]["structuredContent"]
    );
}
