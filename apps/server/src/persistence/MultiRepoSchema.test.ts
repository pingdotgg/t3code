import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureMultiRepoSchema } from "./MultiRepoSchema.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const readShape = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name IN ('task_folders', 'idx_task_folders_project_id') ORDER BY name
  `;
  return {
    trackedFolders: columns.filter((column) => column.name === "tracked_folders_json").length,
    objects: tables.map((table) => table.name),
  };
});

describe("Multi-repo schema", () => {
  it.effect("is created on every start without recording a migration id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readShape, {
        trackedFolders: 1,
        objects: ["idx_task_folders_project_id", "task_folders"],
      });
      const [latest] = yield* sql<{ readonly migration_id: number }>`
        SELECT MAX(migration_id) AS migration_id FROM effect_sql_migrations
      `;
      assert.strictEqual(latest?.migration_id, migrationManifest.at(-1)?.[0]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("is a no-op on a database that already has the column and table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO task_folders (root, project_id, home_worktree_path, repositories_json, created_at, updated_at)
        VALUES ('/tmp/root', 'project-1', '/tmp/root/home', '[]', 'now', 'now')
      `;
      yield* ensureMultiRepoSchema;
      yield* ensureMultiRepoSchema;
      assert.strictEqual((yield* sql`SELECT * FROM task_folders`).length, 1);
      assert.deepStrictEqual(yield* readShape, {
        trackedFolders: 1,
        objects: ["idx_task_folders_project_id", "task_folders"],
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
