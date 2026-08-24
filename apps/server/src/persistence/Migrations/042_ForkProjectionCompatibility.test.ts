import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const forkLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const readColumnNames = Effect.fn("readColumnNames")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(${sql.literal(table)})
  `;
  return new Set(columns.map((column) => column.name));
});

upstreamLayer("042_ForkProjectionCompatibility upstream history", (it) => {
  it.effect("adds reasoning storage to an upstream migration history", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const threadColumns = yield* readColumnNames("projection_threads");
      const messageColumns = yield* readColumnNames("projection_thread_messages");
      assert.ok(threadColumns.has("settled_override"));
      assert.ok(threadColumns.has("settled_at"));
      assert.ok(messageColumns.has("reasoning_text"));
    }),
  );
});

forkLayer("042_ForkProjectionCompatibility fork history", (it) => {
  it.effect("repairs a fork database whose migration 33 used the old name", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        ALTER TABLE projection_thread_messages
        ADD COLUMN reasoning_text TEXT
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'ProjectionThreadMessageReasoningText')
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const threadColumns = yield* readColumnNames("projection_threads");
      const messageColumns = yield* readColumnNames("projection_thread_messages");
      assert.ok(threadColumns.has("settled_override"));
      assert.ok(threadColumns.has("settled_at"));
      assert.ok(messageColumns.has("reasoning_text"));
    }),
  );
});
