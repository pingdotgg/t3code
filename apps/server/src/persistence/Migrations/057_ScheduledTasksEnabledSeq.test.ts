import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

describe("057_ScheduledTasksEnabledSeq", () => {
  it.effect("adds enabled_seq to scheduled_tasks tables created by released migration 54", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(scheduled_tasks)
      `;
      assert.ok(!before.some((column) => column.name === "enabled_seq"));

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 57 }), [
        [57, "ScheduledTasksEnabledSeq"],
      ]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 57 }), []);
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(scheduled_tasks)
      `;
      assert.ok(after.some((column) => column.name === "enabled_seq"));

      yield* sql`
        INSERT INTO scheduled_tasks
          (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
           model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
           created_at, updated_at, last_run_status, run_count)
        VALUES ('task', 'Task', 'Prompt', 1, '{}', 'project', '{}', '{}', 'default', 'default',
                'creator', 'test', '2026-09-19', '2026-09-19', 'never', 0)
      `;
      const row = yield* sql<{ readonly enabled_seq: number | null }>`
        SELECT enabled_seq FROM scheduled_tasks WHERE task_id = 'task'
      `;
      assert.isNull(row[0]?.enabled_seq);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("backfills enabled tasks so an archive before the upgrade cannot pause them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 56 });
      // A thread archived (and later unarchived) before the upgrade leaves an
      // archive event behind; a NULL enabled_seq would compare as older than
      // it, so the startup sweep would pause a task the user never touched.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES ('archive', 'thread', 'thread', 1, 'thread.archived',
          '2026-09-19', 'server', '{}', '{}', 2)
      `;
      yield* sql`
        INSERT INTO scheduled_tasks
          (task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
           workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
           created_by, creation_source, created_at, updated_at, last_run_status, run_count)
        VALUES
          ('enabled', 'Task', 'Prompt', 1, '{}', 'project', 'thread', '{}', '{}', 'default',
           'default', 'creator', 'test', '2026-09-19', '2026-09-19', 'never', 0),
          ('paused', 'Task', 'Prompt', 0, '{}', 'project', 'thread', '{}', '{}', 'default',
           'default', 'creator', 'test', '2026-09-19', '2026-09-19', 'never', 0)
      `;
      const archive = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events WHERE event_id = 'archive'
      `;

      yield* runMigrations({ toMigrationInclusive: 57 });
      const rows = yield* sql<{ readonly task_id: string; readonly enabled_seq: number | null }>`
        SELECT task_id, enabled_seq FROM scheduled_tasks ORDER BY task_id
      `;
      assert.deepStrictEqual(rows, [
        { task_id: "enabled", enabled_seq: archive[0]!.sequence },
        { task_id: "paused", enabled_seq: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is a no-op on databases where the column already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Databases created while the column briefly lived inside migration 54's
      // CREATE TABLE already carry it; the guard keeps this migration safe to
      // run there instead of failing on a duplicate column.
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN enabled_seq INTEGER`;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 57 }), [
        [57, "ScheduledTasksEnabledSeq"],
      ]);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(scheduled_tasks)
      `;
      assert.ok(columns.some((column) => column.name === "enabled_seq"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
