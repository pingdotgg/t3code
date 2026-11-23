#![recursion_limit = "256"]

use conn_contract::from_json;
use std::collections::HashMap;

use conn_state::{
    ItemStatus, LayoutState, LocalDateTime, RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MAX_WIDTH,
    RIGHT_PANEL_MIN_WIDTH, RightPanelTab, RunStatus, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH, SecretRequestStatus, ShellChange, ShellState, ShellStreamItem, SubagentTone,
    ThreadActivity, ThreadState, ThreadStreamItem, TimelineEntry, TurnCheckpointFile,
    TurnItemStatus, UserInputAnswerValue, UserInputDraft, build_turn_diff_tree,
    build_user_input_answers, collapsed_plan_preview, flatten_turn_diff_tree,
    format_chat_timestamp_tooltip, format_day_aware_timestamp, format_duration,
    format_subagent_display_title, plan_can_collapse, strip_displayed_plan_markdown,
    subagent_status_visual,
};
use serde_json::{Value, json};

fn project_json(id: &str, title: &str, updated_at: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "workspaceRoot": format!("/tmp/{id}"),
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": "2026-11-13T09:00:00.000Z",
        "updatedAt": updated_at
    })
}

fn thread_json(
    id: &str,
    project_id: &str,
    title: &str,
    status: &str,
    updated_at: &str,
    pending_request_kind: Option<&str>,
) -> Value {
    let pending = pending_request_kind.map(|kind| {
        json!({
            "id": format!("req:{id}"),
            "kind": kind,
            "createdAt": updated_at
        })
    });
    json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": id,
        "projectId": project_id,
        "title": title,
        "providerInstanceId": "claudeAgent",
        "modelSelection": {
            "instanceId": "claudeAgent",
            "model": "claude-haiku-5-5"
        },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": null,
        "worktreePath": null,
        "lineage": {
            "rootThreadId": id,
            "parentThreadId": null,
            "relationshipToParent": null
        },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": null,
        "activeRunId": null,
        "status": status,
        "pendingRuntimeRequest": pending,
        "latestVisibleMessage": null,
        "latestUserMessageAt": null,
        "hasActionableProposedPlan": false,
        "itemCount": 0,
        "visibleItemCount": 0,
        "createdAt": "2026-11-13T09:00:00.000Z",
        "updatedAt": updated_at,
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "deletedAt": null
    })
}

fn decode_shell(value: Value) -> ShellStreamItem {
    match from_json(value) {
        Ok(item) => item,
        Err(err) => panic!("failed to decode ShellStreamItem: {err}"),
    }
}

fn decode_thread(value: Value) -> ThreadStreamItem {
    match from_json(value) {
        Ok(item) => item,
        Err(err) => panic!("failed to decode ThreadStreamItem: {err}"),
    }
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    match serde_json::from_str(raw) {
        Ok(frames) => frames,
        Err(err) => panic!("failed to parse fixture JSON array: {err}"),
    }
}

#[test]
fn shell_snapshot_updates_removals_and_snapshot_required() {
    let mut state = ShellState::default();

    // 1. Initial snapshot replaces state, sets sequence, and sorts threads newest-first.
    let snap = decode_shell(json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 10,
            "projects": [
                project_json("proj-1", "Conn", "2026-11-13T09:00:00.000Z")
            ],
            "threads": [
                thread_json("t-old", "proj-1", "Older", "idle", "2026-11-13T09:01:00.000Z", None),
                thread_json("t-new", "proj-1", "Newer", "running", "2026-11-13T09:05:00.000Z", None)
            ],
            "archivedThreads": [
                thread_json("t-arch", "proj-1", "Archived", "completed", "2026-11-13T08:00:00.000Z", None)
            ]
        }
    }));

    let change = state.apply(snap);
    assert!(
        change.projects_changed,
        "snapshot should mark projects_changed"
    );
    assert!(
        !change.snapshot_required,
        "snapshot should not set snapshot_required"
    );
    assert_eq!(
        state.sequence,
        Some(10),
        "snapshot should set sequence to snapshotSequence"
    );
    assert_eq!(state.projects.len(), 1, "snapshot should populate projects");
    let ordered_ids: Vec<&str> = state
        .threads_for_project("proj-1")
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(
        ordered_ids,
        vec!["t-new", "t-old"],
        "active threads should be sorted by most-recent activity descending"
    );
    assert_eq!(
        state.archived_threads.len(),
        1,
        "snapshot should populate archived_threads"
    );

    // 2. Synchronized marks shell synchronized.
    let sync_change = state.apply(decode_shell(json!({ "kind": "synchronized" })));
    assert_eq!(
        sync_change,
        ShellChange::default(),
        "synchronized should return empty change"
    );
    assert!(state.synchronized, "synchronized should set flag");

    // 3. Project upsert and add.
    let proj_update = state.apply(decode_shell(json!({
        "kind": "project.updated",
        "sequence": 11,
        "project": project_json("proj-2", "Server", "2026-11-13T09:06:00.000Z")
    })));
    assert!(
        proj_update.projects_changed,
        "project.updated should mark projects_changed"
    );
    assert_eq!(state.sequence, Some(11), "sequence should advance to 11");
    assert_eq!(
        state.project("proj-2").map(|p| p.title.as_str()),
        Some("Server"),
        "project.updated should insert new project"
    );

    // 4. Thread update bumps t-old above t-new.
    let t_update = state.apply(decode_shell(json!({
        "kind": "thread.updated",
        "sequence": 12,
        "location": "active",
        "thread": thread_json("t-old", "proj-1", "Older bumped", "idle", "2026-11-13T09:10:00.000Z", None)
    })));
    assert_eq!(
        t_update.threads_changed,
        vec!["t-old".to_owned()],
        "thread.updated should report changed thread id"
    );
    let ordered_after: Vec<&str> = state
        .threads_for_project("proj-1")
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(
        ordered_after,
        vec!["t-old", "t-new"],
        "bumping updatedAt should reorder t-old before t-new"
    );

    // 5. Moving thread to archive removes it from active list.
    state.apply(decode_shell(json!({
        "kind": "thread.updated",
        "sequence": 13,
        "location": "archive",
        "thread": thread_json("t-old", "proj-1", "Older archived", "completed", "2026-11-13T09:11:00.000Z", None)
    })));
    assert!(
        state.thread("t-old").is_none(),
        "archiving a thread should remove it from active threads"
    );
    assert_eq!(
        state.archived_threads.len(),
        2,
        "archiving a thread should add it to archived_threads"
    );

    // 6. Removing active thread and project.
    let rm_thread = state.apply(decode_shell(json!({
        "kind": "thread.removed",
        "sequence": 14,
        "location": "active",
        "threadId": "t-new"
    })));
    assert_eq!(
        rm_thread.threads_changed,
        vec!["t-new".to_owned()],
        "thread.removed should report removed thread id"
    );
    assert!(
        state.threads.is_empty(),
        "removing last active thread should leave threads empty"
    );

    let rm_proj = state.apply(decode_shell(json!({
        "kind": "project.removed",
        "sequence": 15,
        "projectId": "proj-2"
    })));
    assert!(
        rm_proj.projects_changed,
        "project.removed should mark projects_changed"
    );
    assert!(
        state.project("proj-2").is_none(),
        "project.removed should remove project"
    );
    assert_eq!(state.sequence, Some(15), "sequence should track max seen");

    // 7. Snapshot-required clears synchronized and signals resubscribe.
    let req_change = state.apply(decode_shell(json!({ "kind": "snapshot-required" })));
    assert!(
        req_change.snapshot_required,
        "snapshot-required should set change.snapshot_required"
    );
    assert!(
        !state.synchronized,
        "snapshot-required should clear synchronized"
    );
}

#[test]
fn shell_activity_derivation_and_fixture_replay() {
    let mut state = ShellState::default();

    let snap = decode_shell(json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 1,
            "projects": [],
            "threads": [
                thread_json("t-idle", "p", "Idle", "completed", "2026-11-13T09:00:00.000Z", None),
                thread_json("t-work", "p", "Work", "running", "2026-11-13T09:01:00.000Z", None),
                thread_json("t-attn-cmd", "p", "Approval", "waiting", "2026-11-13T09:02:00.000Z", Some("command")),
                thread_json("t-attn-input", "p", "Question", "waiting", "2026-11-13T09:03:00.000Z", Some("user_input")),
                thread_json("t-auth", "p", "Auth", "running", "2026-11-13T09:04:00.000Z", Some("auth_refresh")),
                thread_json("t-fail", "p", "Failed", "failed", "2026-11-13T09:05:00.000Z", None)
            ],
            "archivedThreads": []
        }
    }));
    state.apply(snap);

    assert_eq!(
        state.activity("t-idle"),
        ThreadActivity::Idle,
        "completed thread should be Idle"
    );
    assert_eq!(
        state.activity("t-work"),
        ThreadActivity::Working,
        "running thread should be Working"
    );
    assert_eq!(
        state.activity("t-attn-cmd"),
        ThreadActivity::NeedsAttention,
        "pending command approval should be NeedsAttention"
    );
    assert_eq!(
        state.activity("t-attn-input"),
        ThreadActivity::NeedsAttention,
        "pending user_input should be NeedsAttention"
    );
    assert_eq!(
        state.activity("t-auth"),
        ThreadActivity::Working,
        "auth_refresh does not trigger NeedsAttention"
    );
    assert_eq!(
        state.activity("t-fail"),
        ThreadActivity::Failed,
        "failed thread should be Failed"
    );
    assert_eq!(
        state.activity("t-missing"),
        ThreadActivity::Idle,
        "unknown thread should default to Idle"
    );

    // Replay real recorded shell thread.updated frames from conn-server.
    let frames = parse_json_array(include_str!("fixtures/shell_thread_updates.json"));
    let mut live_shell = ShellState::default();
    for frame in frames {
        let item = decode_shell(frame);
        live_shell.apply(item);
    }
    assert_eq!(
        live_shell.threads.len(),
        1,
        "fixture updates should upsert a single thread"
    );
    assert_eq!(
        live_shell.activity("a82e6d43-12a1-43aa-af0b-906df435b953"),
        ThreadActivity::Working,
        "recorded running thread fixture should report Working"
    );
}

#[test]
fn thread_snapshot_and_streaming_deltas_flip_working() {
    let mut state = ThreadState::new("thread-1");

    // 1. Snapshot with user message, assistant reply, and completed command tool item.
    let snap = decode_thread(json!({
        "kind": "snapshot",
        "snapshotSequence": 5,
        "projection": {
            "thread": {
                "createdBy": "user",
                "creationSource": "web",
                "id": "thread-1",
                "projectId": "proj-1",
                "title": "Test thread",
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "lineage": { "rootThreadId": "thread-1", "parentThreadId": null, "relationshipToParent": null },
                "forkedFrom": null,
                "activeProviderThreadId": null,
                "createdAt": "2026-11-13T09:00:00.000Z",
                "updatedAt": "2026-11-13T09:00:10.000Z",
                "archivedAt": null,
                "settledOverride": null,
                "settledAt": null,
                "deletedAt": null
            },
            "runs": [
                {
                    "id": "run-1",
                    "threadId": "thread-1",
                    "ordinal": 1,
                    "providerInstanceId": "claudeAgent",
                    "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                    "providerThreadId": null,
                    "userMessageId": "msg-u1",
                    "rootNodeId": null,
                    "activeAttemptId": null,
                    "status": "completed",
                    "requestedAt": "2026-11-13T09:00:00.000Z",
                    "startedAt": "2026-11-13T09:00:01.000Z",
                    "completedAt": "2026-11-13T09:00:10.000Z",
                    "checkpointId": null,
                    "contextHandoffId": null
                }
            ],
            "attempts": [],
            "nodes": [],
            "subagents": [],
            "providerSessions": [],
            "providerThreads": [],
            "providerTurns": [],
            "runtimeRequests": [],
            "messages": [],
            "plans": [],
            "turnItems": [],
            "checkpointScopes": [],
            "checkpoints": [],
            "contextHandoffs": [],
            "contextTransfers": [],
            "visibleTurnItems": [
                {
                    "position": 0,
                    "visibility": "local",
                    "sourceThreadId": "thread-1",
                    "sourceItemId": "item-u1",
                    "item": {
                        "id": "item-u1",
                        "threadId": "thread-1",
                        "runId": "run-1",
                        "nodeId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "parentItemId": null,
                        "ordinal": 1,
                        "status": "completed",
                        "title": null,
                        "startedAt": "2026-11-13T09:00:00.000Z",
                        "completedAt": "2026-11-13T09:00:00.000Z",
                        "updatedAt": "2026-11-13T09:00:00.000Z",
                        "createdBy": "user",
                        "creationSource": "web",
                        "type": "user_message",
                        "messageId": "msg-u1",
                        "inputIntent": "turn_start",
                        "text": "Run tests",
                        "attachments": []
                    }
                },
                {
                    "position": 1,
                    "visibility": "local",
                    "sourceThreadId": "thread-1",
                    "sourceItemId": "item-cmd1",
                    "item": {
                        "id": "item-cmd1",
                        "threadId": "thread-1",
                        "runId": "run-1",
                        "nodeId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "parentItemId": null,
                        "ordinal": 2,
                        "status": "completed",
                        "title": "cargo test",
                        "startedAt": "2026-11-13T09:00:02.000Z",
                        "completedAt": "2026-11-13T09:00:05.000Z",
                        "updatedAt": "2026-11-13T09:00:05.000Z",
                        "type": "command_execution",
                        "input": "cargo test -p conn-state",
                        "output": "ok",
                        "exitCode": 0
                    }
                },
                {
                    "position": 2,
                    "visibility": "local",
                    "sourceThreadId": "thread-1",
                    "sourceItemId": "item-a1",
                    "item": {
                        "id": "item-a1",
                        "threadId": "thread-1",
                        "runId": "run-1",
                        "nodeId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "parentItemId": null,
                        "ordinal": 3,
                        "status": "completed",
                        "title": null,
                        "startedAt": "2026-11-13T09:00:06.000Z",
                        "completedAt": "2026-11-13T09:00:10.000Z",
                        "updatedAt": "2026-11-13T09:00:10.000Z",
                        "type": "assistant_message",
                        "messageId": "msg-a1",
                        "text": "All tests passed.",
                        "streaming": false
                    }
                }
            ],
            "updatedAt": "2026-11-13T09:00:10.000Z"
        }
    }));

    assert!(state.apply(snap), "snapshot should report changed");
    assert!(
        !state.working,
        "completed run in snapshot should leave working=false"
    );
    assert_eq!(state.entries.len(), 3, "snapshot should produce 3 entries");
    assert_eq!(
        state.entries[0],
        TimelineEntry::User {
            id: "item-u1".to_owned(),
            text: "Run tests".to_owned(),
            created_by_agent: false,
            created_at: Some("2026-11-13T09:00:00.000Z".to_owned()),
            attachments: Vec::new(),
            is_steer: false,
            run_id: Some("run-1".to_owned()),
        },
        "first entry should be user message"
    );
    assert_eq!(
        state.entries[1],
        TimelineEntry::Tool {
            id: "item-cmd1".to_owned(),
            kind: "command".to_owned(),
            title: "cargo test".to_owned(),
            detail: Some("ok".to_owned()),
            status: ItemStatus::Completed,
            output_omitted: false,
        },
        "second entry should be completed command tool"
    );
    assert_eq!(
        state.entries[2],
        TimelineEntry::Assistant {
            id: "item-a1".to_owned(),
            markdown: "All tests passed.".to_owned(),
            streaming: false,
            created_at: Some("2026-11-13T09:00:10.000Z".to_owned()),
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
        "third entry should be assistant reply"
    );

    // 2. New run starts -> working flips on.
    let run_created = decode_thread(json!({
        "kind": "event",
        "sequence": 6,
        "event": {
            "id": "ev-run-2-start",
            "threadId": "thread-1",
            "occurredAt": "2026-11-13T09:01:00.000Z",
            "type": "run.created",
            "payload": {
                "id": "run-2",
                "threadId": "thread-1",
                "ordinal": 2,
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "providerThreadId": null,
                "userMessageId": "msg-u2",
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": "running",
                "requestedAt": "2026-11-13T09:01:00.000Z",
                "startedAt": "2026-11-13T09:01:00.000Z",
                "completedAt": null,
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }));
    assert!(
        state.apply(run_created),
        "run.created with running status should report change"
    );
    assert!(state.working, "working should flip to true on active run");

    // 3. Stream assistant reply delta by delta (via turn-item.updated, plus Event2 .delta).
    let stream_1 = decode_thread(json!({
        "kind": "event",
        "sequence": 7,
        "event": {
            "id": "ev-a2-1",
            "threadId": "thread-1",
            "occurredAt": "2026-11-13T09:01:01.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-a2",
                "threadId": "thread-1",
                "runId": "run-2",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 4,
                "status": "running",
                "title": null,
                "startedAt": "2026-11-13T09:01:01.000Z",
                "completedAt": null,
                "updatedAt": "2026-11-13T09:01:01.000Z",
                "type": "assistant_message",
                "messageId": "msg-a2",
                "text": "Hello",
                "streaming": true
            }
        }
    }));
    assert!(state.apply(stream_1), "first streaming chunk should update");
    assert_eq!(
        state.entries.last(),
        Some(&TimelineEntry::Assistant {
            id: "item-a2".to_owned(),
            markdown: "Hello".to_owned(),
            streaming: true,
            created_at: Some("2026-11-13T09:01:01.000Z".to_owned()),
            run_id: Some("run-2".to_owned()),
            status: ItemStatus::Running,
        }),
        "streaming entry should start with 'Hello'"
    );

    // Event2 incremental delta appends to the same entry.
    let delta_2 = decode_thread(json!({
        "kind": "event",
        "sequence": 8,
        "event": {
            "type": "assistant_message.delta",
            "payload": { "id": "item-a2", "delta": ", world" }
        }
    }));
    assert!(state.apply(delta_2), "Event2 delta should append text");
    assert_eq!(
        state.entries.last(),
        Some(&TimelineEntry::Assistant {
            id: "item-a2".to_owned(),
            markdown: "Hello, world".to_owned(),
            streaming: true,
            created_at: Some("2026-11-13T09:01:01.000Z".to_owned()),
            run_id: Some("run-2".to_owned()),
            status: ItemStatus::Running,
        }),
        "delta should append onto existing assistant entry"
    );

    // Final turn-item.updated completes the assistant reply.
    let stream_done = decode_thread(json!({
        "kind": "event",
        "sequence": 9,
        "event": {
            "id": "ev-a2-done",
            "threadId": "thread-1",
            "occurredAt": "2026-11-13T09:01:02.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-a2",
                "threadId": "thread-1",
                "runId": "run-2",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 4,
                "status": "completed",
                "title": null,
                "startedAt": "2026-11-13T09:01:01.000Z",
                "completedAt": "2026-11-13T09:01:02.000Z",
                "updatedAt": "2026-11-13T09:01:02.000Z",
                "type": "assistant_message",
                "messageId": "msg-a2",
                "text": "Hello, world!",
                "streaming": false
            }
        }
    }));
    assert!(state.apply(stream_done), "completion event should update");
    assert_eq!(
        state.entries.len(),
        4,
        "upserts by id should not duplicate streaming entries"
    );
    assert_eq!(
        state.entries[3],
        TimelineEntry::Assistant {
            id: "item-a2".to_owned(),
            markdown: "Hello, world!".to_owned(),
            streaming: false,
            created_at: Some("2026-11-13T09:01:02.000Z".to_owned()),
            run_id: Some("run-2".to_owned()),
            status: ItemStatus::Completed,
        },
        "completed assistant entry should have streaming=false"
    );

    // 4. Run finishes -> working flips off.
    let run_done = decode_thread(json!({
        "kind": "event",
        "sequence": 10,
        "event": {
            "id": "ev-run-2-done",
            "threadId": "thread-1",
            "occurredAt": "2026-11-13T09:01:03.000Z",
            "type": "run.updated",
            "payload": {
                "id": "run-2",
                "threadId": "thread-1",
                "ordinal": 2,
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "providerThreadId": null,
                "userMessageId": "msg-u2",
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": "completed",
                "requestedAt": "2026-11-13T09:01:00.000Z",
                "startedAt": "2026-11-13T09:01:00.000Z",
                "completedAt": "2026-11-13T09:01:03.000Z",
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }));
    assert!(
        state.apply(run_done),
        "run.updated to completed should report change"
    );
    assert!(
        !state.working,
        "working should flip back to false when run completes"
    );
}

#[test]
fn thread_replays_real_conn_server_turn_and_permission_fixtures() {
    // 1. Real turn fixture: snapshot (working=true) -> streaming assistant -> completed -> run completed.
    let turn_frames = parse_json_array(include_str!("fixtures/thread_turn_stream.json"));
    let mut turn_state = ThreadState::default();
    let mut saw_working = false;
    let mut saw_streaming = false;

    for frame in turn_frames {
        let item = decode_thread(frame);
        turn_state.apply(item);
        if turn_state.working {
            saw_working = true;
        }
        if turn_state.entries.iter().any(|e| {
            matches!(
                e,
                TimelineEntry::Assistant {
                    streaming: true,
                    ..
                }
            )
        }) {
            saw_streaming = true;
        }
    }

    assert!(saw_working, "recorded turn should enter working=true");
    assert!(
        saw_streaming,
        "recorded turn should observe streaming assistant text"
    );
    assert!(
        !turn_state.working,
        "recorded turn should end with working=false"
    );
    assert_eq!(
        turn_state.entries.len(),
        2,
        "recorded turn should have user message + final assistant reply"
    );
    assert!(
        matches!(
            &turn_state.entries[1],
            TimelineEntry::Assistant { markdown, streaming: false, .. } if markdown == "hello from haiku"
        ),
        "final assistant message should match recorded reply, got {:?}",
        turn_state.entries[1]
    );

    // 2. Real permission fixture: command running -> approval waiting -> resolved -> assistant reply.
    let perm_frames = parse_json_array(include_str!("fixtures/thread_permission_stream.json"));
    let mut perm_state = ThreadState::default();
    let mut saw_pending_approval = false;

    for frame in perm_frames {
        let item = decode_thread(frame);
        perm_state.apply(item);
        if perm_state
            .entries
            .iter()
            .any(|e| matches!(e, TimelineEntry::Approval { .. }))
        {
            saw_pending_approval = true;
        }
    }

    assert!(
        saw_pending_approval,
        "permission fixture should surface pending TimelineEntry::Approval"
    );
    assert!(
        !perm_state.working,
        "permission fixture should finish with working=false"
    );
    assert!(
        !perm_state
            .entries
            .iter()
            .any(|e| matches!(e, TimelineEntry::Approval { .. })),
        "resolved approval should no longer remain pending Approval"
    );
    assert!(
        perm_state.entries.iter().any(|e| matches!(
            e,
            TimelineEntry::Tool {
                kind,
                status: ItemStatus::Completed,
                ..
            } if kind == "command"
        )),
        "command execution should finish Completed"
    );
}

#[test]
fn pending_approvals_follow_their_runtime_request() {
    let frames = parse_json_array(include_str!("fixtures/thread_permission_stream.json"));
    let is_runtime_request = |frame: &Value| frame["event"]["type"] == "runtime-request.updated";
    let replay = |frames: &[Value]| {
        let mut state = ThreadState::default();
        for frame in frames {
            let changed = state.apply(decode_thread(frame.clone()));
            if is_runtime_request(frame) {
                assert!(changed, "a runtime request change re-syncs views");
            }
        }
        state
    };
    let shows_approval_card = |state: &ThreadState| {
        state
            .entries
            .iter()
            .any(|e| matches!(e, TimelineEntry::Approval { .. }))
    };
    let request_index = frames
        .iter()
        .position(is_runtime_request)
        .expect("fixture has a pending runtime request");
    let card_index = frames
        .iter()
        .position(|f| f["event"]["payload"]["type"] == "approval_request")
        .expect("fixture has an approval card");
    let resolved_index = frames
        .iter()
        .rposition(is_runtime_request)
        .expect("fixture resolves the request");

    // Claude's live request takes decline feedback.
    let waiting = replay(&frames[..=card_index]);
    let approvals = waiting.pending_approvals();
    assert_eq!(approvals.len(), 1);
    assert!(approvals[0].answerable && approvals[0].supports_feedback);
    assert_eq!(
        Some(&approvals[0].request_id),
        waiting.approval_requests.get(&approvals[0].entry_id)
    );

    // Once the request resolves, its card is no longer a pending approval, even before the
    // card's own turn item catches up.
    let resolved = replay(&frames[..=resolved_index]);
    assert!(shows_approval_card(&resolved));
    assert!(resolved.pending_approvals().is_empty());

    // A request the provider can no longer answer stays pending but is not answerable.
    let mut stale = frames[..=card_index].to_vec();
    stale[request_index]["event"]["payload"]["responseCapability"] =
        json!({ "type": "not_resumable", "reason": "provider session ended" });
    let approvals = replay(&stale).pending_approvals();
    assert_eq!(approvals.len(), 1);
    assert!(!approvals[0].answerable && !approvals[0].supports_feedback);

    // A snapshot carries the same state through `runtimeRequests`.
    let mut snapshot = frames[0].clone();
    snapshot["projection"]["runtimeRequests"] =
        json!([frames[request_index]["event"]["payload"].clone()]);
    snapshot["projection"]["visibleTurnItems"]
        .as_array_mut()
        .expect("snapshot visible turn items")
        .push(json!({
            "position": 1,
            "sourceItemId": frames[card_index]["event"]["payload"]["id"].clone(),
            "sourceThreadId": frames[card_index]["event"]["payload"]["threadId"].clone(),
            "visibility": "local",
            "item": frames[card_index]["event"]["payload"].clone(),
        }));
    let approvals = replay(&[snapshot]).pending_approvals();
    assert_eq!(approvals.len(), 1);
    assert!(approvals[0].answerable && approvals[0].supports_feedback);
}

#[test]
fn layout_toggles_selection_and_width_clamping() {
    let mut layout = LayoutState::default();
    assert!(layout.sidebar_open, "sidebar starts open");
    assert!(!layout.right_panel_open, "right panel starts closed");

    layout.toggle_sidebar();
    assert!(!layout.sidebar_open, "toggle_sidebar closes sidebar");
    layout.toggle_sidebar();
    assert!(layout.sidebar_open, "toggle_sidebar reopens sidebar");

    layout.toggle_right_panel();
    assert!(
        layout.right_panel_open,
        "toggle_right_panel opens right panel"
    );
    layout.toggle_right_panel();
    assert!(
        !layout.right_panel_open,
        "toggle_right_panel closes right panel"
    );

    // open_panel opens and selects; clicking the already-open tab toggles closed.
    layout.open_panel(RightPanelTab::Diff);
    assert!(layout.right_panel_open, "open_panel should open panel");
    assert_eq!(
        layout.right_panel_tab,
        RightPanelTab::Diff,
        "open_panel should select Diff tab"
    );

    layout.open_panel(RightPanelTab::Terminal);
    assert!(
        layout.right_panel_open,
        "open_panel with different tab should keep panel open"
    );
    assert_eq!(
        layout.right_panel_tab,
        RightPanelTab::Terminal,
        "open_panel should switch to Terminal tab"
    );

    layout.open_panel(RightPanelTab::Terminal);
    assert!(
        !layout.right_panel_open,
        "open_panel on already-open tab should toggle closed"
    );

    // Selection.
    layout.select_thread("proj-1", "thread-42");
    assert_eq!(
        layout.selected_project_id.as_deref(),
        Some("proj-1"),
        "select_thread sets selected_project_id"
    );
    assert_eq!(
        layout.selected_thread_id.as_deref(),
        Some("thread-42"),
        "select_thread sets selected_thread_id"
    );

    // Clamping.
    layout.set_sidebar_width(50.0);
    assert_eq!(
        layout.sidebar_width, SIDEBAR_MIN_WIDTH,
        "sidebar_width should clamp to min 200"
    );
    layout.set_sidebar_width(999.0);
    assert_eq!(
        layout.sidebar_width, SIDEBAR_MAX_WIDTH,
        "sidebar_width should clamp to max 480"
    );
    layout.set_sidebar_width(f32::NAN);
    assert_eq!(
        layout.sidebar_width, SIDEBAR_MAX_WIDTH,
        "NaN sidebar_width should be ignored"
    );

    layout.set_right_panel_width(100.0);
    assert_eq!(
        layout.right_panel_width, RIGHT_PANEL_MIN_WIDTH,
        "right_panel_width should clamp to min 320"
    );
    layout.set_right_panel_width(5000.0);
    assert_eq!(
        layout.right_panel_width, RIGHT_PANEL_MAX_WIDTH,
        "right_panel_width should clamp to max 1200"
    );

    layout.sidebar_width = f32::INFINITY;
    layout.right_panel_width = f32::NAN;
    layout.clamp_widths();
    assert_eq!(
        layout.sidebar_width, SIDEBAR_DEFAULT_WIDTH,
        "clamp_widths should reset non-finite sidebar_width to default"
    );
    assert_eq!(
        layout.right_panel_width, RIGHT_PANEL_DEFAULT_WIDTH,
        "clamp_widths should reset non-finite right_panel_width to default"
    );
}

#[test]
fn shell_partitions_settled_and_subagent_threads_and_finds_archived() {
    let mut state = ShellState::default();

    let mut settled = thread_json(
        "t-settled",
        "proj-1",
        "Settled in active list",
        "completed",
        "2026-11-13T09:04:00.000Z",
        None,
    );
    settled["settledAt"] = json!("2026-11-13T09:05:00.000Z");

    let mut subagent = thread_json(
        "t-sub",
        "proj-1",
        "Delegated subagent",
        "running",
        "2026-11-13T09:06:00.000Z",
        None,
    );
    subagent["lineage"] = json!({
        "rootThreadId": "t-active",
        "parentThreadId": "t-active",
        "relationshipToParent": "subagent"
    });

    let snap = decode_shell(json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 20,
            "projects": [
                project_json("proj-1", "Conn", "2026-11-13T09:00:00.000Z")
            ],
            "threads": [
                thread_json("t-active", "proj-1", "Active", "idle", "2026-11-13T09:03:00.000Z", None),
                settled,
                subagent
            ],
            "archivedThreads": [
                thread_json("t-archived", "proj-1", "Archived", "completed", "2026-11-13T09:02:00.000Z", None)
            ]
        }
    }));
    state.apply(snap);

    let active_ids: Vec<&str> = state
        .top_level_active_threads()
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(
        active_ids,
        vec!["t-active"],
        "settled and subagent threads must be excluded from top_level_active_threads"
    );

    assert_eq!(
        state.listed_ancestor("t-sub"),
        Some("t-active"),
        "an open subagent keeps its parent's row current"
    );
    assert_eq!(state.listed_ancestor("t-active"), Some("t-active"));
    assert_eq!(state.listed_ancestor("t-settled"), Some("t-settled"));
    assert_eq!(state.listed_ancestor("gone"), None);

    let settled_ids: Vec<&str> = state
        .top_level_settled_threads()
        .into_iter()
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(
        settled_ids,
        vec!["t-settled", "t-archived"],
        "top_level_settled_threads must combine settled active rows and archived rows newest-first"
    );

    assert!(
        state.find_thread("t-archived").is_some(),
        "find_thread must resolve archived threads"
    );
    assert!(
        state.find_thread("t-settled").is_some(),
        "find_thread must resolve settled threads"
    );
}

#[test]
fn thread_hydrates_deduped_message_bodies() {
    let mut state = ThreadState::new("thread-dedupe");
    let snap = decode_thread(json!({
        "kind": "snapshot",
        "snapshotSequence": 5,
        "turnItemsOmitLocalVisible": true,
        "projection": {
            "thread": thread_json("thread-dedupe", "proj-1", "Deduped", "completed", "2026-11-13T09:05:00.000Z", None),
            "runs": [],
            "attempts": [],
            "nodes": [],
            "subagents": [],
            "providerSessions": [],
            "providerThreads": [],
            "providerTurns": [],
            "runtimeRequests": [],
            "messages": [
                {
                    "id": "msg-u1",
                    "threadId": "thread-dedupe",
                    "runId": null,
                    "nodeId": null,
                    "role": "user",
                    "text": "Hydrated user prompt",
                    "attachments": [],
                    "streaming": false,
                    "createdBy": "user",
                    "creationSource": "web",
                    "createdAt": "2026-11-13T09:04:00.000Z",
                    "updatedAt": "2026-11-13T09:04:00.000Z"
                },
                {
                    "id": "msg-a1",
                    "threadId": "thread-dedupe",
                    "runId": null,
                    "nodeId": null,
                    "role": "assistant",
                    "text": "Hydrated assistant reply",
                    "attachments": [],
                    "streaming": false,
                    "createdBy": "agent",
                    "creationSource": "provider",
                    "createdAt": "2026-11-13T09:04:01.000Z",
                    "updatedAt": "2026-11-13T09:04:01.000Z"
                }
            ],
            "plans": [],
            "turnItems": [],
            "checkpointScopes": [],
            "checkpoints": [],
            "contextHandoffs": [],
            "contextTransfers": [],
            "visibleTurnItems": [
                {
                    "position": 0,
                    "visibility": "local",
                    "sourceThreadId": "thread-dedupe",
                    "sourceItemId": "item-u1",
                    "item": {
                        "type": "user_message",
                        "id": "item-u1",
                        "threadId": "thread-dedupe",
                        "runId": null,
                        "nodeId": "node-1",
                        "parentItemId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "ordinal": 1,
                        "status": "completed",
                        "title": null,
                        "startedAt": "2026-11-13T09:04:00.000Z",
                        "completedAt": "2026-11-13T09:04:00.000Z",
                        "updatedAt": "2026-11-13T09:04:00.000Z",
                        "messageId": "msg-u1",
                        "text": "",
                        "textOmitted": true,
                        "attachments": [],
                        "createdBy": "user",
                        "creationSource": "web",
                        "inputIntent": "turn_start"
                    }
                },
                {
                    "position": 1,
                    "visibility": "local",
                    "sourceThreadId": "thread-dedupe",
                    "sourceItemId": "item-a1",
                    "item": {
                        "type": "assistant_message",
                        "id": "item-a1",
                        "threadId": "thread-dedupe",
                        "runId": null,
                        "nodeId": "node-1",
                        "parentItemId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "ordinal": 2,
                        "status": "completed",
                        "title": null,
                        "startedAt": "2026-11-13T09:04:01.000Z",
                        "completedAt": "2026-11-13T09:04:01.000Z",
                        "updatedAt": "2026-11-13T09:04:01.000Z",
                        "messageId": "msg-a1",
                        "text": "",
                        "textOmitted": true,
                        "streaming": false
                    }
                }
            ],
            "updatedAt": "2026-11-13T09:05:00.000Z"
        }
    }));

    assert!(state.apply(snap), "compact deduped snapshot should apply");
    assert_eq!(
        state.entries.len(),
        2,
        "expected user and assistant entries"
    );
    assert!(
        matches!(&state.entries[0], TimelineEntry::User { text, .. } if text == "Hydrated user prompt"),
        "expected hydrated user prompt, got {:?}",
        state.entries[0]
    );
    assert!(
        matches!(&state.entries[1], TimelineEntry::Assistant { markdown, .. } if markdown == "Hydrated assistant reply"),
        "expected hydrated assistant reply, got {:?}",
        state.entries[1]
    );
}

#[test]
fn thread_bounded_snapshot_multi_page_prepend_and_deduplication() {
    fn projected_user(position: i64, id: &str, text: &str, ts: &str) -> Value {
        json!({
            "position": position,
            "visibility": "local",
            "sourceThreadId": "thread-bounded",
            "sourceItemId": id,
            "item": {
                "type": "user_message",
                "id": id,
                "threadId": "thread-bounded",
                "runId": format!("run-{id}"),
                "nodeId": null,
                "parentItemId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "ordinal": position + 1,
                "status": "completed",
                "title": null,
                "startedAt": ts,
                "completedAt": ts,
                "updatedAt": ts,
                "messageId": format!("msg-{id}"),
                "text": text,
                "attachments": [],
                "createdBy": "user",
                "creationSource": "web",
                "inputIntent": "turn_start"
            }
        })
    }

    fn projected_assistant(position: i64, id: &str, text: &str, ts: &str) -> Value {
        json!({
            "position": position,
            "visibility": "local",
            "sourceThreadId": "thread-bounded",
            "sourceItemId": id,
            "item": {
                "type": "assistant_message",
                "id": id,
                "threadId": "thread-bounded",
                "runId": format!("run-{id}"),
                "nodeId": null,
                "parentItemId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "ordinal": position + 1,
                "status": "completed",
                "title": null,
                "startedAt": ts,
                "completedAt": ts,
                "updatedAt": ts,
                "messageId": format!("msg-{id}"),
                "text": text,
                "streaming": false
            }
        })
    }

    let make_snapshot = |history_cursor: Option<&str>, has_more: Option<bool>| {
        let mut obj = json!({
            "kind": "snapshot",
            "snapshotSequence": 50,
            "projection": {
                "thread": {
                    "createdBy": "user",
                    "creationSource": "web",
                    "id": "thread-bounded",
                    "projectId": "proj-1",
                    "title": "Long thread",
                    "providerInstanceId": "claudeAgent",
                    "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                    "runtimeMode": "full-access",
                    "interactionMode": "default",
                    "branch": null,
                    "worktreePath": null,
                    "lineage": { "rootThreadId": "thread-bounded", "parentThreadId": null, "relationshipToParent": null },
                    "forkedFrom": null,
                    "activeProviderThreadId": null,
                    "createdAt": "2026-11-13T09:00:00.000Z",
                    "updatedAt": "2026-11-13T09:10:00.000Z",
                    "archivedAt": null,
                    "settledOverride": null,
                    "settledAt": null,
                    "deletedAt": null
                },
                "runs": [],
                "attempts": [],
                "nodes": [],
                "subagents": [],
                "providerSessions": [],
                "providerThreads": [],
                "providerTurns": [],
                "runtimeRequests": [],
                "messages": [],
                "plans": [],
                "turnItems": [],
                "checkpointScopes": [],
                "checkpoints": [],
                "contextHandoffs": [],
                "contextTransfers": [],
                "visibleTurnItems": [
                    projected_user(10, "u3", "Latest prompt", "2026-11-13T09:09:00.000Z"),
                    projected_assistant(11, "a3", "Latest reply (live)", "2026-11-13T09:09:10.000Z")
                ],
                "updatedAt": "2026-11-13T09:10:00.000Z"
            }
        });
        if let Some(map) = obj.as_object_mut() {
            if let Some(cursor) = history_cursor {
                map.insert("historyCursor".to_owned(), json!(cursor));
            }
            if let Some(more) = has_more {
                map.insert("hasMoreHistory".to_owned(), json!(more));
            }
        }
        decode_thread(obj)
    };

    // 1. Backwards-compatibility: snapshot omitting bounded fields defaults has_more_history=false.
    let mut legacy = ThreadState::new("thread-bounded");
    legacy.apply(make_snapshot(None, None));
    assert!(!legacy.has_more_history);
    assert_eq!(legacy.history_cursor, None);
    assert!(!legacy.loading_earlier);

    // 2. Bounded snapshot populates history_cursor and has_more_history.
    let mut state = ThreadState::new("thread-bounded");
    state.apply(make_snapshot(Some("cursor-page-2"), Some(true)));
    assert!(state.has_more_history);
    assert_eq!(state.history_cursor.as_deref(), Some("cursor-page-2"));
    assert!(!state.loading_earlier);
    assert_eq!(state.sequence, Some(50));

    // 3. First history page: out-of-order positions + overlapping existing ID ("u3") + duplicate ID in page.
    state.loading_earlier = true;
    let page_2: conn_contract::OrchestrationV2ThreadHistoryPage = match from_json(json!({
        "snapshotSequence": 60,
        "items": [
            projected_assistant(5, "a2", "Middle reply", "2026-11-13T09:05:10.000Z"),
            projected_user(4, "u2", "Middle prompt", "2026-11-13T09:05:00.000Z"),
            projected_user(10, "u3", "Stale overlapping prompt", "2026-11-13T09:09:00.000Z")
        ],
        "nextCursor": "cursor-page-1",
        "hasMoreHistory": true
    })) {
        Ok(p) => p,
        Err(err) => panic!("failed to decode page_2: {err}"),
    };
    let added_2 = state.prepend_history_page(page_2);
    assert_eq!(added_2, 2, "overlapping existing u3 must be deduplicated");
    assert!(!state.loading_earlier, "prepend must clear loading_earlier");
    assert!(state.has_more_history);
    assert_eq!(state.history_cursor.as_deref(), Some("cursor-page-1"));
    assert_eq!(
        state.sequence,
        Some(50),
        "history page must not advance WS resume sequence"
    );
    let ids_after_p2: Vec<&str> = state.entries.iter().map(TimelineEntry::id).collect();
    assert_eq!(
        ids_after_p2,
        vec!["u2", "a2", "u3", "a3"],
        "prepended page must be sorted by position and placed ahead of existing entries"
    );
    assert!(
        matches!(&state.entries[2], TimelineEntry::User { text, .. } if text == "Latest prompt"),
        "existing live entry u3 must not be overwritten by older page"
    );
    assert_eq!(
        state.entry_run_id("a2"),
        Some("run-a2"),
        "timings must be recorded for prepended entries"
    );

    // 4. Second (final) history page clears has_more_history and history_cursor.
    state.loading_earlier = true;
    let page_1: conn_contract::OrchestrationV2ThreadHistoryPage = match from_json(json!({
        "snapshotSequence": 61,
        "items": [
            projected_user(0, "u1", "First prompt", "2026-11-13T09:00:00.000Z"),
            projected_assistant(1, "a1", "First reply", "2026-11-13T09:00:10.000Z"),
            projected_user(4, "u2", "Duplicate from page 2", "2026-11-13T09:05:00.000Z")
        ],
        "nextCursor": null,
        "hasMoreHistory": false
    })) {
        Ok(p) => p,
        Err(err) => panic!("failed to decode page_1: {err}"),
    };
    let added_1 = state.prepend_history_page(page_1);
    assert_eq!(added_1, 2);
    assert!(!state.has_more_history);
    assert_eq!(state.history_cursor, None);
    assert!(!state.loading_earlier);
    let ids_after_p1: Vec<&str> = state.entries.iter().map(TimelineEntry::id).collect();
    assert_eq!(
        ids_after_p1,
        vec!["u1", "a1", "u2", "a2", "u3", "a3"],
        "multi-page prepend must assemble complete chronological timeline"
    );
}

#[test]
fn thread_queued_messages_appear_edit_cancel_and_transition_to_user() {
    let mut state = ThreadState::new("thread-q");

    // 1. Snapshot with an active running turn and one queued run + message (with image attachment).
    let snap = decode_thread(json!({
        "kind": "snapshot",
        "snapshotSequence": 10,
        "projection": {
            "thread": thread_json("thread-q", "proj-1", "Queued test", "running", "2026-11-22T12:00:00.000Z", None),
            "runs": [
                {
                    "id": "run-active",
                    "threadId": "thread-q",
                    "ordinal": 1,
                    "providerInstanceId": "claudeAgent",
                    "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                    "providerThreadId": null,
                    "userMessageId": "msg-1",
                    "rootNodeId": null,
                    "activeAttemptId": null,
                    "status": "running",
                    "requestedAt": "2026-11-22T12:00:00.000Z",
                    "startedAt": "2026-11-22T12:00:00.000Z",
                    "completedAt": null,
                    "checkpointId": null,
                    "contextHandoffId": null
                },
                {
                    "id": "run-q1",
                    "threadId": "thread-q",
                    "ordinal": 2,
                    "providerInstanceId": "claudeAgent",
                    "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                    "providerThreadId": null,
                    "userMessageId": "msg-q1",
                    "rootNodeId": null,
                    "activeAttemptId": null,
                    "status": "queued",
                    "queuePosition": 1,
                    "requestedAt": "2026-11-22T12:00:05.000Z",
                    "startedAt": null,
                    "completedAt": null,
                    "checkpointId": null,
                    "contextHandoffId": null
                }
            ],
            "attempts": [],
            "nodes": [],
            "subagents": [],
            "providerSessions": [],
            "providerThreads": [],
            "providerTurns": [],
            "runtimeRequests": [],
            "messages": [
                {
                    "id": "msg-q1",
                    "threadId": "thread-q",
                    "runId": "run-q1",
                    "nodeId": null,
                    "role": "user",
                    "text": "First queued prompt",
                    "attachments": [
                        {
                            "type": "image",
                            "id": "att-img-1",
                            "name": "screenshot.png",
                            "mimeType": "image/png",
                            "sizeBytes": 4096
                        }
                    ],
                    "streaming": false,
                    "createdBy": "user",
                    "creationSource": "web",
                    "createdAt": "2026-11-22T12:00:05.000Z",
                    "updatedAt": "2026-11-22T12:00:05.000Z"
                }
            ],
            "plans": [],
            "turnItems": [],
            "checkpointScopes": [],
            "checkpoints": [],
            "contextHandoffs": [],
            "contextTransfers": [],
            "visibleTurnItems": [
                {
                    "position": 0,
                    "visibility": "local",
                    "sourceThreadId": "thread-q",
                    "sourceItemId": "item-1",
                    "item": {
                        "id": "item-1",
                        "threadId": "thread-q",
                        "runId": "run-active",
                        "nodeId": null,
                        "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": null,
                        "parentItemId": null,
                        "ordinal": 1,
                        "status": "completed",
                        "title": null,
                        "startedAt": "2026-11-22T12:00:00.000Z",
                        "completedAt": "2026-11-22T12:00:00.000Z",
                        "updatedAt": "2026-11-22T12:00:00.000Z",
                        "createdBy": "user",
                        "creationSource": "web",
                        "type": "user_message",
                        "messageId": "msg-1",
                        "inputIntent": "turn_start",
                        "text": "Active prompt",
                        "attachments": []
                    }
                }
            ],
            "updatedAt": "2026-11-22T12:00:05.000Z"
        }
    }));

    assert!(state.apply(snap), "snapshot with queued run should apply");
    assert!(state.working, "active run should mark working=true");
    assert_eq!(
        state.active_run_id(),
        Some("run-active"),
        "active_run_id should return the running run"
    );
    assert_eq!(
        state.entries.len(),
        2,
        "snapshot should contain active user message and trailing queued message"
    );
    assert!(
        matches!(
            &state.entries[1],
            TimelineEntry::QueuedUser {
                run_id,
                message_id,
                text,
                attachments,
                created_at,
                created_by_agent: false,
                ..
            } if run_id == "run-q1"
                && message_id == "msg-q1"
                && text == "First queued prompt"
                && attachments.len() == 1
                && created_at == "2026-11-22T12:00:05.000Z"
        ),
        "queued run should surface as TimelineEntry::QueuedUser with attachment preserved, got {:?}",
        state.entries[1]
    );

    // 2. Live edit (`queued-run.edit` emits `message.updated`).
    let edit_event = decode_thread(json!({
        "kind": "event",
        "sequence": 11,
        "event": {
            "id": "ev-edit-q1",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:10.000Z",
            "type": "message.updated",
            "payload": {
                "id": "msg-q1",
                "threadId": "thread-q",
                "runId": "run-q1",
                "nodeId": null,
                "role": "user",
                "text": "Edited queued prompt",
                "attachments": [
                    {
                        "type": "image",
                        "id": "att-img-1",
                        "name": "screenshot.png",
                        "mimeType": "image/png",
                        "sizeBytes": 4096
                    }
                ],
                "streaming": false,
                "createdBy": "user",
                "creationSource": "web",
                "createdAt": "2026-11-22T12:00:05.000Z",
                "updatedAt": "2026-11-22T12:00:10.000Z"
            }
        }
    }));
    assert!(
        state.apply(edit_event),
        "editing a queued message via message.updated should report change"
    );
    assert!(
        matches!(
            &state.entries[1],
            TimelineEntry::QueuedUser { text, attachments, .. }
                if text == "Edited queued prompt" && attachments.len() == 1
        ),
        "queued entry text should update in place, got {:?}",
        state.entries[1]
    );

    // 3. Second queued run arrives via live run.created + message.updated, and a live tool streams
    //    ahead of both queued messages.
    let q2_run = decode_thread(json!({
        "kind": "event",
        "sequence": 12,
        "event": {
            "id": "ev-q2-run",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:12.000Z",
            "type": "run.created",
            "payload": {
                "id": "run-q2",
                "threadId": "thread-q",
                "ordinal": 3,
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "providerThreadId": null,
                "userMessageId": "msg-q2",
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": "queued",
                "queuePosition": 2,
                "requestedAt": "2026-11-22T12:00:12.000Z",
                "startedAt": null,
                "completedAt": null,
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }));
    state.apply(q2_run);
    let q2_msg = decode_thread(json!({
        "kind": "event",
        "sequence": 13,
        "event": {
            "id": "ev-q2-msg",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:12.000Z",
            "type": "message.updated",
            "payload": {
                "id": "msg-q2",
                "threadId": "thread-q",
                "runId": "run-q2",
                "nodeId": null,
                "role": "user",
                "text": "Second queued prompt",
                "attachments": [],
                "streaming": false,
                "createdBy": "user",
                "creationSource": "web",
                "createdAt": "2026-11-22T12:00:12.000Z",
                "updatedAt": "2026-11-22T12:00:12.000Z"
            }
        }
    }));
    assert!(
        state.apply(q2_msg),
        "message.updated for new queued run should append QueuedUser"
    );
    assert_eq!(state.entries.len(), 3, "should have 1 sent + 2 queued");

    let live_reply = decode_thread(json!({
        "kind": "event",
        "sequence": 14,
        "event": {
            "id": "ev-a1",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:13.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-a1",
                "threadId": "thread-q",
                "runId": "run-active",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 2,
                "status": "running",
                "title": null,
                "startedAt": "2026-11-22T12:00:13.000Z",
                "completedAt": null,
                "updatedAt": "2026-11-22T12:00:13.000Z",
                "type": "assistant_message",
                "messageId": "msg-a1",
                "text": "Working on it",
                "streaming": true
            }
        }
    }));
    assert!(state.apply(live_reply), "streaming reply should insert");
    assert!(
        matches!(&state.entries[1], TimelineEntry::Assistant { id, .. } if id == "item-a1"),
        "active turn item must insert ahead of trailing queued entries, got {:?}",
        state.entries
    );

    // 4. Cancel second queued message (`queued-run.cancel` -> `run.updated` status=cancelled).
    let cancel_q2 = decode_thread(json!({
        "kind": "event",
        "sequence": 15,
        "event": {
            "id": "ev-q2-cancel",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:14.000Z",
            "type": "run.updated",
            "payload": {
                "id": "run-q2",
                "threadId": "thread-q",
                "ordinal": 3,
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "providerThreadId": null,
                "userMessageId": "msg-q2",
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": "cancelled",
                "requestedAt": "2026-11-22T12:00:12.000Z",
                "startedAt": null,
                "completedAt": "2026-11-22T12:00:14.000Z",
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }));
    assert!(state.apply(cancel_q2), "cancelling q2 should update state");
    assert!(
        state.working,
        "cancelling a queued run must NOT clear working while run-active is still running"
    );
    assert_eq!(
        state.entries.len(),
        3,
        "cancelled queued message should disappear"
    );

    // 5. Promote first queued message to steer (`run.updated` cancelled + `turn-item.updated`
    //    with `promoted_queued_to_steer` / `completed`).
    let promote_cancel = decode_thread(json!({
        "kind": "event",
        "sequence": 16,
        "event": {
            "id": "ev-q1-promote-run",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:15.000Z",
            "type": "run.updated",
            "payload": {
                "id": "run-q1",
                "threadId": "thread-q",
                "ordinal": 2,
                "providerInstanceId": "claudeAgent",
                "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
                "providerThreadId": null,
                "userMessageId": "msg-q1",
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": "cancelled",
                "requestedAt": "2026-11-22T12:00:05.000Z",
                "startedAt": null,
                "completedAt": "2026-11-22T12:00:15.000Z",
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }));
    assert!(
        state.apply(promote_cancel),
        "promote run cancel should apply"
    );
    let promote_item = decode_thread(json!({
        "kind": "event",
        "sequence": 17,
        "event": {
            "id": "ev-q1-promote-item",
            "threadId": "thread-q",
            "occurredAt": "2026-11-22T12:00:15.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "turn-item:msg-q1",
                "threadId": "thread-q",
                "runId": "run-active",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 3,
                "status": "completed",
                "title": null,
                "startedAt": "2026-11-22T12:00:15.000Z",
                "completedAt": "2026-11-22T12:00:15.000Z",
                "updatedAt": "2026-11-22T12:00:15.000Z",
                "createdBy": "user",
                "creationSource": "web",
                "type": "user_message",
                "messageId": "msg-q1",
                "inputIntent": "promoted_queued_to_steer",
                "text": "Edited queued prompt",
                "attachments": []
            }
        }
    }));
    assert!(state.apply(promote_item), "promoted turn item should apply");
    assert!(
        !state
            .entries
            .iter()
            .any(|e| matches!(e, TimelineEntry::QueuedUser { .. })),
        "promoted message should no longer be QueuedUser"
    );
    assert!(
        matches!(
            state.entries.last(),
            Some(TimelineEntry::User { id, text, created_by_agent: false, .. })
                if id == "turn-item:msg-q1" && text == "Edited queued prompt"
        ),
        "promoted queued message should transition to normal TimelineEntry::User, got {:?}",
        state.entries.last()
    );
}

#[test]
fn thread_pending_queued_turn_item_transitions_to_user_and_cancel() {
    let mut state = ThreadState::new("thread-pending-ti");

    // 1. Standalone pending QueuedTurn user_message turn item appears as QueuedUser.
    let pending = decode_thread(json!({
        "kind": "event",
        "sequence": 1,
        "event": {
            "id": "ev-ti-q1",
            "threadId": "thread-pending-ti",
            "occurredAt": "2026-11-22T12:10:00.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-q1",
                "threadId": "thread-pending-ti",
                "runId": "run-q1",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 1,
                "status": "pending",
                "title": null,
                "startedAt": "2026-11-22T12:10:00.000Z",
                "completedAt": null,
                "updatedAt": "2026-11-22T12:10:00.000Z",
                "createdBy": "user",
                "creationSource": "web",
                "type": "user_message",
                "messageId": "msg-q1",
                "inputIntent": "queued_turn",
                "text": "Wait my turn",
                "attachments": []
            }
        }
    }));
    assert!(
        state.apply(pending),
        "pending queued turn item should apply"
    );
    assert!(
        matches!(
            state.entries.as_slice(),
            [TimelineEntry::QueuedUser { id, run_id, text, .. }]
                if id == "item-q1" && run_id == "run-q1" && text == "Wait my turn"
        ),
        "pending QueuedTurn must map to QueuedUser, got {:?}",
        state.entries
    );

    // 2. Transitions from pending -> completed (started): becomes normal User entry.
    let started = decode_thread(json!({
        "kind": "event",
        "sequence": 2,
        "event": {
            "id": "ev-ti-q1-started",
            "threadId": "thread-pending-ti",
            "occurredAt": "2026-11-22T12:10:05.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-q1",
                "threadId": "thread-pending-ti",
                "runId": "run-q1",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 1,
                "status": "completed",
                "title": null,
                "startedAt": "2026-11-22T12:10:00.000Z",
                "completedAt": "2026-11-22T12:10:05.000Z",
                "updatedAt": "2026-11-22T12:10:05.000Z",
                "createdBy": "user",
                "creationSource": "web",
                "type": "user_message",
                "messageId": "msg-q1",
                "inputIntent": "queued_turn",
                "text": "Wait my turn",
                "attachments": []
            }
        }
    }));
    assert!(
        state.apply(started),
        "started queued turn item should apply"
    );
    assert!(
        matches!(
            state.entries.as_slice(),
            [TimelineEntry::User { id, text, created_by_agent: false, .. }]
                if id == "item-q1" && text == "Wait my turn"
        ),
        "started queued turn item must transition cleanly into TimelineEntry::User, got {:?}",
        state.entries
    );

    // 3. Another pending queued item cancelled via turn-item.updated disappears.
    let pending2 = decode_thread(json!({
        "kind": "event",
        "sequence": 3,
        "event": {
            "id": "ev-ti-q2",
            "threadId": "thread-pending-ti",
            "occurredAt": "2026-11-22T12:10:10.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-q2",
                "threadId": "thread-pending-ti",
                "runId": "run-q2",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 2,
                "status": "pending",
                "title": null,
                "startedAt": "2026-11-22T12:10:10.000Z",
                "completedAt": null,
                "updatedAt": "2026-11-22T12:10:10.000Z",
                "createdBy": "user",
                "creationSource": "web",
                "type": "user_message",
                "messageId": "msg-q2",
                "inputIntent": "queued_turn",
                "text": "Cancel me",
                "attachments": []
            }
        }
    }));
    assert!(
        state.apply(pending2),
        "second pending queued item should apply"
    );
    assert_eq!(state.entries.len(), 2, "second queued item should appear");

    let cancelled2 = decode_thread(json!({
        "kind": "event",
        "sequence": 4,
        "event": {
            "id": "ev-ti-q2-cancel",
            "threadId": "thread-pending-ti",
            "occurredAt": "2026-11-22T12:10:12.000Z",
            "type": "turn-item.updated",
            "payload": {
                "id": "item-q2",
                "threadId": "thread-pending-ti",
                "runId": "run-q2",
                "nodeId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "nativeItemRef": null,
                "parentItemId": null,
                "ordinal": 2,
                "status": "cancelled",
                "title": null,
                "startedAt": "2026-11-22T12:10:10.000Z",
                "completedAt": "2026-11-22T12:10:12.000Z",
                "updatedAt": "2026-11-22T12:10:12.000Z",
                "createdBy": "user",
                "creationSource": "web",
                "type": "user_message",
                "messageId": "msg-q2",
                "inputIntent": "queued_turn",
                "text": "Cancel me",
                "attachments": []
            }
        }
    }));
    assert!(
        state.apply(cancelled2),
        "cancelling pending queued item should report change"
    );
    assert_eq!(
        state.entries.len(),
        1,
        "cancelled pending queued item should be removed"
    );
}

/// Builds a `turn-item.updated` event with the common turn-item base fields merged into
/// `fields`.
fn turn_item_event(sequence: i64, fields: Value) -> ThreadStreamItem {
    let mut payload = json!({
        "threadId": "thread-cards",
        "runId": "run-1",
        "nodeId": null,
        "providerThreadId": null,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": sequence,
        "title": null,
        "startedAt": "2026-11-22T10:00:00.000Z",
        "completedAt": null,
        "updatedAt": "2026-11-22T10:00:05.000Z"
    });
    if let (Some(base), Value::Object(extra)) = (payload.as_object_mut(), fields) {
        base.extend(extra);
    }
    decode_thread(json!({
        "kind": "event",
        "sequence": sequence,
        "event": {
            "id": format!("ev-{sequence}"),
            "threadId": "thread-cards",
            "occurredAt": "2026-11-22T10:00:05.000Z",
            "type": "turn-item.updated",
            "payload": payload
        }
    }))
}

fn run_event(
    sequence: i64,
    kind: &str,
    run_id: &str,
    ordinal: i64,
    status: &str,
) -> ThreadStreamItem {
    decode_thread(json!({
        "kind": "event",
        "sequence": sequence,
        "event": {
            "id": format!("ev-run-{sequence}"),
            "threadId": "thread-cards",
            "occurredAt": "2026-11-22T10:00:00.000Z",
            "type": kind,
            "payload": {
                "id": run_id,
                "threadId": "thread-cards",
                "ordinal": ordinal,
                "providerInstanceId": "codex",
                "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
                "providerThreadId": null,
                "userMessageId": format!("msg-{run_id}"),
                "rootNodeId": null,
                "activeAttemptId": null,
                "status": status,
                "requestedAt": "2026-11-22T10:00:00.000Z",
                "startedAt": "2026-11-22T10:00:00.000Z",
                "completedAt": null,
                "checkpointId": null,
                "contextHandoffId": null
            }
        }
    }))
}

#[test]
fn user_input_request_maps_to_interactive_card_and_answer_history() {
    let mut state = ThreadState::new("thread-cards");
    let pending = turn_item_event(
        1,
        json!({
            "id": "item-q",
            "status": "waiting",
            "type": "user_input_request",
            "requestId": "req-q",
            "responseMode": "message",
            "questions": [
                {
                    "id": "q-lang",
                    "header": "Language",
                    "question": "Which **language**?",
                    "options": [
                        { "label": "Rust", "description": "Fast" },
                        { "label": "Go", "description": "Simple", "value": "golang" }
                    ]
                },
                {
                    "id": "q-tools",
                    "header": "Tools",
                    "question": "Pick tools",
                    "multiSelect": true,
                    "allowCustomAnswer": false,
                    "options": [
                        { "label": "fmt", "description": "" },
                        { "label": "clippy", "description": "" }
                    ]
                }
            ]
        }),
    );
    assert!(state.apply(pending), "pending question should apply");
    let Some(TimelineEntry::UserInputRequest {
        request_id,
        questions,
        pending,
        dismissible,
        answers,
        created_at,
        ..
    }) = state.entries.first()
    else {
        panic!("expected UserInputRequest, got {:?}", state.entries);
    };
    assert_eq!(
        request_id, "req-q",
        "request id is preserved for runtime-request.respond"
    );
    assert!(*pending, "waiting question without answer is pending");
    assert!(*dismissible, "message-mode questions are dismissible");
    assert!(answers.is_empty(), "pending question has no answers");
    assert_eq!(created_at.as_deref(), Some("2026-11-22T10:00:00.000Z"));
    assert_eq!(questions.len(), 2, "both questions map");
    assert!(questions[1].multi_select && !questions[1].allow_custom_answer);
    assert_eq!(
        questions[0].options[1].answer_value(),
        "golang",
        "value beats label"
    );
    assert!(
        !state
            .entries
            .iter()
            .any(|e| matches!(e, TimelineEntry::Approval { .. })),
        "questions must never render as Approve/Decline rows"
    );

    // Draft answers: single select replaces, multi select toggles, custom text wins.
    let lang = &questions[0];
    let tools = &questions[1];
    let mut drafts: HashMap<String, UserInputDraft> = HashMap::new();
    assert_eq!(
        build_user_input_answers(questions, &drafts),
        None,
        "unanswered"
    );
    let d = lang.toggle_option(None, "Rust");
    let d = lang.toggle_option(Some(&d), "golang");
    assert_eq!(
        d.selected,
        vec!["golang".to_owned()],
        "single select keeps one value"
    );
    assert!(lang.is_option_selected(Some(&d), "golang"));
    drafts.insert("q-lang".to_owned(), d);
    let t = tools.toggle_option(None, "fmt");
    let t = tools.toggle_option(Some(&t), "clippy");
    let t = tools.toggle_option(Some(&t), "fmt");
    assert_eq!(
        t.selected,
        vec!["clippy".to_owned()],
        "multi select toggles off"
    );
    assert_eq!(
        tools.toggle_option(Some(&t), "unknown"),
        t,
        "unknown option leaves the draft unchanged"
    );
    drafts.insert("q-tools".to_owned(), t);
    assert_eq!(
        build_user_input_answers(questions, &drafts),
        Some(vec![
            (
                "q-lang".to_owned(),
                UserInputAnswerValue::Single("golang".to_owned())
            ),
            (
                "q-tools".to_owned(),
                UserInputAnswerValue::Multi(vec!["clippy".to_owned()])
            ),
        ]),
        "all questions answered"
    );
    let custom = lang.set_custom_answer(drafts.get("q-lang"), "  Zig  ");
    assert!(custom.selected.is_empty(), "typing clears selections");
    assert!(!lang.is_option_selected(Some(&custom), "golang"));
    assert_eq!(
        lang.resolve_answer(Some(&custom)),
        Some(UserInputAnswerValue::Single("Zig".to_owned())),
        "custom answer is trimmed and wins"
    );
    assert_eq!(
        tools.set_custom_answer(drafts.get("q-tools"), "nope"),
        drafts["q-tools"],
        "custom answers are ignored when the provider disallows them"
    );

    // Answered: the same item now carries `questionAnswer` and renders as history.
    let answered = turn_item_event(
        2,
        json!({
            "id": "item-q",
            "status": "completed",
            "type": "user_input_request",
            "requestId": "req-q",
            "questions": [
                { "id": "q-lang", "header": "Language", "question": "Which language?", "options": [] },
                { "id": "q-tools", "header": "Tools", "question": "Pick tools", "options": [] }
            ],
            "questionAnswer": {
                "requestId": "req-q",
                "questionTextById": { "q-lang": "Which language do you want?" },
                "answers": { "q-lang": "golang", "q-tools": ["fmt", "clippy"] },
                "attachmentsByQuestionId": {}
            }
        }),
    );
    assert!(state.apply(answered), "answer should apply");
    let Some(TimelineEntry::UserInputRequest {
        pending,
        answers,
        dismissible,
        ..
    }) = state.entries.first()
    else {
        panic!("expected answered UserInputRequest");
    };
    assert!(!*pending, "answered question is no longer pending");
    assert!(!*dismissible, "non-message requests are not dismissible");
    assert_eq!(answers.len(), 2, "both answers recorded");
    assert_eq!(
        answers[0].question, "Which language do you want?",
        "questionTextById wins"
    );
    assert_eq!(answers[0].answer, "golang");
    assert_eq!(answers[1].answer, "fmt, clippy", "multi answers join");
}

#[test]
fn secret_request_maps_to_secret_card_with_status() {
    let mut state = ThreadState::new("thread-cards");
    let pending = turn_item_event(
        1,
        json!({
            "id": "item-secret",
            "status": "waiting",
            "type": "secret_request",
            "label": "GITHUB_TOKEN",
            "reason": "Needed to open the PR",
            "url": "https://github.com/settings/tokens",
            "placeholder": "ghp_...",
            "delivery": "file",
            "secretStatus": "pending"
        }),
    );
    assert!(state.apply(pending), "pending secret should apply");
    assert_eq!(
        state.entries,
        vec![TimelineEntry::SecretRequest {
            id: "item-secret".to_owned(),
            label: "GITHUB_TOKEN".to_owned(),
            reason: "Needed to open the PR".to_owned(),
            url: Some("https://github.com/settings/tokens".to_owned()),
            placeholder: Some("ghp_...".to_owned()),
            file_delivery: true,
            status: SecretRequestStatus::Pending,
            pending: true,
            created_at: Some("2026-11-22T10:00:00.000Z".to_owned()),
        }],
        "pending secret maps to a SecretRequest card, never an approval"
    );

    let saved = turn_item_event(
        2,
        json!({
            "id": "item-secret",
            "status": "completed",
            "type": "secret_request",
            "label": "GITHUB_TOKEN",
            "reason": "Needed to open the PR",
            "secretStatus": "saved"
        }),
    );
    assert!(state.apply(saved), "saved secret should apply");
    assert!(
        matches!(
            state.entries.first(),
            Some(TimelineEntry::SecretRequest {
                pending: false,
                status: SecretRequestStatus::Saved,
                url: None,
                file_delivery: false,
                ..
            })
        ),
        "saved secret is settled, got {:?}",
        state.entries
    );
}

#[test]
fn proposed_plan_maps_to_plan_card_with_title_and_preview() {
    let mut state = ThreadState::new("thread-cards");
    let body: String = (1..=25).map(|i| format!("- Step {i}\n")).collect();
    let markdown = format!("# Ship the timeline cards\n\n## Summary\n\nPort the cards.\n\n{body}");
    let plan = turn_item_event(
        1,
        json!({
            "id": "item-plan",
            "status": "completed",
            "type": "proposed_plan",
            "planId": "plan-1",
            "markdown": markdown,
            "streaming": false
        }),
    );
    assert!(state.apply(plan), "plan should apply");
    let Some(TimelineEntry::ProposedPlan {
        title,
        run_id,
        markdown: plan_md,
        status,
        ..
    }) = state.entries.first()
    else {
        panic!("expected ProposedPlan, got {:?}", state.entries);
    };
    assert_eq!(
        title, "Ship the timeline cards",
        "title comes from the first heading"
    );
    assert_eq!(run_id.as_deref(), Some("run-1"));
    assert_eq!(*status, ItemStatus::Completed);
    assert!(plan_can_collapse(plan_md), "25+ lines collapse");
    let display = strip_displayed_plan_markdown(plan_md);
    assert!(
        display.starts_with("Port the cards."),
        "title and Summary headings are stripped, got {display:?}"
    );
    let preview = collapsed_plan_preview(plan_md, 10);
    assert_eq!(
        preview.lines().filter(|l| !l.trim().is_empty()).count(),
        11,
        "10 lines + ..."
    );
    assert!(preview.ends_with("\n\n..."), "preview marks hidden content");
    assert!(
        !plan_can_collapse("# Short\n\nOne step."),
        "short plans stay open"
    );
}

#[test]
fn subagent_maps_to_clickable_link_with_status_and_detail() {
    let mut state = ThreadState::new("thread-cards");
    let running = turn_item_event(
        1,
        json!({
            "id": "item-sub",
            "status": "running",
            "title": "Subagent: /root/work/code_reviewer",
            "type": "subagent",
            "subagentId": "sub-1",
            "origin": "app_owned",
            "driver": "codex",
            "providerInstanceId": "codex",
            "childThreadId": "thread-child",
            "prompt": "Review the diff",
            "progress": "Reading [main.rs](src/main.rs)\n- `cargo test`",
            "result": null
        }),
    );
    assert!(state.apply(running), "subagent should apply");
    assert_eq!(
        state.entries,
        vec![TimelineEntry::Subagent {
            id: "item-sub".to_owned(),
            child_thread_id: Some("thread-child".to_owned()),
            title: "Code Reviewer".to_owned(),
            role: "codex".to_owned(),
            status: TurnItemStatus::Running,
            summary: Some("Reading main.rs cargo test".to_owned()),
            remote_label: None,
            created_at: Some("2026-11-22T10:00:05.000Z".to_owned()),
            started_at: Some("2026-11-22T10:00:00.000Z".to_owned()),
            completed_at: None,
        }],
        "subagent is a first-class link row, not a folded tool"
    );

    let done = turn_item_event(
        2,
        json!({
            "id": "item-sub",
            "status": "completed",
            "title": "Reviewer",
            "type": "subagent",
            "subagentId": "sub-1",
            "origin": "app_owned",
            "driver": "codex",
            "providerInstanceId": "codex",
            "childThreadId": null,
            "prompt": "Review the diff",
            "progress": "Still reading",
            "result": "Child task ended with status completed"
        }),
    );
    assert!(state.apply(done), "settled subagent should apply");
    assert!(
        matches!(
            state.entries.first(),
            Some(TimelineEntry::Subagent {
                child_thread_id: None,
                summary: None,
                status: TurnItemStatus::Completed,
                ..
            })
        ),
        "generic child-end result hides the detail, got {:?}",
        state.entries
    );
    assert_eq!(
        subagent_status_visual(TurnItemStatus::Completed),
        (SubagentTone::Success, "Completed")
    );
    assert_eq!(
        subagent_status_visual(TurnItemStatus::Interrupted),
        (SubagentTone::Stopped, "Stopped")
    );
    assert_eq!(format_subagent_display_title("Plain title"), "Plain title");
}

#[test]
fn user_message_preserves_attachments_steer_and_timestamps() {
    let mut state = ThreadState::new("thread-cards");
    assert!(state.apply(run_event(1, "run.created", "run-1", 1, "running")));
    let steer = turn_item_event(
        2,
        json!({
            "id": "item-steer",
            "status": "completed",
            "createdBy": "user",
            "creationSource": "web",
            "type": "user_message",
            "messageId": "msg-steer",
            "inputIntent": "promoted_queued_to_steer",
            "text": "Also update docs",
            "attachments": [
                { "type": "image", "id": "att-1", "name": "shot.png", "mimeType": "image/png", "sizeBytes": 42 }
            ]
        }),
    );
    assert!(state.apply(steer), "steer message should apply");
    let Some(TimelineEntry::User {
        is_steer,
        attachments,
        created_at,
        run_id,
        created_by_agent,
        ..
    }) = state.entries.first()
    else {
        panic!("expected user entry, got {:?}", state.entries);
    };
    assert!(
        *is_steer,
        "promoted-to-steer messages carry the Steer marker"
    );
    assert!(!*created_by_agent);
    assert_eq!(attachments.len(), 1, "attachments are preserved");
    assert_eq!(created_at.as_deref(), Some("2026-11-22T10:00:00.000Z"));
    assert_eq!(run_id.as_deref(), Some("run-1"));

    // Run status accessors drive `You stopped after ...` fold labels.
    assert_eq!(state.latest_run_id(), Some("run-1"));
    assert_eq!(state.run_status("run-1"), Some(RunStatus::Running));
    assert!(state.apply(run_event(3, "run.updated", "run-1", 1, "interrupted")));
    assert_eq!(state.run_status("run-1"), Some(RunStatus::Interrupted));

    // Day-aware timestamps and the ordinal tooltip.
    let now = LocalDateTime {
        year: 2026,
        month: 11,
        day: 22,
        hour: 15,
        minute: 0,
    };
    let at = |year, month, day| LocalDateTime {
        year,
        month,
        day,
        hour: 14,
        minute: 2,
    };
    assert_eq!(format_day_aware_timestamp(at(2026, 11, 22), now), "14:02");
    assert_eq!(
        format_day_aware_timestamp(at(2026, 11, 21), now),
        "yesterday at 14:02"
    );
    assert_eq!(
        format_day_aware_timestamp(at(2026, 11, 20), now),
        "11/20 14:02"
    );
    assert_eq!(
        format_day_aware_timestamp(at(2025, 12, 31), now),
        "12/31/2025 14:02"
    );
    assert_eq!(
        format_chat_timestamp_tooltip(at(2026, 11, 22)),
        "14:02, 22nd November 2026"
    );
    assert_eq!(
        format_chat_timestamp_tooltip(at(2026, 11, 11)),
        "14:02, 11th November 2026"
    );
    let utc = LocalDateTime::from_epoch_ms(
        conn_state::parse_iso8601_epoch_ms("2026-11-22T23:30:00Z").unwrap_or_default(),
        3_600,
    );
    assert_eq!(
        utc,
        LocalDateTime {
            year: 2026,
            month: 11,
            day: 23,
            hour: 0,
            minute: 30
        }
    );

    // Conn's `formatDuration`.
    assert_eq!(format_duration(0), "1ms");
    assert_eq!(format_duration(450), "450ms");
    assert_eq!(format_duration(2_000), "2s");
    assert_eq!(format_duration(7_500), "7.5s");
    assert_eq!(format_duration(59_600), "1m", "unit chosen after rounding");
    assert_eq!(format_duration(134_000), "2m 14s");
    assert_eq!(format_duration(3_725_000), "1h 2m 5s");
    assert_eq!(format_duration(3_600_000), "1h");
}

#[test]
fn checkpoint_keeps_changed_files_and_builds_tree() {
    let mut state = ThreadState::new("thread-cards");
    let captured = decode_thread(json!({
        "kind": "event",
        "sequence": 1,
        "event": {
            "id": "ev-cp",
            "threadId": "thread-cards",
            "occurredAt": "2026-11-22T10:01:00.000Z",
            "type": "checkpoint.captured",
            "payload": {
                "id": "cp-1",
                "threadId": "thread-cards",
                "scopeId": "scope-1",
                "runId": "run-1",
                "nodeId": "node-1",
                "parentCheckpointId": null,
                "ordinalWithinScope": 1,
                "appRunOrdinal": 3,
                "ref": "refs/conn/cp-1",
                "status": "ready",
                "files": [
                    { "path": "crates/app/src/chat/mod.rs", "kind": "modified", "additions": 10, "deletions": 2 },
                    { "path": "crates/app/src/chat/cache.rs", "kind": "modified", "additions": 3, "deletions": 1 },
                    { "path": "docs/status.md", "kind": "modified", "additions": 4, "deletions": 0 },
                    { "path": "README.md", "kind": "added", "additions": 1, "deletions": 0 }
                ],
                "filesTotal": { "count": 6, "additions": 30, "deletions": 5 },
                "capturedAt": "2026-11-22T10:01:00.000Z"
            }
        }
    }));
    assert!(state.apply(captured), "ready checkpoint should apply");
    let Some(cp) = state.checkpoint_for_run("run-1") else {
        panic!("checkpoint should be recorded for run-1");
    };
    assert_eq!(
        (cp.file_count, cp.additions, cp.deletions),
        (6, 30, 5),
        "totals win"
    );
    assert_eq!(cp.app_run_ordinal, Some(3));
    assert_eq!(
        cp.files.len(),
        4,
        "individual files are kept (server prefix)"
    );
    assert_eq!(
        cp.files[0],
        TurnCheckpointFile {
            path: "crates/app/src/chat/mod.rs".to_owned(),
            kind: "modified".to_owned(),
            additions: 10,
            deletions: 2,
        }
    );

    let tree = build_turn_diff_tree(&cp.files);
    let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["crates/app/src/chat", "docs", "README.md"],
        "single-child folders compact; folders sort before files"
    );
    assert_eq!(
        (tree[0].additions, tree[0].deletions),
        (13, 3),
        "folder stats sum"
    );
    let collapsed = flatten_turn_diff_tree(&tree, &HashMap::new(), false);
    assert_eq!(collapsed.len(), 3, "collapsed folders hide children");
    let expanded = flatten_turn_diff_tree(&tree, &HashMap::new(), true);
    let rows: Vec<(usize, &str)> = expanded
        .iter()
        .map(|r| (r.depth, r.name.as_str()))
        .collect();
    assert_eq!(
        rows,
        vec![
            (0, "crates/app/src/chat"),
            (1, "cache.rs"),
            (1, "mod.rs"),
            (0, "docs"),
            (1, "status.md"),
            (0, "README.md"),
        ],
        "expanded tree lists files under folders in name order"
    );
    assert_eq!(
        expanded[1].path, "crates/app/src/chat/cache.rs",
        "file rows keep full paths"
    );
    let mut overrides = HashMap::new();
    overrides.insert("docs".to_owned(), false);
    assert_eq!(
        flatten_turn_diff_tree(&tree, &overrides, true).len(),
        5,
        "per-folder override collapses one folder"
    );
}

#[test]
fn shell_enrichment_snapshot_preserves_threads_and_sequence() {
    let mut shell = ShellState::default();
    let initial = decode_shell(json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 14,
            "projects": [project_json("proj-1", "conn-demo", "2026-11-22T10:00:00.000Z")],
            "threads": [thread_json(
                "thread-1",
                "proj-1",
                "Demo thread",
                "completed",
                "2026-11-22T10:00:00.000Z",
                None,
            )],
            "archivedThreads": []
        }
    }));
    shell.apply(initial);
    assert_eq!(shell.threads.len(), 1);
    assert_eq!(shell.sequence, Some(14));

    // Enrichment-only snapshot carries `resolvedRepositoryIdentityRoots` with empty threads and
    // an older/different sequence; matching Conn's `mergeShellSnapshotProjects`, threads and
    // sequence must stay intact while repositoryIdentity updates.
    let mut enriched_project = project_json("proj-1", "conn-demo", "2026-11-22T10:00:00.000Z");
    enriched_project["repositoryIdentity"] = json!({
        "canonicalKey": "github.com/nckrtl/conn-demo",
        "locator": {
            "source": "git-remote",
            "remoteName": "origin",
            "remoteUrl": "https://github.com/nckrtl/conn-demo.git"
        }
    });
    let enrichment = decode_shell(json!({
        "kind": "snapshot",
        "resolvedRepositoryIdentityRoots": ["/tmp/proj-1"],
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 4,
            "projects": [enriched_project],
            "threads": [],
            "archivedThreads": []
        }
    }));
    let change = shell.apply(enrichment);
    assert!(change.projects_changed, "repository identity updated");
    assert!(change.threads_changed.is_empty(), "threads untouched");
    assert_eq!(
        shell.threads.len(),
        1,
        "enrichment snapshot must not wipe threads"
    );
    assert_eq!(
        shell.sequence,
        Some(14),
        "enrichment snapshot must not rewind sequence"
    );
    assert_eq!(
        shell.projects[0]
            .repository_identity
            .as_ref()
            .and_then(Option::as_ref)
            .map(|r| r.canonical_key.as_str()),
        Some("github.com/nckrtl/conn-demo")
    );
}
