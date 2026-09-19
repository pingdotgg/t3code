import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { boundedPayloadPreviewJson } from "../../orchestration-v2/boundedPayloadPreview.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "../../orchestration-v2/ProjectionStore.ts";
import { THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES } from "../../orchestration-v2/threadHistoryPaging.ts";

/**
 * Adds a write-time bounded preview column to every payload-bearing V2
 * projection table. Bounded snapshot reads select `bounded_json` instead of
 * `payload_json`, so oversized rows never cross SQLite→JS before compaction.
 *
 * Rows written before this migration have no preview; the backfill computes
 * one for every payload already over the row cap, plus payloads too deeply
 * nested for SQLite's JSON1 parser (the depth limit differs per engine —
 * ~800 under bun:sqlite, higher under node:sqlite — so candidates are chosen
 * by byte length and the JS preview helper decides). Payloads under both
 * caps keep a NULL preview and are read raw.
 */
const PREVIEW_TABLES = [
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_context_transfers",
  "orchestration_v2_projection_subagents",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of PREVIEW_TABLES) {
    yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN bounded_json TEXT`;

    let lastRowId = 0;
    while (true) {
      // One payload at a time: a fixed-row page can stage hundreds of
      // unbounded payload_json values at once and exhaust startup memory.
      const rows = yield* sql<{
        readonly row_id: number;
        readonly payload_json: string;
      }>`
        SELECT rowid AS row_id, payload_json
        FROM ${sql.literal(table)}
        WHERE rowid > ${lastRowId}
          -- Over-cap rows always need a preview; past JSON1's minimum-depth
          -- bound (800 levels = at least 1600 bytes) the JS helper decides,
          -- which keeps the check identical across sqlite engines.
          AND LENGTH(CAST(payload_json AS BLOB)) > 1600
        ORDER BY rowid ASC
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) break;
      // Over-depth payloads are spliced down textually before JSON.parse,
      // so even nesting past the JS parser stack still yields a preview;
      // only source text that is not valid JSON at all stays NULL — such a
      // row was already unreadable to bounded queries.
      let preview: string | null = null;
      try {
        preview = boundedPayloadPreviewJson(row.payload_json);
      } catch {
        preview = null;
      }
      if (preview !== null) {
        yield* sql`UPDATE ${sql.literal(table)} SET bounded_json = ${preview} WHERE rowid = ${row.row_id}`;
      }
      lastRowId = row.row_id;
      yield* Effect.yieldNow;
    }
  }

  // The backfill brings existing rows up to the current projection schema,
  // so no rebuild is needed for the preview column.
  yield* sql`
    UPDATE orchestration_v2_projection_metadata
    SET schema_version = ${ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION}
    WHERE projection_name = 'thread-projections'
  `;
});
