import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import DropProjectLoomIndexes from "./Migrations/091_DropProjectLoomIndexes.ts";

// The saved-memory preview used 91 before Loom cleanup took that id.
export const reconcileSavedKnowledgePreviewMigration = Effect.fn(
  "reconcileSavedKnowledgePreviewMigration",
)(function* (manifest: ReadonlyArray<readonly [number, string]>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55`;
      const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
      if (recorded.get(91) !== "ProjectKnowledgeSavedLifecycle") return [];

      const expected = new Map(manifest.filter(([id]) => id >= 55 && id < 91));
      expected.set(91, "ProjectKnowledgeSavedLifecycle");
      if (
        [...expected].some(([id, name]) => recorded.get(id) !== name) ||
        history.some((row) => expected.get(row.migration_id) !== row.name)
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile saved-memory preview with unexpected migration history.",
        });
      }
      const facts = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_knowledge_facts'
      `;
      const assistedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(project_knowledge_assisted_runs)
      `;
      if (
        !facts[0]?.sql.includes("CHECK (status IN ('saved', 'forgotten'))") ||
        !assistedColumns.some(({ name }) => name === "saved") ||
        assistedColumns.some(({ name }) => name === "proposed" || name === "suggested")
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile saved-memory preview with an incomplete saved schema.",
        });
      }

      yield* DropProjectLoomIndexes;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 92 WHERE migration_id = 91`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (91, 'DropProjectLoomIndexes')
      `;
      return [[91, "DropProjectLoomIndexes"]] as const;
    }),
  );
});
