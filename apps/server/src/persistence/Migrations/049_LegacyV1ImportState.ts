import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionTurnsKeysetIndexMigration from "./037_ProjectionTurnsKeysetIndex.ts";
import ProjectionThreadsPinOrderKeyMigration from "./038_ProjectionThreadsPinOrderKey.ts";
import ProjectionProjectsDefaultThreadEnvModeMigration from "./039_ProjectionProjectsDefaultThreadEnvMode.ts";
import ProjectionProjectFaviconPathMigration from "./040_ProjectionProjectFaviconPath.ts";
import ScheduledTasksMigration from "./048_ScheduledTasks.ts";

/**
 * Tracks the incremental import of v1 materialized thread state into the v2
 * event model. Shells are imported synchronously at startup; full transcripts
 * are hydrated on demand and by a low-priority background pass.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Compatibility for databases that ran v2 migrations under private ids before
  // main inserted released migrations into the 037-040 and 048 slots.
  yield* ProjectionTurnsKeysetIndexMigration;
  yield* ProjectionThreadsPinOrderKeyMigration;
  yield* ProjectionProjectsDefaultThreadEnvModeMigration;
  yield* ProjectionProjectFaviconPathMigration;
  yield* ScheduledTasksMigration;
  yield* sql`
    UPDATE effect_sql_migrations
    SET name = CASE migration_id
      WHEN 37 THEN 'ProjectionTurnsKeysetIndex'
      WHEN 38 THEN 'ProjectionThreadsPinOrderKey'
      WHEN 39 THEN 'ProjectionProjectsDefaultThreadEnvMode'
      WHEN 40 THEN 'ProjectionProjectFaviconPath'
      WHEN 41 THEN 'OrchestrationV2'
      WHEN 42 THEN 'OrchestrationV2Subagents'
      WHEN 43 THEN 'OrchestrationV2Foundation'
      WHEN 44 THEN 'OrchestrationV2ProviderSessionBindings'
      WHEN 45 THEN 'OrchestrationV2ThreadLaunchWorkflows'
      WHEN 46 THEN 'ApplicationEventSource'
      WHEN 47 THEN 'OrchestrationV2EffectCancellation'
      WHEN 48 THEN 'ScheduledTasks'
      ELSE name
    END
    WHERE migration_id BETWEEN 37 AND 48
      AND EXISTS (
        SELECT 1
        FROM effect_sql_migrations
        WHERE migration_id IN (37, 38) AND name = 'OrchestrationV2'
      )
  `;
  yield* sql`
    UPDATE effect_sql_migrations
    SET name = CASE migration_id
      WHEN 45 THEN 'OrchestrationV2ThreadLaunchWorkflows'
      WHEN 46 THEN 'ApplicationEventSource'
      WHEN 47 THEN 'OrchestrationV2EffectCancellation'
      WHEN 48 THEN 'ScheduledTasks'
      ELSE name
    END
    WHERE migration_id BETWEEN 45 AND 48
      AND EXISTS (
        SELECT 1
        FROM effect_sql_migrations
        WHERE migration_id = 45 AND name = 'LegacyV1ImportState'
      )
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
