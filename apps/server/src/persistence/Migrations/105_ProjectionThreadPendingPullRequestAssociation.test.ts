import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("105_ProjectionThreadPendingPullRequestAssociation", (it) => {
  it.effect("adds the pending association projection column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* runMigrations({ toMigrationInclusive: 105 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "pending_pull_request_association_json"));
    }),
  );

  it.effect("repairs the column when the projection table was skipped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`DROP TABLE projection_threads`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 105`;

      yield* runMigrations({ toMigrationInclusive: 105 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "pending_pull_request_association_json"));
    }),
  );
});
