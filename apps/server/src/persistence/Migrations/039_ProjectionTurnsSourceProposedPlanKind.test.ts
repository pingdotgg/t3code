import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_ProjectionTurnsSourceProposedPlanKind", (it) => {
  it.effect("adds and backfills the source plan kind for a v38 database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id,
          source_proposed_plan_thread_id, source_proposed_plan_id,
          assistant_message_id, state, requested_at,
          started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        )
        VALUES (
          'thread-implementation', 'turn-implementation', 'message-implementation',
          'thread-source', 'plan-source',
          NULL, 'completed', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', NULL,
          NULL, NULL, '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.ok(columns.some((column) => column.name === "source_proposed_plan_kind"));

      const rows = yield* sql<{ readonly kind: string | null }>`
        SELECT source_proposed_plan_kind AS kind
        FROM projection_turns
        WHERE thread_id = 'thread-implementation'
      `;
      assert.deepStrictEqual(rows, [{ kind: "implementation" }]);
    }),
  );
});
