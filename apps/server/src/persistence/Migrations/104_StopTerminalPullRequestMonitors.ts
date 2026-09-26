import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE pull_request_monitors
    SET
      status = 'terminal',
      enabled = 0,
      next_poll_at = NULL,
      stopped_at = COALESCE(stopped_at, updated_at)
    WHERE enabled = 1
      AND (
        SELECT json_extract(snapshot.snapshot_json, '$.state')
        FROM pull_request_monitor_snapshots AS snapshot
        WHERE snapshot.monitor_id = pull_request_monitors.monitor_id
        ORDER BY snapshot.fetched_at DESC, snapshot.snapshot_id DESC
        LIMIT 1
      ) IN ('closed', 'merged')
  `;
});
