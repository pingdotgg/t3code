// @effect-diagnostics nodeBuiltinImport:off - Public benchmark adapter tests isolated SQLite projection materialization.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";

import { materializeT3PublicCorpus } from "./t3-public-materializer.ts";

it("translates pinned OpenCode events into T3's canonical projection fixture and reads it back", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-"));
  try {
    const dbPath = NodePath.join(root, "userdata", "state.sqlite");
    await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root);
    const result = await materializeT3PublicCorpus({
      corpusDirectory: corpus.directory,
      corpusManifestPath: corpus.manifestPath,
      expectedCorpusDigestSha256: corpus.corpusDigestSha256,
      expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
      dbPath,
      disposableRoot: root,
      workspaceRoot: NodePath.join(root, "workspace"),
    });
    assert.equal(result.messageCount, 2);
    assert.equal(result.transcriptBytes, 10);
    assert.equal(result.sessionMapping.control, "ses_bench_control");
    assert.deepStrictEqual(result.readinessTargets.get("control")?.expectedMessageIds, [
      "msg_assistant",
    ]);
    assert.match(result.mappingDigestSha256, /^[0-9a-f]{64}$/u);

    const read = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = read
      .prepare("SELECT role, text FROM projection_thread_messages ORDER BY created_at")
      .all() as Array<{ readonly role: string; readonly text: string }>;
    read.close();
    assert.deepStrictEqual(rows, [
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects reordered OpenCode durable events before writing T3 state", async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-public-materializer-invalid-"),
  );
  try {
    const dbPath = NodePath.join(root, "state.sqlite");
    const database = new NodeSqlite.DatabaseSync(dbPath);
    createSchema(database);
    database.close();
    const corpus = await writeCorpusFixture(root, true);
    let rejection: unknown;
    try {
      await materializeT3PublicCorpus({
        corpusDirectory: corpus.directory,
        corpusManifestPath: corpus.manifestPath,
        expectedCorpusDigestSha256: corpus.corpusDigestSha256,
        expectedEventSchemaDigestSha256: corpus.eventSchemaDigestSha256,
        dbPath,
        disposableRoot: root,
        workspaceRoot: root,
      });
    } catch (error) {
      rejection = error;
    }
    assert.match(String(rejection), /invalid event order/u);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

async function writeCorpusFixture(
  root: string,
  reorder = false,
): Promise<{
  readonly directory: string;
  readonly manifestPath: string;
  readonly corpusDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
}> {
  const directory = NodePath.join(root, "corpus");
  await NodeFSP.mkdir(NodePath.join(directory, "sessions"), { recursive: true });
  const sessionID = "ses_bench_control";
  const events = [
    {
      id: "evt_0",
      type: "session.created.1",
      seq: 0,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: {
          id: sessionID,
          title: "Control",
          time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
        },
      },
    },
    {
      id: "evt_1",
      type: "message.updated.1",
      seq: reorder ? 9 : 1,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: { id: "msg_user", sessionID, role: "user", time: { created: 1_700_000_000_001 } },
      },
    },
    {
      id: "evt_2",
      type: "message.part.updated.1",
      seq: 2,
      aggregateID: sessionID,
      data: {
        sessionID,
        part: { id: "prt_user", sessionID, messageID: "msg_user", type: "text", text: "hello" },
        time: 1_700_000_000_002,
      },
    },
    {
      id: "evt_3",
      type: "message.updated.1",
      seq: 3,
      aggregateID: sessionID,
      data: {
        sessionID,
        info: {
          id: "msg_assistant",
          sessionID,
          role: "assistant",
          time: { created: 1_700_000_000_003, completed: 1_700_000_000_004 },
        },
      },
    },
    {
      id: "evt_4",
      type: "message.part.updated.1",
      seq: 4,
      aggregateID: sessionID,
      data: {
        sessionID,
        part: {
          id: "prt_assistant",
          sessionID,
          messageID: "msg_assistant",
          type: "text",
          text: "world",
        },
        time: 1_700_000_000_004,
      },
    },
  ];
  const bytes = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const relativeFile = "sessions/control.ndjson";
  await NodeFSP.writeFile(NodePath.join(directory, relativeFile), bytes);
  const corpusDigestSha256 = "a".repeat(64);
  const eventSchemaDigestSha256 = "b".repeat(64);
  const manifest = {
    schemaVersion: 1,
    corpusId: "fixture-v1",
    corpusDigestSha256,
    sourceEventFormat: { schemaDigestSha256: eventSchemaDigestSha256 },
    sessions: [
      {
        logicalSessionId: "control",
        nativeSessionId: sessionID,
        workspaceId: "workspace-a",
        role: "control",
        transcriptBytes: 10,
        eventCount: 5,
        file: relativeFile,
        fileDigestSha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const manifestPath = NodePath.join(directory, "manifest.json");
  await NodeFSP.writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifestPath, corpusDigestSha256, eventSchemaDigestSha256 };
}

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
