// @effect-diagnostics nodeBuiltinImport:off - Script fixture tests use temporary native SQLite files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";

import {
  assertDisposableProjectionTarget,
  hasProjectionFixtureSchema,
  writeProjectionFixture,
  type ProjectionFixture,
} from "./projection-fixture.ts";

function createSchema(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
      default_model_selection_json TEXT NOT NULL, scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      model_selection_json TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
      branch TEXT, worktree_path TEXT, latest_turn_id TEXT, latest_user_message_at TEXT,
      pending_approval_count INTEGER NOT NULL, pending_user_input_count INTEGER NOT NULL,
      has_actionable_proposed_plan INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, settled_override TEXT,
      settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT,
      pending_message_id TEXT, assistant_message_id TEXT, state TEXT NOT NULL,
      requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
      checkpoint_turn_count INTEGER, checkpoint_ref TEXT, checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT, UNIQUE(thread_id, turn_id)
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL,
      text TEXT NOT NULL, is_streaming INTEGER NOT NULL, attachments_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL,
      kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
      sequence INTEGER, created_at TEXT NOT NULL
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider_name TEXT,
      provider_instance_id TEXT, provider_session_id TEXT, provider_thread_id TEXT,
      runtime_mode TEXT NOT NULL, active_turn_id TEXT, last_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE projection_pending_approvals (
      request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, status TEXT NOT NULL,
      decision TEXT, created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE projection_thread_proposed_plans (
      plan_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, implemented_at TEXT,
      implementation_thread_id TEXT
    );
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY, last_applied_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
  `);
}

const timestamp = "2026-08-09T00:00:00.000Z";

function fixture(projectId = "project-1"): ProjectionFixture {
  return {
    projects: [
      {
        projectId,
        title: "Fixture",
        workspaceRoot: "/fixture/workspace",
        defaultModelSelectionJson: '{"instanceId":"opencode","model":"benchmark"}',
        scriptsJson: "[]",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    threads: [
      {
        threadId: "thread-1",
        projectId,
        title: "Fixture thread",
        modelSelectionJson: '{"instanceId":"opencode","model":"benchmark"}',
        runtimeMode: "full-access",
        interactionMode: "default",
        latestTurnId: "turn-1",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    turns: [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        assistantMessageId: "message-1",
        state: "completed",
        requestedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    ],
    messages: [
      {
        messageId: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        role: "assistant",
        text: "hello",
        attachmentsJson: "[]",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

it("writes a complete projection fixture through one owned transaction", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-projection-fixture-"));
  try {
    const dbPath = NodePath.join(root, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();

    assert.equal(hasProjectionFixtureSchema(dbPath), true);
    writeProjectionFixture({ dbPath, disposableRoot: root, fixture: fixture() });

    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    assert.deepStrictEqual(
      read
        .prepare("SELECT message_id, role, text, attachments_json FROM projection_thread_messages")
        .all(),
      [
        {
          message_id: "message-1",
          role: "assistant",
          text: "hello",
          attachments_json: "[]",
        },
      ],
    );
    read.close();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rolls back clears and inserts when a row violates a projection constraint", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-projection-rollback-"));
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database
      .prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("existing", "Existing", "/existing", "{}", "[]", timestamp, timestamp);
    database.close();

    const duplicated: ProjectionFixture = {
      ...fixture(),
      projects: [fixture().projects[0]!, fixture().projects[0]!],
    };
    assert.throws(
      () => writeProjectionFixture({ dbPath, disposableRoot: root, fixture: duplicated }),
      /UNIQUE constraint failed/u,
    );

    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    assert.deepStrictEqual(read.prepare("SELECT project_id FROM projection_projects").all(), [
      { project_id: "existing" },
    ]);
    read.close();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses schema drift, an existing transaction, and a live or out-of-root target", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-projection-guard-"));
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database.exec("CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)");
    assert.equal(hasProjectionFixtureSchema(dbPath), false);
    assert.throws(
      () => writeProjectionFixture({ dbPath, disposableRoot: root, fixture: fixture(), database }),
      /schema is not ready/u,
    );
    database.close();

    const ready = new NodeSqlite.DatabaseSync(dbPath);
    ready.exec("DROP TABLE projection_projects");
    createSchema(ready);
    ready.exec("BEGIN");
    assert.throws(
      () =>
        writeProjectionFixture({
          dbPath,
          disposableRoot: root,
          fixture: fixture(),
          database: ready,
        }),
      /requires transaction ownership/u,
    );
    assert.equal(ready.isTransaction, true);
    ready.exec("ROLLBACK");
    ready.close();

    assert.throws(
      () => assertDisposableProjectionTarget({ dbPath, disposableRoot: "/another-root" }),
      /must be inside disposable root/u,
    );
    assert.throws(
      () => assertDisposableProjectionTarget({ dbPath, disposableRoot: root, liveHomeDir: root }),
      /live T3 home/u,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
