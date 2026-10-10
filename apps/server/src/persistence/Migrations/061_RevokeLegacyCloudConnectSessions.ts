import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The scope vocabulary before permissions were split. Frozen here so later
// scope changes cannot alter which sessions this migration matched.
const preSplitScopes = JSON.stringify([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
]);

/**
 * T3 Connect sessions carry whatever grant the server chose when it minted
 * them, not one the user picked. Sessions minted before the split hold only
 * the broad scopes, which no longer imply file access and the other newly
 * separated permissions. Revoking them makes clients mint a replacement through
 * the normal cloud flow, which receives the current standard grant.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);

  yield* sql`
    UPDATE auth_sessions
    SET revoked_at = ${now}
    WHERE subject = 'cloud-connect'
      AND revoked_at IS NULL
      AND expires_at > ${now}
      AND NOT EXISTS (
        SELECT 1 FROM json_each(auth_sessions.scopes)
        WHERE value NOT IN (SELECT value FROM json_each(${preSplitScopes}))
      )
  `;
});
