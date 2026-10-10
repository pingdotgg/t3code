import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Background sweeps (settlement, pull request sync, the shell reads behind pull request
 * discovery) filtered every thread with `json_extract` on its payload, which holds every linked
 * pull request's snapshot: tens of KB parsed per thread per sweep. This index stores the values
 * they filter on, so SQLite reads them from the index instead of parsing payloads.
 *
 * SQLite computes the entries from `payload_json` on every write, so they stay correct for any
 * writer, including an older build sharing this database. ProjectionStore's sweep queries must
 * spell each expression exactly as it is here, or SQLite parses the payload again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Development builds of this change created an index of the same name over copied columns.
  // Replace it so every database gets this definition.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_active_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_active_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      json_extract(payload_json, '$.settledAt'),
      json_extract(payload_json, '$.settledOverride'),
      json_extract(payload_json, '$.pinnedAt'),
      json_extract(payload_json, '$.autoSettleDisabledAt'),
      json_array_length(payload_json, '$.pullRequests'),
      CASE
        WHEN json_extract(payload_json, '$.forkedFrom.type') = 'run'
          THEN json_extract(payload_json, '$.forkedFrom.threadId')
        ELSE NULL
      END,
      provider_instance_id
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
  // Usage-limit recovery only concerns threads whose latest run failed; this finds the few
  // threads with any failed run without reading the rest.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_failed_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE status = 'failed'
  `;
});
