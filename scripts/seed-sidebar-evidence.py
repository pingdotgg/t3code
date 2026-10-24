#!/usr/bin/env python3
"""Seed synthetic sidebar projections in a stopped, isolated, initialized T3 home.

Usage: python3 scripts/seed-sidebar-evidence.py --base-dir /tmp/sidebar-proof/.t3 \
    --workspace /tmp/sidebar-proof/workspace [--empty]

Start the server once to migrate an empty isolated home, then stop it first.
Restart with T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false so startup does not
create an unrelated project and fourth thread.
This fixture creates no event history and must not prove backend behavior.
Use identical workspace, settings, bindings and a fixed browser clock for pairs.
"""

import argparse
import json
import os
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-dir", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--empty", action="store_true")
    args = parser.parse_args()
    base = args.base_dir.resolve()
    if base == (Path.home() / ".t3").resolve() or (base / "userdata").is_symlink():
        parser.error("Use a copied, isolated home, never the live T3 home.")
    db = base / "userdata/statev2.sqlite"
    if db.is_symlink():
        parser.error("The isolated database must be a copy, never a symlink.")
    if not db.is_file():
        parser.error("Initialize an empty isolated home with the server first.")
    try:
        is_live_db = db.samefile(Path.home() / ".t3/userdata/statev2.sqlite")
    except FileNotFoundError:
        is_live_db = False
    if is_live_db:
        parser.error("The isolated database must be a copy, never a hardlink.")
    runtime_file = base / "userdata/server-runtime.json"
    if runtime_file.is_file():
        runtime = json.loads(runtime_file.read_text())
        try:
            os.kill(runtime["pid"], 0)
        except ProcessLookupError:
            pass
        else:
            parser.error("Stop the isolated server before seeding its database.")
    workspace = args.workspace.resolve(strict=True)
    if not workspace.is_dir():
        parser.error("Workspace must be a directory.")

    with sqlite3.connect(db) as connection:
        # Refuse existing work, including runnable effects, rather than clearing it.
        for table in (
            "orchestration_v2_projection_messages",
            "orchestration_v2_projection_runs",
            "orchestration_v2_projection_runtime_requests",
            "orchestration_v2_effect_outbox",
            "scheduled_tasks",
        ):
            if connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]:
                parser.error(f"Expected empty synthetic state: {table} is populated.")
        project, project_title = "shortcut-fixtures", "Shortcut fixtures"
        # Only rows this script writes may be replaced; match them exactly.
        if connection.execute(
            "SELECT count(*) FROM orchestration_v2_projection_threads WHERE NOT "
            "(thread_id IN ('shortcut-fixture-1','shortcut-fixture-2','shortcut-fixture-3') "
            "AND project_id IS ?)",
            (project,),
        ).fetchone()[0]:
            parser.error("Refusing to replace nonfixture threads.")
        if connection.execute(
            "SELECT count(*) FROM projection_projects "
            "WHERE NOT (project_id IS ? AND title IS ?)",
            (project, project_title),
        ).fetchone()[0]:
            parser.error("Refusing to replace nonfixture projects.")

        clock = "2026-10-22T08:00:00.000Z"
        connection.execute("DELETE FROM orchestration_v2_projection_threads")
        connection.execute("DELETE FROM projection_projects")
        connection.execute(
            "INSERT INTO projection_projects "
            "(project_id,title,workspace_root,scripts_json,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (project, project_title, str(workspace), "[]", clock, clock),
        )
        for index, title in enumerate(() if args.empty else ("Alpha", "Beta", "Gamma"), 1):
            thread = f"shortcut-fixture-{index}"
            payload = dict(
                id=thread, projectId=project, title=f"Thread {title}",
                createdBy="system", creationSource="server",
                providerInstanceId="codex",
                modelSelection=dict(instanceId="codex", model="gpt-6-astra"),
                runtimeMode="full-access", interactionMode="default",
                branch=None, worktreePath=None, pullRequests=[],
                activeProviderThreadId=None, forkedFrom=None,
                lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId=thread),
                createdAt=clock, updatedAt=clock, lastVisitedAt=clock,
                archivedAt=None, deletedAt=None, settledOverride=None, settledAt=None,
                snoozedUntil=None, snoozedAt=None, activeOrderKey=str(index),
            )
            connection.execute(
                "INSERT INTO orchestration_v2_projection_threads "
                "(thread_id,project_id,title,default_provider,provider_instance_id,"
                "runtime_mode,interaction_mode,created_at,updated_at,payload_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (thread, project, payload["title"], "codex", "codex", "full-access",
                 "default", clock, clock, json.dumps(payload)),
            )
    print(f"Seeded {0 if args.empty else 3} synthetic stopped threads in {db}")


if __name__ == "__main__":
    main()
