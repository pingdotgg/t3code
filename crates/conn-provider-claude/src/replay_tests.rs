//! Recorded CLI output through the mapper, compared with what `ClaudeAdapterV2` (TS) emitted for
//! the same lines. Runs without the CLI and without network.
//!
//! The TS events were captured by feeding the same transcripts through the adapter's own test
//! harness (`makeWakeHarness` in `ClaudeAdapterV2.test.ts`, TestClock at epoch 0), with the
//! same thread, run, attempt and node ids used here.

use conn_contract::{from_json, to_json};
use conn_provider::{ProviderEvent, RuntimeRequestResponse, TurnInput, TurnMessage};
use serde_json::{Value, json};

use crate::DRIVER;
use crate::ids::{self, FixedEnv};
use crate::mapper::{Mapper, Out};
use crate::protocol::Inbound;
use crate::testdata;

const THREAD: &str = "thread-claude-wake";
const SESSION: &str = "provider-session-claude-wake";

struct Replay {
    events: Vec<Value>,
    writes: Vec<Value>,
    skipped: Vec<String>,
}

fn provider_thread(native: &str) -> Value {
    json!({
        "id": ids::provider_thread_id(DRIVER, native), "driver": "claudeAgent",
        "providerInstanceId": "claudeAgent", "providerSessionId": SESSION,
        "appThreadId": THREAD, "ownerNodeId": null,
        "nativeThreadRef": {"driver": "claudeAgent", "nativeId": native, "strength": "strong"},
        "nativeConversationHeadRef": null, "status": "idle", "firstRunOrdinal": null,
        "lastRunOrdinal": null, "handoffIds": [], "forkedFrom": null,
        "createdAt": "1970-01-01T00:00:00.000Z", "updatedAt": "1970-01-01T00:00:00.000Z",
    })
}

fn turn_input(n: u32, thread: &Value, text: &str, runtime_mode: &str) -> TurnInput {
    let attempt = format!("attempt-{n}");
    TurnInput {
        native_thread_has_turns: None,
        restart_continuation_of_run_id: None,
        app_context: vec![],
        app_thread: from_json(json!({
            "createdBy": "user", "creationSource": "web", "id": THREAD, "projectId": "project-thread-claude-wake",
            "title": "Claude attachment test", "providerInstanceId": "claudeAgent",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-sonnet-4-6"},
            "runtimeMode": runtime_mode, "interactionMode": "default", "branch": null,
            "worktreePath": null, "activeProviderThreadId": null,
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": THREAD},
            "forkedFrom": null, "createdAt": "1970-01-01T00:00:00.000Z",
            "updatedAt": "1970-01-01T00:00:00.000Z", "archivedAt": null,
        }))
        .unwrap(),
        thread_id: THREAD.into(),
        run_id: format!("run-{attempt}").as_str().into(),
        run_ordinal: 1,
        provider_turn_ordinal: n,
        attempt_id: attempt.as_str().into(),
        root_node_id: format!("node-{attempt}").as_str().into(),
        provider_thread: from_json(thread.clone()).unwrap(),
        message: TurnMessage {
            created_by: conn_contract::OrchestrationV2Actor::User,
            creation_source: conn_contract::OrchestrationV2CreationSource::Web,
            scheduled_task_id: None,
            sender_thread_id: None,
            message_id: format!("message-{attempt}").as_str().into(),
            text: text.into(),
            attachments: vec![],
        },
        model_selection: from_json(
            json!({"instanceId": "claudeAgent", "model": "claude-sonnet-4-6"}),
        )
        .unwrap(),
        runtime_policy: from_json(
            json!({"runtimeMode": runtime_mode, "interactionMode": "default", "cwd": "/workspace"}),
        )
        .unwrap(),
    }
}

fn replay(name: &str, runtime_mode: &str) -> Replay {
    let lines: Vec<Value> = testdata::cli(name)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let native = lines
        .iter()
        .find_map(|l| l["msg"]["session_id"].as_str().filter(|s| !s.is_empty()))
        .unwrap()
        .to_string();
    let mode = crate::launch::permission_mode_for(&crate::launch::PolicyInput {
        runtime_mode,
        interaction_mode: "default",
        ..Default::default()
    });
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let mut thread = provider_thread(&native);
    let mut replay = Replay {
        events: vec![],
        writes: vec![],
        skipped: vec![],
    };
    let mut turn = 0;
    for (i, line) in lines.iter().enumerate() {
        let msg = &line["msg"];
        let outs = match (
            line["dir"].as_str().unwrap(),
            msg["type"].as_str().unwrap_or(""),
        ) {
            ("out", "user") if msg["priority"] == "now" => {
                mapper.steer_sent(msg["uuid"].as_str().unwrap(), "message-steer-1")
            }
            ("out", "user") => {
                turn += 1;
                let content = &msg["message"]["content"];
                let text = content.as_str().unwrap_or_else(|| {
                    content
                        .as_array()
                        .unwrap()
                        .iter()
                        .find_map(|b| b["text"].as_str())
                        .unwrap()
                });
                mapper.begin_turn(&turn_input(turn, &thread, text, runtime_mode), mode)
            }
            ("out", "control_request") if msg["request"]["subtype"] == "interrupt" => {
                mapper.mark_interrupted();
                vec![]
            }
            ("in", "control_response") | ("out", _) => vec![],
            ("in", _) => {
                let mut outs = mapper.handle(Inbound::from_value(msg.clone()));
                // Answer each permission prompt as the recording did.
                let pending: Vec<String> = outs
                    .iter()
                    .filter_map(|o| match o {
                        Out::Event(ProviderEvent::RuntimeRequestUpdated {
                            runtime_request,
                            ..
                        }) => {
                            let r = to_json(runtime_request);
                            (r["status"] == "pending")
                                .then(|| r["id"].as_str().unwrap().to_string())
                        }
                        _ => None,
                    })
                    .collect();
                for request_id in pending {
                    let answer = lines[i..]
                        .iter()
                        .find(|l| l["dir"] == "out" && l["msg"]["type"] == "control_response")
                        .unwrap();
                    let allow = answer["msg"]["response"]["response"]["behavior"] == "allow";
                    let decision = if allow { "accept" } else { "decline" };
                    outs.extend(
                        mapper
                            .respond(&RuntimeRequestResponse {
                                request_id: request_id.as_str().into(),
                                decision: Some(from_json(json!(decision)).unwrap()),
                                feedback: None,
                                answers: None,
                            })
                            .unwrap(),
                    );
                }
                outs
            }
            _ => vec![],
        };
        // The engine answers a continuation request by starting the next turn.
        let mut outs = outs;
        if outs
            .iter()
            .any(|o| matches!(o, Out::Event(ProviderEvent::ContinuationRequested(_))))
        {
            turn += 1;
            let next =
                mapper.begin_continuation(&turn_input(turn, &thread, "", runtime_mode), mode);
            outs.extend(next);
        }
        for out in outs {
            match out {
                Out::Event(event) => {
                    let value = serde_json::to_value(&event).unwrap();
                    if value["type"] == "provider_thread.updated" {
                        thread = value["providerThread"].clone();
                    }
                    replay.events.push(value);
                }
                Out::Write(line) => replay.writes.push(serde_json::from_str(&line).unwrap()),
                Out::Skipped(kind) => replay.skipped.push(kind),
            }
        }
    }
    replay
}

/// Makes both sides comparable. Each rule is a known, accepted difference (see README):
/// - runtime request and plan ids end in a random uuid: renamed `REQ<n>` in order.
/// - `threadId: null` (Rust `Option`) vs an absent key (TS) on `provider_turn.updated`.
/// - TS-only fields: `nativeMetadata` (attachment budget), `goal`, `pendingBackgroundWork`,
///   `failureItemOrdinal`.
/// - TS emits `provider_turn.updated` again with unchanged usage after `message_delta`; equal
///   consecutive usage updates are folded.
/// - TS re-sends an unchanged provider thread when Claude's background-task roster changes
///   (`pendingBackgroundTasks`, which the trait does not carry): the field is dropped and a
///   thread equal to the last one sent is folded.
fn normalize(events: &[Value]) -> Vec<Value> {
    let mut text = serde_json::to_string(events).unwrap();
    let mut ids: Vec<String> = Vec::new();
    for event in events {
        if let Some(id) = event["runtimeRequest"]["id"].as_str()
            && !ids.iter().any(|x| x == id)
        {
            ids.push(id.to_string());
        }
    }
    for (n, id) in ids.iter().enumerate() {
        let alias = format!("REQ{}", n + 1);
        text = text.replace(&ids::encode_component(&ids::encode_component(id)), &alias);
        text = text.replace(&ids::encode_component(id), &alias);
        text = text.replace(id, &alias);
    }
    let mut out: Vec<Value> = Vec::new();
    for mut event in serde_json::from_str::<Vec<Value>>(&text).unwrap() {
        if event["type"] == "continuation.requested" {
            continue;
        }
        let obj = event.as_object_mut().unwrap();
        obj.remove("driver");
        obj.remove("pendingBackgroundWork");
        obj.remove("failureItemOrdinal");
        if obj.get("threadId") == Some(&Value::Null) {
            obj.remove("threadId");
        }
        if let Some(thread) = obj.get_mut("providerThread").and_then(Value::as_object_mut) {
            thread.remove("nativeMetadata");
            thread.remove("goal");
            thread.remove("pendingBackgroundTasks");
        }
        if event["type"] == "provider_turn.updated" && out.last() == Some(&event) {
            continue;
        }
        if event["type"] == "provider_thread.updated"
            && out.iter().rfind(|e| e["type"] == "provider_thread.updated") == Some(&event)
        {
            continue;
        }
        out.push(event);
    }
    out
}

fn ts_events(name: &str) -> Vec<Value> {
    let file: Value = serde_json::from_str(testdata::ts_events(name)).unwrap();
    file["events"].as_array().unwrap().clone()
}

fn assert_same(name: &str, runtime_mode: &str) -> Replay {
    let replay = replay(name, runtime_mode);
    let ours = normalize(&replay.events);
    let theirs = normalize(&ts_events(name));
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        assert_eq!(
            a,
            b,
            "{name}: event {i} differs\nrust: {}\nts:   {}",
            serde_json::to_string(a).unwrap(),
            serde_json::to_string(b).unwrap()
        );
    }
    assert_eq!(
        ours.len(),
        theirs.len(),
        "{name}: event count; rust types {:?}",
        ours.iter().map(|e| e["type"].clone()).collect::<Vec<_>>()
    );
    replay
}

#[test]
fn simple_turn_matches_the_ts_adapter() {
    let replay = assert_same("e01_turn", "full-access");
    let last = replay.events.last().unwrap();
    assert_eq!(last["type"], "turn.terminal");
    assert_eq!(last["status"], "completed");
    assert!(replay.writes.is_empty());
}

#[test]
fn permission_turn_matches_the_ts_adapter_and_answers_like_the_sdk() {
    let replay = assert_same("e06_permissions", "approval-required");
    let behaviors: Vec<_> = replay
        .writes
        .iter()
        .map(|w| w["response"]["response"]["behavior"].clone())
        .collect();
    assert_eq!(behaviors, [json!("deny"), json!("allow")]);
    let deny = &replay.writes[0]["response"];
    assert_eq!(deny["request_id"], "1e332ec6-7928-4b84-9d9a-45df17032778");
    assert_eq!(deny["response"]["message"], "User declined tool execution.");
    assert_eq!(
        deny["response"]["toolUseID"],
        "toolu_013vpcpsPLYmZnii5PpFCJBd"
    );
    let allow = &replay.writes[1]["response"]["response"];
    assert_eq!(allow["updatedInput"]["command"], "touch allowed.txt");
}

#[test]
fn interrupted_turn_then_next_turn_match_the_ts_adapter() {
    let replay = assert_same("e03_interrupt", "full-access");
    let statuses: Vec<_> = replay
        .events
        .iter()
        .filter(|e| e["type"] == "turn.terminal")
        .map(|e| e["status"].clone())
        .collect();
    assert_eq!(statuses, [json!("interrupted"), json!("completed")]);
}

#[test]
fn background_subagent_and_its_continuation_match_the_ts_adapter() {
    assert_same("e12_subagent", "full-access");
}

#[test]
fn foreground_subagent_matches_the_ts_adapter() {
    assert_same("e13_subagent_fg", "full-access");
}

#[test]
fn steer_matches_the_ts_adapter() {
    let replay = assert_same("e14_steer", "full-access");
    let steers: Vec<_> = replay
        .events
        .iter()
        .filter(|e| e["type"] == "steer.updated")
        .map(|e| e["status"].clone())
        .collect();
    assert_eq!(steers, [json!("pending"), json!("completed")]);
}

#[test]
fn image_turn_matches_the_ts_adapter() {
    assert_same("e15_image", "full-access");
}

#[test]
fn second_turn_matches_the_ts_adapter() {
    assert_same("e02_second_turn", "full-access");
}

#[test]
fn a_killed_cli_fails_the_turn_with_a_transport_error() {
    let lines: Vec<Value> = testdata::cli("e10_kill")
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let native = lines
        .iter()
        .find_map(|l| l["msg"]["session_id"].as_str().filter(|s| !s.is_empty()))
        .unwrap();
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let mut events = Vec::new();
    for line in &lines {
        let outs = match (line["dir"].as_str().unwrap(), line["msg"]["type"].as_str()) {
            ("out", Some("user")) => mapper.begin_turn(
                &turn_input(1, &provider_thread(native), "x", "full-access"),
                "bypassPermissions",
            ),
            ("in", Some(_)) => mapper.handle(Inbound::from_value(line["msg"].clone())),
            _ => vec![],
        };
        events.extend(outs);
    }
    // The recording ends at SIGKILL: stdout closed with no `result`.
    assert!(mapper.turn_active());
    events.extend(mapper.on_exit(false, "The Claude process exited unexpectedly (signal 9)."));
    let Some(Out::Event(ProviderEvent::TurnTerminal(terminal))) = events.last() else {
        panic!("expected a terminal")
    };
    let failure = to_json(terminal.failure.as_ref().unwrap());
    assert_eq!(failure["class"], "transport_error");
    assert_eq!(failure["code"], "claude_process_exited");
    assert!(!mapper.turn_active());
}

#[test]
fn every_recording_replays_without_skips_or_panics() {
    for (name, _) in testdata::cli_transcripts() {
        let replay = replay(name, "full-access");
        // An unknown --resume id: the CLI answers with one `result` before any turn exists.
        let expected: &[&str] = if name == "e09_resume_missing" {
            &["result (no active turn)"]
        } else {
            &[]
        };
        assert_eq!(replay.skipped, expected, "{name}");
    }
}

#[test]
fn ask_user_question_round_trip() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n1"), "ask", "full-access"),
        "bypassPermissions",
    );
    let input = json!({"questions": [{"question": "Pick one", "header": "Choice",
        "options": [{"label": "A", "description": "first"}, {"label": "B"}], "multiSelect": false}]});
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-1",
        "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input,
                    "tool_use_id": "toolu_q"},
    })));
    let request = outs
        .iter()
        .find_map(|o| match o {
            Out::Event(ProviderEvent::RuntimeRequestUpdated {
                runtime_request, ..
            }) => Some(to_json(runtime_request)),
            _ => None,
        })
        .unwrap();
    assert_eq!(request["kind"], "user_input");
    let item = outs
        .iter()
        .find_map(|o| match o {
            Out::Event(ProviderEvent::TurnItemUpdated { turn_item }) => Some(to_json(turn_item)),
            _ => None,
        })
        .unwrap();
    assert_eq!(item["type"], "user_input_request");
    assert_eq!(item["questions"][0]["options"][1]["description"], "B");
    let reply = mapper
        .respond(&RuntimeRequestResponse {
            request_id: request["id"].as_str().unwrap().into(),
            decision: None,
            feedback: None,
            answers: Some(from_json(json!({"Pick one": ["A", "B"]})).unwrap()),
        })
        .unwrap();
    let Out::Write(line) = &reply[0] else {
        panic!()
    };
    let reply: Value = serde_json::from_str(line).unwrap();
    assert_eq!(reply["response"]["request_id"], "cli-1");
    assert_eq!(reply["response"]["response"]["behavior"], "allow");
    assert_eq!(
        reply["response"]["response"]["updatedInput"]["answers"]["Pick one"],
        "A, B"
    );
}

#[test]
fn plan_dialog_and_withdrawn_requests() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n1"), "plan", "approval-required"),
        "default",
    );
    // ExitPlanMode: the plan is captured and the tool denied, as T3 does.
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-plan",
        "request": {"subtype": "can_use_tool", "tool_name": "ExitPlanMode",
                    "input": {"plan": "1. Do it"}, "tool_use_id": "toolu_plan"},
    })));
    let plan = outs.iter().find_map(|o| match o {
        Out::Event(ProviderEvent::PlanUpdated { plan }) => Some(to_json(plan)),
        _ => None,
    });
    assert_eq!(plan.unwrap()["markdown"], "1. Do it");
    let Some(Out::Write(deny)) = outs.last() else {
        panic!()
    };
    assert!(deny.contains("\"behavior\":\"deny\""));

    // A permission prompt the CLI withdraws is cancelled and still answered.
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-2",
        "request": {"subtype": "can_use_tool", "tool_name": "Write",
                    "input": {"file_path": "/x"}, "tool_use_id": "toolu_w"},
    })));
    assert!(
        outs.iter()
            .any(|o| matches!(o, Out::Event(ProviderEvent::RuntimeRequestUpdated { .. })))
    );
    let outs = mapper.handle(Inbound::from_value(
        json!({"type": "control_cancel_request", "request_id": "cli-2"}),
    ));
    let cancelled = outs.iter().find_map(|o| match o {
        Out::Event(ProviderEvent::RuntimeRequestUpdated {
            runtime_request, ..
        }) => Some(to_json(runtime_request)),
        _ => None,
    });
    assert_eq!(cancelled.unwrap()["status"], "cancelled");
    assert!(matches!(outs.last(), Some(Out::Write(w)) if w.contains("\"interrupt\":true")));

    // Elicitations with fields, and dialogs T3 does not show, are declined at once.
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-3",
        "request": {"subtype": "elicitation", "mcp_server_name": "s", "message": "token?",
                    "requested_schema": {"type": "object", "properties": {"t": {"type": "string"}}}},
    })));
    assert!(matches!(&outs[..], [Out::Write(w)] if w.contains("decline")));
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-4",
        "request": {"subtype": "request_user_dialog", "dialog_kind": "other_kind", "payload": {}},
    })));
    assert!(matches!(&outs[..], [Out::Write(w)] if w.contains("cancelled")));
    // A field-less elicitation becomes an approval card; Approve accepts it.
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-5",
        "request": {"subtype": "elicitation", "mcp_server_name": "s", "message": "Continue?",
                    "requested_schema": {"type": "object", "properties": {}}},
    })));
    let id = outs
        .iter()
        .find_map(|o| match o {
            Out::Event(ProviderEvent::RuntimeRequestUpdated {
                runtime_request, ..
            }) => to_json(runtime_request)["id"].as_str().map(str::to_string),
            _ => None,
        })
        .unwrap();
    let reply = mapper
        .respond(&RuntimeRequestResponse {
            request_id: id.as_str().into(),
            decision: Some(from_json(json!("accept")).unwrap()),
            feedback: None,
            answers: None,
        })
        .unwrap();
    assert!(matches!(&reply[..], [Out::Write(w)] if w.contains("\"action\":\"accept\"")));
    // The resume dialog T3 supports becomes a question.
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-6",
        "request": {"subtype": "request_user_dialog", "dialog_kind": "resume_return",
                    "payload": {"sessionAgeMinutes": 90, "estimatedTokens": 250000}},
    })));
    assert!(outs.iter().any(
        |o| matches!(o, Out::Event(ProviderEvent::TurnItemUpdated { turn_item })
        if to_json(turn_item)["type"] == "user_input_request")
    ));
}

#[test]
fn subagent_compaction_and_retry_frames_decode_without_failing() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n1"), "x", "full-access"),
        "bypassPermissions",
    );
    let frames = [
        json!({"type": "stream_event", "parent_tool_use_id": "toolu_agent",
               "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "sub"}}}),
        json!({"type": "assistant", "parent_tool_use_id": "toolu_agent", "uuid": "u1",
               "message": {"id": "m_sub", "model": "claude-haiku-5-5", "content": [{"type": "text", "text": "sub"}]}}),
        json!({"type": "system", "subtype": "task_started", "task_id": "t1", "tool_use_id": "toolu_agent"}),
        json!({"type": "system", "subtype": "status", "status": "compacting"}),
        json!({"type": "system", "subtype": "compact_boundary", "uuid": "c1",
               "compact_metadata": {"trigger": "auto", "pre_tokens": 190000, "post_tokens": 20000}}),
        json!({"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 10,
               "retry_delay_ms": 500, "error_status": 529, "error": "overloaded"}),
        json!({"type": "brand_new_kind"}),
    ];
    let mut kinds = Vec::new();
    for frame in frames {
        for out in mapper.handle(Inbound::from_value(frame)) {
            match out {
                Out::Event(event) => {
                    kinds.push(serde_json::to_value(&event).unwrap()["type"].clone())
                }
                Out::Skipped(kind) => kinds.push(json!(format!("skip:{kind}"))),
                Out::Write(_) => {}
            }
        }
    }
    assert_eq!(
        kinds,
        [
            // task_started opens the row and replays the child reply it held.
            "app_thread.created",
            "node.updated",
            "subagent.updated",
            "node.updated",
            "message.updated",
            "turn_item.updated",
            "turn_item.updated",
            "message.updated",
            "turn_item.updated",
            // compacting, then the boundary with its token count.
            "turn_item.updated",
            "provider_turn.updated",
            "turn_item.updated",
            // api_retry row.
            "turn_item.updated",
            "skip:brand_new_kind",
        ]
        .map(|k| json!(k))
    );
    assert!(mapper.turn_active());
}

/// Per-session state must not grow with the number of turns: replays the subagent, steer and
/// continuation recordings 200 times into one mapper.
#[test]
fn mapper_state_stays_bounded_over_many_turns() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let mut sizes = Vec::new();
    for round in 0..200 {
        for name in ["e12_subagent", "e14_steer", "e06_permissions"] {
            let thread = provider_thread("n-bounded");
            for line in testdata::cli(name).lines() {
                let line: Value = serde_json::from_str(line).unwrap();
                let msg = &line["msg"];
                match (line["dir"].as_str(), msg["type"].as_str()) {
                    (Some("out"), Some("user")) if msg["priority"] == "now" => {
                        mapper.steer_sent(msg["uuid"].as_str().unwrap(), "m");
                    }
                    (Some("out"), Some("user")) => {
                        if mapper.turn_active() {
                            mapper.on_exit(true, "next round");
                        }
                        mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
                    }
                    (Some("in"), Some(_)) => {
                        let outs = mapper.handle(Inbound::from_value(msg.clone()));
                        if outs.iter().any(|o| {
                            matches!(o, Out::Event(ProviderEvent::ContinuationRequested(_)))
                        }) {
                            mapper.begin_continuation(
                                &turn_input(2, &thread, "", "full-access"),
                                "default",
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        if mapper.turn_active() {
            mapper.on_exit(true, "end of round");
        }
        if round == 1 || round == 199 {
            sizes.push(mapper.held_sizes());
        }
    }
    assert_eq!(sizes[0], sizes[1], "state after round 2 vs round 200");
}

#[test]
fn plan_mode_without_approvals_denies_tools() {
    // `interactionMode: plan` with `approvalPolicy: never`: T3's callback denies the tool
    // without a prompt (ClaudeAdapterV2 canUseTool).
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n1"), "plan", "approval-required"),
        "plan",
    );
    mapper.set_policy_asks(true);
    mapper.set_plan_without_approvals(true);
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "control_request", "request_id": "cli-w",
        "request": {"subtype": "can_use_tool", "tool_name": "Write",
                    "input": {"file_path": "/x"}, "tool_use_id": "toolu_w"},
    })));
    assert!(
        !outs
            .iter()
            .any(|o| matches!(o, Out::Event(ProviderEvent::RuntimeRequestUpdated { .. })))
    );
    let Some(Out::Write(deny)) = outs.last() else {
        panic!("a reply expected: {outs:?}")
    };
    assert!(deny.contains("approvals are disabled for this thread"));
}
