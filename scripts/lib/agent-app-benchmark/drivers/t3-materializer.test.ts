// @effect-diagnostics nodeBuiltinImport:off - Benchmark materializer tests use temporary native SQLite files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";

import type { AgentAppCorpus, AgentAppCorpusCounts } from "../contracts.ts";
import { materializeT3Corpus } from "./t3-materializer.ts";

function createSchema(database: NodeSqlite.DatabaseSync): void {
  database.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,default_model_selection_json TEXT NOT NULL,scripts_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,model_selection_json TEXT NOT NULL,runtime_mode TEXT NOT NULL,interaction_mode TEXT NOT NULL,branch TEXT,worktree_path TEXT,latest_turn_id TEXT,latest_user_message_at TEXT,pending_approval_count INTEGER NOT NULL,pending_user_input_count INTEGER NOT NULL,has_actionable_proposed_plan INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,settled_override TEXT,settled_at TEXT,snoozed_until TEXT,snoozed_at TEXT);
    CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL,turn_id TEXT,pending_message_id TEXT,assistant_message_id TEXT,state TEXT NOT NULL,requested_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,checkpoint_turn_count INTEGER,checkpoint_ref TEXT,checkpoint_status TEXT,checkpoint_files_json TEXT NOT NULL,source_proposed_plan_thread_id TEXT,source_proposed_plan_id TEXT,UNIQUE(thread_id,turn_id));
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL,is_streaming INTEGER NOT NULL,attachments_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,tone TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,payload_json TEXT NOT NULL,sequence INTEGER,created_at TEXT NOT NULL);
    CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_name TEXT,provider_instance_id TEXT,provider_session_id TEXT,provider_thread_id TEXT,runtime_mode TEXT NOT NULL,active_turn_id TEXT,last_error TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,status TEXT NOT NULL,decision TEXT,created_at TEXT NOT NULL,resolved_at TEXT);
    CREATE TABLE projection_thread_proposed_plans (plan_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT,plan_markdown TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,implemented_at TEXT,implementation_thread_id TEXT);
    CREATE TABLE projection_state (projector TEXT PRIMARY KEY,last_applied_sequence INTEGER NOT NULL,updated_at TEXT NOT NULL);
  `);
}

const counts: AgentAppCorpusCounts = {
  sessions: 1,
  turns: 1,
  messages: 2,
  parts: 7,
  textParts: 1,
  markdownParts: 1,
  codeParts: 0,
  tableParts: 0,
  diffParts: 1,
  toolParts: 1,
  reasoningParts: 1,
  attachments: 2,
  lifecycleEvents: 0,
  terminalStreams: 1,
  terminalBytes: 0,
  renderableBytes: 0,
};

const hash = "a".repeat(64);
const corpus: AgentAppCorpus = {
  schemaVersion: 1,
  kind: "agent-app-corpus",
  corpusId: "mixed",
  source: "generated-public",
  seed: "seed",
  sessions: [
    {
      id: "session-1",
      title: "Mixed session",
      order: 0,
      turns: [
        {
          id: "turn-1",
          index: 0,
          messages: [
            {
              id: "user-1",
              order: 0,
              role: "user",
              parts: [{ id: "text-1", order: 0, type: "text", text: "Please inspect." }],
            },
            {
              id: "assistant-1",
              order: 1,
              role: "assistant",
              parts: [
                { id: "markdown-1", order: 0, type: "markdown", markdown: "**Done.**" },
                {
                  id: "diff-1",
                  order: 1,
                  type: "diff",
                  path: "file.ts",
                  oldText: "a",
                  newText: "b",
                  patch: "@@ -1 +1 @@\n-a\n+b",
                },
                { id: "reasoning-1", order: 2, type: "reasoning", text: "private thought" },
                {
                  id: "image-1",
                  order: 3,
                  type: "attachment",
                  name: "image.png",
                  mediaType: "image/png",
                  sizeBytes: 12,
                  sha256: "b".repeat(64),
                },
                {
                  id: "pdf-1",
                  order: 4,
                  type: "attachment",
                  name: "notes.pdf",
                  mediaType: "application/pdf",
                  sizeBytes: 20,
                  sha256: "c".repeat(64),
                },
                {
                  id: "tool-1",
                  order: 5,
                  type: "tool",
                  callId: "call-1",
                  toolName: "apply_patch",
                  state: "completed",
                  inputJson: '{"file":"file.ts"}',
                  outputText: "updated",
                },
              ],
            },
          ],
        },
      ],
      events: [],
      terminalStreams: [
        {
          id: "terminal-1",
          columns: 80,
          rows: 24,
          chunks: [],
          inputSentinels: [],
          expectedBytes: 0,
          expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
    },
  ],
  manifest: {
    counts,
    hashes: { corpusSha256: hash, semanticSha256: "d".repeat(64), terminalSha256: "e".repeat(64) },
  },
};

it("materializes canonical T3 rows and validates read-back order, bytes, and hashes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-materializer-"));
  try {
    const dbPath = NodePath.join(root, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();

    const result = materializeT3Corpus({
      corpus,
      dbPath,
      disposableRoot: root,
      workspaceRoot: NodePath.join(root, "workspace"),
    });
    assert.equal(
      result.coverage.find((entry) => entry.profile === "workspace-core-v1")?.passed,
      true,
    );
    // History-projection drops (T3 persists neither reasoning nor non-image
    // attachments) stay declared on the workspace entry; this corpus streams
    // no events at all.
    assert.deepStrictEqual(
      result.coverage.find((entry) => entry.profile === "workspace-core-v1")?.unsupportedShapes,
      ["attachment:application/pdf", "reasoning"],
    );
    assert.equal(result.readback.orderedProjectionSha256, result.expectedProjectionSha256);
    assert.deepStrictEqual(result.readinessTargets, [
      {
        sessionId: "session-1",
        title: "Mixed session",
        expectedMessageIds: ["user-1", "assistant-1"],
      },
    ]);

    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = read
      .prepare(
        "SELECT message_id, role, text, attachments_json FROM projection_thread_messages ORDER BY created_at",
      )
      .all() as Array<Record<string, string | null>>;
    read.close();
    assert.equal(rows[1]?.text, "**Done.**\n\n@@ -1 +1 @@\n-a\n+b");
    assert.equal(rows[1]?.text?.includes("private thought"), false);
    assert.deepStrictEqual(JSON.parse(rows[1]?.attachments_json ?? "[]"), [
      { type: "image", id: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: 12 },
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rolls back the whole corpus when duplicate canonical IDs are encountered", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-materializer-duplicate-"));
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    materializeT3Corpus({ corpus, dbPath, disposableRoot: root, workspaceRoot: root });
    const duplicateCorpus: AgentAppCorpus = {
      ...corpus,
      sessions: [corpus.sessions[0]!, { ...corpus.sessions[0]!, order: 1 }],
    };
    assert.throws(
      () =>
        materializeT3Corpus({
          corpus: duplicateCorpus,
          dbPath,
          disposableRoot: root,
          workspaceRoot: root,
        }),
      /UNIQUE constraint failed/u,
    );
    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (read.prepare("SELECT COUNT(*) AS count FROM projection_projects").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (
        read.prepare("SELECT COUNT(*) AS count FROM projection_thread_messages").get() as {
          count: number;
        }
      ).count,
      2,
    );
    read.close();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
