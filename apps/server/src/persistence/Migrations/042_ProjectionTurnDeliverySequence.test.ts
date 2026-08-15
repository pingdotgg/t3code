import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionTurnDeliverySequence", (it) => {
  it.effect("adds a nullable delivery marker without changing existing pending starts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          request_sequence,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          source_proposed_plan_thread_id,
          source_proposed_plan_id
        ) VALUES (
          'existing-thread',
          NULL,
          'existing-message',
          42,
          NULL,
          'pending',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]',
          NULL,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_turns)
      `;
      const deliverySequence = columns.find((column) => column.name === "delivery_sequence");
      const rows = yield* sql<{ readonly delivery_sequence: number | null }>`
        SELECT delivery_sequence
        FROM projection_turns
        WHERE thread_id = 'existing-thread'
      `;

      assert.equal(deliverySequence?.notnull, 0);
      assert.equal(rows[0]?.delivery_sequence, null);
    }),
  );
});
