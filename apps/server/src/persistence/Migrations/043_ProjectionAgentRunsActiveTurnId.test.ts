import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionAgentRunsActiveTurnId", (it) => {
  it.effect("repairs projections from an already-applied 041 without active_turn_id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        CREATE TABLE projection_agent_runs (
          agent_run_id TEXT PRIMARY KEY
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'AgentRuns'), (42, 'ProjectionThreadsAgentProfile')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 43 });
      assert.deepStrictEqual(executed, [[43, "ProjectionAgentRunsActiveTurnId"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_agent_runs)
      `;
      assert.ok(columns.some((column) => column.name === "active_turn_id"));
    }),
  );
});
