#![recursion_limit = "256"]

use conn_contract::from_json;
use conn_state::{
    ItemStatus, LayoutState, RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MAX_WIDTH,
    RIGHT_PANEL_MIN_WIDTH, RightPanelTab, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH, ShellChange, ShellState, ShellStreamItem, ThreadActivity, ThreadState,
    ThreadStreamItem, TimelineEntry,
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
            text: "Run tests".to_owned()
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
            status: ItemStatus::Completed
        },
        "second entry should be completed command tool"
    );
    assert_eq!(
        state.entries[2],
        TimelineEntry::Assistant {
            id: "item-a1".to_owned(),
            markdown: "All tests passed.".to_owned(),
            streaming: false
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
            streaming: true
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
            streaming: true
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
            streaming: false
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
