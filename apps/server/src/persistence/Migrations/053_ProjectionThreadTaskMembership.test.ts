import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateTasks from "./052_ProjectionTasks.ts";
import migrateMembership from "./053_ProjectionThreadTaskMembership.ts";

it.layer(NodeSqliteClient.layerMemory())("053_ProjectionThreadTaskMembership", (it) => {
  it.effect(
    "preserves existing threads and remains safe to rerun after membership is assigned",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 51 });
        const now = "2026-09-13T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          branch, worktree_path, archived_at, created_at, updated_at
        ) VALUES (
          'thread-existing', 'project-existing', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          'feature/existing', '/tmp/existing', ${now}, ${now}, ${now}
        )
      `;
        const before = yield* sql`SELECT * FROM projection_threads`;
        yield* runMigrations();
        assert.deepEqual(yield* sql`SELECT * FROM projection_threads`, [
          { ...before[0], task_id: null },
        ]);
        assert.deepEqual(yield* sql`SELECT * FROM projection_tasks`, []);

        yield* sql`
        INSERT INTO projection_tasks (task_id, name, primary_project_id, created_at, updated_at)
        VALUES ('task-existing', 'Existing task', 'project-existing', ${now}, ${now})
      `;
        yield* sql`UPDATE projection_threads SET task_id = 'task-existing'`;
        yield* migrateTasks;
        yield* migrateMembership;
        assert.deepEqual(yield* sql`SELECT * FROM projection_threads`, [
          { ...before[0], task_id: "task-existing" },
        ]);
        assert.deepEqual(yield* sql`SELECT task_id FROM projection_tasks`, [
          { task_id: "task-existing" },
        ]);
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM projection_threads WHERE task_id = 'task-existing'`,
          [{ thread_id: "thread-existing" }],
        );
      }),
  );
});
