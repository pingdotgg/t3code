import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_subagent_activations (
      activation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      run_id TEXT,
      provider_turn_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_subagent_activations_thread_idx ON orchestration_v2_projection_subagent_activations(thread_id, subagent_id, ordinal)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_subagent_activations_run_idx ON orchestration_v2_projection_subagent_activations(run_id, status)`;

  yield* sql`
    UPDATE orchestration_v2_projection_subagents
    SET payload_json = json_set(
      payload_json,
      '$.kind', COALESCE(json_extract(payload_json, '$.kind'), 'subagent'),
      '$.role', COALESCE(
        json_extract(payload_json, '$.role'),
        json_object('name', 'general-purpose', 'source', 'app_default')
      ),
      '$.usage', json_extract(payload_json, '$.usage'),
      '$.currentActivationId', json_extract(payload_json, '$.currentActivationId'),
      '$.activationCount', COALESCE(json_extract(payload_json, '$.activationCount'), 1),
      '$.workflow', json_extract(payload_json, '$.workflow'),
      '$.workflowMembership', json_extract(payload_json, '$.workflowMembership'),
      '$.recentActivity', COALESCE(json_extract(payload_json, '$.recentActivity'), json_array())
    )
    WHERE json_type(payload_json, '$.kind') IS NULL
       OR json_type(payload_json, '$.role') IS NULL
       OR json_type(payload_json, '$.usage') IS NULL
       OR json_type(payload_json, '$.currentActivationId') IS NULL
       OR json_type(payload_json, '$.activationCount') IS NULL
       OR json_type(payload_json, '$.workflow') IS NULL
       OR json_type(payload_json, '$.workflowMembership') IS NULL
       OR json_type(payload_json, '$.recentActivity') IS NULL
  `;
});
