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

  it.effect("adds later columns to run and step tables created before they existed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE pipeline_runs (
          run_id TEXT PRIMARY KEY,
          pipeline_id TEXT,
          definition_json TEXT NOT NULL,
          project_id TEXT NOT NULL,
          parent_thread_id TEXT NOT NULL UNIQUE,
          input TEXT NOT NULL,
          workspace_strategy_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pause_reason TEXT,
          error TEXT,
          current_step_index INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          creation_source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO pipeline_runs (
          run_id, definition_json, project_id, parent_thread_id, input, workspace_strategy_json,
          status, current_step_index, created_by, creation_source, created_at, updated_at
        )
        VALUES ('run-1', '{}', 'project-1', 'parent-1', 'Fix', '{}', 'running', 0, 'user', 'web', 'now', 'now')
      `;
      yield* sql`
        CREATE TABLE pipeline_run_steps (
          run_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          step_id TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          child_thread_id TEXT,
          pause_before INTEGER NOT NULL,
          prompt TEXT,
          workspace_strategy_json TEXT,
          start_checkpoint_json TEXT,
          output TEXT,
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          PRIMARY KEY (run_id, step_index)
        )
      `;
      yield* sql`
        INSERT INTO pipeline_run_steps (run_id, step_index, step_id, status, attempt, pause_before)
        VALUES ('run-1', 0, 'plan', 'running', 1, 0)
      `;
      yield* runMigrations();
      yield* runMigrations();
      const steps = yield* sql<{ readonly handed_off: number; readonly revising: number }>`
        SELECT handed_off, revising FROM pipeline_run_steps
      `;
      assert.deepStrictEqual(steps, [{ handed_off: 0, revising: 0 }]);
      const runs = yield* sql<{ readonly revisions_json: string }>`
        SELECT revisions_json FROM pipeline_runs
      `;
      assert.deepStrictEqual(runs, [{ revisions_json: "[]" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
