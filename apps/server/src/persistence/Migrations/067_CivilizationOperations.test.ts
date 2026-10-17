import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds only minimal resumable Civilization purge tombstones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(civilization_purge_tombstones)`;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "project_id",
        "thread_id",
        "deletion_at",
        "purge_started_at",
        "purge_completed_at",
        "preview_token",
        "retention_days",
        "progress_state",
        "updated_at",
      ],
    );
    assert.notInclude(
      columns.map((column) => column.name),
      "body",
    );
    assert.notInclude(
      columns.map((column) => column.name),
      "name_display",
    );
    assert.notInclude(
      columns.map((column) => column.name),
      "packet_hash",
    );

    const projectStateColumns = yield* sql<{
      readonly name: string;
      readonly dflt_value: string | null;
    }>`
      PRAGMA table_info(civilization_project_state)
    `;
    assert.deepInclude(
      projectStateColumns.map((column) => ({ name: column.name, defaultValue: column.dflt_value })),
      { name: "applied_note_retention_days", defaultValue: "30" },
    );
    assert.deepInclude(
      projectStateColumns.map((column) => ({ name: column.name, defaultValue: column.dflt_value })),
      { name: "applied_diagnostic_retention_days", defaultValue: "7" },
    );
    assert.deepInclude(
      projectStateColumns.map((column) => ({ name: column.name, defaultValue: column.dflt_value })),
      { name: "applied_tombstone_retention_days", defaultValue: "30" },
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
