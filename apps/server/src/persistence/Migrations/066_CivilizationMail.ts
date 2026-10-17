import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Delivery lifecycle is intentionally independent from the citizen identity
  // epoch. Aggregate `closed` can remain true while settlement/archive/delete
  // independently transition, and each such transition must invalidate mail.
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN delivery_epoch INTEGER NOT NULL DEFAULT 0 CHECK (delivery_epoch >= 0)`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN delivery_settled INTEGER NOT NULL DEFAULT 0 CHECK (delivery_settled IN (0, 1))`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN delivery_archived INTEGER NOT NULL DEFAULT 0 CHECK (delivery_archived IN (0, 1))`;
  yield* sql`ALTER TABLE civilization_citizens ADD COLUMN delivery_deleted INTEGER NOT NULL DEFAULT 0 CHECK (delivery_deleted IN (0, 1))`;

  // Preserve the existing citizen epoch semantics. Seed delivery_epoch from the
  // current epoch so an upgrade never makes an older lifecycle generation look
  // newer, while component bits come from authoritative host projection state.
  yield* sql`
    UPDATE civilization_citizens AS c
    SET delivery_epoch = c.epoch,
        delivery_settled = CASE WHEN EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS t
          WHERE t.thread_id = c.thread_id
            AND (json_extract(t.payload_json, '$.settledOverride') = 'settled'
              OR json_extract(t.payload_json, '$.settledAt') IS NOT NULL)
        ) THEN 1 ELSE 0 END,
        delivery_archived = CASE WHEN EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS t
          WHERE t.thread_id = c.thread_id AND t.archived_at IS NOT NULL
        ) THEN 1 ELSE 0 END,
        delivery_deleted = CASE WHEN c.deleted = 1 OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS t
          WHERE t.thread_id = c.thread_id AND t.deleted_at IS NOT NULL
        ) THEN 1 ELSE 0 END
  `;

  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN mail_revision INTEGER NOT NULL DEFAULT 0 CHECK (mail_revision >= 0)`;
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN retained_message_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_message_count >= 0)`;
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN retained_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_body_bytes >= 0)`;
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN last_mail_cleanup_at TEXT`;

  yield* sql`
    CREATE TABLE civilization_messages (
      message_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sender_thread_id TEXT NOT NULL,
      sender_name_at_send TEXT NOT NULL,
      sender_citizen_epoch INTEGER NOT NULL CHECK (sender_citizen_epoch >= 0),
      sender_run_id TEXT NOT NULL,
      recipient_thread_id TEXT NOT NULL,
      recipient_delivery_epoch INTEGER NOT NULL CHECK (recipient_delivery_epoch >= 0),
      reply_to_message_id TEXT,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0 AND body_bytes <= 16384),
      accepted_runtime_mode TEXT NOT NULL CHECK (accepted_runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      accepted_interaction_mode TEXT NOT NULL CHECK (accepted_interaction_mode IN ('default', 'plan')),
      accepted_environment_revision INTEGER NOT NULL CHECK (accepted_environment_revision >= 0),
      accepted_project_revision INTEGER NOT NULL CHECK (accepted_project_revision >= 0),
      accepted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      terminal_retention_days INTEGER NOT NULL CHECK (terminal_retention_days >= 0 AND terminal_retention_days <= 365),
      first_offered_at TEXT,
      last_offered_at TEXT,
      offer_count INTEGER NOT NULL DEFAULT 0 CHECK (offer_count >= 0),
      acknowledged_at TEXT,
      terminal_at TEXT,
      terminal_reason TEXT CHECK (
        terminal_reason IS NULL OR terminal_reason IN (
          'recipient_settled', 'recipient_archived', 'recipient_deleted',
          'project_deleted', 'expired', 'purged'
        )
      ),
      CHECK (sender_thread_id <> recipient_thread_id),
      CHECK ((terminal_at IS NULL) = (terminal_reason IS NULL)),
      CHECK ((offer_count = 0 AND first_offered_at IS NULL AND last_offered_at IS NULL)
        OR (offer_count > 0 AND first_offered_at IS NOT NULL AND last_offered_at IS NOT NULL))
    )
  `;

  yield* sql`
    CREATE INDEX civilization_messages_project_capacity_idx
    ON civilization_messages(project_id, terminal_at, accepted_at, message_id)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_recipient_epoch_pending_idx
    ON civilization_messages(
      project_id, recipient_thread_id, recipient_delivery_epoch,
      terminal_at, acknowledged_at, accepted_at, message_id
    )
  `;
  yield* sql`
    CREATE INDEX civilization_messages_recipient_history_idx
    ON civilization_messages(project_id, recipient_thread_id, accepted_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_sender_history_idx
    ON civilization_messages(project_id, sender_thread_id, accepted_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_reply_idx
    ON civilization_messages(project_id, reply_to_message_id)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_expiry_idx
    ON civilization_messages(terminal_at, expires_at, project_id, message_id)
  `;

  yield* sql`
    CREATE TABLE civilization_mail_operation_receipts (
      project_id TEXT NOT NULL,
      actor_thread_id TEXT NOT NULL,
      actor_citizen_epoch INTEGER NOT NULL CHECK (actor_citizen_epoch >= 0),
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('send', 'receive', 'acknowledge')),
      client_request_id TEXT NOT NULL,
      canonical_payload_hash TEXT NOT NULL,
      result_message_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (project_id, actor_thread_id, client_request_id)
    )
  `;
  yield* sql`
    CREATE INDEX civilization_mail_receipts_expiry_idx
    ON civilization_mail_operation_receipts(expires_at, project_id, actor_thread_id)
  `;
  yield* sql`
    CREATE INDEX civilization_mail_receipts_result_idx
    ON civilization_mail_operation_receipts(project_id, result_message_id)
  `;

  yield* sql`
    CREATE TABLE civilization_mail_quota_windows (
      project_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('sender', 'project')),
      scope_id TEXT NOT NULL,
      window_start_minute TEXT NOT NULL,
      accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scope_kind, scope_id, window_start_minute)
    )
  `;
  yield* sql`
    CREATE INDEX civilization_mail_quota_window_idx
    ON civilization_mail_quota_windows(window_start_minute, project_id, scope_kind, scope_id)
  `;

  // Context references are durable semantic provenance for the packet that was
  // built. Mail changes independently of census/notes, so snapshot its revision.
  yield* sql`ALTER TABLE civilization_context_references ADD COLUMN inbox_revision INTEGER NOT NULL DEFAULT 0 CHECK (inbox_revision >= 0)`;

  yield* sql`
    CREATE TRIGGER civilization_messages_revision_insert
    AFTER INSERT ON civilization_messages
    BEGIN
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, mail_revision,
        retained_message_count, retained_body_bytes, updated_at
      ) VALUES (NEW.project_id, 0, 0, 1, 1, NEW.body_bytes, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        mail_revision = mail_revision + 1,
        retained_message_count = retained_message_count + 1,
        retained_body_bytes = retained_body_bytes + NEW.body_bytes,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_messages_revision_update
    AFTER UPDATE ON civilization_messages
    BEGIN
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, mail_revision,
        retained_message_count, retained_body_bytes, updated_at
      ) VALUES (OLD.project_id, 0, 0, 1, 0, 0, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        mail_revision = mail_revision + 1,
        updated_at = excluded.updated_at;
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, mail_revision,
        retained_message_count, retained_body_bytes, updated_at
      )
      SELECT NEW.project_id, 0, 0, 1, 0, 0, datetime('now')
      WHERE NEW.project_id <> OLD.project_id
      ON CONFLICT(project_id) DO UPDATE SET
        mail_revision = mail_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_messages_revision_delete
    AFTER DELETE ON civilization_messages
    BEGIN
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, mail_revision,
        retained_message_count, retained_body_bytes, updated_at
      ) VALUES (OLD.project_id, 0, 0, 1, 0, 0, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        mail_revision = mail_revision + 1,
        retained_message_count = MAX(0, retained_message_count - 1),
        retained_body_bytes = MAX(0, retained_body_bytes - OLD.body_bytes),
        updated_at = excluded.updated_at;
    END
  `;

  // Message bodies and acceptance identity are immutable. Offer/ack/terminal
  // metadata are the only mutable message lifecycle fields.
  yield* sql`
    CREATE TRIGGER civilization_messages_immutable_content
    BEFORE UPDATE ON civilization_messages
    WHEN NEW.message_id <> OLD.message_id
      OR NEW.project_id <> OLD.project_id
      OR NEW.sender_thread_id <> OLD.sender_thread_id
      OR NEW.sender_name_at_send <> OLD.sender_name_at_send
      OR NEW.sender_citizen_epoch <> OLD.sender_citizen_epoch
      OR NEW.sender_run_id <> OLD.sender_run_id
      OR NEW.recipient_thread_id <> OLD.recipient_thread_id
      OR NEW.recipient_delivery_epoch <> OLD.recipient_delivery_epoch
      OR COALESCE(NEW.reply_to_message_id, '') <> COALESCE(OLD.reply_to_message_id, '')
      OR NEW.body <> OLD.body
      OR NEW.body_bytes <> OLD.body_bytes
      OR NEW.accepted_runtime_mode <> OLD.accepted_runtime_mode
      OR NEW.accepted_interaction_mode <> OLD.accepted_interaction_mode
      OR NEW.accepted_environment_revision <> OLD.accepted_environment_revision
      OR NEW.accepted_project_revision <> OLD.accepted_project_revision
      OR NEW.accepted_at <> OLD.accepted_at
      OR NEW.expires_at <> OLD.expires_at
      OR NEW.terminal_retention_days <> OLD.terminal_retention_days
    BEGIN
      SELECT RAISE(ABORT, 'civilization message acceptance fields are immutable');
    END
  `;
});
