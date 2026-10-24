"""Seed rendering projections in a stopped worktree's copied dev database.

Run from the worktree after migrate-dev-db, with its dev server stopped:
    python3 scripts/fixtures/composer-banner-shadow.py
Requires a completed Claude run. This fixture does not prove orchestration.
"""

import json
import sqlite3
from pathlib import Path


database = Path(__file__).resolve().parents[2] / ".t3/userdata/statev2.sqlite"
if not database.is_file():
    raise SystemExit("Seed this worktree's .t3 with migrate-dev-db first.")

with sqlite3.connect(database) as connection:
    row = connection.execute(
        """SELECT r.payload_json, p.payload_json, t.payload_json
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_provider_threads p
          ON p.provider_thread_id = json_extract(r.payload_json, '$.providerThreadId')
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        WHERE r.status = 'completed' AND p.driver = 'claudeAgent'
          AND t.active_provider_thread_id = p.provider_thread_id
          AND t.archived_at IS NULL AND t.deleted_at IS NULL
        ORDER BY r.rowid LIMIT 1"""
    ).fetchone()
    if row is None:
        raise SystemExit("The copied dev database needs a completed Claude run.")

    run, provider_thread, thread = map(json.loads, row)
    thread_id = thread["id"]
    provider_thread["goal"] = {
        "objective": "Check the composer banners",
        "status": "active",
        "tokensUsed": 1200,
        "tokenBudget": 10000,
    }
    connection.execute(
        "UPDATE orchestration_v2_projection_provider_threads SET payload_json=? "
        "WHERE provider_thread_id=?",
        (json.dumps(provider_thread), provider_thread["id"]),
    )
    thread.update(title="Composer banner shadow", settledAt=None, settledOverride=None)
    connection.execute(
        "UPDATE orchestration_v2_projection_threads SET title=?, payload_json=? "
        "WHERE thread_id=?",
        (thread["title"], json.dumps(thread), thread_id),
    )
    plan = {
        "id": "composer-banner-shadow-tasks",
        "threadId": thread_id,
        "runId": run["id"],
        "nodeId": run["rootNodeId"],
        "kind": "todo_list",
        "status": "active",
        "steps": [
            {"id": "one", "text": "Inspect the banners", "status": "completed"},
            {"id": "two", "text": "Compare the shadow", "status": "pending"},
            {"id": "three", "text": "Capture the composer", "status": "pending"},
        ],
    }
    connection.execute(
        """INSERT OR REPLACE INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (plan["id"], thread_id, run["id"], plan["nodeId"], "todo_list", "active", json.dumps(plan)),
    )
    connection.execute(
        """UPDATE orchestration_v2_projection_messages SET payload_json=
        json_set(payload_json, '$.text', 'Inspect the goal and task banners above the composer.')
        WHERE thread_id=?""",
        (thread_id,),
    )
    connection.execute(
        """UPDATE orchestration_v2_projection_turn_items SET payload_json=
        json_set(payload_json, '$.text', 'Inspect the goal and task banners above the composer.')
        WHERE thread_id=? AND json_extract(payload_json, '$.type')
        IN ('user_message', 'assistant_message')""",
        (thread_id,),
    )

print(thread_id)
