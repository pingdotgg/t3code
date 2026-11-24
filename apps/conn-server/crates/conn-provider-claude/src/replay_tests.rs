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
            ("end", _) => mapper.end_process_subagents(0, false),
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
                Out::TailOutput { .. }
                | Out::StopTail { .. }
                | Out::StopTask { .. }
                | Out::ReadMemberTranscript(_) => {}
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

/// A downloaded catalog that moves `sonnet` to a new model: a child thread launched for
/// `sonnet`, by the `Agent` input or by the child's own assistant frame, records the turn's
/// catalog slug, not the bundled one (`canonicalClaudeSubagentModel(modelCatalog, …)`).
#[test]
fn subagent_models_resolve_through_the_turns_catalog() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.set_catalog(vec![
        json!({"slug": "claude-sonnet-9", "aliases": ["sonnet"]}),
    ]);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n1"), "x", "full-access"),
        "bypassPermissions",
    );
    let frames = [
        json!({"type": "assistant", "uuid": "r1", "message": {"id": "m_root",
            "model": "claude-sonnet-4-6", "content": [{"type": "tool_use", "id": "toolu_a",
            "name": "Agent", "input": {"description": "a", "prompt": "a", "model": "sonnet"}}]}}),
        json!({"type": "system", "subtype": "task_started", "task_id": "t1",
            "tool_use_id": "toolu_a", "description": "a"}),
        json!({"type": "assistant", "parent_tool_use_id": "toolu_b", "uuid": "u2",
            "message": {"id": "m_b", "model": "sonnet", "content": [{"type": "text", "text": "b"}]}}),
        json!({"type": "system", "subtype": "task_started", "task_id": "t2",
            "tool_use_id": "toolu_b", "description": "b"}),
    ];
    let mut models = Vec::new();
    for frame in frames {
        for out in mapper.handle(Inbound::from_value(frame)) {
            if let Out::Event(event) = out {
                let event = serde_json::to_value(&event).unwrap();
                if event["type"] == "app_thread.created" {
                    models.push(event["appThread"]["modelSelection"]["model"].clone());
                }
            }
        }
    }
    assert_eq!(models, [json!("claude-sonnet-9"), json!("claude-sonnet-9")]);
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
                Out::Write(_)
                | Out::TailOutput { .. }
                | Out::StopTail { .. }
                | Out::StopTask { .. }
                | Out::ReadMemberTranscript(_) => {}
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

/// The background roster keeps its bounds when Claude starts many tasks and never reports
/// them done: at most 64 tasks and 64 task-to-call links.
#[test]
fn the_background_roster_stays_bounded() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    mapper.begin_turn(
        &turn_input(1, &provider_thread("n-roster"), "x", "full-access"),
        "default",
    );
    for n in 0..1_000 {
        let started = json!({
            "type": "system", "subtype": "task_started", "session_id": "s",
            "task_id": format!("task-{n}"), "tool_use_id": format!("toolu-{n}"),
            "task_type": "local_bash", "description": "sleep", "is_backgrounded": true,
        });
        mapper.handle(Inbound::from_value(started));
        let monitor = json!({
            "type": "assistant", "parent_tool_use_id": null, "uuid": format!("u-{n}"),
            "message": {"id": format!("m-{n}"), "content": [
                {"type": "tool_use", "id": format!("mon-{n}"), "name": "Monitor", "input": {}}
            ]},
        });
        mapper.handle(Inbound::from_value(monitor));
    }
    let [.., roster] = mapper.held_sizes();
    // Tasks, links, open Monitor calls, Monitor tasks, known tasks, wake-eligible ids, owed ids.
    assert!(roster <= 64 * 7, "roster state: {roster}");
    let outs = mapper.on_exit(false, "done");
    let cleared = outs.iter().rev().find_map(|o| match o {
        Out::Event(ProviderEvent::ProviderThreadUpdated { provider_thread }) => {
            Some(serde_json::to_value(provider_thread).unwrap()["pendingBackgroundTasks"].clone())
        }
        _ => None,
    });
    assert_eq!(cleared, Some(json!([])), "a failed turn clears the roster");
}

fn last_roster(outs: &[Out]) -> Option<serde_json::Value> {
    outs.iter().rev().find_map(|o| match o {
        Out::Event(ProviderEvent::ProviderThreadUpdated { provider_thread }) => {
            Some(serde_json::to_value(provider_thread).ok()?["pendingBackgroundTasks"].clone())
        }
        _ => None,
    })
}

/// `awaitBackgroundTasks`: only roster tasks match; they are published with `awaited`.
#[test]
fn awaited_background_tasks_are_marked() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("n-await");
    mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
    mapper.handle(Inbound::from_value(json!({
        "type": "system", "subtype": "task_started", "session_id": "s", "task_id": "bg1",
        "tool_use_id": "toolu-bg1", "task_type": "local_bash", "description": "sleep",
        "is_backgrounded": true,
    })));
    let thread_json = serde_json::to_value(&thread).unwrap();
    let (matched, outs) =
        mapper.await_background_tasks(&thread_json, &["bg1".into(), "nope".into()], true);
    assert_eq!(matched, vec!["bg1".to_string()]);
    assert_eq!(
        last_roster(&outs),
        Some(
            json!([{"taskId": "bg1", "kind": "command", "description": "sleep",
                     "nativeItemId": "toolu-bg1", "awaited": true}])
        )
    );
    let (matched, outs) = mapper.await_background_tasks(&thread_json, &["bg1".into()], false);
    assert_eq!(matched, vec!["bg1".to_string()]);
    assert_eq!(last_roster(&outs).unwrap()[0].get("awaited"), None);
    let (matched, outs) = mapper.await_background_tasks(&thread_json, &["nope".into()], true);
    assert!(matched.is_empty() && outs.is_empty());
}

/// `trackClaudeScheduledWakeup`: a ScheduleWakeup result puts T3's stable entry on the
/// roster; a later `stop` (scheduledFor 0) takes it off.
#[test]
fn a_scheduled_wakeup_is_listed_until_cancelled() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("n-wake");
    mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
    let call = |id: &str| {
        Inbound::from_value(json!({
            "type": "assistant", "parent_tool_use_id": null, "uuid": format!("u-{id}"),
            "message": {"id": format!("m-{id}"), "content": [
                {"type": "tool_use", "id": id, "name": "ScheduleWakeup", "input": {}}
            ]},
        }))
    };
    let result = |id: &str, due: u64| {
        Inbound::from_value(json!({
            "type": "user", "parent_tool_use_id": null,
            "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": "ok"}]},
            "tool_use_result": {"scheduledFor": due},
        }))
    };
    mapper.handle(call("w1"));
    mapper.handle(result("w1", 4_000_000_000_000));
    assert!(mapper.has_pending_background_work());
    let thread_json = serde_json::to_value(&thread).unwrap();
    let (_, outs) = mapper.await_background_tasks(&thread_json, &[], true);
    assert!(outs.is_empty());
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "system", "subtype": "background_tasks_changed", "tasks": [],
    })));
    assert_eq!(
        last_roster(&outs),
        Some(
            json!([{"taskId": "claude-scheduled-wakeup", "kind": "background_task",
                     "description": "Scheduled wakeup"}])
        )
    );
    mapper.handle(call("w2"));
    mapper.handle(result("w2", 0));
    let outs = mapper.handle(Inbound::from_value(json!({
        "type": "system", "subtype": "background_tasks_changed", "tasks": [],
    })));
    assert_eq!(last_roster(&outs), Some(json!([])));
    assert!(!mapper.has_pending_background_work());
}

#[test]
fn workflow_run_matches_the_ts_adapter() {
    let replay = assert_same("e16_workflow", "full-access");
    assert!(
        replay
            .events
            .iter()
            .any(|e| e["subagent"]["workflow"]["name"] == "Audit")
    );
}

#[test]
fn workflow_progress_after_the_root_turn_matches_the_ts_adapter() {
    assert_same("e17_workflow_idle", "full-access");
    let frames: Vec<Value> = testdata::cli("e17_workflow_idle")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["msg"].clone())
        .collect();
    let frame = |subtype: &str| {
        frames
            .iter()
            .find(|msg| msg["subtype"] == subtype)
            .unwrap()
            .clone()
    };
    let result = frames
        .iter()
        .find(|msg| msg["type"] == "result")
        .unwrap()
        .clone();
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("workflow-session");
    mapper.begin_turn(
        &turn_input(1, &thread, "workflow", "full-access"),
        "default",
    );
    mapper.handle(Inbound::from_value(frame("task_started")));
    mapper.handle(Inbound::from_value(result.clone()));
    mapper.begin_turn(
        &turn_input(2, &thread, "another turn", "full-access"),
        "default",
    );
    mapper.handle(Inbound::from_value(result));
    let updates = mapper.handle(Inbound::from_value(frame("task_progress")));
    assert!(updates.iter().any(
        |out| matches!(out, Out::Event(ProviderEvent::SubagentUpdated { subagent })
        if to_json(subagent)["workflow"]["agents"][0]["label"] == "Reviewer")
    ));
    assert!(
        updates
            .iter()
            .any(|out| matches!(out, Out::Event(ProviderEvent::AppThreadCreated { .. })))
    );
    assert!(!updates.iter().any(
        |out| matches!(out, Out::Event(ProviderEvent::TurnItemUpdated { turn_item })
        if to_json(turn_item)["threadId"] == THREAD)
    ));
}

#[test]
fn workflow_process_exit_matches_the_ts_adapter() {
    assert_same("e18_workflow_exit", "full-access");
}

#[test]
fn a_retired_process_cannot_stop_or_settle_a_replacements_workflow() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("workflow-processes");
    mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
    let started = |task: &str| {
        Inbound::from_value(json!({
            "type":"system", "subtype":"task_started", "task_id":task, "tool_use_id":task,
            "task_type":"local_workflow", "workflow_name":"Review"
        }))
    };
    mapper.handle(started("old"));
    mapper.new_process(1);
    let thread = serde_json::to_value(thread).unwrap();
    assert!(!mapper.workflow_stop(&thread, "old", true));
    mapper.handle(started("new"));
    let ended = mapper.end_process_subagents(0, false);
    let events: Vec<Value> = ended
        .into_iter()
        .filter_map(|out| match out {
            Out::Event(event) => Some(serde_json::to_value(event).unwrap()),
            _ => None,
        })
        .collect();
    assert!(
        events
            .iter()
            .any(|e| e["subagent"]["nativeTaskRef"]["nativeId"] == "old"
                && e["subagent"]["status"] == "failed")
    );
    assert!(
        !events
            .iter()
            .any(|e| e["subagent"]["nativeTaskRef"]["nativeId"] == "new")
    );
    assert!(mapper.workflow_stop(&thread, "new", true));
    assert!(mapper.turn_active());
}

/// `ClaudeAdapterV2.test.ts` "stops the run's live workflow after root result api_error,
/// continuation=true, pending Stop=…": Claude reports the live workflow's `task_started`
/// again for a wake; the continuation then owns it, so its failed root stops it. Both frame
/// orders: the restart while the root is idle (T3's case), and inside the open continuation.
#[test]
fn a_failed_continuation_stops_the_workflow_it_took_over() {
    let started = json!({"type":"system", "subtype":"task_started", "task_id":"wf1",
        "tool_use_id":"run1", "task_type":"local_workflow", "workflow_name":"Review",
        "description":"Review", "prompt":"workflow()"});
    let result = |is_error: bool, text: &str| {
        json!({"type":"result", "subtype":"success", "is_error":is_error,
            "terminal_reason": if is_error { "api_error" } else { "completed" },
            "result":text, "duration_ms":1, "duration_api_ms":1, "num_turns":1, "usage":{},
            "modelUsage":{}, "total_cost_usd":0})
    };
    let wake_start = json!({"type":"assistant", "parent_tool_use_id":null, "uuid":"wake-1",
        "message":{"id":"m-wake", "content":[{"type":"text","text":"Checking the workflow."}]}});
    for (restart_inside, pending_stop) in [(false, false), (false, true), (true, false)] {
        let case = format!("restart_inside={restart_inside} pending_stop={pending_stop}");
        let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
        let thread = provider_thread("continuation-workflow");
        mapper.begin_turn(
            &turn_input(1, &thread, "workflow", "full-access"),
            "default",
        );
        mapper.handle(Inbound::from_value(started.clone()));
        mapper.handle(Inbound::from_value(result(false, "Launched.")));
        assert!(mapper.has_pending_background_work(), "{case}");
        let thread_json = serde_json::to_value(&thread).unwrap();
        if pending_stop {
            assert!(mapper.workflow_stop(&thread_json, "wf1", true), "{case}");
        }
        let mut frames = vec![started.clone(), result(true, "Root turn ended.")];
        if restart_inside {
            frames.insert(0, wake_start.clone());
        }
        let mut outs = Vec::new();
        for frame in frames {
            let step = mapper.handle(Inbound::from_value(frame));
            let wake = step
                .iter()
                .any(|o| matches!(o, Out::Event(ProviderEvent::ContinuationRequested(_))));
            outs.extend(step);
            if wake {
                outs.extend(
                    mapper
                        .begin_continuation(&turn_input(2, &thread, "", "full-access"), "default"),
                );
            }
        }
        let stops: Vec<&str> = outs
            .iter()
            .filter_map(|o| match o {
                Out::StopTask { task_id } => Some(task_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(stops, ["wf1"], "{case}");
        let events: Vec<Value> = outs
            .iter()
            .filter_map(|o| match o {
                Out::Event(event) => Some(serde_json::to_value(event).unwrap()),
                _ => None,
            })
            .collect();
        let turn = events
            .iter()
            .rev()
            .find(|e| e["type"] == "provider_turn.updated")
            .unwrap();
        assert_eq!(turn["providerTurn"]["status"], "failed", "{case}");
        assert_eq!(turn["providerTurn"]["runAttemptId"], "attempt-2", "{case}");
        let workflow = events
            .iter()
            .rev()
            .find(|e| e["subagent"]["nativeTaskRef"]["nativeId"] == "wf1")
            .unwrap();
        assert_eq!(workflow["subagent"]["status"], "failed", "{case}");
        assert_eq!(workflow["subagent"]["runId"], "run-attempt-2", "{case}");
        assert!(!mapper.has_pending_background_work(), "{case}");
        assert!(!mapper.workflow_stop(&thread_json, "wf1", true), "{case}");
    }
}

/// While the root is idle, Claude restarts a running workflow and then reports it done.
/// The continuation that the completion asks for must not replay the superseded start and
/// reopen the finished workflow.
#[test]
fn an_idle_restart_then_completion_leaves_the_workflow_finished() {
    let started = json!({"type":"system", "subtype":"task_started", "task_id":"wf1",
        "tool_use_id":"run1", "task_type":"local_workflow", "workflow_name":"Review",
        "description":"Review", "prompt":"workflow()"});
    let completed = json!({"type":"system", "subtype":"task_notification", "task_id":"wf1",
        "tool_use_id":"run1", "status":"completed", "summary":"Reviewed."});
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("idle-restart-workflow");
    mapper.begin_turn(
        &turn_input(1, &thread, "workflow", "full-access"),
        "default",
    );
    mapper.handle(Inbound::from_value(started.clone()));
    mapper.handle(Inbound::from_value(
        json!({"type":"result", "subtype":"success",
        "is_error":false, "result":"Launched.", "duration_ms":1, "duration_api_ms":1,
        "num_turns":1, "usage":{}, "modelUsage":{}, "total_cost_usd":0}),
    ));
    let mut outs = Vec::new();
    for frame in [started, completed] {
        let step = mapper.handle(Inbound::from_value(frame));
        let wake = step
            .iter()
            .any(|o| matches!(o, Out::Event(ProviderEvent::ContinuationRequested(_))));
        outs.extend(step);
        if wake {
            outs.extend(
                mapper.begin_continuation(&turn_input(2, &thread, "", "full-access"), "default"),
            );
        }
    }
    let last = outs
        .iter()
        .filter_map(|o| match o {
            Out::Event(event) => Some(serde_json::to_value(event).unwrap()),
            _ => None,
        })
        .rfind(|e| e["subagent"]["nativeTaskRef"]["nativeId"] == "wf1")
        .unwrap();
    assert_eq!(last["subagent"]["status"], "completed");
    assert!(!mapper.has_pending_background_work());
}

/// `readContainedWorkflowFile` refuses a path that is not absolute: a relative
/// `transcriptDir` is never read, and the progress excerpt stands in.
#[test]
fn a_relative_transcript_dir_is_not_read() {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("workflow-relative");
    mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
    let frames = [
        json!({"type":"assistant", "parent_tool_use_id":null, "uuid":"wf-2", "message":{
            "id":"m-wf", "content":[{"type":"tool_use", "id":"tool-workflow", "name":"Run",
            "input":{"script":"await workflow.run()"}}]}}),
        json!({"type":"system", "subtype":"task_started", "task_id":"wf1",
            "tool_use_id":"tool-workflow", "task_type":"local_workflow", "workflow_name":"Audit",
            "description":"Audit code", "prompt":"await workflow.run()"}),
        json!({"type":"user", "parent_tool_use_id":null, "uuid":"wf-4", "message":{"role":"user",
            "content":[{"type":"tool_result", "tool_use_id":"tool-workflow", "content":"launched"}]},
            "tool_use_result":{"taskType":"local_workflow", "runId":"wf-run",
            "transcriptDir":"projects/workflow"}}),
        json!({"type":"system", "subtype":"task_progress", "task_id":"wf1",
            "tool_use_id":"tool-workflow", "description":"Review", "workflow_progress":[
            {"type":"workflow_agent", "index":0, "label":"Reviewer", "state":"done", "attempt":1,
             "startedAt":1, "lastProgressAt":5, "agentId":"a1", "resultPreview":"Looks good"}]}),
    ];
    let outs: Vec<Out> = frames
        .into_iter()
        .flat_map(|frame| mapper.handle(Inbound::from_value(frame)))
        .collect();
    assert!(
        !outs
            .iter()
            .any(|o| matches!(o, Out::ReadMemberTranscript(_)))
    );
    assert!(outs.iter().any(|o| matches!(o,
        Out::Event(ProviderEvent::TurnItemUpdated { turn_item })
            if to_json(turn_item)["text"] == "Partial answer from workflow progress:\n\nLooks good")));
}

/// A workflow with one member, `a1`, whose transcripts live in `dir`.
fn member_workflow(dir: &std::path::Path) -> (Mapper<FixedEnv>, Vec<Out>) {
    let mut mapper = Mapper::new(FixedEnv::default(), SESSION);
    let thread = provider_thread("workflow-member");
    mapper.begin_turn(&turn_input(1, &thread, "x", "full-access"), "default");
    let frames = [
        json!({"type":"assistant", "parent_tool_use_id":null, "uuid":"wf-2", "message":{
            "id":"m-wf", "content":[{"type":"tool_use", "id":"tool-workflow", "name":"Run",
            "input":{"script":"await workflow.run()"}}]}}),
        json!({"type":"system", "subtype":"task_started", "task_id":"wf1",
            "tool_use_id":"tool-workflow", "task_type":"local_workflow", "workflow_name":"Audit",
            "description":"Audit code", "prompt":"await workflow.run()"}),
        json!({"type":"user", "parent_tool_use_id":null, "uuid":"wf-4", "message":{"role":"user",
            "content":[{"type":"tool_result", "tool_use_id":"tool-workflow", "content":"launched"}]},
            "tool_use_result":{"taskType":"local_workflow", "runId":"wf-run", "transcriptDir":dir}}),
    ];
    let outs = frames
        .into_iter()
        .flat_map(|frame| mapper.handle(Inbound::from_value(frame)))
        .collect();
    (mapper, outs)
}

fn member_progress(uuid: &str, result: Option<&str>) -> Inbound {
    let mut entry = json!({"type":"workflow_agent", "index":0, "label":"Reviewer",
        "state":"done", "attempt":1, "startedAt":0, "agentId":"a1"});
    if let Some(result) = result {
        entry["resultPreview"] = json!(result);
    }
    Inbound::from_value(
        json!({"type":"system", "subtype":"task_progress", "uuid":uuid,
        "task_id":"wf1", "tool_use_id":"tool-workflow", "description":"Review",
        "workflow_progress":[entry]}),
    )
}

fn coordinator_done() -> Inbound {
    Inbound::from_value(json!({"type":"system", "subtype":"task_notification",
        "task_id":"wf1", "tool_use_id":"tool-workflow", "status":"completed",
        "summary":"Audited."}))
}

fn transcript_line(uuid: &str, stop_reason: &str, text: &str) -> String {
    let line = json!({"type":"assistant", "uuid":uuid, "message":{"id":format!("m-{uuid}"),
        "role":"assistant", "stop_reason":stop_reason,
        "content":[{"type":"text","text":text}]}});
    format!("{line}\n")
}

fn append(file: &std::path::Path, text: &str) {
    use std::io::Write;
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    handle.write_all(text.as_bytes()).unwrap();
}

/// Runs the session's side of each transcript read the mapper asks for, as the session does.
/// `before_read` runs before the n-th read (0-based).
fn import_reads(
    mapper: &mut Mapper<FixedEnv>,
    outs: Vec<Out>,
    reads: &mut usize,
    before_read: &mut dyn FnMut(usize),
) -> Vec<Out> {
    let mut done = Vec::new();
    let mut queue: std::collections::VecDeque<Out> = outs.into();
    while let Some(out) = queue.pop_front() {
        let Out::ReadMemberTranscript(member) = out else {
            done.push(out);
            continue;
        };
        before_read(*reads);
        *reads += 1;
        let read = crate::session::read_member_transcript(&member, &member.dir);
        queue.extend(mapper.member_transcript(member, read));
    }
    done
}

/// The assistant texts of the member's child thread, by item id in the order first seen.
fn member_answers(outs: &[Out]) -> Vec<String> {
    let child = outs
        .iter()
        .find_map(|out| match out {
            Out::Event(event @ ProviderEvent::SubagentUpdated { .. }) => {
                let event = serde_json::to_value(event).unwrap();
                let member = event["subagent"]["nativeTaskRef"]["nativeId"]
                    .as_str()
                    .is_some_and(|id| id.ends_with(":agent:0"));
                member.then(|| event["subagent"]["childThreadId"].clone())
            }
            _ => None,
        })
        .unwrap();
    let mut items: Vec<(String, String)> = Vec::new();
    for out in outs {
        let Out::Event(ProviderEvent::TurnItemUpdated { turn_item }) = out else {
            continue;
        };
        let item = to_json(turn_item);
        if item["type"] != "assistant_message" || item["threadId"] != child {
            continue;
        }
        let (id, text) = (
            item["id"].as_str().unwrap().to_owned(),
            item["text"].as_str().unwrap_or_default().to_owned(),
        );
        match items.iter_mut().find(|(seen, _)| *seen == id) {
            Some(entry) => entry.1 = text,
            None => items.push((id, text)),
        }
    }
    items.into_iter().map(|(_, text)| text).collect()
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("conn-claude-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// `ClaudeAdapterV2.test.ts` "answers settled workflow members from a transcript, or the
/// snapshot excerpt": a line Claude flushes after the member settled shows on the next settled
/// snapshot ("A1 continued"); a member without a transcript shows the excerpt, then its
/// transcript once it appears.
#[test]
fn a_late_transcript_line_shows_on_the_next_settled_snapshot() {
    let dir = scratch("late-line");
    let file = dir.join("agent-a1.jsonl");
    append(
        &file,
        &transcript_line("wf-line-3", "end_turn", "A1 from the transcript"),
    );
    let (mut mapper, mut outs) = member_workflow(&dir);
    let mut reads = 0;
    let mut nothing = |_| {};
    let step = mapper.handle(member_progress("p-1", Some("A1 excerpt")));
    outs.extend(import_reads(&mut mapper, step, &mut reads, &mut nothing));
    assert_eq!(member_answers(&outs), ["A1 from the transcript"]);
    append(
        &file,
        &transcript_line("wf-line-4", "end_turn", "A1 continued"),
    );
    let step = mapper.handle(member_progress("p-2", Some("A1 excerpt")));
    let stale = step.iter().find_map(|o| match o {
        Out::ReadMemberTranscript(member) => Some(member.clone()),
        _ => None,
    });
    outs.extend(import_reads(&mut mapper, step, &mut reads, &mut nothing));
    assert_eq!(
        member_answers(&outs),
        ["A1 from the transcript", "A1 continued"]
    );
    // A late result for a cursor that has moved on since is dropped.
    let stale = stale.unwrap();
    let read = crate::session::read_member_transcript(&stale, &stale.dir);
    assert!(mapper.member_transcript(stale, read).is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// `WORKFLOW_MEMBER_TRANSCRIPT_FLUSH_MS`: when the coordinator ends while a settled member's
/// reply is not in its transcript yet, the reader waits out the flush window once and reads
/// again before it falls back to the excerpt.
#[test]
fn a_final_flush_after_the_coordinator_ends_shows_the_answer() {
    let dir = scratch("final-flush");
    let file = dir.join("agent-a1.jsonl");
    append(
        &file,
        &transcript_line("wf-line-1", "tool_use", "Let me look."),
    );
    let (mut mapper, mut outs) = member_workflow(&dir);
    let mut reads = 0;
    let step = mapper.handle(member_progress("p-1", Some("Looks good")));
    outs.extend(import_reads(&mut mapper, step, &mut reads, &mut |_| {}));
    let step = mapper.handle(coordinator_done());
    let mut flush = |n: usize| {
        if n == 2 {
            append(
                &file,
                &transcript_line("wf-line-2", "end_turn", "FINAL ANSWER"),
            );
        }
    };
    outs.extend(import_reads(&mut mapper, step, &mut reads, &mut flush));
    assert_eq!(member_answers(&outs), ["Let me look.", "FINAL ANSWER"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// `ClaudeAdapterV2.ts` shows the progress excerpt only when the attempt showed no transcript
/// text: a read the byte bound cut short still shows its answers and no excerpt.
#[test]
fn a_byte_truncated_transcript_shows_no_excerpt() {
    let dir = scratch("byte-truncated");
    let file = dir.join("agent-a1.jsonl");
    let filler = "x".repeat(5 * 1024 * 1024);
    append(&file, &transcript_line("wf-line-1", "end_turn", &filler));
    append(&file, &transcript_line("wf-line-2", "end_turn", &filler));
    append(
        &file,
        &transcript_line("wf-line-3", "end_turn", "FINAL ANSWER"),
    );
    let (mut mapper, mut outs) = member_workflow(&dir);
    let step = mapper.handle(member_progress("p-1", Some("Looks good")));
    outs.extend(import_reads(&mut mapper, step, &mut 0, &mut |_| {}));
    let answers = member_answers(&outs);
    assert_eq!(answers.last().map(String::as_str), Some("FINAL ANSWER"));
    assert!(!answers.iter().any(|a| a.starts_with("Partial answer")));
    std::fs::remove_dir_all(&dir).unwrap();
}
