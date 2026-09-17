import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateActiveOrderKey from "./049_ProjectionThreadsActiveOrderKey.ts";

it.layer(NodeSqliteClient.layerMemory())("049_ProjectionThreadsActiveOrderKey", (it) => {
  it.effect("migrates old threads without changing their timestamps or assigning an order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
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
      yield* runMigrations({ toMigrationInclusive: 49 });
      const migrated = yield* sql<{ readonly activeOrderKey: string | null }>`
        SELECT active_order_key AS "activeOrderKey" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ activeOrderKey: null }]);
      // Recovery may run the same migration against a database that already
      // has the column, including a placement written after the upgrade.
      yield* sql`UPDATE projection_threads SET active_order_key = 'gm' WHERE thread_id = 'thread-1'`;
      yield* migrateActiveOrderKey;
      const rows = yield* sql<{
        readonly activeOrderKey: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>`
        SELECT active_order_key AS "activeOrderKey", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ activeOrderKey: "gm", createdAt: now, updatedAt: now }]);
    }),
  );
});
