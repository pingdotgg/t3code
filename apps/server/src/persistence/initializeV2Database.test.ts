// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { commitV1Copy, initializeV2Database } from "./initializeV2Database.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(layerDatabase));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

const seedV1 = (sourcePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

const createV1Thread = (sourcePath: string, threadId: string) => {
  const v1 = new NodeSqlite.DatabaseSync(sourcePath);
  try {
    v1.prepare(
      `INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (?, 'thread', ?, 0, 'thread.created', '2026-01-02T00:00:00.000Z', 'client', '{}', '{}')`,
    ).run(`created:${threadId}`, threadId);
    v1.prepare(
      `INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (?, 'project', ?, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
    ).run(threadId, threadId);
  } finally {
    v1.close();
  }
};

const readCopy = (destinationPath: string) => {
  const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
  try {
    return {
      threads: copy
        .prepare("SELECT thread_id FROM projection_threads ORDER BY thread_id")
        .all()
        .map((row) => row.thread_id),
      uncommitted:
        copy.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'uncommitted_v1_copy'").get() !==
        undefined,
      migratedToV2:
        copy.prepare("SELECT 1 FROM effect_sql_migrations WHERE migration_id > 52").get() !==
        undefined,
    };
  } finally {
    copy.close();
  }
};

const withV1AndV2 = <A, E, R>(
  run: (paths: {
    readonly sourcePath: string;
    readonly destinationPath: string;
  }) => Effect.Effect<A, E, R>,
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-uncommitted-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    yield* seedV1(sourcePath);
    createV1Thread(sourcePath, "thread-before");
    return yield* run({ sourcePath, destinationPath });
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
};

// Like a launcher trial rolled back after its migrations: the copy changed, but nothing committed it.
const startWithoutCommitting = (destinationPath: string) =>
  Effect.scoped(Layer.build(SqlitePersistence.layerFromPath(destinationPath)));

it.effect("copies V1 again when V1 changed after a start that never committed its copy", () =>
  withV1AndV2(({ sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      yield* initializeV2Database(destinationPath, { deferCommit: true });
      yield* startWithoutCommitting(destinationPath);
      createV1Thread(sourcePath, "thread-after");

      yield* initializeV2Database(destinationPath, { deferCommit: true });

      const copy = readCopy(destinationPath);
      assert.deepEqual(copy.threads, ["thread-after", "thread-before"]);
      assert.isTrue(copy.uncommitted);
      assert.isFalse(copy.migratedToV2);
    }),
  ),
);

it.effect("keeps an uncommitted copy while V1 has not changed", () =>
  withV1AndV2(({ destinationPath }) =>
    Effect.gen(function* () {
      yield* initializeV2Database(destinationPath, { deferCommit: true });
      yield* startWithoutCommitting(destinationPath);

      yield* initializeV2Database(destinationPath, { deferCommit: true });

      const copy = readCopy(destinationPath);
      assert.deepEqual(copy.threads, ["thread-before"]);
      assert.isTrue(copy.uncommitted);
      assert.isTrue(copy.migratedToV2);
    }),
  ),
);

it.effect("never replaces a copy once a server committed it", () =>
  withV1AndV2(({ sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      yield* initializeV2Database(destinationPath, { deferCommit: true });
      yield* Effect.gen(function* () {
        yield* commitV1Copy();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(SqlitePersistence.layerFromPath(destinationPath)));
      createV1Thread(sourcePath, "thread-after");

      yield* initializeV2Database(destinationPath, { deferCommit: true });

      const copy = readCopy(destinationPath);
      assert.deepEqual(copy.threads, ["thread-before"]);
      assert.isFalse(copy.uncommitted);
      const v2 = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.equal(v2.prepare("SELECT text FROM v2_work").get()?.text, "Keep V2 work");
      } finally {
        v2.close();
      }
    }),
  ),
);

it.effect("keeps an uncommitted copy that another process has open", () =>
  withV1AndV2(({ sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      yield* initializeV2Database(destinationPath, { deferCommit: true });
      createV1Thread(sourcePath, "thread-after");

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const other = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
          other.prepare("SELECT count(*) FROM projection_threads").get();
          return other;
        }),
        () => initializeV2Database(destinationPath, { deferCommit: true }),
        (other) => Effect.sync(() => other.close()),
      );

      assert.deepEqual(readCopy(destinationPath).threads, ["thread-before"]);
    }),
  ),
);

it.effect("leaves only a server's copy uncommitted; other processes commit it on open", () =>
  withV1AndV2(({ destinationPath }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );

      yield* Effect.scoped(Layer.build(layerDatabase)).pipe(
        Effect.provideService(ServerActivation, Effect.never),
      );
      assert.isTrue(readCopy(destinationPath).uncommitted);

      yield* Effect.scoped(Layer.build(layerDatabase));
      assert.isFalse(readCopy(destinationPath).uncommitted);
    }),
  ),
);
