import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE civilization_project_state (
      project_id TEXT PRIMARY KEY,
      census_revision INTEGER NOT NULL DEFAULT 0 CHECK (census_revision >= 0),
      notes_revision INTEGER NOT NULL DEFAULT 0 CHECK (notes_revision >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
    SELECT DISTINCT project_id, 0, 0, datetime('now')
    FROM civilization_citizens
  `;

  yield* sql`
    CREATE TABLE civilization_notes (
      note_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
      author_thread_id TEXT NOT NULL,
      author_epoch INTEGER NOT NULL CHECK (author_epoch >= 0),
      accepted_runtime_mode TEXT NOT NULL CHECK (accepted_runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      accepted_interaction_mode TEXT NOT NULL CHECK (accepted_interaction_mode IN ('default', 'plan')),
      source_refs_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX civilization_notes_project_id_idx
    ON civilization_notes(project_id, note_id)
  `;
  yield* sql`
    CREATE INDEX civilization_notes_project_recent_idx
    ON civilization_notes(project_id, resolved_at, updated_at DESC, note_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_notes_author_idx
    ON civilization_notes(project_id, author_thread_id, note_id)
  `;

  yield* sql`
    CREATE TABLE civilization_context_references (
      context_reference_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_turn_ordinal INTEGER NOT NULL CHECK (provider_turn_ordinal >= 0),
      provider_instance_id TEXT NOT NULL,
      environment_revision INTEGER NOT NULL CHECK (environment_revision >= 0),
      project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
      citizen_revision INTEGER NOT NULL CHECK (citizen_revision >= 0),
      census_revision INTEGER NOT NULL CHECK (census_revision >= 0),
      notes_revision INTEGER NOT NULL CHECK (notes_revision >= 0),
      packet_hash TEXT NOT NULL,
      packet_bytes INTEGER NOT NULL CHECK (packet_bytes >= 0 AND packet_bytes <= 16384),
      selected_citizen_ids_json TEXT NOT NULL,
      selected_note_ids_json TEXT NOT NULL,
      selected_inbox_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX civilization_context_references_thread_idx
    ON civilization_context_references(project_id, thread_id, created_at DESC, context_reference_id DESC)
  `;

  yield* sql`
    CREATE TRIGGER civilization_citizens_revision_insert
    AFTER INSERT ON civilization_citizens
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (NEW.project_id, 1, 0, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        census_revision = census_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_citizens_revision_update
    AFTER UPDATE ON civilization_citizens
    WHEN OLD.project_id <> NEW.project_id OR OLD.revision <> NEW.revision
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (OLD.project_id, 1, 0, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        census_revision = census_revision + 1,
        updated_at = excluded.updated_at;
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      SELECT NEW.project_id, 1, 0, datetime('now')
      WHERE NEW.project_id <> OLD.project_id
      ON CONFLICT(project_id) DO UPDATE SET
        census_revision = census_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_citizens_revision_delete
    AFTER DELETE ON civilization_citizens
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (OLD.project_id, 1, 0, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        census_revision = census_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_notes_revision_insert
    AFTER INSERT ON civilization_notes
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (NEW.project_id, 0, 1, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        notes_revision = notes_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_notes_revision_update
    AFTER UPDATE ON civilization_notes
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (OLD.project_id, 0, 1, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        notes_revision = notes_revision + 1,
        updated_at = excluded.updated_at;
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      SELECT NEW.project_id, 0, 1, datetime('now')
      WHERE NEW.project_id <> OLD.project_id
      ON CONFLICT(project_id) DO UPDATE SET
        notes_revision = notes_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_notes_revision_delete
    AFTER DELETE ON civilization_notes
    BEGIN
      INSERT INTO civilization_project_state (project_id, census_revision, notes_revision, updated_at)
      VALUES (OLD.project_id, 0, 1, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        notes_revision = notes_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;
});
