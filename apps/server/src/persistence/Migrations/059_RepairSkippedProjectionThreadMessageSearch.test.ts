import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const skippedMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const existingMigrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

skippedMigrationLayer("059_RepairSkippedProjectionThreadMessageSearch skipped migration", (it) => {
  it.effect("applies after migration 48 was skipped by a newer historical ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('settled', 'thread-search', NULL, 'user', 'preserve searchable history', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('streaming', 'thread-search', NULL, 'assistant', 'partial searchable history', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (52, 'HistoricalMigration')
      `;
      // `origin_json` only exists from migration 056, so the handoff
      // continuation that migration 057 excludes is seeded once it is present.
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, origin_json
        ) VALUES (
          'handoff', 'thread-search', NULL, 'user', 'continued searchable history', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{"kind":"workspace-handoff"}'
        )
      `;
      const messagesBefore = yield* sql`
        SELECT * FROM projection_thread_messages ORDER BY message_id
      `;

      yield* runMigrations({ toMigrationInclusive: 59 });

      const messagesAfter = yield* sql`
        SELECT * FROM projection_thread_messages ORDER BY message_id
      `;
      const settledMatches = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM projection_thread_message_fts
        WHERE projection_thread_message_fts MATCH '"searchable history"'
      `;
      const repairMigration = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 59
      `;

      assert.deepStrictEqual(messagesAfter, messagesBefore);
      assert.equal(settledMatches[0]?.count, 1);
      assert.deepStrictEqual(repairMigration, [
        { name: "RepairSkippedProjectionThreadMessageSearch" },
      ]);
    }),
  );
});

existingMigrationLayer(
  "059_RepairSkippedProjectionThreadMessageSearch existing migration",
  (it) => {
    it.effect("preserves messages and existing index entries when migration 48 already ran", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 47 });
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'settled', 'thread-search', NULL, 'assistant', 'already indexed history', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
        yield* runMigrations({ toMigrationInclusive: 48 });
        yield* Effect.forEach(
          [49, 50, 51, 52],
          (migrationId) => sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`HistoricalMigration${migrationId}`})
        `,
        );
        const messagesBefore = yield* sql`
        SELECT * FROM projection_thread_messages ORDER BY message_id
      `;

        yield* runMigrations({ toMigrationInclusive: 59 });

        const messagesAfter = yield* sql`
        SELECT * FROM projection_thread_messages ORDER BY message_id
      `;
        const matches = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM projection_thread_message_fts
        WHERE projection_thread_message_fts MATCH '"indexed history"'
      `;

        assert.deepStrictEqual(messagesAfter, messagesBefore);
        assert.equal(matches[0]?.count, 1);
      }),
    );
  },
);
