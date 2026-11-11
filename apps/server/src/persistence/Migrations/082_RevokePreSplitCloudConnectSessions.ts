import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// T3 Connect sessions minted through v0.0.45 hold that release's standard grant,
// which lacks the permissions split out of it later. Revoked tokens make clients
// exchange again for today's grant. Narrower grants are deliberate and stay.
const preSplitStandardScopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const revokedAt = DateTime.formatIso(yield* DateTime.now);

  yield* sql`
    UPDATE auth_sessions
    SET revoked_at = ${revokedAt}
    WHERE subject = 'cloud-connect'
      AND method = 'dpop-access-token'
      AND revoked_at IS NULL
      AND json_array_length(scopes) = ${preSplitStandardScopes.length}
      AND (
        SELECT COUNT(DISTINCT value) FROM json_each(auth_sessions.scopes)
        WHERE value IN ${sql.in(preSplitStandardScopes)}
      ) = ${preSplitStandardScopes.length}
  `;
});
