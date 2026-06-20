import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Production-facing V2 persistence additions.
 *
 * The original V2 schema used a single `provider` column for both configured
 * instance routing and driver identity. Keep those columns in place for
 * migration compatibility. They remain write-through shadows where the old
 * schema declared them NOT NULL; all V2 reads and indexes use the explicit
 * columns added here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_v2_events ADD COLUMN driver TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_events ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_events
    SET
      driver = provider,
      provider_instance_id = COALESCE(
        json_extract(payload_json, '$.providerInstanceId'),
        provider
      )
  `;
  yield* sql`CREATE INDEX orchestration_v2_events_instance_sequence_idx ON orchestration_v2_events(provider_instance_id, sequence)`;

  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET provider_instance_id = COALESCE(
      json_extract(payload_json, '$.providerInstanceId'),
      default_provider
    )
  `;

  yield* sql`ALTER TABLE orchestration_v2_projection_runs ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_runs
    SET provider_instance_id = COALESCE(
      json_extract(payload_json, '$.providerInstanceId'),
      provider
    )
  `;

  yield* sql`ALTER TABLE orchestration_v2_projection_run_attempts ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_run_attempts
    SET provider_instance_id = COALESCE(
      json_extract(payload_json, '$.providerInstanceId'),
      provider
    )
  `;

  yield* sql`ALTER TABLE orchestration_v2_projection_provider_sessions ADD COLUMN driver TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_sessions ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_provider_sessions
    SET
      driver = COALESCE(json_extract(payload_json, '$.driver'), provider),
      provider_instance_id = COALESCE(
        json_extract(payload_json, '$.providerInstanceId'),
        provider
      )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_sessions_instance_status_idx ON orchestration_v2_projection_provider_sessions(provider_instance_id, status)`;

  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN driver TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_provider_threads
    SET
      driver = COALESCE(json_extract(payload_json, '$.driver'), provider),
      provider_instance_id = COALESCE(
        json_extract(payload_json, '$.providerInstanceId'),
        provider
      )
  `;
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_threads_instance_status_idx ON orchestration_v2_projection_provider_threads(provider_instance_id, status)`;

  yield* sql`ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN driver TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_subagents
    SET
      driver = json_extract(payload_json, '$.driver'),
      provider_instance_id = COALESCE(
        json_extract(payload_json, '$.providerInstanceId'),
        provider
      )
  `;

  yield* sql`ALTER TABLE orchestration_v2_projection_context_transfers ADD COLUMN source_provider_instance_id TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_context_transfers ADD COLUMN target_provider_instance_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_context_transfers
    SET
      source_provider_instance_id = COALESCE(
        json_extract(payload_json, '$.sourceProviderInstanceId'),
        source_provider
      ),
      target_provider_instance_id = COALESCE(
        json_extract(payload_json, '$.targetProviderInstanceId'),
        target_provider
      )
  `;

  yield* sql`
    CREATE TABLE orchestration_v2_effect_outbox (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_effect_outbox_claim_idx ON orchestration_v2_effect_outbox(status, available_at, lease_expires_at, created_at)`;
  yield* sql`CREATE INDEX orchestration_v2_effect_outbox_command_idx ON orchestration_v2_effect_outbox(command_id, effect_id)`;

  yield* sql`
    CREATE TABLE orchestration_v2_turn_item_positions (
      thread_id TEXT NOT NULL,
      turn_item_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_item_id),
      UNIQUE (thread_id, ordinal)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO orchestration_v2_turn_item_positions (
      thread_id,
      turn_item_id,
      ordinal
    )
    SELECT thread_id, turn_item_id, ordinal
    FROM orchestration_v2_projection_turn_items
    ORDER BY thread_id, ordinal, turn_item_id
  `;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_metadata (
      projection_name TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_metadata (
      projection_name,
      schema_version,
      last_sequence,
      updated_at
    )
    VALUES (
      'thread-projections',
      1,
      COALESCE((SELECT MAX(sequence) FROM orchestration_v2_events), 0),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  `;
});
