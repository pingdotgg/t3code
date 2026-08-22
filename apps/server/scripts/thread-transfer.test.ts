import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { exportThread, importThread, listThreads } from "./thread-transfer.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeProjectPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ projectId: Schema.String })),
);

interface FixtureInput {
  readonly workspace: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly orchestrationVersion: 1 | 2;
  readonly includeV1EventBesideV2?: boolean;
  readonly state?: "userdata" | "dev";
}

const createFixtureDatabase = Effect.fn("createThreadTransferFixtureDatabase")(function* (
  input: FixtureInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(input.workspace, ".t3", input.state ?? "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`;
    yield* sql`CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL
    )`;
    if (input.orchestrationVersion === 2) {
      yield* sql`CREATE TABLE orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_event_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        application_event_version INTEGER NOT NULL
      )`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL
      )`;
      yield* sql`CREATE TABLE orchestration_v2_turn_item_positions (
        thread_id TEXT NOT NULL,
        turn_item_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_item_id)
      )`;
    } else {
      yield* sql`CREATE TABLE orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_event_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      )`;
    }
    yield* sql`INSERT INTO projection_projects (
      project_id, title, workspace_root, updated_at, deleted_at
    ) VALUES (
      ${input.projectId},
      ${`Project ${input.projectId}`},
      ${input.workspace},
      '2026-08-20T12:00:00.000Z',
      NULL
    )`;
    if (input.threadId === undefined) return;

    if (input.orchestrationVersion === 1) {
      yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, updated_at
      ) VALUES (
        ${input.threadId}, ${input.projectId}, 'Image rendering thread', '2026-08-20T12:00:00.000Z'
      )`;
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, text
      ) VALUES ('message-v1', ${input.threadId}, 'Render this image')`;
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (
        'event-v1', 'thread', ${input.threadId}, 0, 'ThreadCreated',
        '2026-08-20T12:00:00.000Z', NULL, NULL, NULL, 'client',
        ${encodeUnknownJson({ threadId: input.threadId, projectId: input.projectId })}, '{}'
      )`;
      return;
    }

    yield* sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title
    ) VALUES (${input.threadId}, ${input.projectId}, 'Codex turn mapping thread')`;
    yield* sql`INSERT INTO orchestration_v2_turn_item_positions (
      thread_id, turn_item_id, ordinal
    ) VALUES (${input.threadId}, 'turn-item-v2', 1000001)`;
    if (input.includeV1EventBesideV2 === true) {
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
        application_event_version
      ) VALUES (
        'legacy-event', 'thread', ${input.threadId}, 0, 'ThreadCreated',
        '2026-08-20T11:00:00.000Z', NULL, NULL, NULL, 'client',
        ${encodeUnknownJson({ threadId: input.threadId, projectId: input.projectId })}, '{}', 1
      )`;
    }
    yield* sql`INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
      application_event_version
    ) VALUES (
      'event-v2', 'thread', ${input.threadId}, 1, 'thread.created',
      '2026-08-20T12:00:00.000Z', NULL, NULL, NULL, 'server',
      ${encodeUnknownJson({ id: input.threadId, projectId: input.projectId, title: "Codex turn mapping thread" })},
      ${encodeUnknownJson({ runId: null, nodeId: null })}, 2
    )`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  return databasePath;
});

it.layer(NodeServices.layer)("thread transfer", (it) => {
  it.effect("moves a v1 thread, its projection rows, and its image into another project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-v1-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      yield* createFixtureDatabase({
        workspace: source,
        projectId: "project-source",
        threadId: "thread-v1",
        orchestrationVersion: 1,
      });
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      const attachmentName = "thread-v1-00000000-0000-4000-8000-000000000001.png";
      const sourceAttachments = path.join(source, ".t3", "userdata", "attachments");
      yield* fs.makeDirectory(sourceAttachments, { recursive: true });
      yield* fs.writeFile(
        path.join(sourceAttachments, attachmentName),
        Uint8Array.from([137, 80, 78, 71]),
      );
      const terminalLogName = `terminal_${Encoding.encodeBase64Url("thread-v1")}.log`;
      const sourceTerminalLogs = path.join(source, ".t3", "userdata", "logs", "terminals");
      yield* fs.makeDirectory(sourceTerminalLogs, { recursive: true });
      yield* fs.writeFileString(
        path.join(sourceTerminalLogs, terminalLogName),
        "\u001b[32mterminal output\u001b[0m\n",
      );
      yield* fs.writeFileString(
        path.join(sourceTerminalLogs, "terminal_dW5yZWxhdGVk.log"),
        "unrelated output\n",
      );

      const listed = yield* listThreads({ source });
      assert.deepStrictEqual(listed, [
        {
          id: "thread-v1",
          title: "Image rendering thread",
          projectId: "project-source",
          projectTitle: "Project project-source",
          workspaceRoot: source,
          updatedAt: "2026-08-20T12:00:00.000Z",
          orchestrationVersion: 1,
        },
      ]);

      const exported = yield* exportThread({
        source,
        threadId: "thread-v1",
        output: archivePath,
        includeTerminalLogs: true,
      });
      assert.equal(exported.orchestrationVersion, 1);
      assert.equal(exported.attachmentCount, 1);
      assert.equal(exported.terminalLogCount, 1);

      const imported = yield* importThread(
        { archive: archivePath, destination },
        { sharedHome: path.join(root, "shared-home") },
      );
      assert.equal(imported.targetProjectId, "project-target");
      assert.isTrue(yield* fs.exists(imported.backup));
      assert.isTrue(
        yield* fs.exists(path.join(destination, ".t3", "userdata", "attachments", attachmentName)),
      );
      assert.equal(imported.terminalLogCount, 1);
      assert.equal(
        yield* fs.readFileString(
          path.join(destination, ".t3", "userdata", "logs", "terminals", terminalLogName),
        ),
        "\u001b[32mterminal output\u001b[0m\n",
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* sql<{ readonly projectId: string }>`
          SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = 'thread-v1'`;
        const messages = yield* sql<{ readonly text: string }>`
          SELECT text FROM projection_thread_messages WHERE thread_id = 'thread-v1'`;
        const events = yield* sql<{ readonly payload: string }>`
          SELECT payload_json AS payload FROM orchestration_events WHERE stream_id = 'thread-v1'`;
        assert.deepStrictEqual(threads, [{ projectId: "project-target" }]);
        assert.deepStrictEqual(messages, [{ text: "Render this image" }]);
        assert.equal(decodeProjectPayload(events[0]!.payload).projectId, "project-target");
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: destinationDatabase, readonly: true })),
      );
    }),
  );

  it.effect(
    "exports only v2 events from a migrated stream and imports them into a v2 database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-v2-" });
        const source = path.join(root, "source");
        const destination = path.join(root, "destination");
        const archivePath = path.join(root, "thread.json");
        yield* createFixtureDatabase({
          workspace: source,
          projectId: "project-source-v2",
          threadId: "thread-v2",
          orchestrationVersion: 2,
          includeV1EventBesideV2: true,
          state: "dev",
        });
        const sourceTerminalLogs = path.join(source, ".t3", "dev", "logs", "terminals");
        yield* fs.makeDirectory(sourceTerminalLogs, { recursive: true });
        yield* fs.writeFileString(
          path.join(sourceTerminalLogs, `terminal_${Encoding.encodeBase64Url("thread-v2")}.log`),
          "excluded by default\n",
        );
        const destinationDatabase = yield* createFixtureDatabase({
          workspace: destination,
          projectId: "project-target-v2",
          orchestrationVersion: 2,
          state: "dev",
        });

        const listed = yield* listThreads({ source, state: "dev" });
        assert.deepStrictEqual(listed, [
          {
            id: "thread-v2",
            title: "Codex turn mapping thread",
            projectId: "project-source-v2",
            projectTitle: "Project project-source-v2",
            workspaceRoot: source,
            updatedAt: null,
            orchestrationVersion: 2,
          },
        ]);

        const exported = yield* exportThread({
          source,
          state: "dev",
          threadId: "thread-v2",
          output: archivePath,
        });
        assert.equal(exported.orchestrationVersion, 2);
        assert.equal(exported.eventCount, 1);
        assert.equal(exported.terminalLogCount, 0);

        const imported = yield* importThread(
          { archive: archivePath, destination, state: "dev" },
          { sharedHome: path.join(root, "shared-home") },
        );
        assert.equal(imported.terminalLogCount, 0);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const events = yield* sql<{
            readonly version: number;
            readonly type: string;
            readonly payload: string;
          }>`
          SELECT application_event_version AS version, event_type AS type, payload_json AS payload
          FROM orchestration_events
          WHERE stream_id = 'thread-v2'`;
          const positions = yield* sql<{ readonly itemId: string; readonly ordinal: number }>`
          SELECT turn_item_id AS "itemId", ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = 'thread-v2'`;
          assert.equal(events.length, 1);
          assert.equal(events[0]!.version, 2);
          assert.equal(events[0]!.type, "thread.created");
          assert.equal(decodeProjectPayload(events[0]!.payload).projectId, "project-target-v2");
          assert.deepStrictEqual(positions, [{ itemId: "turn-item-v2", ordinal: 1000001 }]);
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: destinationDatabase, readonly: true })),
        );
      }),
  );

  it.effect("imports a released v1 thread into a direct v2 dev state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-cross-version-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      const sourceDatabase = yield* createFixtureDatabase({
        workspace: source,
        projectId: "project-release",
        threadId: "thread-from-release",
        orchestrationVersion: 1,
      });
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-dev",
        orchestrationVersion: 2,
        state: "dev",
      });

      yield* exportThread({
        source: path.dirname(sourceDatabase),
        threadId: "thread-from-release",
        output: archivePath,
      });
      const imported = yield* importThread(
        {
          archive: archivePath,
          destination: path.dirname(destinationDatabase),
          targetProjectId: "project-dev",
        },
        { sharedHome: path.join(root, "shared-home") },
      );
      assert.equal(imported.orchestrationVersion, 1);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* sql<{ readonly version: number }>`
          SELECT application_event_version AS version
          FROM orchestration_events
          WHERE stream_id = 'thread-from-release'`;
        assert.deepStrictEqual(events, [{ version: 1 }]);
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: destinationDatabase, readonly: true })),
      );
    }),
  );
});
