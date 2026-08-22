import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import {
  exportThread,
  importThread,
  listThreads,
  ThreadArchive,
  ThreadTransferError,
} from "./thread-transfer.ts";

const withDatabase =
  (databasePath: string, readonly = false) =>
  <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly })));

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeArchive = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadArchive));
const encodeArchive = Schema.encodeSync(Schema.fromJsonString(ThreadArchive));

const failImport = (...args: Parameters<typeof importThread>) =>
  importThread(...args).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.instanceOf(error, ThreadTransferError);
      return error;
    }),
  );

const failExport = (...args: Parameters<typeof exportThread>) =>
  exportThread(...args).pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.instanceOf(error, ThreadTransferError);
      return error;
    }),
  );

const decodeProjectPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      projectId: Schema.String,
      worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

const TERMINAL_LOG_CONTENTS = "[32mterminal output[0m\n";

/** Writes one terminal history file owned by `threadId` below `stateDir` and returns its name. */
const writeTerminalLog = Effect.fn("writeThreadTransferTerminalLog")(function* (
  stateDir: string,
  threadId: string,
  contents = TERMINAL_LOG_CONTENTS,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "logs", "terminals");
  const fileName = `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, fileName), contents);
  return fileName;
});

interface FixtureInput {
  readonly workspace: string;
  readonly projectId: string;
  readonly threadId?: string;
  readonly orchestrationVersion: 1 | 2;
  readonly includeV1EventBesideV2?: boolean;
  readonly state?: "userdata" | "dev";
  readonly worktreePath?: string;
}

/**
 * Seeds the subset of the server schema the transfer scripts touch. A v2
 * database carries the `application_event_version` column and the v2 tables
 * the scripts probe; the v1 thread event is a contract-valid `thread.created`
 * because the importer decodes v1 archives against `@t3tools/contracts`.
 */
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
      worktree_path TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )`;
    yield* sql`CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL
    )`;
    yield* sql.unsafe(`CREATE TABLE orchestration_events (
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
      metadata_json TEXT NOT NULL${
        input.orchestrationVersion === 2
          ? ",\n      application_event_version INTEGER NOT NULL DEFAULT 1"
          : ""
      },
      UNIQUE (aggregate_kind, stream_id, stream_version)
    )`).unprepared;
    if (input.orchestrationVersion === 2) {
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`;
      yield* sql`CREATE TABLE orchestration_v2_legacy_imports (
        thread_id TEXT PRIMARY KEY,
        transcript_imported_at TEXT
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
        thread_id, project_id, title, worktree_path, updated_at, deleted_at
      ) VALUES (
        ${input.threadId}, ${input.projectId}, 'Image rendering thread',
        ${input.worktreePath ?? null}, '2026-08-20T12:00:00.000Z', NULL
      )`;
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, text
      ) VALUES ('message-v1', ${input.threadId}, 'Render this image')`;
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (
        'event-v1', 'thread', ${input.threadId}, 0, 'thread.created',
        '2026-08-20T12:00:00.000Z', NULL, NULL, NULL, 'client',
        ${encodeUnknownJson({
          threadId: input.threadId,
          projectId: input.projectId,
          title: "Image rendering thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          branch: null,
          worktreePath: input.worktreePath ?? null,
          createdAt: "2026-08-20T12:00:00.000Z",
          updatedAt: "2026-08-20T12:00:00.000Z",
        })}, '{}'
      )`;
      return;
    }

    yield* sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, updated_at, deleted_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, 'Codex turn mapping thread',
      '2026-08-20T12:00:00.000Z', NULL
    )`;
    if (input.includeV1EventBesideV2 === true) {
      yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json,
        application_event_version
      ) VALUES (
        'legacy-event', 'thread', ${input.threadId}, 0, 'thread.created',
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
  }).pipe(withDatabase(databasePath));
  return databasePath;
});

/** Seeds a v1 source state with one thread and one attachment, returning what the tests need. */
const createAttachmentSource = Effect.fn("createThreadTransferAttachmentSource")(function* (
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* createFixtureDatabase({
    workspace: source,
    projectId: "project-source",
    threadId: "thread-v1",
    orchestrationVersion: 1,
  });
  const attachmentName = "thread-v1-00000000-0000-4000-8000-000000000001.png";
  const attachmentsDir = path.join(source, ".t3", "userdata", "attachments");
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  yield* fs.writeFile(
    path.join(attachmentsDir, attachmentName),
    Uint8Array.from([137, 80, 78, 71]),
  );
  return { attachmentName };
});

const readThreadEventIds = (databasePath: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly eventId: string }>`
      SELECT event_id AS "eventId" FROM orchestration_events
      WHERE stream_id = ${threadId} ORDER BY sequence`;
    return rows.map((row) => row.eventId);
  }).pipe(withDatabase(databasePath, true));

it.layer(NodeServices.layer)("thread transfer", (it) => {
  it.effect("moves a v1 thread, its projection rows, and its image into another project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-v1-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      const { attachmentName } = yield* createAttachmentSource(source);
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      const sourceStateDir = path.join(source, ".t3", "userdata");
      const terminalLogName = yield* writeTerminalLog(sourceStateDir, "thread-v1");
      yield* writeTerminalLog(sourceStateDir, "unrelated", "unrelated output\n");

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
      assert.deepStrictEqual(
        yield* readThreadEventIds(imported.backup, "thread-v1"),
        [],
        "backup holds the pre-import database",
      );
      assert.isTrue(
        yield* fs.exists(path.join(destination, ".t3", "userdata", "attachments", attachmentName)),
      );
      assert.equal(imported.terminalLogCount, 1);
      assert.equal(
        yield* fs.readFileString(
          path.join(destination, ".t3", "userdata", "logs", "terminals", terminalLogName),
        ),
        TERMINAL_LOG_CONTENTS,
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* sql`SELECT thread_id FROM projection_threads`;
        const events = yield* sql<{ readonly payload: string }>`
          SELECT payload_json AS payload FROM orchestration_events WHERE stream_id = 'thread-v1'`;
        assert.deepStrictEqual(threads, [], "read model is left for the server to rebuild");
        assert.equal(decodeProjectPayload(events[0]!.payload).projectId, "project-target");
      }).pipe(withDatabase(destinationDatabase, true));
    }),
  );

  it.effect("keeps worktree paths that exist on the destination and clears the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-worktree-" });
      const sharedHome = path.join(root, "shared-home");
      const presentWorktree = path.join(root, "present-worktree");
      yield* fs.makeDirectory(presentWorktree, { recursive: true });
      const missingWorktree = path.join(root, "missing-worktree");

      const readImportedWorktree = (destinationDatabase: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const events = yield* sql<{ readonly payload: string }>`
            SELECT payload_json AS payload FROM orchestration_events WHERE stream_id = 'thread-v1'`;
          return decodeProjectPayload(events[0]!.payload).worktreePath;
        }).pipe(withDatabase(destinationDatabase, true));

      for (const [name, worktreePath, expected] of [
        ["present", presentWorktree, presentWorktree],
        ["missing", missingWorktree, null],
      ] as const) {
        const source = path.join(root, name, "source");
        const destination = path.join(root, name, "destination");
        const archivePath = path.join(root, name, "thread.json");
        yield* createFixtureDatabase({
          workspace: source,
          projectId: "project-source",
          threadId: "thread-v1",
          orchestrationVersion: 1,
          worktreePath,
        });
        const destinationDatabase = yield* createFixtureDatabase({
          workspace: destination,
          projectId: "project-target",
          orchestrationVersion: 1,
        });
        yield* exportThread({ source, threadId: "thread-v1", output: archivePath });
        const imported = yield* importThread({ archive: archivePath, destination }, { sharedHome });
        assert.deepStrictEqual(
          imported.droppedWorktreePaths,
          expected === null ? [worktreePath] : [],
          name,
        );
        assert.equal(yield* readImportedWorktree(destinationDatabase), expected, name);
      }
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
        yield* writeTerminalLog(path.join(source, ".t3", "dev"), "thread-v2");
        const destinationDatabase = yield* createFixtureDatabase({
          workspace: destination,
          projectId: "project-target-v2",
          orchestrationVersion: 2,
          state: "dev",
        });

        const listed = yield* listThreads({ source, state: "dev" });
        assert.deepStrictEqual(listed.threads, [
          {
            id: "thread-v2",
            title: "Codex turn mapping thread",
            projectId: "project-source-v2",
            projectTitle: "Project project-source-v2",
            workspaceRoot: source,
            updatedAt: "2026-08-20T12:00:00.000Z",
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
          assert.equal(events.length, 1);
          assert.equal(events[0]!.version, 2);
          assert.equal(events[0]!.type, "thread.created");
          assert.equal(decodeProjectPayload(events[0]!.payload).projectId, "project-target-v2");
        }).pipe(withDatabase(destinationDatabase, true));
      }),
  );

  it.effect("refuses to export a migrated v2 thread whose transcript is still v1-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-pending-" });
      const source = path.join(root, "source");
      const sourceDatabase = yield* createFixtureDatabase({
        workspace: source,
        projectId: "project-source-v2",
        threadId: "thread-v2",
        orchestrationVersion: 2,
        includeV1EventBesideV2: true,
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, transcript_imported_at)
          VALUES ('thread-v2', NULL)`;
      }).pipe(withDatabase(sourceDatabase));

      const error = yield* failExport({
        source,
        threadId: "thread-v2",
        output: path.join(root, "thread.json"),
      });
      assert.equal(
        error.detail,
        "Thread 'thread-v2' still has a pending v1 transcript import. Open it in the source T3 server first so its messages become v2 events.",
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
      }).pipe(withDatabase(destinationDatabase, true));
    }),
  );

  it.effect("falls back to the thread.created payload when the projection row is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-no-row-" });
      const source = path.join(root, "source");
      const archivePath = path.join(root, "thread.json");
      const sourceDatabase = yield* createFixtureDatabase({
        workspace: source,
        projectId: "project-source",
        threadId: "thread-v1",
        orchestrationVersion: 1,
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_threads WHERE thread_id = 'thread-v1'`;
      }).pipe(withDatabase(sourceDatabase));

      const exported = yield* exportThread({ source, threadId: "thread-v1", output: archivePath });
      assert.equal(exported.title, "thread-v1");
      const archive = decodeArchive(yield* fs.readFileString(archivePath));
      assert.equal(archive.thread.sourceProjectId, "project-source");
    }),
  );

  it.effect("exports every terminal history the server attributes to the thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-terminals-" });
      const source = path.join(root, "source");
      const archivePath = path.join(root, "thread.json");
      yield* createFixtureDatabase({
        workspace: source,
        projectId: "project-source",
        threadId: "thread-v1",
        orchestrationVersion: 1,
      });
      const threadPart = `terminal_${Encoding.encodeBase64Url("thread-v1")}`;
      const owned = [
        `${threadPart}.log`,
        `${threadPart}_${Encoding.encodeBase64Url("terminal-1")}.log`,
        "thread-v1.log",
      ];
      const foreign = [
        `terminal_${Encoding.encodeBase64Url("thread-v10")}.log`,
        `terminal_${Encoding.encodeBase64Url("thread-v10")}_${Encoding.encodeBase64Url("t")}.log`,
        "thread-v10.log",
      ];
      const logsDir = path.join(source, ".t3", "userdata", "logs", "terminals");
      yield* fs.makeDirectory(logsDir, { recursive: true });
      for (const name of [...owned, ...foreign]) {
        yield* fs.writeFileString(path.join(logsDir, name), `${name}\n`);
      }

      const exported = yield* exportThread({
        source,
        threadId: "thread-v1",
        output: archivePath,
        includeTerminalLogs: true,
      });
      assert.equal(exported.terminalLogCount, owned.length);
      const archive = decodeArchive(yield* fs.readFileString(archivePath));
      assert.deepStrictEqual(
        archive.terminalLogs.map((log) => log.fileName).sort(),
        [...owned].sort(),
      );
    }),
  );

  it.effect("refuses imports that would collide, downgrade, or touch shared state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-refusals-" });
      const source = path.join(root, "source");
      const archivePath = path.join(root, "thread.json");
      const sharedHome = path.join(root, "shared-home");
      yield* createAttachmentSource(source);
      yield* exportThread({ source, threadId: "thread-v1", output: archivePath });

      const missing = yield* failImport(
        { archive: archivePath, destination: path.join(root, "nowhere") },
        { sharedHome },
      );
      assert.match(missing.detail, /^No T3 userdata database found at /);

      const collision = yield* failImport(
        { archive: archivePath, destination: source },
        { sharedHome },
      );
      assert.equal(collision.detail, "Thread 'thread-v1' already exists in the destination.");

      yield* createFixtureDatabase({
        workspace: sharedHome,
        projectId: "project-shared",
        orchestrationVersion: 1,
      });
      const shared = yield* failImport(
        { archive: archivePath, destination: path.join(sharedHome, ".t3") },
        { sharedHome: path.join(sharedHome, ".t3") },
      );
      assert.equal(
        shared.detail,
        "Refusing to mutate the shared ~/.t3/userdata database. Choose an isolated destination or pass --dangerous-allow-t3-directory.",
      );
      const allowed = yield* importThread(
        {
          archive: archivePath,
          destination: path.join(sharedHome, ".t3"),
          dangerousAllowT3Directory: true,
        },
        { sharedHome: path.join(sharedHome, ".t3") },
      );
      assert.equal(allowed.targetProjectId, "project-shared");

      const v2Source = path.join(root, "v2-source");
      const v2Archive = path.join(root, "thread-v2.json");
      yield* createFixtureDatabase({
        workspace: v2Source,
        projectId: "project-source-v2",
        threadId: "thread-v2",
        orchestrationVersion: 2,
      });
      yield* exportThread({ source: v2Source, threadId: "thread-v2", output: v2Archive });
      const v1Destination = path.join(root, "v1-destination");
      yield* createFixtureDatabase({
        workspace: v1Destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      const downgrade = yield* failImport(
        { archive: v2Archive, destination: v1Destination },
        { sharedHome },
      );
      assert.equal(
        downgrade.detail,
        "The destination schema does not support Orchestrator v2 events.",
      );
    }),
  );

  it.effect("rejects archives whose events stray from the thread or its contract", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-events-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      const sharedHome = path.join(root, "shared-home");
      yield* createAttachmentSource(source);
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      yield* exportThread({ source, threadId: "thread-v1", output: archivePath });
      const archive = decodeArchive(yield* fs.readFileString(archivePath));
      const [created] = archive.events;

      const foreignPath = path.join(root, "foreign.json");
      yield* fs.writeFileString(
        foreignPath,
        encodeArchive({
          ...archive,
          events: [created!, { ...created!, eventId: "event-other", streamId: "thread-other" }],
        }),
      );
      const foreign = yield* failImport({ archive: foreignPath, destination }, { sharedHome });
      assert.equal(foreign.operation, "read archive");
      assert.equal(foreign.detail, "Event 'event-other' does not belong to thread 'thread-v1'.");

      const skewedPath = path.join(root, "skewed.json");
      yield* fs.writeFileString(
        skewedPath,
        encodeArchive({
          ...archive,
          events: [{ ...created!, payloadJson: encodeUnknownJson({ threadId: "thread-v1" }) }],
        }),
      );
      const skewed = yield* failImport({ archive: skewedPath, destination }, { sharedHome });
      assert.equal(
        skewed.detail,
        "Event 'event-v1' (thread.created) does not match this checkout's orchestration contract. Run the import from the destination's checkout.",
      );
      assert.deepStrictEqual(yield* readThreadEventIds(destinationDatabase, "thread-v1"), []);
      assert.isFalse(yield* fs.exists(path.join(destination, ".t3", "userdata", "attachments")));
    }),
  );

  it.effect("rejects a corrupt archive file before writing anything to the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-checksum-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      yield* createAttachmentSource(source);
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      const terminalLogName = yield* writeTerminalLog(
        path.join(source, ".t3", "userdata"),
        "thread-v1",
      );
      yield* exportThread({
        source,
        threadId: "thread-v1",
        output: archivePath,
        includeTerminalLogs: true,
      });
      const archive = decodeArchive(yield* fs.readFileString(archivePath));
      const tampered = {
        ...archive,
        terminalLogs: archive.terminalLogs.map((log) => ({ ...log, sha256: "0".repeat(64) })),
      };
      yield* fs.writeFileString(archivePath, encodeArchive(tampered));

      const error = yield* failImport(
        { archive: archivePath, destination },
        { sharedHome: path.join(root, "shared-home") },
      );
      assert.equal(error.detail, `Terminal log '${terminalLogName}' failed its checksum.`);
      assert.isFalse(yield* fs.exists(path.join(destination, ".t3", "userdata", "attachments")));
      assert.isFalse(
        yield* fs.exists(path.join(destination, ".t3", "userdata", "logs", "terminals")),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const events = yield* sql`SELECT event_id FROM orchestration_events`;
        assert.deepStrictEqual(events, []);
      }).pipe(withDatabase(destinationDatabase, true));
    }),
  );

  it.effect("rolls back every event and removes the files it wrote when one insert fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "thread-transfer-rollback-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const archivePath = path.join(root, "thread.json");
      const { attachmentName } = yield* createAttachmentSource(source);
      const destinationDatabase = yield* createFixtureDatabase({
        workspace: destination,
        projectId: "project-target",
        orchestrationVersion: 1,
      });
      // The second archived event collides with an event id the destination
      // already holds, so the first insert succeeds and the second fails.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-archived', 'thread', 'thread-other', 0, 'thread.created',
          '2026-08-20T12:00:00.000Z', NULL, NULL, NULL, 'client', '{}', '{}'
        )`;
      }).pipe(withDatabase(destinationDatabase));
      yield* exportThread({ source, threadId: "thread-v1", output: archivePath });
      const archive = decodeArchive(yield* fs.readFileString(archivePath));
      const [created] = archive.events;
      yield* fs.writeFileString(
        archivePath,
        encodeArchive({
          ...archive,
          events: [
            created!,
            {
              ...created!,
              eventId: "event-archived",
              streamVersion: 1,
              eventType: "thread.archived",
              payloadJson: encodeUnknownJson({
                threadId: "thread-v1",
                archivedAt: "2026-08-20T13:00:00.000Z",
                updatedAt: "2026-08-20T13:00:00.000Z",
              }),
            },
          ],
        }),
      );

      const error = yield* failImport(
        { archive: archivePath, destination },
        { sharedHome: path.join(root, "shared-home") },
      );
      assert.equal(error.operation, "import thread");
      assert.isFalse(
        yield* fs.exists(path.join(destination, ".t3", "userdata", "attachments", attachmentName)),
      );
      assert.deepStrictEqual(yield* readThreadEventIds(destinationDatabase, "thread-v1"), []);
      assert.deepStrictEqual(yield* readThreadEventIds(destinationDatabase, "thread-other"), [
        "event-archived",
      ]);
    }),
  );
});
