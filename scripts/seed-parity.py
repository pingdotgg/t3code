#!/usr/bin/env python3
"""Deterministic parity database seeder for disposable `:3891` Conn / conn-server (0.4.2).

Creates throwaway git repos and writes reproducible parity data covering every
core sidebar and timeline visual state (Pinned, Active, unselected Working,
Waiting/Approval, Failed, Settled, Subagent lineage, Proposed plan, Markdown/code,
and uncommitted git diffs) into:
  - `engine.sqlite` (for standalone Rust `conn-server`)
  - `statev2.sqlite` (when present, for `Conn.app`'s bundled TS server so both
    `Conn.app` and `Conn GPUI.app` render the exact same live `:3891` state)
  - `client-settings.json` (marks `onboardingCompletedAt` so `Conn.app` skips Welcome)

Usage:
  python3 scripts/seed-parity.py [--dev-dir /tmp/conn-gpui-dev] [--state-subdir userdata] [--statev2-only]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

ENGINE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS mcp_app_model_context (
 thread_id TEXT NOT NULL, item_id TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(thread_id,item_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  command_id TEXT,
  type      TEXT NOT NULL,
  streaming INTEGER NOT NULL DEFAULT 0,
  event     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id, seq);
CREATE INDEX IF NOT EXISTS created_runs_by_command ON events(command_id, seq) WHERE type = 'run.created';
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  activity_at TEXT NOT NULL,
  thread      TEXT NOT NULL,
  shell       TEXT
);
CREATE TABLE IF NOT EXISTS entities (
  thread_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  ordinal   INTEGER,
  body      TEXT NOT NULL,
  PRIMARY KEY (thread_id, kind, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entities_waiting_secrets
ON entities(thread_id, json_extract(body, '$.updatedAt') DESC, id DESC)
WHERE kind = 'turnItems' AND json_extract(body, '$.type') = 'secret_request'
  AND json_extract(body, '$.status') = 'waiting';
CREATE INDEX IF NOT EXISTS mcp_app_items ON entities(id, thread_id) WHERE kind='turnItems';
CREATE INDEX IF NOT EXISTS turn_items_in_order ON entities(thread_id, ordinal, id)
WHERE kind = 'turnItems';
CREATE INDEX IF NOT EXISTS turn_item_interrupts ON entities(thread_id, json_extract(body, '$.runId'))
WHERE kind = 'turnItems' AND json_extract(body, '$.type') = 'run_interrupt_request';
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL UNIQUE,
  body           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_changes (
  seq  INTEGER PRIMARY KEY,
  item TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS message_keys (
  id         INTEGER PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  message_id TEXT NOT NULL,
  UNIQUE (thread_id, message_id)
);
CREATE TABLE IF NOT EXISTS turn_item_positions (
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (thread_id, item_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  command_id TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  result     TEXT NOT NULL
);
"""


def run_git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def ensure_demo_repos(projects_dir: Path) -> tuple[Path, Path]:
    projects_dir.mkdir(parents=True, exist_ok=True)
    demo_app = projects_dir / "conn-demo"
    hello = projects_dir / "hello-rust"

    for repo, files, branch in (
        (
            demo_app,
            {
                "README.md": "# conn-demo\n\nDeterministic parity workspace for Conn vs Conn GPUI.\n",
                "src/sidebar.rs": "pub fn row_height() -> f32 {\n    52.0\n}\n",
                "src/subagent_card.rs": "pub fn card_padding() -> f32 {\n    12.0\n}\n",
                ".gitignore": "/target\n",
            },
            "feat/ui-parity",
        ),
        (
            hello,
            {
                "Cargo.toml": '[package]\nname = "hello-rust"\nversion = "0.1.0"\nedition = "2024"\n',
                "src/main.rs": 'fn main() {\n    println!("hello from conn-gpui");\n}\n',
                "README.md": "# hello-rust\n\nTiny demo repo for diff and terminal checks.\n",
                ".gitignore": "/target\n",
            },
            "main",
        ),
    ):
        if repo.exists():
            shutil.rmtree(repo)
        repo.mkdir(parents=True)
        for rel, content in files.items():
            target = repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        run_git(repo, "init", "-q", "-b", "main")
        run_git(repo, "add", ".")
        run_git(
            repo,
            "-c",
            "user.name=Conn Parity",
            "-c",
            "user.email=parity@conn.local",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Initial parity commit",
        )
        if branch != "main":
            run_git(repo, "checkout", "-q", "-b", branch)

    # Leave an uncommitted edit in conn-demo so Files & Diff panels always have live changes.
    (demo_app / "src/sidebar.rs").write_text(
        "pub fn row_height() -> f32 {\n    // Matches Conn two-line row height.\n    48.0\n}\n",
        encoding="utf-8",
    )
    return demo_app, hello


def build_parity_dataset(demo_app: Path, hello: Path) -> dict:
    projects = [
        {
            "id": "proj-conn-demo",
            "title": "conn-demo",
            "workspaceRoot": str(demo_app),
            "defaultModelSelection": None,
            "scripts": [
                {
                    "id": "script-check",
                    "name": "Check",
                    "command": "cargo check",
                    "icon": "play",
                    "runOnWorktreeCreate": False,
                }
            ],
            "createdAt": "2026-11-20T09:00:00.000Z",
            "updatedAt": "2026-11-22T15:00:00.000Z",
            "deletedAt": None,
        },
        {
            "id": "proj-hello-rust",
            "title": "hello-rust",
            "workspaceRoot": str(hello),
            "defaultModelSelection": None,
            "scripts": [],
            "createdAt": "2026-11-20T09:05:00.000Z",
            "updatedAt": "2026-11-22T14:45:00.000Z",
            "deletedAt": None,
        },
    ]

    def make_thread(
        *,
        thread_id: str,
        project_id: str,
        title: str,
        branch: str,
        status: str,
        created_at: str,
        updated_at: str,
        model: str = "claude-sonnet-4-6",
        provider_instance_id: str = "claudeAgent",
        pinned_at: str | None = None,
        pin_order_key: str | None = None,
        settled_at: str | None = None,
        last_visited_at: str | None = "2026-11-22T15:00:00.000Z",
        activity_run_status: str | None = None,
        pending_request: dict | None = None,
        last_error: str | None = None,
        parent_thread_id: str | None = None,
        subagent_count: int = 0,
        item_count: int = 2,
    ) -> dict:
        lineage = {
            "parentThreadId": parent_thread_id,
            "relationshipToParent": "subagent" if parent_thread_id else None,
            "rootThreadId": parent_thread_id or thread_id,
        }
        model_selection = {"instanceId": provider_instance_id, "model": model}
        created_by = "agent" if parent_thread_id else "user"
        creation_source = "provider" if parent_thread_id else "web"
        run_id = f"run-{thread_id}-1"
        att_id = f"att-{thread_id}-1"
        node_id = f"node-{thread_id}-root"
        pt_id = f"pt-{thread_id}"

        settled_override = "settled" if settled_at else None
        thread_body = {
            "id": thread_id,
            "projectId": project_id,
            "title": title,
            "createdBy": created_by,
            "creationSource": creation_source,
            "providerInstanceId": provider_instance_id,
            "modelSelection": model_selection,
            "runtimeMode": "auto-accept-edits",
            "interactionMode": "default",
            "branch": branch,
            "worktreePath": None,
            "pullRequests": [],
            "lineage": lineage,
            "forkedFrom": None,
            "activeProviderThreadId": pt_id,
            "tags": [],
            "createdAt": created_at,
            "updatedAt": updated_at,
            "archivedAt": None,
            "settledOverride": settled_override,
            "settledAt": settled_at,
            "unsettledAt": None,
            "snoozedUntil": None,
            "snoozedAt": None,
            "pinnedAt": pinned_at,
            "autoSettleDisabledAt": None,
            "pinOrderKey": pin_order_key,
            "activeOrderKey": None,
            "lastVisitedAt": last_visited_at,
            "opens": None,
            "titleRegeneration": None,
            "lastTitleRegeneration": None,
            "limitRecovery": None,
            "deletedAt": None,
        }
        shell_body = {
            "createdBy": created_by,
            "creationSource": creation_source,
            "id": thread_id,
            "projectId": project_id,
            "title": title,
            "providerInstanceId": provider_instance_id,
            "modelSelection": model_selection,
            "runtimeMode": "auto-accept-edits",
            "interactionMode": "default",
            "branch": branch,
            "worktreePath": None,
            "pullRequests": [],
            "lineage": lineage,
            "forkedFrom": None,
            "activeProviderThreadId": pt_id,
            "latestRunId": run_id,
            "latestRunRequestedAt": created_at,
            "latestRunStartedAt": created_at,
            "latestRunCompletedAt": None if activity_run_status else updated_at,
            "latestRunStopRequested": False,
            "latestRunBackgroundWake": False,
            "activeRunId": run_id if activity_run_status in ("preparing", "starting", "running") else None,
            "blockedOnThreadWait": False,
            "activityRunStatus": activity_run_status,
            "activityRunStartedAt": created_at if activity_run_status else None,
            "status": status,
            "lastError": last_error,
            "lastErrorClass": "provider_error" if last_error else None,
            "lastErrorCode": "provider_error" if last_error else None,
            "usageLimitResetAt": None,
            "pendingRuntimeRequest": pending_request,
            "pendingGuestMessageCount": 0,
            "latestVisibleMessage": None,
            "latestUserMessageAt": created_at,
            "latestUserAuthoredMessageAt": created_at,
            "hasActionableProposedPlan": False,
            "pendingBackgroundTasks": [],
            "providerInstanceHistory": [provider_instance_id],
            "goal": None,
            "itemCount": item_count,
            "visibleItemCount": item_count,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "archivedAt": None,
            "settledOverride": settled_override,
            "settledAt": settled_at,
            "unsettledAt": None,
            "snoozedUntil": None,
            "snoozedAt": None,
            "pinnedAt": pinned_at,
            "autoSettleDisabledAt": None,
            "pinOrderKey": pin_order_key,
            "activeOrderKey": None,
            "tags": [],
            "lastVisitedAt": last_visited_at,
            "opens": None,
            "titleRegeneration": None,
            "lastTitleRegeneration": None,
            "limitRecovery": None,
            "deletedAt": None,
        }
        if subagent_count > 0:
            shell_body["subagentCount"] = subagent_count

        run_body = {
            "id": run_id,
            "threadId": thread_id,
            "ordinal": 1,
            "providerInstanceId": provider_instance_id,
            "modelSelection": model_selection,
            "providerThreadId": pt_id,
            "userMessageId": f"msg-{thread_id}-u1",
            "rootNodeId": node_id,
            "activeAttemptId": att_id,
            "status": status,
            "requestedAt": created_at,
            "startedAt": created_at,
            "completedAt": None if activity_run_status else updated_at,
            "checkpointId": None,
            "contextHandoffId": None,
        }
        attempt_body = {
            "id": att_id,
            "runId": run_id,
            "attemptOrdinal": 1,
            "rootNodeId": node_id,
            "providerInstanceId": provider_instance_id,
            "providerThreadId": pt_id,
            "providerTurnId": None,
            "reason": "initial",
            "status": "running" if activity_run_status else ("failed" if status == "failed" else "completed"),
            "startedAt": created_at,
            "completedAt": None if activity_run_status else updated_at,
        }
        node_body = {
            "id": node_id,
            "threadId": thread_id,
            "runId": run_id,
            "parentNodeId": None,
            "rootNodeId": node_id,
            "kind": "root_turn",
            "status": "waiting" if status == "waiting" else ("running" if activity_run_status else ("failed" if status == "failed" else "completed")),
            "countsForRun": True,
            "providerThreadId": pt_id,
            "providerTurnId": None,
            "nativeItemRef": None,
            "runtimeRequestId": pending_request["id"] if pending_request else None,
            "checkpointScopeId": None,
            "startedAt": created_at,
            "completedAt": None if activity_run_status else updated_at,
        }
        runtime_req_body = None
        if pending_request:
            runtime_req_body = {
                "id": pending_request["id"],
                "nodeId": node_id,
                "providerTurnId": None,
                "nativeRequestRef": None,
                "kind": "command",
                "status": "pending",
                "responseCapability": {"type": "message"},
                "createdAt": pending_request["createdAt"],
                "resolvedAt": None,
            }

        return {
            "thread": thread_body,
            "shell": shell_body,
            "run": run_body,
            "attempt": attempt_body,
            "node": node_body,
            "runtime_request": runtime_req_body,
            "last_error": last_error,
        }

    threads = [
        make_thread(
            thread_id="thread-parity-pinned",
            project_id="proj-conn-demo",
            title="Pinned parity reference thread",
            branch="feat/ui-parity",
            status="completed",
            created_at="2026-11-22T14:00:00.000Z",
            updated_at="2026-11-22T15:18:00.000Z",
            pinned_at="2026-11-22T14:10:00.000Z",
            pin_order_key="a0",
            subagent_count=2,
        ),
        make_thread(
            thread_id="thread-parity-main",
            project_id="proj-conn-demo",
            title="Align sidebar rows and inline subagent cards",
            branch="feat/ui-parity",
            status="completed",
            created_at="2026-11-22T14:30:00.000Z",
            updated_at="2026-11-22T15:20:00.000Z",
            subagent_count=1,
            item_count=6,
        ),
        make_thread(
            thread_id="thread-parity-working",
            project_id="proj-hello-rust",
            title="Stream live diffs across worktrees",
            branch="main",
            status="running",
            activity_run_status="running",
            created_at="2026-11-22T15:19:00.000Z",
            updated_at="2026-11-22T15:21:00.000Z",
        ),
        make_thread(
            thread_id="thread-parity-waiting",
            project_id="proj-hello-rust",
            title="Verify shell approval popover flow",
            branch="main",
            status="waiting",
            activity_run_status="waiting",
            pending_request={
                "id": "req-parity-1",
                "kind": "command",
                "createdAt": "2026-11-22T15:16:00.000Z",
                "blocking": True,
            },
            created_at="2026-11-22T15:10:00.000Z",
            updated_at="2026-11-22T15:16:00.000Z",
        ),
        make_thread(
            thread_id="thread-parity-failed",
            project_id="proj-hello-rust",
            title="Reproduce provider timeout banner",
            branch="main",
            status="failed",
            last_error="Provider exited with code 1",
            created_at="2026-11-22T13:00:00.000Z",
            updated_at="2026-11-22T13:15:00.000Z",
        ),
        make_thread(
            thread_id="thread-parity-settled-1",
            project_id="proj-conn-demo",
            title="Verify 44px glass header traffic lights",
            branch="main",
            status="completed",
            settled_at="2026-11-22T11:30:00.000Z",
            created_at="2026-11-22T10:00:00.000Z",
            updated_at="2026-11-22T11:30:00.000Z",
        ),
        make_thread(
            thread_id="thread-parity-sub-1",
            project_id="proj-conn-demo",
            title="Inspect subagent card spacing tokens",
            branch="feat/ui-parity",
            status="completed",
            parent_thread_id="thread-parity-main",
            created_at="2026-11-22T14:32:00.000Z",
            updated_at="2026-11-22T14:36:00.000Z",
        ),
    ]

    main_tid = "thread-parity-main"
    main_run = f"run-{main_tid}-1"
    main_node = f"node-{main_tid}-root"
    main_pt = f"pt-{main_tid}"

    assistant_markdown = (
        "## Visual parity findings\n\n"
        "Checked `SidebarThreadRow.tsx` and `SubagentTimelineLink.tsx` on `origin/main`:\n\n"
        "- **Sidebar rows:** Two-line compact layout with status dot on the project favicon and a single `12px` provider mark.\n"
        "- **Subagent & task cards:** Matching boxed `glass-card` containers with `12px` padding and `13px` metadata.\n\n"
        "```rust\npub const CARD_PADDING_PX: f32 = 12.0;\npub const ROW_FONT_PX: f32 = 13.0;\n```\n\n"
        "| Surface | Conn main | Status |\n"
        "| --- | --- | --- |\n"
        "| Sidebar rows | 2-line + hover card | Audited |\n"
        "| Subagent cards | Boxed glass-card | Audited |\n"
    )
    plan_markdown = (
        "# Three-layer parity verification harness\n\n"
        "1. Headless `#[gpui_kit::test]` suite in `scripts/check.sh`\n"
        "2. Expanded live E2E suite in `scripts/e2e.py`\n"
        "3. Side-by-side `Conn.app` vs `Conn GPUI.app` captures in `nick-vm`\n"
    )

    messages = [
        {
            "id": f"msg-{main_tid}-u1",
            "threadId": main_tid,
            "runId": main_run,
            "nodeId": main_node,
            "role": "user",
            "createdBy": "user",
            "creationSource": "web",
            "text": "Compare the sidebar rows and inline subagent card against current Conn main.",
            "attachments": [],
            "streaming": False,
            "createdAt": "2026-11-22T14:30:00.000Z",
            "updatedAt": "2026-11-22T14:30:00.000Z",
        },
        {
            "id": f"msg-{main_tid}-a1",
            "threadId": main_tid,
            "runId": main_run,
            "nodeId": main_node,
            "role": "assistant",
            "createdBy": "agent",
            "creationSource": "provider",
            "text": assistant_markdown,
            "attachments": [],
            "streaming": False,
            "createdAt": "2026-11-22T14:36:30.000Z",
            "updatedAt": "2026-11-22T15:20:00.000Z",
        },
    ]

    def base_item(eid: str, ordinal: int, status: str, title: str | None, started_at: str, updated_at: str) -> dict:
        return {
            "id": eid,
            "threadId": main_tid,
            "runId": main_run,
            "nodeId": main_node,
            "providerThreadId": main_pt,
            "providerTurnId": None,
            "nativeItemRef": None,
            "parentItemId": None,
            "ordinal": ordinal,
            "status": status,
            "title": title,
            "startedAt": started_at,
            "completedAt": updated_at if status == "completed" else None,
            "updatedAt": updated_at,
        }

    turn_items = [
        {
            **base_item("ti-u1", 1, "completed", None, "2026-11-22T14:30:00.000Z", "2026-11-22T14:30:00.000Z"),
            "type": "user_message",
            "createdBy": "user",
            "creationSource": "web",
            "messageId": f"msg-{main_tid}-u1",
            "inputIntent": "turn_start",
            "text": "Compare the sidebar rows and inline subagent card against current Conn main.",
            "attachments": [],
        },
        {
            **base_item("ti-think-1", 2, "completed", "Thinking", "2026-11-22T14:30:05.000Z", "2026-11-22T14:30:25.000Z"),
            "type": "reasoning",
            "text": "Inspecting SidebarThreadRow.tsx and SubagentTimelineLink.tsx tokens.",
            "streaming": False,
        },
        {
            **base_item("ti-cmd-1", 3, "completed", "Ran cargo test --workspace", "2026-11-22T14:30:30.000Z", "2026-11-22T14:31:00.000Z"),
            "type": "command_execution",
            "input": "cargo test --workspace",
            "output": "test result: ok. 166 passed; 0 failed",
            "exitCode": 0,
        },
        {
            **base_item("ti-sub-1", 4, "completed", "Inspect subagent card spacing tokens", "2026-11-22T14:32:00.000Z", "2026-11-22T14:36:00.000Z"),
            "type": "subagent",
            "subagentId": "sub-parity-1",
            "origin": "app_owned",
            "driver": "claudeAgent",
            "providerInstanceId": "claudeAgent",
            "childThreadId": "thread-parity-sub-1",
            "prompt": "Audit SidebarThreadRow.tsx and SubagentTimelineLink.tsx padding and badge tokens.",
            "result": "Verified 2-line sidebar rows and boxed 12px subagent card layout.",
        },
        {
            **base_item("ti-plan-1", 5, "completed", "Three-layer parity verification harness", "2026-11-22T14:36:10.000Z", "2026-11-22T14:36:20.000Z"),
            "type": "proposed_plan",
            "planId": "plan-parity-1",
            "markdown": plan_markdown,
            "streaming": False,
        },
        {
            **base_item("ti-a1", 6, "completed", None, "2026-11-22T14:36:30.000Z", "2026-11-22T15:20:00.000Z"),
            "type": "assistant_message",
            "messageId": f"msg-{main_tid}-a1",
            "text": assistant_markdown,
            "streaming": False,
        },
    ]

    # Ensure every non-main thread has real user/assistant messages and turn items so
    # `visibleItemCount >= 2` and `latestUserMessageAt` are populated identically across
    # both Conn.app (TS server) and conn-server (Rust).
    failed_tid = "thread-parity-failed"
    for entry in threads:
        tid = entry["thread"]["id"]
        if tid == main_tid:
            continue
        rid = entry["run"]["id"]
        nid = entry["node"]["id"]
        ptid = entry["thread"]["activeProviderThreadId"]
        created_at = entry["thread"]["createdAt"]
        updated_at = entry["thread"]["updatedAt"]
        prompt_text = f"Parity prompt for {entry['thread']['title']}."
        reply_text = f"Seeded parity response for `{tid}`."
        messages.append(
            {
                "id": f"msg-{tid}-u1",
                "threadId": tid,
                "runId": rid,
                "nodeId": nid,
                "role": "user",
                "createdBy": "user",
                "creationSource": "web",
                "text": prompt_text,
                "attachments": [],
                "streaming": False,
                "createdAt": created_at,
                "updatedAt": created_at,
            }
        )
        turn_items.append(
            {
                "id": f"ti-{tid}-u1",
                "threadId": tid,
                "runId": rid,
                "nodeId": nid,
                "providerThreadId": ptid,
                "providerTurnId": None,
                "nativeItemRef": None,
                "parentItemId": None,
                "ordinal": 1,
                "status": "completed",
                "title": None,
                "startedAt": created_at,
                "completedAt": created_at,
                "updatedAt": created_at,
                "type": "user_message",
                "createdBy": "user",
                "creationSource": "web",
                "messageId": f"msg-{tid}-u1",
                "inputIntent": "turn_start",
                "text": prompt_text,
                "attachments": [],
            }
        )
        if tid == failed_tid:
            turn_items.append(
                {
                    "id": "ti-failed-err-1",
                    "threadId": failed_tid,
                    "runId": rid,
                    "nodeId": nid,
                    "providerThreadId": ptid,
                    "providerTurnId": None,
                    "nativeItemRef": None,
                    "parentItemId": None,
                    "ordinal": 2,
                    "status": "failed",
                    "title": "Provider error",
                    "startedAt": updated_at,
                    "completedAt": updated_at,
                    "updatedAt": updated_at,
                    "type": "error",
                    "failure": {
                        "class": "provider_error",
                        "message": "Provider exited with code 1",
                        "code": "provider_error",
                        "retryable": True,
                    },
                }
            )
        else:
            messages.append(
                {
                    "id": f"msg-{tid}-a1",
                    "threadId": tid,
                    "runId": rid,
                    "nodeId": nid,
                    "role": "assistant",
                    "createdBy": "agent",
                    "creationSource": "provider",
                    "text": reply_text,
                    "attachments": [],
                    "streaming": False,
                    "createdAt": updated_at,
                    "updatedAt": updated_at,
                }
            )
            turn_items.append(
                {
                    "id": f"ti-{tid}-a1",
                    "threadId": tid,
                    "runId": rid,
                    "nodeId": nid,
                    "providerThreadId": ptid,
                    "providerTurnId": None,
                    "nativeItemRef": None,
                    "parentItemId": None,
                    "ordinal": 2,
                    "status": "completed",
                    "title": None,
                    "startedAt": updated_at,
                    "completedAt": updated_at,
                    "updatedAt": updated_at,
                    "type": "assistant_message",
                    "messageId": f"msg-{tid}-a1",
                    "text": reply_text,
                    "streaming": False,
                }
            )

    plans = [
        {
            "id": "plan-parity-1",
            "threadId": main_tid,
            "runId": main_run,
            "nodeId": main_node,
            "kind": "proposed_plan",
            "status": "completed",
            "markdown": plan_markdown,
        }
    ]

    subagents = [
        {
            "id": "sub-parity-1",
            "threadId": main_tid,
            "runId": main_run,
            "parentNodeId": main_node,
            "origin": "app_owned",
            "createdBy": "agent",
            "driver": "claudeAgent",
            "providerInstanceId": "claudeAgent",
            "providerThreadId": "pt-thread-parity-sub-1",
            "childThreadId": "thread-parity-sub-1",
            "nativeTaskRef": None,
            "prompt": "Audit SidebarThreadRow.tsx and SubagentTimelineLink.tsx padding and badge tokens.",
            "title": "Inspect subagent card spacing tokens",
            "model": "claude-sonnet-4-6",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-sonnet-4-6"},
            "status": "completed",
            "result": "Verified 2-line sidebar rows and boxed 12px subagent card layout.",
            "startedAt": "2026-11-22T14:32:00.000Z",
            "completedAt": "2026-11-22T14:36:00.000Z",
            "updatedAt": "2026-11-22T14:36:00.000Z",
        }
    ]

    return {
        "projects": projects,
        "threads": threads,
        "messages": messages,
        "turn_items": turn_items,
        "plans": plans,
        "subagents": subagents,
    }


def write_client_settings(state_dir: Path) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    settings_path = state_dir / "client-settings.json"
    existing: dict = {}
    if settings_path.exists():
        try:
            existing = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    existing["onboardingCompletedAt"] = "2026-01-01T00:00:00.000Z"
    settings_path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")


def seed_engine_sqlite(state_dir: Path, dataset: dict) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    db_path = state_dir / "engine.sqlite"
    for suffix in ("", "-wal", "-shm"):
        p = Path(f"{db_path}{suffix}")
        if p.exists():
            p.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript(ENGINE_SCHEMA_SQL)

    for proj in dataset["projects"]:
        conn.execute(
            "INSERT INTO projects (id, workspace_root, body) VALUES (?, ?, ?)",
            (proj["id"], proj["workspaceRoot"], json.dumps(proj)),
        )

    seq = 1

    def put_entity(thread_id: str, kind: str, eid: str, body: dict, ordinal: int | None = None) -> None:
        nonlocal seq
        seq += 1
        conn.execute(
            "INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (thread_id, kind, eid, seq, seq, ordinal, json.dumps(body)),
        )
        if kind == "turnItems" and ordinal is not None:
            conn.execute(
                "INSERT OR REPLACE INTO turn_item_positions (thread_id, item_id, ordinal) VALUES (?, ?, ?)",
                (thread_id, eid, ordinal),
            )

    for entry in dataset["threads"]:
        t_body = entry["thread"]
        s_body = entry["shell"]
        tid = t_body["id"]
        conn.execute(
            "INSERT INTO threads (id, project_id, deleted, activity_at, thread, shell) VALUES (?, ?, 0, ?, ?, ?)",
            (tid, t_body["projectId"], t_body["updatedAt"], json.dumps(t_body), json.dumps(s_body)),
        )
        put_entity(tid, "runs", entry["run"]["id"], entry["run"], ordinal=1)
        put_entity(tid, "attempts", entry["attempt"]["id"], entry["attempt"], ordinal=1)
        put_entity(tid, "nodes", entry["node"]["id"], entry["node"])
        if entry["runtime_request"]:
            put_entity(tid, "runtimeRequests", entry["runtime_request"]["id"], entry["runtime_request"])

    for msg in dataset["messages"]:
        put_entity(msg["threadId"], "messages", msg["id"], msg)
    for item in dataset["turn_items"]:
        put_entity(item["threadId"], "turnItems", item["id"], item, ordinal=item["ordinal"])
    for plan in dataset["plans"]:
        put_entity(plan["threadId"], "plans", plan["id"], plan)
    for sub in dataset["subagents"]:
        put_entity(sub["threadId"], "subagents", sub["id"], sub)

    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('high_water', ?)", (seq + 10,))
    conn.commit()
    conn.close()
    return db_path


def seed_statev2_sqlite(state_dir: Path, dataset: dict) -> Path | None:
    db_path = state_dir / "statev2.sqlite"
    if not db_path.exists():
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Clear projection tables cleanly while preserving migrations & auth_sessions.
    for tbl in (
        "projection_projects",
        "orchestration_v2_projection_threads",
        "orchestration_v2_projection_runs",
        "orchestration_v2_projection_run_attempts",
        "orchestration_v2_projection_nodes",
        "orchestration_v2_projection_messages",
        "orchestration_v2_projection_turn_items",
        "orchestration_v2_projection_turn_item_counts",
        "orchestration_v2_turn_item_positions",
        "orchestration_v2_projection_plans",
        "orchestration_v2_projection_subagents",
        "orchestration_v2_projection_runtime_requests",
    ):
        cur.execute(f"DELETE FROM {tbl}")

    for proj in dataset["projects"]:
        cur.execute(
            """INSERT INTO projection_projects (
                project_id, title, workspace_root, scripts_json, created_at, updated_at,
                deleted_at, default_model_selection_json, auto_pull, has_custom_title
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1)""",
            (
                proj["id"],
                proj["title"],
                proj["workspaceRoot"],
                json.dumps(proj["scripts"]),
                proj["createdAt"],
                proj["updatedAt"],
            ),
        )

    for entry in dataset["threads"]:
        t = entry["thread"]
        r = entry["run"]
        a = entry["attempt"]
        n = entry["node"]
        tid = t["id"]
        cur.execute(
            """INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, provider_instance_id,
                runtime_mode, interaction_mode, active_provider_thread_id,
                created_at, updated_at, archived_at, deleted_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tid,
                t["projectId"],
                t["title"],
                t["providerInstanceId"],
                t["providerInstanceId"],
                t["runtimeMode"],
                t["interactionMode"],
                t["activeProviderThreadId"],
                t["createdAt"],
                t["updatedAt"],
                t["archivedAt"],
                t["deletedAt"],
                json.dumps(t),
            ),
        )
        cur.execute(
            """INSERT INTO orchestration_v2_projection_runs (
                run_id, thread_id, ordinal, provider, provider_instance_id,
                provider_thread_id, status, requested_at, completed_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                r["id"],
                tid,
                r["ordinal"],
                r["providerInstanceId"],
                r["providerInstanceId"],
                r["providerThreadId"],
                r["status"],
                r["requestedAt"],
                r["completedAt"],
                json.dumps(r),
            ),
        )
        cur.execute(
            """INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id, thread_id, run_id, attempt_ordinal, root_node_id,
                provider, provider_instance_id, provider_thread_id, provider_turn_id,
                status, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                a["id"],
                tid,
                a["runId"],
                a["attemptOrdinal"],
                a["rootNodeId"],
                a["providerInstanceId"],
                a["providerInstanceId"],
                a["providerThreadId"],
                a["providerTurnId"],
                a["status"],
                json.dumps(a),
            ),
        )
        cur.execute(
            """INSERT INTO orchestration_v2_projection_nodes (
                node_id, thread_id, run_id, parent_node_id, root_node_id,
                kind, status, provider_thread_id, provider_turn_id,
                runtime_request_id, checkpoint_scope_id, started_at, completed_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                n["id"],
                tid,
                n["runId"],
                n["parentNodeId"],
                n["rootNodeId"],
                n["kind"],
                n["status"],
                n["providerThreadId"],
                n["providerTurnId"],
                n["runtimeRequestId"],
                n["checkpointScopeId"],
                n["startedAt"],
                n["completedAt"],
                json.dumps(n),
            ),
        )
        rr = entry["runtime_request"]
        if rr:
            cur.execute(
                """INSERT INTO orchestration_v2_projection_runtime_requests (
                    runtime_request_id, thread_id, node_id, provider_turn_id,
                    kind, status, created_at, resolved_at, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    rr["id"],
                    tid,
                    rr["nodeId"],
                    rr["providerTurnId"],
                    rr["kind"],
                    rr["status"],
                    rr["createdAt"],
                    rr["resolvedAt"],
                    json.dumps(rr),
                ),
            )

    for m in dataset["messages"]:
        cur.execute(
            """INSERT INTO orchestration_v2_projection_messages (
                message_id, thread_id, run_id, node_id, role, streaming,
                created_at, updated_at, payload_json, search_text
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)""",
            (
                m["id"],
                m["threadId"],
                m["runId"],
                m["nodeId"],
                m["role"],
                m["createdAt"],
                m["updatedAt"],
                json.dumps(m),
                m["text"],
            ),
        )

    item_counts: dict[tuple[str, str], int] = {}
    for item in dataset["turn_items"]:
        tid = item["threadId"]
        rkey = item["runId"] or ""
        item_counts[(tid, rkey)] = item_counts.get((tid, rkey), 0) + 1
        cur.execute(
            """INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id, thread_id, run_id, node_id, provider_thread_id,
                provider_turn_id, parent_item_id, ordinal, type, status,
                updated_at, payload_json, inline_work_output
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
            (
                item["id"],
                tid,
                item["runId"],
                item["nodeId"],
                item["providerThreadId"],
                item["providerTurnId"],
                item["parentItemId"],
                item["ordinal"],
                item["type"],
                item["status"],
                item["updatedAt"],
                json.dumps(item),
            ),
        )
        cur.execute(
            """INSERT OR REPLACE INTO orchestration_v2_turn_item_positions (
                thread_id, turn_item_id, ordinal
            ) VALUES (?, ?, ?)""",
            (tid, item["id"], item["ordinal"]),
        )

    for (tid, rkey), cnt in item_counts.items():
        cur.execute(
            """INSERT OR REPLACE INTO orchestration_v2_projection_turn_item_counts (
                thread_id, run_key, item_count
            ) VALUES (?, ?, ?)""",
            (tid, rkey, cnt),
        )

    for plan in dataset["plans"]:
        cur.execute(
            """INSERT INTO orchestration_v2_projection_plans (
                plan_id, thread_id, run_id, node_id, kind, status, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                plan["id"],
                plan["threadId"],
                plan["runId"],
                plan["nodeId"],
                plan["kind"],
                plan["status"],
                json.dumps(plan),
            ),
        )

    for sub in dataset["subagents"]:
        cur.execute(
            """INSERT INTO orchestration_v2_projection_subagents (
                subagent_id, thread_id, run_id, parent_node_id, provider, driver,
                provider_instance_id, provider_thread_id, child_thread_id, origin,
                status, started_at, completed_at, updated_at, completion_delivery_state, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
            (
                sub["id"],
                sub["threadId"],
                sub["runId"],
                sub["parentNodeId"],
                sub["providerInstanceId"],
                sub["driver"],
                sub["providerInstanceId"],
                sub["providerThreadId"],
                sub["childThreadId"],
                sub["origin"],
                sub["status"],
                sub["startedAt"],
                sub["completedAt"],
                sub["updatedAt"],
                json.dumps(sub),
            ),
        )

    cur.execute(
        """INSERT OR REPLACE INTO orchestration_v2_projection_metadata (
            projection_name, schema_version, last_sequence, updated_at
        ) VALUES ('thread-projections', 1, 100, '2026-11-22T15:21:00.000Z')"""
    )

    conn.commit()
    conn.close()
    return db_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed deterministic parity state for Conn & conn-server.")
    parser.add_argument("--dev-dir", default=os.environ.get("CONN_GPUI_DEV", "/tmp/conn-gpui-dev"))
    parser.add_argument("--state-subdir", default="userdata")
    parser.add_argument("--statev2-only", action="store_true", help="Only populate existing statev2.sqlite + client-settings.json")
    args = parser.parse_args()

    dev_dir = Path(args.dev_dir)
    state_dir = dev_dir / args.state_subdir
    if args.statev2_only:
        demo_app = dev_dir / "projects" / "conn-demo"
        hello = dev_dir / "projects" / "hello-rust"
        if not demo_app.exists() or not hello.exists():
            demo_app, hello = ensure_demo_repos(dev_dir / "projects")
    else:
        demo_app, hello = ensure_demo_repos(dev_dir / "projects")

    dataset = build_parity_dataset(demo_app, hello)
    write_client_settings(state_dir)

    if not args.statev2_only:
        engine_path = seed_engine_sqlite(state_dir, dataset)
        print(f"seeded engine.sqlite: {engine_path}")

    statev2_path = seed_statev2_sqlite(state_dir, dataset)
    if statev2_path:
        print(f"seeded statev2.sqlite: {statev2_path}")
    print(f"parity repos: {demo_app}, {hello}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
