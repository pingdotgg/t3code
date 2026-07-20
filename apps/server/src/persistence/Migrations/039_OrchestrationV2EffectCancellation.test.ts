import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("039_OrchestrationV2EffectCancellation", (it) => {
  it.effect("preserves existing effects and adds the cancelled terminal status", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 38 });
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
          lease_owner,
          lease_expires_at,
          created_at,
          updated_at,
          completed_at,
          last_error
        ) VALUES (
          'effect:existing',
          'command:existing',
          'thread:existing',
          'provider-turn.start',
          '{"type":"provider-turn.start","runId":"run:existing"}',
          'running',
          1,
          '2026-06-20T00:00:00.000Z',
          'worker:old',
          '2026-06-20T00:00:30.000Z',
          '2026-06-20T00:00:00.000Z',
          '2026-06-20T00:00:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        UPDATE orchestration_v2_effect_outbox
        SET
          status = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = '2026-06-20T00:01:00.000Z'
        WHERE effect_id = 'effect:existing'
      `;

      const rows = yield* sql<{
        readonly effect_id: string;
        readonly status: string;
        readonly attempt_count: number;
        readonly lease_owner: string | null;
      }>`
        SELECT effect_id, status, attempt_count, lease_owner
        FROM orchestration_v2_effect_outbox
      `;
      assert.deepStrictEqual(rows, [
        {
          effect_id: "effect:existing",
          status: "cancelled",
          attempt_count: 1,
          lease_owner: null,
        },
      ]);
    }),
  );
});
