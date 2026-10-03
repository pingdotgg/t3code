import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import HistoricalThreadContext from "./113_ProjectionThreadContext.ts";

const hasColumn = Effect.fn("hasColumn")(function* (table: string, column: string) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
  return columns.some((entry) => entry.name === column);
});

const assertBothHistories = Effect.gen(function* () {
  assert.isTrue(yield* hasColumn("projection_thread_messages", "context_json"));
  assert.isTrue(yield* hasColumn("projection_queued_turns", "context_json"));
  assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_transition_files_json"));
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "repair divergent migration 113 histories",
  (it) => {
    it.effect("upgrades main's checkpoint migration 113 without losing thread context", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 113 });
        assert.isTrue(yield* hasColumn("projection_turns", "checkpoint_transition_files_json"));
        assert.isFalse(yield* hasColumn("projection_thread_messages", "context_json"));
        yield* runMigrations({ toMigrationInclusive: 114 });
        yield* assertBothHistories;
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "repair earlier context migration history",
  (it) => {
    it.effect("upgrades the earlier PR's context migration 113 and safely replays", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 112 });
        yield* HistoricalThreadContext;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (113, 'ProjectionThreadContext')`;
        assert.isFalse(yield* hasColumn("projection_turns", "checkpoint_transition_files_json"));
        yield* runMigrations({ toMigrationInclusive: 114 });
        yield* assertBothHistories;
        yield* runMigrations({ toMigrationInclusive: 114 });
        yield* assertBothHistories;
      }),
    );
  },
);
