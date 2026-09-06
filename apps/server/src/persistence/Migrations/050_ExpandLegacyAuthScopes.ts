import { AuthEnvironmentScopes, expandLegacyScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const ScopesJson = Schema.fromJsonString(AuthEnvironmentScopes);
const decodeScopes = Schema.decodeUnknownEffect(ScopesJson);
const encodeScopes = Schema.encodeSync(ScopesJson);

/**
 * Credentials recorded before scopes were split still carry the broad ones.
 * Rewrite live pairing links and sessions so they grant what the same
 * credential meant when it was created. Session rows back websocket tickets;
 * the signed session token carries its own copy of the scopes, and v1 tokens
 * are expanded when verified.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const expandTable = (table: "auth_pairing_links" | "auth_sessions") =>
    Effect.gen(function* () {
      const rows =
        table === "auth_pairing_links"
          ? yield* sql<{ readonly id: string; readonly scopes: string }>`
              SELECT id, scopes
              FROM auth_pairing_links
              WHERE revoked_at IS NULL AND consumed_at IS NULL
            `
          : yield* sql<{ readonly id: string; readonly scopes: string }>`
              SELECT session_id AS id, scopes
              FROM auth_sessions
              WHERE revoked_at IS NULL
            `;
      for (const row of rows) {
        const scopes = yield* decodeScopes(row.scopes).pipe(Effect.option);
        if (scopes._tag === "None") continue;
        const expanded = expandLegacyScopes(scopes.value);
        if (expanded === scopes.value) continue;
        const encoded = encodeScopes(expanded);
        if (table === "auth_pairing_links") {
          yield* sql`UPDATE auth_pairing_links SET scopes = ${encoded} WHERE id = ${row.id}`;
        } else {
          yield* sql`UPDATE auth_sessions SET scopes = ${encoded} WHERE session_id = ${row.id}`;
        }
      }
    });
  yield* expandTable("auth_pairing_links");
  yield* expandTable("auth_sessions");
});
