import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadSessionProviderLifecycle", (it) => {
  it.effect("adds an optional lifecycle snapshot after the reserved migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-existing',
          'running',
          'codex',
          'full-access',
          'turn-existing',
          NULL,
          '2026-08-20T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const rows = yield* sql<{ readonly providerLifecycleUpdatedAt: string | null }>`
        SELECT provider_lifecycle_updated_at AS "providerLifecycleUpdatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-existing'
      `;

      assert.isTrue(columns.some((column) => column.name === "provider_lifecycle_updated_at"));
      assert.deepEqual(rows, [{ providerLifecycleUpdatedAt: null }]);
      assert.deepEqual(migrationManifest.at(-1), [42, "ProjectionThreadSessionProviderLifecycle"]);
    }),
  );
});
