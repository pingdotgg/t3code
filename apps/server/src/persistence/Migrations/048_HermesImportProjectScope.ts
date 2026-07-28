import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repair development databases that ran the pre-project-scoping version of
 * the Hermes import ledger. Resolvable rows inherit their project from the
 * durable binding or orchestration thread projection. Unresolvable prepared
 * rows are safe to discard and will be recreated by the idempotent importer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(hermes_session_imports)
  `;
  if (columns.some(({ name }) => name === "project_id")) return;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP INDEX IF EXISTS hermes_session_imports_stored_identity_idx`;
      yield* sql`DROP INDEX IF EXISTS hermes_session_imports_one_main_idx`;
      yield* sql`
        ALTER TABLE hermes_session_imports
        RENAME TO hermes_session_imports_legacy_048
      `;
      yield* sql`
        CREATE TABLE hermes_session_imports (
          import_id TEXT PRIMARY KEY,
          provider_instance_id TEXT NOT NULL,
          profile_key TEXT NOT NULL,
          project_id TEXT NOT NULL,
          import_kind TEXT NOT NULL CHECK (import_kind IN ('session', 'main')),
          stored_session_key TEXT,
          thread_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('prepared', 'thread_created', 'completed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (import_kind = 'session' AND stored_session_key IS NOT NULL)
            OR (import_kind = 'main' AND stored_session_key IS NULL)
          )
        )
      `;
      yield* sql`
        INSERT INTO hermes_session_imports (
          import_id,
          provider_instance_id,
          profile_key,
          project_id,
          import_kind,
          stored_session_key,
          thread_id,
          state,
          created_at,
          updated_at
        )
        SELECT
          legacy.import_id,
          legacy.provider_instance_id,
          legacy.profile_key,
          COALESCE(binding.project_id, thread.project_id),
          legacy.import_kind,
          legacy.stored_session_key,
          legacy.thread_id,
          legacy.state,
          legacy.created_at,
          legacy.updated_at
        FROM hermes_session_imports_legacy_048 AS legacy
        LEFT JOIN hermes_session_bindings AS binding
          ON binding.thread_id = legacy.thread_id
        LEFT JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = legacy.thread_id
        WHERE COALESCE(binding.project_id, thread.project_id) IS NOT NULL
      `;
      yield* sql`DROP TABLE hermes_session_imports_legacy_048`;
      yield* sql`
        CREATE UNIQUE INDEX hermes_session_imports_stored_identity_idx
        ON hermes_session_imports(provider_instance_id, profile_key, project_id, stored_session_key)
        WHERE import_kind = 'session'
      `;
      yield* sql`
        CREATE UNIQUE INDEX hermes_session_imports_one_main_idx
        ON hermes_session_imports(provider_instance_id, profile_key, project_id)
        WHERE import_kind = 'main'
      `;
    }),
  );
});
