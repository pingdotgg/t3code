import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Devices this host refuses for Tailscale sign-in, by StableID. A device
  // that rejoins the tailnet gets a new StableID and is not blocked.
  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_tailnet_device_blocks (
      stable_node_id TEXT PRIMARY KEY,
      label TEXT,
      blocked_at TEXT NOT NULL
    )
  `;
});
