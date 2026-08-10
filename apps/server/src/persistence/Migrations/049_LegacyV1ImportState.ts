import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionTurnsKeysetIndexMigration from "./037_ProjectionTurnsKeysetIndex.ts";
import ScheduledTasksMigration from "./045_ScheduledTasks.ts";

/**
 * Tracks the incremental import of v1 materialized thread state into the v2
 * event model. Shells are imported synchronously at startup; full transcripts
 * are hydrated on demand and by a low-priority background pass.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Compatibility for databases that ran this migration as private id 045 before
  // ProjectionTurnsKeysetIndex and ScheduledTasks landed in the released slots.
  yield* ProjectionTurnsKeysetIndexMigration;
  yield* ScheduledTasksMigration;
  yield* sql`
    UPDATE effect_sql_migrations
    SET name = CASE migration_id
      WHEN 37 THEN 'ProjectionTurnsKeysetIndex'
      WHEN 38 THEN 'OrchestrationV2'
      WHEN 39 THEN 'OrchestrationV2Subagents'
      WHEN 40 THEN 'OrchestrationV2Foundation'
      WHEN 41 THEN 'OrchestrationV2ProviderSessionBindings'
      WHEN 42 THEN 'OrchestrationV2ThreadLaunchWorkflows'
      WHEN 43 THEN 'ApplicationEventSource'
      WHEN 44 THEN 'OrchestrationV2EffectCancellation'
      WHEN 45 THEN 'ScheduledTasks'
      ELSE name
    END
    WHERE migration_id BETWEEN 37 AND 45
      AND EXISTS (
        SELECT 1
        FROM effect_sql_migrations
        WHERE migration_id = 37 AND name = 'OrchestrationV2'
      )
  `;
  yield* sql`
    UPDATE effect_sql_migrations
    SET name = 'ScheduledTasks'
    WHERE migration_id = 45 AND name = 'LegacyV1ImportState'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_legacy_imports (
      thread_id TEXT PRIMARY KEY,
      source_updated_at TEXT NOT NULL,
      shell_imported_at TEXT NOT NULL,
      transcript_imported_at TEXT,
      imported_message_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_legacy_imports_pending_transcript_idx
    ON orchestration_v2_legacy_imports(transcript_imported_at, shell_imported_at, thread_id)
  `;
});
