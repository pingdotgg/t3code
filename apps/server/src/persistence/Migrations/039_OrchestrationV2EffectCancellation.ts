import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_effect_outbox_next (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
      ),
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
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox_next (
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
    )
    SELECT
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
    FROM orchestration_v2_effect_outbox
  `;
  yield* sql`DROP TABLE orchestration_v2_effect_outbox`;
  yield* sql`
    ALTER TABLE orchestration_v2_effect_outbox_next
    RENAME TO orchestration_v2_effect_outbox
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_claim_idx
    ON orchestration_v2_effect_outbox(status, available_at, lease_expires_at, created_at)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_command_idx
    ON orchestration_v2_effect_outbox(command_id, effect_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_effect_outbox_thread_status_idx
    ON orchestration_v2_effect_outbox(thread_id, status, effect_type)
  `;
});
