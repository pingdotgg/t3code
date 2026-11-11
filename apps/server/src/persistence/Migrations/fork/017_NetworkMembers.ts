import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The roster replaces the device policy. Existing access carries over exactly: a policy entry keeps
// its level and stamp; a machine linked over the tailnet without one keeps the shared default it had
// (full access when that was never changed), stamped at zero so any real write wins. Machines that
// were only found on the tailnet do not become members. The old tables stay for a rollback.
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
});
