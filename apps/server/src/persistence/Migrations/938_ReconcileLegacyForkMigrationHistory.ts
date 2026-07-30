import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0026 from "./026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./030_ProjectionThreadShellArchiveIndexes.ts";

/**
 * PR #1 used migration ids 26-31 for fork-only projections. Databases created
 * by that branch therefore report those ids as applied even though the
 * upstream migrations with the same ids never ran. Replay the idempotent
 * upstream effects here, repair only legacy role-based auth tables, and remove
 * the old mobile-visible Ask literal.
 *
 * Originally registered as fork id 38, now id 938 (reserved fork block).
 * Nothing here depends on the id it runs under: the legacy 26-31 history rows
 * are left in place (the migrator orders by id only, so their fork names are
 * harmless) and every replayed effect is idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* Migration0026;
  yield* Migration0027;
  yield* Migration0028;
  yield* Migration0029;
  yield* Migration0030;

  const pairingColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  const hasScopedPairingLinks = pairingColumns.some((column) => column.name === "scopes");
  const hasScopedSessions = sessionColumns.some((column) => column.name === "scopes");

  if (!hasScopedPairingLinks || !hasScopedSessions) {
    // Role-based credentials cannot be assigned authorization scopes safely.
    // This matches migration 031's intentional invalidation boundary.
    yield* sql`DROP TABLE IF EXISTS auth_pairing_links`;
    yield* sql`DROP TABLE IF EXISTS auth_sessions`;

    yield* sql`
      CREATE TABLE auth_pairing_links (
        id TEXT PRIMARY KEY,
        credential TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        scopes TEXT NOT NULL,
        subject TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        proof_key_thumbprint TEXT
      )
    `;
    yield* sql`
      CREATE INDEX idx_auth_pairing_links_active
      ON auth_pairing_links(revoked_at, consumed_at, expires_at)
    `;

    yield* sql`
      CREATE TABLE auth_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        scopes TEXT NOT NULL,
        method TEXT NOT NULL,
        client_label TEXT,
        client_ip_address TEXT,
        client_user_agent TEXT,
        client_device_type TEXT NOT NULL DEFAULT 'unknown',
        client_os TEXT,
        client_browser TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_connected_at TEXT,
        revoked_at TEXT
      )
    `;
    yield* sql`
      CREATE INDEX idx_auth_sessions_active
      ON auth_sessions(revoked_at, expires_at, issued_at)
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET interaction_mode = 'default'
    WHERE interaction_mode = 'ask'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.interactionMode', 'default')
    WHERE json_type(payload_json, '$.interactionMode') = 'text'
      AND json_extract(payload_json, '$.interactionMode') = 'ask'
  `;
});
