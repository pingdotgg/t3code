import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateAutoSettleDisabledAt from "./053_ProjectionThreadsAutoSettleDisabledAt.ts";

it.layer(NodeSqliteClient.layerMemory())("053_ProjectionThreadsAutoSettleDisabledAt", (it) => {
  it.effect("adds the column with auto-settle left on for existing threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const migrated = yield* sql<{ readonly autoSettleDisabledAt: string | null }>`
        SELECT auto_settle_disabled_at AS "autoSettleDisabledAt" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ autoSettleDisabledAt: null }]);
      // Re-running against a database that already has the column keeps its value.
      yield* sql`UPDATE projection_threads SET auto_settle_disabled_at = ${now} WHERE thread_id = 'thread-1'`;
      yield* migrateAutoSettleDisabledAt;
      const rows = yield* sql<{ readonly autoSettleDisabledAt: string | null }>`
        SELECT auto_settle_disabled_at AS "autoSettleDisabledAt" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ autoSettleDisabledAt: now }]);
    }),
  );
});
