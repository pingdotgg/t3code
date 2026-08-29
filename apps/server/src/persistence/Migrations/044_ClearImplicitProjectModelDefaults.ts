import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The old client creation path always wrote this exact bare Codex default.
  // Keep every other creation-time selection because the command contract
  // also permits callers to supply a legitimate project default.
  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = NULL
    WHERE default_model_selection_json IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.aggregate_kind = 'project'
          AND created.stream_id = projection_projects.project_id
          AND created.event_type = 'project.created'
          AND COALESCE(
            json_extract(created.payload_json, '$.defaultModelSelection.instanceId'),
            json_extract(created.payload_json, '$.defaultModelSelection.provider')
          ) = 'codex'
          AND json_extract(created.payload_json, '$.defaultModelSelection.model') = 'gpt-5.4'
          AND json_type(created.payload_json, '$.defaultModelSelection.options') IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS updated
        WHERE updated.aggregate_kind = 'project'
          AND updated.stream_id = projection_projects.project_id
          AND updated.event_type = 'project.meta-updated'
          AND json_type(updated.payload_json, '$.defaultModelSelection') IS NOT NULL
      )
  `;

  // Keep replay consistent with the repaired projection.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.defaultModelSelection', json('null'))
    WHERE aggregate_kind = 'project'
      AND event_type = 'project.created'
      AND COALESCE(
        json_extract(payload_json, '$.defaultModelSelection.instanceId'),
        json_extract(payload_json, '$.defaultModelSelection.provider')
      ) = 'codex'
      AND json_extract(payload_json, '$.defaultModelSelection.model') = 'gpt-5.4'
      AND json_type(payload_json, '$.defaultModelSelection.options') IS NULL
  `;
});
