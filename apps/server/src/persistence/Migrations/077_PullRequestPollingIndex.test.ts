import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("077_PullRequestPollingIndex", (it) => {
  it.effect("polls only live PR threads in stable update order and maintains membership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      for (const [id, updatedAt, deletedAt, payload] of [
        ["b", "2026-10-01", null, { pullRequests: [{ number: 1 }] }],
        ["a", "2026-10-01", null, { pullRequests: [{ number: 2 }] }],
        ["later", "2026-10-02", null, { pullRequests: [{ number: 3 }] }],
        ["deleted", "2026-10-01", "2026-10-02", { pullRequests: [{ number: 4 }] }],
        [
          "archived",
          "2026-10-01",
          null,
          { archivedAt: "2026-10-02", pullRequests: [{ number: 5 }] },
        ],
        ["empty", "2026-10-01", null, { pullRequests: [] }],
        ["missing", "2026-10-01", null, {}],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, deleted_at, payload_json)
          VALUES (${id}, 'project', 'test', 'codex', 'full-access', 'default',
                  '2026-10-01', ${updatedAt}, ${deletedAt}, ${JSON.stringify(payload)})`;
      }
      const query = `SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_array_length(payload_json, '$.pullRequests') > 0
        ORDER BY updated_at ASC, thread_id ASC`;
      const before = yield* sql.unsafe(query);
      assert.deepEqual(yield* runMigrations(), [[77, "PullRequestPollingIndex"]]);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 76 ORDER BY migration_id`,
        [
          { migration_id: 76, name: "ProjectionProjectsPinArchive" },
          { migration_id: 77, name: "PullRequestPollingIndex" },
        ],
      );
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* sql.unsafe(query), before);
      assert.deepEqual(before, [{ thread_id: "a" }, { thread_id: "b" }, { thread_id: "later" }]);
      const plan = yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
      assert.ok(
        plan.some((row) =>
          row.detail.includes("orchestration_v2_projection_threads_pull_request_poll_idx"),
        ),
      );
      assert.ok(plan.every((row) => !row.detail.includes("TEMP B-TREE")));
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"pullRequests":[]}' WHERE thread_id = 'a'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"pullRequests":[{"number":6}]}' WHERE thread_id = 'missing'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = 'deleted'`;
      assert.deepEqual(yield* sql.unsafe(query), [
        { thread_id: "b" },
        { thread_id: "deleted" },
        { thread_id: "missing" },
        { thread_id: "later" },
      ]);
    }),
  );
});
