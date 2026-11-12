import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(
      model_selection_json,
      '$.options',
      (
        SELECT json_group_array(
          json_object(
            'id', key,
            'value',
            CASE type
              WHEN 'true' THEN json('true')
              WHEN 'false' THEN json('false')
              ELSE atom
            END
          )
        )
        FROM json_each(json_extract(model_selection_json, '$.options'))
        WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
           OR type IN ('true', 'false')
      )
    )
    WHERE model_selection_json IS NOT NULL
      AND json_type(model_selection_json, '$.options') = 'object'
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.options',
      (
        SELECT json_group_array(
          json_object(
            'id', key,
            'value',
            CASE type
              WHEN 'true' THEN json('true')
              WHEN 'false' THEN json('false')
              ELSE atom
            END
          )
        )
        FROM json_each(json_extract(default_model_selection_json, '$.options'))
        WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
           OR type IN ('true', 'false')
      )
    )
    WHERE default_model_selection_json IS NOT NULL
      AND json_type(default_model_selection_json, '$.options') = 'object'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.modelSelection.options',
      (
        SELECT json_group_array(
          json_object(
            'id', key,
            'value',
            CASE type
              WHEN 'true' THEN json('true')
              WHEN 'false' THEN json('false')
              ELSE atom
            END
          )
        )
        FROM json_each(json_extract(payload_json, '$.modelSelection.options'))
        WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
           OR type IN ('true', 'false')
      )
    )
    WHERE event_type IN (
      'thread.created',
      'thread.meta-updated',
      'thread.turn-start-requested'
    )
      AND json_type(payload_json, '$.modelSelection.options') = 'object'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection.options',
      (
        SELECT json_group_array(
          json_object(
            'id', key,
            'value',
            CASE type
              WHEN 'true' THEN json('true')
              WHEN 'false' THEN json('false')
              ELSE atom
            END
          )
        )
        FROM json_each(json_extract(payload_json, '$.defaultModelSelection.options'))
        WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
           OR type IN ('true', 'false')
      )
    )
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_type(payload_json, '$.defaultModelSelection.options') = 'object'
  `;
});
