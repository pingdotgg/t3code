import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionProjectsAdditionalFolders", (it) => {
  it.effect("adds the additional folders column and backfills existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      // A project row written before source folders existed.
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        )
        VALUES (
          'project-legacy', 'Legacy', '/tmp/legacy', NULL,
          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(columns.some((column) => column.name === "additional_folders_json"));

      const rows = yield* sql<{ readonly additional_folders_json: string }>`
        SELECT additional_folders_json FROM projection_projects WHERE project_id = 'project-legacy'
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.additional_folders_json),
        ["[]"],
      );
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "additional_folders_json").length,
        1,
      );
    }),
  );
});
