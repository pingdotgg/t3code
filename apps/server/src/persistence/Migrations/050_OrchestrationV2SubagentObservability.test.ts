import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_OrchestrationV2SubagentObservability", (it) => {
  it.effect("installs activation persistence and leaves existing subagents alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });

      const preObservabilityPayload =
        '{"id":"node:pre-observability-subagent","status":"completed"}';
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents (
          subagent_id,
          thread_id,
          run_id,
          parent_node_id,
          provider,
          provider_thread_id,
          child_thread_id,
          origin,
          status,
          started_at,
          completed_at,
          updated_at,
          payload_json
        ) VALUES (
          'node:pre-observability-subagent',
          'thread:pre-observability-subagent',
          'run:pre-observability-subagent',
          'node:pre-observability-root',
          'codex',
          NULL,
          NULL,
          'provider_native',
          'completed',
          '2026-07-26T00:00:00.000Z',
          '2026-07-26T00:01:00.000Z',
          '2026-07-26T00:01:00.000Z',
          ${preObservabilityPayload}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const activationTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'orchestration_v2_projection_subagent_activations'
      `;
      assert.lengthOf(activationTable, 1);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'orchestration_v2_projection_subagent_activations'
          AND sql IS NOT NULL
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(
        indexes.map((row) => row.name),
        [
          "orchestration_v2_projection_subagent_activations_run_idx",
          "orchestration_v2_projection_subagent_activations_thread_idx",
        ],
      );

      // Deliberately no backfill: the observability fields all carry decoding
      // defaults, and the projection schema version bump replays these rows
      // from the event log anyway. Rewriting them here would be dead work, so
      // the row must come through byte-identical.
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json
        FROM orchestration_v2_projection_subagents
        WHERE subagent_id = 'node:pre-observability-subagent'
      `;
      assert.deepStrictEqual(rows, [{ payload_json: preObservabilityPayload }]);
    }),
  );
});
