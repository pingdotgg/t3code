#!/usr/bin/env python3
"""Deterministic parity database seeder for disposable `:3891` conn-server (0.4.2).

Creates throwaway git repos and writes a reproducible `engine.sqlite` covering
every core sidebar and timeline visual state (Pinned, Active, unselected Working,
Waiting/Approval, Failed, Settled, Subagent lineage, Proposed plan, Markdown/code,
and uncommitted git diffs) so both `Conn.app` and `Conn GPUI.app` render the
exact same live data side-by-side with zero LLM API calls.

Usage:
  python3 scripts/seed-parity.py [--dev-dir /tmp/conn-gpui-dev] [--state-subdir state]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

SCHEMA_SQL = """
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


def make_thread_records(
    *,
    thread_id: str,
    project_id: str,
    title: str,
    branch: str,
    status: str,
    created_at: str,
    updated_at: str,
    model: str = "claude-sonnet-4-6",
    provider: str = "claude",
    provider_instance_id: str = "claude-default",
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
) -> tuple[dict, dict]:
    lineage = {
        "parentThreadId": parent_thread_id,
        "relationshipToParent": "subagent" if parent_thread_id else None,
        "rootThreadId": parent_thread_id or thread_id,
    }
    thread_body = {
        "id": thread_id,
        "projectId": project_id,
        "title": title,
        "createdBy": "agent" if parent_thread_id else "user",
        "creationSource": "subagent" if parent_thread_id else "web",
        "providerInstanceId": provider_instance_id,
        "modelSelection": {"provider": provider, "model": model},
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": branch,
        "worktreePath": None,
        "pullRequests": [],
        "lineage": lineage,
        "forkedFrom": None,
        "activeProviderThreadId": f"pt-{thread_id}",
        "tags": [],
        "createdAt": created_at,
        "updatedAt": updated_at,
        "archivedAt": None,
        "settledOverride": None,
        "settledAt": settled_at,
        "unsettledAt": None,
        "snoozedUntil": None,
        "snoozedAt": None,
        "pinnedAt": pinned_at,
        "autoSettleDisabledAt": None,
        "pinOrderKey": pin_order_key,
        "activeOrderKey": None,
        "lastVisitedAt": last_visited_at,
        "opens": 1,
        "titleRegeneration": None,
        "lastTitleRegeneration": None,
        "limitRecovery": None,
        "deletedAt": None,
    }
    shell_body = {
        "createdBy": thread_body["createdBy"],
        "creationSource": thread_body["creationSource"],
        "id": thread_id,
        "projectId": project_id,
        "title": title,
        "providerInstanceId": provider_instance_id,
        "modelSelection": thread_body["modelSelection"],
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": branch,
        "worktreePath": None,
        "pullRequests": [],
        "lineage": lineage,
        "forkedFrom": None,
        "activeProviderThreadId": f"pt-{thread_id}",
        "latestRunId": f"run-{thread_id}-1",
        "latestRunRequestedAt": created_at,
        "latestRunStartedAt": created_at,
        "latestRunCompletedAt": None if activity_run_status else updated_at,
        "latestRunStopRequested": False,
        "latestRunBackgroundWake": False,
        "activeRunId": f"run-{thread_id}-1" if activity_run_status in ("preparing", "starting", "running") else None,
        "blockedOnThreadWait": False,
        "activityRunStatus": activity_run_status,
        "activityRunStartedAt": created_at if activity_run_status else None,
        "status": status,
        "lastError": last_error,
        "lastErrorClass": "provider" if last_error else None,
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
        "settledOverride": None,
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
        "opens": 1,
        "titleRegeneration": None,
        "lastTitleRegeneration": None,
        "limitRecovery": None,
        "deletedAt": None,
    }
    if subagent_count > 0:
        shell_body["subagentCount"] = subagent_count
    return thread_body, shell_body


def seed_database(state_dir: Path, demo_app: Path, hello: Path) -> Path:
    state_dir.mkdir(parents=True, exist_ok=True)
    db_path = state_dir / "engine.sqlite"
    for suffix in ("", "-wal", "-shm"):
        p = Path(f"{db_path}{suffix}")
        if p.exists():
            p.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)

    projects = [
        (
            "proj-conn-demo",
            str(demo_app),
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
        ),
        (
            "proj-hello-rust",
            str(hello),
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
        ),
    ]
    for pid, root, body in projects:
        conn.execute(
            "INSERT INTO projects (id, workspace_root, body) VALUES (?, ?, ?)",
            (pid, root, json.dumps(body)),
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

    specs = [
        dict(
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
        dict(
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
        dict(
            thread_id="thread-parity-working",
            project_id="proj-hello-rust",
            title="Stream live diffs across worktrees",
            branch="main",
            status="running",
            activity_run_status="running",
            created_at="2026-11-22T15:19:00.000Z",
            updated_at="2026-11-22T15:21:00.000Z",
        ),
        dict(
            thread_id="thread-parity-waiting",
            project_id="proj-hello-rust",
            title="Verify shell approval popover flow",
            branch="main",
            status="waiting",
            activity_run_status="waiting",
            pending_request={
                "id": "req-parity-1",
                "kind": "permission",
                "createdAt": "2026-11-22T15:16:00.000Z",
                "blocking": True,
            },
            created_at="2026-11-22T15:10:00.000Z",
            updated_at="2026-11-22T15:16:00.000Z",
        ),
        dict(
            thread_id="thread-parity-failed",
            project_id="proj-hello-rust",
            title="Reproduce provider timeout banner",
            branch="main",
            status="failed",
            last_error="Provider exited with code 1",
            created_at="2026-11-22T13:00:00.000Z",
            updated_at="2026-11-22T13:15:00.000Z",
        ),
        dict(
            thread_id="thread-parity-settled-1",
            project_id="proj-conn-demo",
            title="Verify 44px glass header traffic lights",
            branch="main",
            status="completed",
            settled_at="2026-11-22T11:30:00.000Z",
            created_at="2026-11-22T10:00:00.000Z",
            updated_at="2026-11-22T11:30:00.000Z",
        ),
        dict(
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

    for spec in specs:
        t_body, s_body = make_thread_records(**spec)
        tid = spec["thread_id"]
        conn.execute(
            "INSERT INTO threads (id, project_id, deleted, activity_at, thread, shell) VALUES (?, ?, 0, ?, ?, ?)",
            (tid, spec["project_id"], spec["updated_at"], json.dumps(t_body), json.dumps(s_body)),
        )
        run_id = f"run-{tid}-1"
        att_id = f"att-{tid}-1"
        node_id = f"node-{tid}-root"
        put_entity(
            tid,
            "runs",
            run_id,
            {
                "id": run_id,
                "threadId": tid,
                "ordinal": 1,
                "status": spec["status"],
                "rootNodeId": node_id,
                "activeAttemptId": att_id,
                "requestedAt": spec["created_at"],
                "startedAt": spec["created_at"],
                "completedAt": None if spec.get("activity_run_status") else spec["updated_at"],
                "userMessageId": f"msg-{tid}-u1",
                "mode": "default",
                "inputIntent": "normal",
                "modelSelection": t_body["modelSelection"],
                "providerInstanceId": t_body["providerInstanceId"],
                "runtimeMode": "auto-accept-edits",
                "interactionMode": "default",
            },
            ordinal=1,
        )
        put_entity(
            tid,
            "attempts",
            att_id,
            {
                "id": att_id,
                "runId": run_id,
                "threadId": tid,
                "ordinal": 1,
                "status": "completed" if not spec.get("activity_run_status") else "running",
                "startedAt": spec["created_at"],
                "completedAt": None if spec.get("activity_run_status") else spec["updated_at"],
            },
            ordinal=1,
        )

    # Rich timeline entries on `thread-parity-main`.
    main_tid = "thread-parity-main"
    main_run = f"run-{main_tid}-1"
    main_att = f"att-{main_tid}-1"
    main_node = f"node-{main_tid}-root"

    put_entity(
        main_tid,
        "messages",
        f"msg-{main_tid}-u1",
        {
            "id": f"msg-{main_tid}-u1",
            "threadId": main_tid,
            "runId": main_run,
            "role": "user",
            "createdBy": "user",
            "text": "Compare the sidebar rows and inline subagent card against current Conn main.",
            "attachments": [],
            "createdAt": "2026-11-22T14:30:00.000Z",
            "updatedAt": "2026-11-22T14:30:00.000Z",
        },
        ordinal=1,
    )
    put_entity(
        main_tid,
        "messages",
        f"msg-{main_tid}-a1",
        {
            "id": f"msg-{main_tid}-a1",
            "threadId": main_tid,
            "runId": main_run,
            "role": "assistant",
            "createdBy": "assistant",
            "text": (
                "## Visual parity findings\n\n"
                "Checked `SidebarThreadRow.tsx` and `SubagentTimelineLink.tsx` on `origin/main`:\n\n"
                "- **Sidebar rows:** Two-line compact layout with status dot on the project favicon and a single `12px` provider mark.\n"
                "- **Subagent & task cards:** Matching boxed `glass-card` containers with `12px` padding and `13px` metadata.\n\n"
                "```rust\npub const CARD_PADDING_PX: f32 = 12.0;\npub const ROW_FONT_PX: f32 = 13.0;\n```\n\n"
                "| Surface | Conn main | Status |\n"
                "| --- | --- | --- |\n"
                "| Sidebar rows | 2-line + hover card | Audited |\n"
                "| Subagent cards | Boxed glass-card | Audited |\n"
            ),
            "attachments": [],
            "createdAt": "2026-11-22T14:36:30.000Z",
            "updatedAt": "2026-11-22T15:20:00.000Z",
        },
        ordinal=6,
    )

    turn_items = [
        (
            "ti-u1",
            1,
            {
                "id": "ti-u1",
                "type": "user_message",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "messageId": f"msg-{main_tid}-u1",
                "text": "Compare the sidebar rows and inline subagent card against current Conn main.",
                "createdBy": "user",
                "inputIntent": "normal",
                "startedAt": "2026-11-22T14:30:00.000Z",
                "updatedAt": "2026-11-22T14:30:00.000Z",
                "completedAt": "2026-11-22T14:30:00.000Z",
            },
        ),
        (
            "ti-think-1",
            2,
            {
                "id": "ti-think-1",
                "type": "reasoning",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "text": "Inspecting SidebarThreadRow.tsx and SubagentTimelineLink.tsx tokens.",
                "startedAt": "2026-11-22T14:30:05.000Z",
                "updatedAt": "2026-11-22T14:30:25.000Z",
                "completedAt": "2026-11-22T14:30:25.000Z",
            },
        ),
        (
            "ti-cmd-1",
            3,
            {
                "id": "ti-cmd-1",
                "type": "command_execution",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "title": "Ran cargo test --workspace",
                "command": "cargo test --workspace",
                "exitCode": 0,
                "output": "test result: ok. 166 passed; 0 failed",
                "startedAt": "2026-11-22T14:30:30.000Z",
                "updatedAt": "2026-11-22T14:31:00.000Z",
                "completedAt": "2026-11-22T14:31:00.000Z",
            },
        ),
        (
            "ti-sub-1",
            4,
            {
                "id": "ti-sub-1",
                "type": "subagent",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "subagentId": "sub-parity-1",
                "childThreadId": "thread-parity-sub-1",
                "title": "Inspect subagent card spacing tokens",
                "role": "claudeAgent",
                "summary": "Verified 2-line sidebar rows and boxed 12px subagent card layout.",
                "startedAt": "2026-11-22T14:32:00.000Z",
                "updatedAt": "2026-11-22T14:36:00.000Z",
                "completedAt": "2026-11-22T14:36:00.000Z",
            },
        ),
        (
            "ti-plan-1",
            5,
            {
                "id": "ti-plan-1",
                "type": "proposed_plan",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "title": "Three-layer parity verification harness",
                "markdown": "# Three-layer parity verification harness\n\n1. Headless `#[gpui_kit::test]` suite in `scripts/check.sh`\n2. Expanded live E2E suite in `scripts/e2e.py`\n3. Side-by-side `Conn.app` vs `Conn GPUI.app` captures in `nick-vm`\n",
                "startedAt": "2026-11-22T14:36:10.000Z",
                "updatedAt": "2026-11-22T14:36:20.000Z",
                "completedAt": "2026-11-22T14:36:20.000Z",
            },
        ),
        (
            "ti-a1",
            6,
            {
                "id": "ti-a1",
                "type": "assistant_message",
                "status": "completed",
                "runId": main_run,
                "attemptId": main_att,
                "nodeId": main_node,
                "messageId": f"msg-{main_tid}-a1",
                "text": (
                    "## Visual parity findings\n\n"
                    "Checked `SidebarThreadRow.tsx` and `SubagentTimelineLink.tsx` on `origin/main`:\n\n"
                    "- **Sidebar rows:** Two-line compact layout with status dot on the project favicon and a single `12px` provider mark.\n"
                    "- **Subagent & task cards:** Matching boxed `glass-card` containers with `12px` padding and `13px` metadata.\n\n"
                    "```rust\npub const CARD_PADDING_PX: f32 = 12.0;\npub const ROW_FONT_PX: f32 = 13.0;\n```\n\n"
                    "| Surface | Conn main | Status |\n"
                    "| --- | --- | --- |\n"
                    "| Sidebar rows | 2-line + hover card | Audited |\n"
                    "| Subagent cards | Boxed glass-card | Audited |\n"
                ),
                "startedAt": "2026-11-22T14:36:30.000Z",
                "updatedAt": "2026-11-22T15:20:00.000Z",
                "completedAt": "2026-11-22T15:20:00.000Z",
            },
        ),
    ]
    for eid, ordinal, body in turn_items:
        put_entity(main_tid, "turnItems", eid, body, ordinal=ordinal)

    put_entity(
        main_tid,
        "subagents",
        "sub-parity-1",
        {
            "id": "sub-parity-1",
            "threadId": main_tid,
            "childThreadId": "thread-parity-sub-1",
            "runId": main_run,
            "title": "Inspect subagent card spacing tokens",
            "status": "completed",
            "createdAt": "2026-11-22T14:32:00.000Z",
            "updatedAt": "2026-11-22T14:36:00.000Z",
        },
        ordinal=1,
    )

    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('high_water', ?)", (seq + 10,))
    conn.commit()
    conn.close()
    return db_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed deterministic parity state for conn-server.")
    parser.add_argument("--dev-dir", default=os.environ.get("CONN_GPUI_DEV", "/tmp/conn-gpui-dev"))
    parser.add_argument("--state-subdir", default="state")
    args = parser.parse_args()

    dev_dir = Path(args.dev_dir)
    demo_app, hello = ensure_demo_repos(dev_dir / "projects")
    db_path = seed_database(dev_dir / args.state_subdir, demo_app, hello)
    print(f"seeded parity state: {db_path} (projects: {demo_app}, {hello})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
