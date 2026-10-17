import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Retention reductions require an explicit preview/apply. These project
  // values are the last retention horizons approved for existing data. New
  // projects inherit the shipped defaults; cleanup may extend them when
  // configuration increases, but a lower configured value is inert until the
  // operations service applies the reviewed reduction.
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN applied_note_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (applied_note_retention_days >= 0 AND applied_note_retention_days <= 365)`;
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN applied_diagnostic_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (applied_diagnostic_retention_days >= 0 AND applied_diagnostic_retention_days <= 30)`;
  yield* sql`ALTER TABLE civilization_project_state ADD COLUMN applied_tombstone_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (applied_tombstone_retention_days >= 0 AND applied_tombstone_retention_days <= 365)`;

  // Purge keeps only the identifiers/timestamps/progress required to resume
  // bounded cleanup. Sensitive identity/content/audit data remains in the
  // Phase 0-3 feature tables and is deleted from there by OperationsService.
  yield* sql`
    CREATE TABLE civilization_purge_tombstones (
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      deletion_at TEXT,
      purge_started_at TEXT NOT NULL,
      purge_completed_at TEXT,
      preview_token TEXT,
      retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 0 AND retention_days <= 365),
      progress_state TEXT NOT NULL CHECK (progress_state IN ('pending', 'in_progress', 'complete')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX civilization_purge_tombstones_project_progress_idx
    ON civilization_purge_tombstones(project_id, progress_state, updated_at, thread_id)
  `;
});
