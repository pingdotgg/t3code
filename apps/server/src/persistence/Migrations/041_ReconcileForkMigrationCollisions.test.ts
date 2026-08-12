import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const tableColumns = Effect.fn("test.tableColumns")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`);
});

const legacyForkLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyForkLayer("041_ReconcileForkMigrationCollisions legacy fork", (it) => {
  it.effect("adds upstream project columns to a released fork database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN subtitle TEXT
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (39, 'ProjectionThreadSubtitles'),
          (40, 'RepairForkMigrationCollisions')
      `;

      const projectColumnsBefore = yield* tableColumns("projection_projects");
      assert.notOk(
        projectColumnsBefore.some((column) => column.name === "default_thread_env_mode"),
      );
      assert.notOk(projectColumnsBefore.some((column) => column.name === "favicon_path"));

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[41, "ReconcileForkMigrationCollisions"]]);

      const projectColumns = yield* tableColumns("projection_projects");
      assert.ok(projectColumns.some((column) => column.name === "default_thread_env_mode"));
      assert.ok(projectColumns.some((column) => column.name === "favicon_path"));

      const threadColumns = yield* tableColumns("projection_threads");
      assert.ok(threadColumns.some((column) => column.name === "subtitle"));
      assert.ok(threadColumns.some((column) => column.name === "pin_order_key"));

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 39
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 39, name: "ProjectionThreadSubtitles" },
        { migration_id: 40, name: "RepairForkMigrationCollisions" },
        { migration_id: 41, name: "ReconcileForkMigrationCollisions" },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});

const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamLayer("041_ReconcileForkMigrationCollisions upstream", (it) => {
  it.effect("reconciles a fresh upstream schema idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const projectColumnsBefore = yield* tableColumns("projection_projects");
      assert.equal(
        projectColumnsBefore.filter((column) => column.name === "default_thread_env_mode").length,
        1,
      );
      assert.equal(
        projectColumnsBefore.filter((column) => column.name === "favicon_path").length,
        1,
      );
      const threadColumnsBefore = yield* tableColumns("projection_threads");
      assert.notOk(threadColumnsBefore.some((column) => column.name === "subtitle"));

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[41, "ReconcileForkMigrationCollisions"]]);

      const projectColumns = yield* tableColumns("projection_projects");
      assert.equal(
        projectColumns.filter((column) => column.name === "default_thread_env_mode").length,
        1,
      );
      assert.equal(projectColumns.filter((column) => column.name === "favicon_path").length, 1);

      const threadColumns = yield* tableColumns("projection_threads");
      assert.ok(threadColumns.some((column) => column.name === "subtitle"));
      assert.ok(threadColumns.some((column) => column.name === "pin_order_key"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
