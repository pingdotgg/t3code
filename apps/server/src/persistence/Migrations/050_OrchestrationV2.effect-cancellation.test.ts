import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_OrchestrationV2 effect cancellation", (it) => {
  it.effect("creates the effect outbox with the cancelled terminal status", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id,
          command_id,
          thread_id,
          effect_type,
          payload_json,
          status,
          attempt_count,
          available_at,
          created_at,
          updated_at,
          completed_at
        ) VALUES (
          'effect:cancelled',
          'command:cancelled',
          'thread:cancelled',
          'provider-turn.start',
          '{"type":"provider-turn.start","runId":"run:cancelled"}',
          'cancelled',
          1,
          '2026-06-20T00:00:00.000Z',
          '2026-06-20T00:00:00.000Z',
          '2026-06-20T00:01:00.000Z',
          '2026-06-20T00:01:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly effect_id: string;
        readonly status: string;
        readonly attempt_count: number;
      }>`
        SELECT effect_id, status, attempt_count
        FROM orchestration_v2_effect_outbox
      `;
      assert.deepStrictEqual(rows, [
        {
          effect_id: "effect:cancelled",
          status: "cancelled",
          attempt_count: 1,
        },
      ]);
    }),
  );
});
