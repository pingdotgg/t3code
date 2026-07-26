import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_OrchestrationV2SubagentObservability", (it) => {
  it.effect("backfills old subagents and installs activation persistence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
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
          'node:legacy-subagent',
          'thread:legacy-subagent',
          'run:legacy-subagent',
          'node:legacy-root',
          'codex',
          NULL,
          NULL,
          'provider_native',
          'completed',
          '2026-07-26T00:00:00.000Z',
          '2026-07-26T00:01:00.000Z',
          '2026-07-26T00:01:00.000Z',
          '{"id":"node:legacy-subagent","status":"completed"}'
        )
      `;
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
          'node:current-subagent',
          'thread:current-subagent',
          'run:current-subagent',
          'node:current-root',
          'claudeAgent',
          NULL,
          NULL,
          'provider_native',
          'running',
          '2026-07-26T00:00:00.000Z',
          NULL,
          '2026-07-26T00:01:00.000Z',
          '{"id":"node:current-subagent","status":"running","kind":"workflow_agent","role":{"name":"researcher","source":"provider"},"usage":{"totalTokens":12},"currentActivationId":"activation:current","activationCount":2,"workflow":null,"workflowMembership":null,"recentActivity":[{"at":"2026-07-26T00:00:30.000Z","summary":"kept"}]}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const rows = yield* sql<{
        readonly kind: string;
        readonly role_name: string;
        readonly role_source: string;
        readonly activation_count: number;
        readonly usage_type: string;
        readonly activity_count: number;
      }>`
        SELECT
          json_extract(payload_json, '$.kind') AS kind,
          json_extract(payload_json, '$.role.name') AS role_name,
          json_extract(payload_json, '$.role.source') AS role_source,
          json_extract(payload_json, '$.activationCount') AS activation_count,
          json_type(payload_json, '$.usage') AS usage_type,
          json_array_length(json_extract(payload_json, '$.recentActivity')) AS activity_count
        FROM orchestration_v2_projection_subagents
        WHERE subagent_id = 'node:legacy-subagent'
      `;
      assert.deepStrictEqual(rows, [
        {
          kind: "subagent",
          role_name: "general-purpose",
          role_source: "app_default",
          activation_count: 1,
          usage_type: "null",
          activity_count: 0,
        },
      ]);

      const currentRows = yield* sql<{
        readonly kind: string;
        readonly role_name: string;
        readonly role_source: string;
        readonly total_tokens: number;
        readonly current_activation_id: string;
        readonly activation_count: number;
        readonly activity_summary: string;
      }>`
        SELECT
          json_extract(payload_json, '$.kind') AS kind,
          json_extract(payload_json, '$.role.name') AS role_name,
          json_extract(payload_json, '$.role.source') AS role_source,
          json_extract(payload_json, '$.usage.totalTokens') AS total_tokens,
          json_extract(payload_json, '$.currentActivationId') AS current_activation_id,
          json_extract(payload_json, '$.activationCount') AS activation_count,
          json_extract(payload_json, '$.recentActivity[0].summary') AS activity_summary
        FROM orchestration_v2_projection_subagents
        WHERE subagent_id = 'node:current-subagent'
      `;
      assert.deepStrictEqual(currentRows, [
        {
          kind: "workflow_agent",
          role_name: "researcher",
          role_source: "provider",
          total_tokens: 12,
          current_activation_id: "activation:current",
          activation_count: 2,
          activity_summary: "kept",
        },
      ]);

      const activationTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'orchestration_v2_projection_subagent_activations'
      `;
      assert.lengthOf(activationTable, 1);
    }),
  );
});
