import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

/** A migrated source db with one V2 thread per lifecycle state. Only
 * `stopped-thread` and its fork qualify for the clone. */
const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      // Excluded threads are newer than the kept family, so only the filters
      // can keep them out of a one-family-per-project clone.
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        // Its result never reached the parent, so startup would deliver it.
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      // A provider session shared by two threads names its latest writer.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'settled-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps stopped thread families from live projects and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [leftovers] = yield* sql<{ auth: number; tasks: number; transfers: number }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers`;
          return { threads, events, sessions, leftovers };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(kept.leftovers, { auth: 0, tasks: 0, transfers: 0 });
    }),
  );

  it.effect("fails loudly on a migration slot collision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slot-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // Simulate another branch having claimed slot 1 first: the id is
      // recorded, so this checkout's migration 1 silently never runs.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations
            SET name = 'SomebodyElsesMigration' WHERE migration_id = 1`;
        }),
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSlotCollisionError");
      if (error._tag === "MigrateDevDbSlotCollisionError") {
        assert.equal(error.slot, 1);
        assert.equal(error.appliedName, "SomebodyElsesMigration");
      }
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      // This test process stands in for a live dev server.
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      // A leftover snapshot from a prior failed run, passed as --source: it
      // must not be deleted before it is read.
      const leftoverSnapshot = path.join(destDir, "userdata", "statev2.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
