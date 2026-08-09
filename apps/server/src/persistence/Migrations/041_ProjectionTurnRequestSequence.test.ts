import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionTurnRequestSequence", (it) => {
  it.effect("adds a nullable event sequence without blessing legacy pending starts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
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
          'legacy-thread',
          NULL,
          'legacy-message',
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

      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_turns)
      `;
      const requestSequence = columns.find((column) => column.name === "request_sequence");
      const rows = yield* sql<{ readonly request_sequence: number | null }>`
        SELECT request_sequence
        FROM projection_turns
        WHERE thread_id = 'legacy-thread'
      `;

      assert.equal(requestSequence?.notnull, 0);
      assert.equal(rows[0]?.request_sequence, null);
    }),
  );
});
