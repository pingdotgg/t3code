import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_RepairForkMigrationCollisions", (it) => {
  it.effect("repairs databases whose fork migrations occupied upstream IDs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN subtitle TEXT
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (37, 'ProjectionThreadSubtitles'),
          (38, 'ProjectionThreadSubtitles'),
          (39, 'ProjectionThreadSubtitles')
      `;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "subtitle"));
      assert.ok(columns.some((column) => column.name === "pin_order_key"));

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_projection_turns_thread_keyset"));
    }),
  );
});
