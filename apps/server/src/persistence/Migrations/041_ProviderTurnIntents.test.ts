import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProviderTurnIntents", (it) => {
  it.effect("creates an empty durable intent queue without replaying legacy events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-legacy-turn-start',
          'thread',
          'thread-legacy',
          0,
          'thread.turn-start-requested',
          '2026-08-13T00:00:00.000Z',
          'command-legacy-turn-start',
          NULL,
          'command-legacy-turn-start',
          'client',
          '{"threadId":"thread-legacy","messageId":"message-legacy","runtimeMode":"full-access","createdAt":"2026-08-13T00:00:00.000Z"}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`
        PRAGMA table_info(provider_turn_intents)
      `;
      assert.deepEqual(
        columns.map(({ name, notnull, pk }) => ({ name, notnull, pk })),
        [
          { name: "event_sequence", notnull: 0, pk: 1 },
          { name: "thread_id", notnull: 1, pk: 0 },
          { name: "message_id", notnull: 1, pk: 0 },
          { name: "requested_at", notnull: 1, pk: 0 },
        ],
      );

      const rows = yield* sql`SELECT * FROM provider_turn_intents`;
      assert.deepEqual(rows, []);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(provider_turn_intents)
      `;
      assert.isTrue(
        indexes.some(({ name }) => name === "idx_provider_turn_intents_thread_sequence"),
      );
      assert.isTrue(
        indexes.some(({ name }) => name === "idx_provider_turn_intents_one_per_thread"),
      );

      yield* sql`
        INSERT INTO provider_turn_intents (
          event_sequence,
          thread_id,
          message_id,
          requested_at
        ) VALUES (
          1,
          'thread-one-intent',
          'message-one',
          '2026-08-13T00:00:00.000Z'
        )
      `;
      const duplicateThreadInsert = yield* Effect.exit(sql`
        INSERT INTO provider_turn_intents (
          event_sequence,
          thread_id,
          message_id,
          requested_at
        ) VALUES (
          2,
          'thread-one-intent',
          'message-two',
          '2026-08-13T00:00:01.000Z'
        )
      `);
      assert.isTrue(Exit.isFailure(duplicateThreadInsert));
    }),
  );
});
