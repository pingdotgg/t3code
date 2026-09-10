import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("051_QuickChats", (it) => {
  it.effect("preserves project threads and allows project-free rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
      VALUES ('existing', 'project-1', 'Existing', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-01-01', '2026-01-01')`;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
      VALUES ('quick', NULL, 'Quick', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-01-02', '2026-01-02')`;
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly project_id: string | null;
      }>`SELECT thread_id, project_id FROM projection_threads ORDER BY thread_id`;
      assert.deepEqual(rows, [
        { thread_id: "existing", project_id: "project-1" },
        { thread_id: "quick", project_id: null },
      ]);
    }),
  );
});
