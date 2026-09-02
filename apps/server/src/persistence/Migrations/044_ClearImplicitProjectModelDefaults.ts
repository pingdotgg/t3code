import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Older T3 versions stored the current provider model on every new project.
// That made an implicit seed indistinguishable from a project-level override
// and prevented sticky or provider defaults from winning. Creation events do
// not record whether T3 or an external client supplied a model-only value, so
// this migration accepts that narrow ambiguity. A later project.meta-updated
// event carrying defaultModelSelection proves the field was written after
// creation, even when unrelated updates changed updated_at too.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects AS project
    SET default_model_selection_json = NULL
    WHERE json_type(project.default_model_selection_json) = 'object'
      AND json_type(project.default_model_selection_json, '$.instanceId') = 'text'
      AND json_type(project.default_model_selection_json, '$.model') = 'text'
      AND json_type(project.default_model_selection_json, '$.options') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(project.default_model_selection_json)
        WHERE key NOT IN ('instanceId', 'model')
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.aggregate_kind = 'project'
          AND created.stream_id = project.project_id
          AND created.event_type = 'project.created'
          AND json_type(created.payload_json, '$.defaultModelSelection') = 'object'
          AND json_type(created.payload_json, '$.defaultModelSelection.instanceId') = 'text'
          AND json_type(created.payload_json, '$.defaultModelSelection.model') = 'text'
          AND json_type(created.payload_json, '$.defaultModelSelection.options') IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(json_extract(created.payload_json, '$.defaultModelSelection'))
            WHERE key NOT IN ('instanceId', 'model')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS updated
            WHERE updated.aggregate_kind = 'project'
              AND updated.stream_id = created.stream_id
              AND updated.sequence > created.sequence
              AND updated.event_type = 'project.meta-updated'
              AND json_type(updated.payload_json, '$.defaultModelSelection') IS NOT NULL
          )
      )
  `;

  yield* sql`
    UPDATE orchestration_events AS created
    SET payload_json = json_set(created.payload_json, '$.defaultModelSelection', json('null'))
    WHERE created.aggregate_kind = 'project'
      AND created.event_type = 'project.created'
      AND json_type(created.payload_json, '$.defaultModelSelection') = 'object'
      AND json_type(created.payload_json, '$.defaultModelSelection.instanceId') = 'text'
      AND json_type(created.payload_json, '$.defaultModelSelection.model') = 'text'
      AND json_type(created.payload_json, '$.defaultModelSelection.options') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(created.payload_json, '$.defaultModelSelection'))
        WHERE key NOT IN ('instanceId', 'model')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS updated
        WHERE updated.aggregate_kind = 'project'
          AND updated.stream_id = created.stream_id
          AND updated.sequence > created.sequence
          AND updated.event_type = 'project.meta-updated'
          AND json_type(updated.payload_json, '$.defaultModelSelection') IS NOT NULL
      )
  `;
});
