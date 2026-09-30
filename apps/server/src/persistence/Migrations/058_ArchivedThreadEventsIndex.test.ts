import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

describe("058_ArchivedThreadEventsIndex", () => {
  it.effect("upgrades databases that already recorded migration 57 without losing task state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA index_list(orchestration_events)`;
      assert.ok(
        !before.some((entry) => entry.name === "orchestration_events_v2_archived_threads_idx"),
      );

      yield* sql`
        INSERT INTO scheduled_tasks
          (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
           model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
           created_at, updated_at, last_run_status, run_count, enabled_seq)
        VALUES ('task', 'Task', 'Prompt', 1, '{}', 'project', '{}', '{}', 'default', 'default',
                'creator', 'test', '2026-09-19', '2026-09-19', 'never', 3, 7)
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES ('archive', 'thread', 'thread', 1, 'thread.archived',
          '2026-09-19', 'server', '{}', '{}', 2)
      `;
      const applied = yield* runMigrations();
      const archives = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events
          INDEXED BY orchestration_events_v2_archived_threads_idx
        WHERE stream_id = 'thread' AND aggregate_kind = 'thread'
          AND event_type = 'thread.archived' AND application_event_version = 2
      `;
      assert.deepStrictEqual(archives, [{ event_id: "archive" }]);
      assert.deepStrictEqual(applied, [[58, "ArchivedThreadEventsIndex"]]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const rows = yield* sql<{
        readonly enabled_seq: number;
        readonly enabled: number;
        readonly run_count: number;
      }>`SELECT enabled_seq, enabled, run_count FROM scheduled_tasks WHERE task_id = 'task'`;
      assert.deepStrictEqual(rows, [{ enabled_seq: 7, enabled: 1, run_count: 3 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("preserves an archive index created by an earlier preview", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        CREATE INDEX orchestration_events_v2_archived_threads_idx
        ON orchestration_events(stream_id, sequence)
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.archived'
      `;
      assert.deepStrictEqual(yield* runMigrations(), [[58, "ArchivedThreadEventsIndex"]]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const archives = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence FROM orchestration_events
          INDEXED BY orchestration_events_v2_archived_threads_idx
        WHERE stream_id = 'thread' AND aggregate_kind = 'thread'
          AND event_type = 'thread.archived' AND application_event_version = 2
      `;
      assert.deepStrictEqual(archives, [{ sequence: null }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("creates the archive index and watermark on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied = yield* runMigrations();
      assert.deepStrictEqual(applied.slice(-2), [
        [57, "ScheduledTasksEnabledSeq"],
        [58, "ArchivedThreadEventsIndex"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
        PRAGMA index_list(orchestration_events)
      `;
      assert.ok(
        indexes.some(
          (entry) =>
            entry.name === "orchestration_events_v2_archived_threads_idx" && entry.partial === 1,
        ),
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
      assert.ok(columns.some((column) => column.name === "enabled_seq"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
