import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A peer linked both ways before the roster (a live link here, pairing code included, and a live
// session it holds here) becomes a member at what that session grants, unbound and stamped at
// zero so any real write wins. One-way links, found machines and anything revoked here stay out.
// A roster 017 already split is repaired the same way.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO network_members (environment_id, label, node_id, access, stamp_json)
    SELECT
      links.environment_id,
      links.label,
      NULL,
      CASE grants.rank WHEN 0 THEN 'read-only' WHEN 1 THEN 'approval-required' ELSE 'full-access' END,
      json_object('wallMs', 0, 'counter', 0, 'node', links.environment_id)
    FROM peer_environment_links AS links
    JOIN (
      SELECT sessions.peer_environment_id AS environment_id, MAX(
        CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'orchestration:operate'
          ) THEN 0
          WHEN EXISTS (SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'settings:write')
            AND EXISTS (
              SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'source-control:write'
            ) THEN 2
          ELSE 1
        END
      ) AS rank
      FROM auth_sessions AS sessions
      WHERE sessions.subject = 'mcp-client'
        AND sessions.peer_environment_id IS NOT NULL
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND json_valid(sessions.scopes)
      GROUP BY sessions.peer_environment_id
    ) AS grants ON grants.environment_id = links.environment_id
    WHERE links.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND links.environment_id NOT IN (SELECT environment_id FROM network_members)
      AND links.environment_id NOT IN (SELECT environment_id FROM network_local_members)
      AND links.environment_id NOT IN (
        SELECT environment_id FROM tailnet_device_policy WHERE access = 'revoked'
      )
  `;

  // 017 fell back to the bare id for a member it had no name for.
  yield* sql`
    UPDATE network_members
    SET label = COALESCE(
      (SELECT label FROM peer_environment_links WHERE environment_id = network_members.environment_id),
      (SELECT label FROM tailnet_devices WHERE environment_id = network_members.environment_id),
      label
    )
    WHERE label = environment_id
  `;
});
