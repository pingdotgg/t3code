import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectlessThreads", (it) => {
  it.effect("makes project ownership nullable and preserves thread indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(columns.find((column) => column.name === "project_id")?.notnull, 0);
      assert.equal(columns.find((column) => column.name === "workspace_root")?.notnull, 0);
      assert.equal(
        columns.find((column) => column.name === "runtime_mode")?.dflt_value,
        "'full-access'",
      );
      assert.equal(
        columns.find((column) => column.name === "interaction_mode")?.dflt_value,
        "'default'",
      );
      for (const columnName of [
        "pending_approval_count",
        "pending_user_input_count",
        "has_actionable_proposed_plan",
      ]) {
        assert.equal(columns.find((column) => column.name === columnName)?.dflt_value, "0");
      }

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_threads)
      `;
      const indexNames = new Set(indexes.map((index) => index.name));
      for (const expectedIndex of [
        "idx_projection_threads_project_id",
        "idx_projection_threads_project_archived_at",
        "idx_projection_threads_project_deleted_created",
        "idx_projection_threads_shell_active",
        "idx_projection_threads_shell_archived",
      ]) {
        assert.ok(indexNames.has(expectedIndex), `missing ${expectedIndex}`);
      }
    }),
  );
});
