import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repair databases that ran the original Hermes bindings migration before the
 * session-import ledger was added to it. Released migrations are immutable, so
 * existing databases need a new forward migration while fresh databases keep
 * receiving the same schema from migration 044.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS hermes_session_imports (
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
    CREATE UNIQUE INDEX IF NOT EXISTS hermes_session_imports_stored_identity_idx
    ON hermes_session_imports(provider_instance_id, profile_key, project_id, stored_session_key)
    WHERE import_kind = 'session'
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS hermes_session_imports_one_main_idx
    ON hermes_session_imports(provider_instance_id, profile_key, project_id)
    WHERE import_kind = 'main'
  `;
});
