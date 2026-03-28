import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_model_selection_json TEXT
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = CASE
      WHEN default_model IS NULL THEN NULL
      ELSE json_object(
        'provider',
        CASE
          WHEN lower(default_model) LIKE '%claude%' THEN 'claudeAgent'
          ELSE 'codex'
        END,
        'model',
        default_model
      )
    END
    WHERE default_model_selection_json IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN model_selection_json TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_object(
      'provider',
      COALESCE(
        (
          SELECT provider_name
          FROM projection_thread_sessions
          WHERE projection_thread_sessions.thread_id = projection_threads.thread_id
        ),
        CASE
          WHEN lower(model) LIKE '%claude%' THEN 'claudeAgent'
          ELSE 'codex'
        END,
        'codex'
      ),
      'model',
      model
    )
    WHERE model_selection_json IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_projects
    DROP COLUMN default_model
  `;

  yield* sql`
    ALTER TABLE projection_threads
    DROP COLUMN model
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = CASE
      WHEN json_type(payload_json, '$.defaultModel') = 'null' THEN json_remove(
        json_set(payload_json, '$.defaultModelSelection', json('null')),
        '$.defaultProvider',
        '$.defaultModel',
        '$.defaultModelOptions'
      )
      ELSE json_remove(
        json_set(
          payload_json,
          '$.defaultModelSelection',
          json_patch(
            json_object(
              'provider',
              CASE
                WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                THEN json_extract(payload_json, '$.defaultProvider')
                WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                THEN 'claudeAgent'
                ELSE 'codex'
              END,
              'model',
              json_extract(payload_json, '$.defaultModel')
            ),
              CASE
                WHEN json_type(payload_json, '$.defaultModelOptions') IS NULL THEN '{}'
                WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                  OR json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                THEN CASE
                  WHEN (
                  CASE
                    WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                    THEN json_extract(payload_json, '$.defaultProvider')
                    WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                    THEN 'claudeAgent'
                    ELSE 'codex'
                    END
                  ) = 'claudeAgent'
                  THEN CASE
                    WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                    )
                    WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                    )
                    ELSE '{}'
                  END
                  ELSE CASE
                    WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                    )
                    WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                    )
                    ELSE '{}'
                  END
                END
              ELSE json_object(
                'options',
                json(json_extract(payload_json, '$.defaultModelOptions'))
              )
            END
          )
        ),
        '$.defaultProvider',
        '$.defaultModel',
        '$.defaultModelOptions'
      )
    END
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_type(payload_json, '$.defaultModelSelection') IS NULL
      AND json_type(payload_json, '$.defaultModel') IS NOT NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.modelSelection',
        json_patch(
          json_object(
            'provider',
            CASE
              WHEN json_extract(payload_json, '$.provider') IS NOT NULL
              THEN json_extract(payload_json, '$.provider')
              WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
              THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'model',
            json_extract(payload_json, '$.model')
          ),
          CASE
            WHEN json_type(payload_json, '$.modelOptions') IS NULL THEN '{}'
            WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
              OR json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
            THEN CASE
              WHEN (
                CASE
                  WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                  THEN json_extract(payload_json, '$.provider')
                  WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                  THEN 'claudeAgent'
                  ELSE 'codex'
                  END
              ) = 'claudeAgent'
              THEN CASE
                WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                THEN json_object(
                  'options',
                  json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                )
                WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                THEN json_object(
                  'options',
                  json(json_extract(payload_json, '$.modelOptions.codex'))
                )
                ELSE '{}'
              END
              ELSE CASE
                WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                THEN json_object(
                  'options',
                  json(json_extract(payload_json, '$.modelOptions.codex'))
                )
                WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                THEN json_object(
                  'options',
                  json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                )
                ELSE '{}'
              END
            END
            ELSE json_object('options', json(json_extract(payload_json, '$.modelOptions')))
          END
        )
      ),
      '$.provider',
      '$.model',
      '$.modelOptions'
    )
    WHERE event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
      AND json_type(payload_json, '$.modelSelection') IS NULL
      AND json_type(payload_json, '$.model') IS NOT NULL
  `;

  // Backfill thread.created events that predate the model field entirely
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.modelSelection',
      json(json_object('provider', 'codex', 'model', 'gpt-5.4'))
    )
    WHERE event_type = 'thread.created'
      AND json_type(payload_json, '$.modelSelection') IS NULL
      AND json_type(payload_json, '$.model') IS NULL
  `;
});
