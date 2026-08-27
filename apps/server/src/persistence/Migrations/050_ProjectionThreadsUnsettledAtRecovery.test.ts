import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionThreadsUnsettledAtRecovery", (it) => {
  it.effect("recovers when migration IDs 43 through 49 belong to a divergent history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (43, 'ProjectionThreadOperatorScope'),
          (44, 'OperatorProjects'),
          (45, 'OperatorProjectExecutionRequestText'),
          (46, 'OperatorProjectContextRequests'),
          (47, 'OperatorPlugins'),
          (48, 'OperatorPluginHardening'),
          (49, 'OperatorOrchestrationV0')
      `;

      const executed = yield* runMigrations();
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;

      assert.deepStrictEqual(executed, [[50, "ProjectionThreadsUnsettledAtRecovery"]]);
      assert.ok(columns.some((column) => column.name === "unsettled_at"));
    }),
  );
});
