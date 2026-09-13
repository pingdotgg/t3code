import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateTasks from "./052_ProjectionTasks.ts";

const now = "2026-09-13T00:00:00.000Z";
const insertHistory = Effect.fn("insertHistory")(function* (aggregateKind: "thread" | "task") {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_events (
      sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json
    ) VALUES (42, 'event-existing', ${aggregateKind}, 'existing', 1,
      ${`${aggregateKind}.created`}, ${now}, 'user', '{}', '{}')
  `;
});

it.effect("seeds an empty task projector at zero on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* migrateTasks;
    assert.deepEqual(yield* sql`SELECT * FROM projection_tasks`, []);
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_state WHERE projector = 'projection.tasks'`,
      [
        {
          projector: "projection.tasks",
          last_applied_sequence: 0,
          updated_at: "1970-01-01T00:00:00.000Z",
        },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("seeds only the new task cursor at the pre-task history head", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* insertHistory("thread");
    yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES ('projection.threads', 42, ${now}), ('projection.attachment-cleanup', 12, ${now})`;
    const existing = yield* sql`SELECT * FROM projection_state ORDER BY projector`;
    yield* runMigrations({ toMigrationInclusive: 52 });
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_state WHERE projector = 'projection.tasks'`,
      [{ projector: "projection.tasks", last_applied_sequence: 42, updated_at: now }],
    );
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_state WHERE projector != 'projection.tasks' ORDER BY projector`,
      existing,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("leaves imported task history without a cursor for bootstrap replay", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 51 });
    yield* insertHistory("task");
    yield* migrateTasks;
    yield* migrateTasks;
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_state WHERE projector = 'projection.tasks'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const aggregateKind of ["thread", "task"] as const) {
  it.effect(`preserves existing task rows and cursor on rerun with ${aggregateKind} history`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* insertHistory(aggregateKind);
      yield* migrateTasks;
      yield* sql`INSERT INTO projection_tasks
        (task_id, name, primary_project_id, created_at, updated_at)
        VALUES ('existing-task', 'Existing task', 'existing-project', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.tasks', 17, ${now})
        ON CONFLICT(projector) DO UPDATE SET last_applied_sequence = 17, updated_at = excluded.updated_at`;
      const tasks = yield* sql`SELECT * FROM projection_tasks`;
      const states = yield* sql`SELECT * FROM projection_state`;
      yield* migrateTasks;
      assert.deepEqual(yield* sql`SELECT * FROM projection_tasks`, tasks);
      assert.deepEqual(yield* sql`SELECT * FROM projection_state`, states);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
