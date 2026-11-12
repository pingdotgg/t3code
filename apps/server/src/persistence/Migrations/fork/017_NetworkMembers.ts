import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The roster replaces the device policy without widening anyone: a policy entry keeps its level and
// stamp; a tailnet link without one keeps the shared default, stamped at zero. Found machines do not
// become members. `node_id` stays NULL: the old tables kept only the renameable node name, so a
// member is bound again only when the user re-adds it. The old tables stay for a rollback.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE network_members (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      node_id TEXT,
      access TEXT NOT NULL,
      stamp_json TEXT NOT NULL
    )
  `;

  // Apps paired once with the whole network; replicated like members.
  yield* sql`
    CREATE TABLE network_apps (
      app_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      access TEXT NOT NULL,
      stamp_json TEXT NOT NULL
    )
  `;

  // Never replicated: this machine's narrower limit for a member.
  yield* sql`
    CREATE TABLE network_member_limits (
      environment_id TEXT PRIMARY KEY,
      access TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO network_members (environment_id, label, node_id, access, stamp_json)
    SELECT
      policy.environment_id,
      COALESCE(links.label, devices.label, policy.environment_id),
      NULL,
      policy.access,
      policy.stamp_json
    FROM tailnet_device_policy AS policy
    LEFT JOIN peer_environment_links AS links ON links.environment_id = policy.environment_id
    LEFT JOIN tailnet_devices AS devices ON devices.environment_id = policy.environment_id
  `;

  yield* sql`
    INSERT INTO network_members (environment_id, label, node_id, access, stamp_json)
    SELECT
      links.environment_id,
      links.label,
      NULL,
      COALESCE(
        (SELECT json_extract(settings_json, '$.defaultAccess')
         FROM tailnet_device_settings WHERE id = 1 AND json_valid(settings_json)),
        'full-access'
      ),
      json_object('wallMs', 0, 'counter', 0, 'node', links.environment_id)
    FROM peer_environment_links AS links
    WHERE links.origin = 'tailnet'
      AND links.environment_id NOT IN (SELECT environment_id FROM network_members)
  `;

  // A member keeps here no more than the widest grant it already held here, so a machine let in
  // read-only by pairing code is not widened by the roster. Grants are the agent sessions it
  // holds (`peer_environment_links.access` is this machine's access there, not theirs here). Only
  // scopes are stored, so a supervised-or-wider grant without settings rounds down to supervised.
  yield* sql`
    INSERT INTO network_member_limits (environment_id, access)
    SELECT environment_id, CASE MAX(rank)
      WHEN 0 THEN 'read-only'
      ELSE 'approval-required'
    END
    FROM (
      SELECT
        sessions.peer_environment_id AS environment_id,
        CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'orchestration:operate'
          ) THEN 0
          WHEN EXISTS (SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'settings:write')
            AND EXISTS (
              SELECT 1 FROM json_each(sessions.scopes) WHERE value = 'source-control:write'
            ) THEN 2
          ELSE 1
        END AS rank
      FROM auth_sessions AS sessions
      WHERE sessions.subject = 'mcp-client'
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND json_valid(sessions.scopes)
        AND sessions.peer_environment_id IN (SELECT environment_id FROM network_members)
    )
    GROUP BY environment_id
    HAVING MAX(rank) < 2
  `;
});
