import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

describe("Pipeline schema", () => {
  it.effect("creates the pipeline tables on every start without recording a migration id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO pipeline_starter_seeds (starter_key, pipeline_id, seeded_at)
        VALUES ('feature-delivery', 'pipeline-1', '2026-10-29')
      `;
      assert.deepStrictEqual(yield* runMigrations(), []);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline%' ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((table) => table.name),
        ["pipeline_run_steps", "pipeline_runs", "pipeline_starter_seeds", "pipelines"],
      );
      assert.strictEqual((yield* sql`SELECT * FROM pipeline_starter_seeds`).length, 1);
      const [latest] = yield* sql<{ readonly migration_id: number }>`
        SELECT MAX(migration_id) AS migration_id FROM effect_sql_migrations
      `;
      assert.strictEqual(latest?.migration_id, migrationManifest.at(-1)?.[0]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
