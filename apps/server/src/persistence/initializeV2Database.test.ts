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
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database, replaceStaleV2Database } from "./initializeV2Database.ts";
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

const makeStaleCopy = Effect.fn(function* (name: string) {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-v1-v2-${name}-`))),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-a', 'Project A', '/tmp/project-a', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES ('thread-a', 'project-a', 'First V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
    VALUES ('session-a', 'phone', '[]', 'browser-session-cookie', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at)
    VALUES ('link-a', 'credential-a', 'desktop-bootstrap', '[]', 'phone', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

  const services = ServerConfig.layerTest(directory, directory).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(services));
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
  const startV2 = Effect.gen(function* () {
    yield* replaceStaleV2Database(destinationPath);
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).reconcileShells;
      const rows =
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
      return rows.map((row) => row.thread_id);
    }).pipe(Effect.provide(layerImporter));
  }).pipe(Effect.provide(services));
  const inV2 = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provide(layerDatabase.pipe(Layer.provide(services))));

  assert.deepEqual(yield* startV2, ["thread-a"]);
  return { directory, startV2, inV2 };
});

const addNewerV1Thread = (directory: string) =>
  Effect.sync(() => {
    const v1 = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"));
    try {
      v1.exec(`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project-b', 'Project B', '/tmp/project-b', '[]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('thread-b', 'project-b', 'Newer V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');`);
    } finally {
      v1.close();
    }
  });

const backups = (directory: string) =>
  NodeFS.readdirSync(directory)
    .filter((name) => name.includes(".stale"))
    .toSorted();

it.effect("re-seeds a V2 store without V2 work when V1 gained threads after the copy", () =>
  Effect.gen(function* () {
    const { directory, startV2, inV2 } = yield* makeStaleCopy("stale");
    // Opening a client records visits and the server settles threads on its own within a
    // minute; neither is V2 work worth keeping a stale copy for.
    yield* inV2(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TEMP TABLE server_events AS
            SELECT * FROM orchestration_events WHERE application_event_version = 2 LIMIT 1`;
        yield* sql`INSERT INTO server_events SELECT * FROM server_events`;
        yield* sql`UPDATE server_events SET
            sequence = NULL,
            event_id = 'event-' || rowid,
            stream_version = stream_version + 1000 + rowid,
            event_type = CASE rowid WHEN 1 THEN 'thread.visited' ELSE 'thread.settled' END,
            command_id = CASE rowid WHEN 1 THEN 'client:visit' ELSE 'server:auto-settle:thread-a' END`;
        yield* sql`INSERT INTO orchestration_events SELECT * FROM server_events`;
      }),
    );
    NodeFS.writeFileSync(NodePath.join(directory, "statev2.sqlite.stale"), "older backup");
    NodeFS.writeFileSync(NodePath.join(directory, "statev2.sqlite.stale-wal"), "older backup");
    yield* addNewerV1Thread(directory);

    assert.deepEqual(yield* startV2, ["thread-a", "thread-b"]);
    assert.deepEqual(yield* startV2, ["thread-a", "thread-b"]);
    // The checkpoint leaves no sidecars to move, and the older backup's are gone.
    assert.deepEqual(backups(directory), ["statev2.sqlite.stale"]);
    const backup = new NodeSqlite.DatabaseSync(NodePath.join(directory, "statev2.sqlite.stale"), {
      readOnly: true,
    });
    try {
      assert.equal(
        backup.prepare("SELECT count(*) AS count FROM projection_threads").get()?.count,
        1,
      );
    } finally {
      backup.close();
    }
  }).pipe(Effect.scoped),
);

it.effect("re-seeds a V2 store without V2 work when V1 only updated an existing thread", () =>
  Effect.gen(function* () {
    const { directory, startV2, inV2 } = yield* makeStaleCopy("updated");
    const v1 = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state.sqlite"));
    try {
      v1.exec(
        `UPDATE projection_threads SET title = 'Renamed in V1', updated_at = '2026-01-02T00:00:00.000Z'`,
      );
    } finally {
      v1.close();
    }

    assert.deepEqual(yield* startV2, ["thread-a"]);
    assert.include(backups(directory), "statev2.sqlite.stale");
    const rows = yield* inV2(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT title FROM projection_threads`;
      }),
    );
    assert.deepEqual(
      rows.map((row) => row.title),
      ["Renamed in V1"],
    );
  }).pipe(Effect.scoped),
);

const v2Work = {
  "a V2 thread without messages": `INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('v2-thread', 'project-a', 'V2 thread', 'codex', 'full-access', 'default', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '{}')`,
  "V2 messages": `INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('v2-message', 'thread-a', 'user', 0, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '{}')`,
  "a V2 scheduled task": `INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count)
    VALUES ('v2-task', 'Daily', 'Check CI', 1, '{}', 'project-a', '{}', '{}', 'full-access', 'default', 'user', 'ui', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'never', 0)`,
  "a session revoked in V2": `UPDATE auth_sessions SET revoked_at = '2026-01-03T00:00:00.000Z' WHERE session_id = 'session-a'`,
  "a pairing link consumed in V2": `UPDATE auth_pairing_links SET consumed_at = '2026-01-03T00:00:00.000Z' WHERE id = 'link-a'`,
  "a V2 project": `INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('v2-project', 'V2 project', '/tmp/v2-project', '[]', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`,
};

it.effect.each(Object.entries(v2Work))(
  "keeps a V2 store with %s even when V1 gained threads after the copy",
  ([, statement]) =>
    Effect.gen(function* () {
      const { directory, startV2, inV2 } = yield* makeStaleCopy("kept");
      yield* inV2(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(statement);
        }),
      );
      yield* addNewerV1Thread(directory);

      const threads = yield* startV2;
      assert.notInclude(threads, "thread-b");
      assert.deepEqual(backups(directory), []);
    }).pipe(Effect.scoped),
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
