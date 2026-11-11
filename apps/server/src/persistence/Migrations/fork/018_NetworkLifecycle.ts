import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The latest revocation a member entry was written knowing about; see `NetworkMember.restores`.
  yield* sql`ALTER TABLE network_members ADD COLUMN restores_json TEXT`;
  // Never replicated: what the user removed from this machine's view.
  yield* sql`ALTER TABLE network_members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE network_apps ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`;

  // Tailscale's stable id for a found machine's node, so clients group a reinstall with its node.
  yield* sql`ALTER TABLE tailnet_devices ADD COLUMN node_id TEXT`;

  // Never replicated: machines linked to this one only, outside any network.
  yield* sql`
    CREATE TABLE network_local_members (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      node_id TEXT NOT NULL,
      access TEXT NOT NULL
    )
  `;

  // The machine that asked for a credential on an app's behalf, so revoking it ends what it opened.
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN brokered_by TEXT`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN brokered_by TEXT`;
  yield* sql`
    CREATE INDEX auth_sessions_brokered_by_idx
    ON auth_sessions(brokered_by) WHERE brokered_by IS NOT NULL
  `;
});
