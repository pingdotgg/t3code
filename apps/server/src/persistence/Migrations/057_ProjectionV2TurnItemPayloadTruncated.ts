import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Flags stored turn-item previews as truncated. A `bounded_json` row exists
 * only when the raw payload exceeded the per-row cap, so every preview is
 * content that was dropped: stamping `payloadTruncated` lets clients surface
 * the compaction and recover the raw row through
 * `orchestration.getThreadTurnItem`. New writes carry the flag from the
 * write-time preview builder; this backfills rows stored before it existed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET bounded_json = json_set(bounded_json, '$.payloadTruncated', json('true'))
    WHERE bounded_json IS NOT NULL
      AND json_extract(bounded_json, '$.payloadTruncated') IS NULL
  `;
});
