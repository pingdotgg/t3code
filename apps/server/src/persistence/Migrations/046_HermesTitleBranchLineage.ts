import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Provider-authoritative title cursor and latest-head native branch provenance.
 *
 * Titles themselves remain in the orchestration projection; the binding stores
 * only the monotonic upstream cursor/origin needed to suppress stale replay.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN title_revision INTEGER NOT NULL DEFAULT 0 CHECK (title_revision >= 0)
  `;
  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN title_origin TEXT
  `;
  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN parent_binding_id TEXT REFERENCES hermes_session_bindings(binding_id)
  `;
  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN branch_boundary_mode TEXT
      CHECK (branch_boundary_mode IS NULL OR branch_boundary_mode = 'latest_only')
  `;
  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN branch_boundary_message_id TEXT
  `;
  yield* sql`
    ALTER TABLE hermes_session_bindings
    ADD COLUMN branch_boundary_message_count INTEGER
      CHECK (branch_boundary_message_count IS NULL OR branch_boundary_message_count >= 0)
  `;

  yield* sql`
    CREATE INDEX hermes_session_bindings_parent_idx
    ON hermes_session_bindings(parent_binding_id, created_at, binding_id)
  `;
});
