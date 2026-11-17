import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ProjectKnowledgeFactVerdict from "./Migrations/115_ProjectKnowledgeFactVerdict.ts";

// The search preview used 115–116 before the standing-memory migration took 115.
export const reconcileConversationSearchPreviewMigration = Effect.fn(
  "reconcileConversationSearchPreviewMigration",
)(function* (manifest: ReadonlyArray<readonly [number, string]>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55
      `;
      const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
      if (recorded.get(115) !== "ConversationSummarySearch") return [];
      const expected = new Map(manifest.filter(([id]) => id >= 55 && id < 115));
      expected.set(115, "ConversationSummarySearch");
      if (recorded.has(116)) expected.set(116, "ToolOutputSearch");
      if (
        [...expected].some(([id, name]) => recorded.get(id) !== name) ||
        history.some((row) => expected.get(row.migration_id) !== row.name)
      )
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot reconcile conversation search preview with unexpected migration history.",
        });

      const required = new Map([
        ["conversation_summary_search_ids", "table"],
        ["conversation_summary_fts", "table"],
        ["conversation_summary_tokenizer", "table"],
        ["conversation_summary_terms", "table"],
        ["conversation_summary_search_insert", "trigger"],
        ["conversation_summary_search_update", "trigger"],
        ["conversation_summary_search_delete", "trigger"],
      ]);
      const schema = yield* sql<{ readonly name: string; readonly type: string }>`
        SELECT name, type FROM sqlite_master WHERE ${sql.in("name", [...required.keys()])}
      `;
      const objects = new Map(schema.map((row) => [row.name, row.type]));
      if ([...required].some(([name, type]) => objects.get(name) !== type))
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot reconcile conversation search preview with an incomplete search schema.",
        });

      yield* ProjectKnowledgeFactVerdict;
      if (recorded.has(116))
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 117 WHERE migration_id = 116`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 116 WHERE migration_id = 115`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (115, 'ProjectKnowledgeFactVerdict')`;
      return [[115, "ProjectKnowledgeFactVerdict"]] as const;
    }),
  );
});
