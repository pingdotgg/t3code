//! Demo [`ShellState`] fixture decoded through `conn_contract::from_json`.
//!
//! Used when launching `conn-app` without a live `conn-server` connection so
//! the window shell, workspace rail, thread sidebar, status indicators, and
//! header breadcrumb can be inspected and tested standalone.

use conn_contract::from_json;
#[cfg(test)]
use conn_state::ThreadActivity;
use conn_state::{ProjectShell, ShellState, ThreadShell};
use serde_json::{Value, json};

/// Builds a realistic demo [`ShellState`] with 3 projects and 10 threads
/// (including one working thread, one needing attention, and one failed).
#[must_use]
pub(crate) fn demo_shell_state() -> ShellState {
    let projects_json = [
        project_json(
            "proj-conn-gpui",
            "conn-gpui",
            "/Users/nckrtl/apps/conn-gpui",
            "2026-11-20T09:00:00.000Z",
        ),
        project_json(
            "proj-conn-server",
            "conn-server",
            "/Users/nckrtl/apps/conn-server",
            "2026-11-19T14:30:00.000Z",
        ),
        project_json(
            "proj-orbit",
            "orbit",
            "/Users/nckrtl/apps/orbit",
            "2026-11-18T11:15:00.000Z",
        ),
    ];

    let threads_json = [
        thread_json(ThreadSeed {
            id: "thread-shell-chrome",
            project_id: "proj-conn-gpui",
            title: "Build native macOS frosted shell and 44px header",
            branch: Some("feat/gpui-shell"),
            status: "running",
            activity_run_status: Some("running"),
            pending_request: false,
            updated_at: "2026-11-21T01:08:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-theme-tokens",
            project_id: "proj-conn-gpui",
            title: "Derive Dark Ocean and Light shell tokens in sRGB",
            branch: Some("feat/theme-tokens"),
            status: "waiting",
            activity_run_status: Some("waiting"),
            pending_request: true,
            updated_at: "2026-11-21T00:54:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-ws-client",
            project_id: "proj-conn-gpui",
            title: "Wire Effect RPC handshake and stream acks",
            branch: Some("feat/conn-client"),
            status: "completed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-20T22:40:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-cef-spike",
            project_id: "proj-conn-gpui",
            title: "Investigate on-demand CEF offscreen surface",
            branch: Some("spike/cef-panel"),
            status: "idle",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-20T18:10:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-rpc-frames",
            project_id: "proj-conn-server",
            title: "Split large orchestration snapshot frames cleanly",
            branch: Some("fix/frame-parts"),
            status: "completed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-20T21:15:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-sqlite-wal",
            project_id: "proj-conn-server",
            title: "Tune SQLite WAL checkpointing under parallel runs",
            branch: Some("perf/wal-checkpoints"),
            status: "failed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-20T19:02:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-auth-ticket",
            project_id: "proj-conn-server",
            title: "Add short-lived WebSocket pairing tickets",
            branch: Some("main"),
            status: "completed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-19T16:45:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-orbit-doctor",
            project_id: "proj-orbit",
            title: "Surface Caddy reload drift in orbit doctor",
            branch: Some("feat/doctor-caddy"),
            status: "completed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-20T15:30:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-orbit-vpn",
            project_id: "proj-orbit",
            title: "Verify WireGuard peer rotation on workload nodes",
            branch: Some("feat/wg-rotation"),
            status: "idle",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-19T13:20:00.000Z",
        }),
        thread_json(ThreadSeed {
            id: "thread-orbit-php",
            project_id: "proj-orbit",
            title: "Bump default PHP-FPM pool workers for Laravel 12",
            branch: Some("main"),
            status: "completed",
            activity_run_status: None,
            pending_request: false,
            updated_at: "2026-11-18T17:05:00.000Z",
        }),
    ];

    let projects: Vec<ProjectShell> = projects_json
        .into_iter()
        .filter_map(|value| from_json::<ProjectShell>(value).ok())
        .collect();
    let threads: Vec<ThreadShell> = threads_json
        .into_iter()
        .filter_map(|value| from_json::<ThreadShell>(value).ok())
        .collect();

    ShellState::from_parts(projects, threads, Vec::new(), Some(42))
}

/// Resolves a thread's sidebar activity indicator.
///
/// Prefers [`ShellState::activity`] once `conn-state`'s reducer populates it,
/// and falls back to inspecting the decoded [`ThreadShell`] fields while
/// running against the stub `conn-state` crate. The sidebar now resolves Conn's full status
/// pills (`sidebar::thread_list::resolve_row_status`); fixture tests still use this.
#[cfg(test)]
#[must_use]
pub(crate) fn thread_activity(shell: &ShellState, thread: &ThreadShell) -> ThreadActivity {
    let from_state = shell.activity(&thread.id);
    if from_state != ThreadActivity::Idle {
        return from_state;
    }
    if thread.pending_runtime_request.is_some() {
        return ThreadActivity::NeedsAttention;
    }
    use conn_contract::OrchestrationV2ShellThreadStatus as Status;
    match thread.status {
        Status::Preparing | Status::Starting | Status::Running | Status::Waiting => {
            ThreadActivity::Working
        }
        Status::Failed => ThreadActivity::Failed,
        Status::Idle
        | Status::Queued
        | Status::Completed
        | Status::Interrupted
        | Status::Cancelled
        | Status::RolledBack => ThreadActivity::Idle,
    }
}

struct ThreadSeed<'a> {
    id: &'a str,
    project_id: &'a str,
    title: &'a str,
    branch: Option<&'a str>,
    status: &'a str,
    activity_run_status: Option<&'a str>,
    pending_request: bool,
    updated_at: &'a str,
}

fn project_json(id: &str, title: &str, workspace_root: &str, updated_at: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "workspaceRoot": workspace_root,
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": updated_at,
        "updatedAt": updated_at,
    })
}

fn thread_json(seed: ThreadSeed<'_>) -> Value {
    let pending_runtime_request = if seed.pending_request {
        json!({
            "id": format!("req-{}", seed.id),
            "kind": "permission",
            "createdAt": seed.updated_at,
            "blocking": true,
        })
    } else {
        Value::Null
    };

    json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": seed.id,
        "projectId": seed.project_id,
        "title": seed.title,
        "providerInstanceId": "claude-default",
        "modelSelection": {
            "provider": "claude",
            "model": "claude-sonnet-4-6"
        },
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": seed.branch,
        "worktreePath": null,
        "lineage": {
            "parentThreadId": null,
            "relationshipToParent": null,
            "rootThreadId": seed.id
        },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": "run-1",
        "activeRunId": seed.activity_run_status.map(|_| "run-1"),
        "activityRunStatus": seed.activity_run_status,
        "status": seed.status,
        "pendingRuntimeRequest": pending_runtime_request,
        "latestVisibleMessage": null,
        "latestUserMessageAt": seed.updated_at,
        "hasActionableProposedPlan": false,
        "itemCount": 6,
        "visibleItemCount": 4,
        "createdAt": seed.updated_at,
        "updatedAt": seed.updated_at,
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_fixture_decodes_all_projects_and_threads() {
        let shell = demo_shell_state();
        assert_eq!(shell.projects.len(), 3, "expected 3 demo projects");
        assert_eq!(shell.threads.len(), 10, "expected 10 demo threads");

        let working_count = shell
            .threads
            .iter()
            .filter(|t| thread_activity(&shell, t) == ThreadActivity::Working)
            .count();
        let attention_count = shell
            .threads
            .iter()
            .filter(|t| thread_activity(&shell, t) == ThreadActivity::NeedsAttention)
            .count();
        let failed_count = shell
            .threads
            .iter()
            .filter(|t| thread_activity(&shell, t) == ThreadActivity::Failed)
            .count();

        assert_eq!(working_count, 1, "expected 1 working thread");
        assert_eq!(attention_count, 1, "expected 1 needs-attention thread");
        assert_eq!(failed_count, 1, "expected 1 failed thread");
    }
}
