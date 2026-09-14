import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { parseBoundedPayloadJson } from "../../orchestration-v2/boundedPayloadPreview.ts";
import { threadHistoryCursorItemTag } from "../../orchestration-v2/threadHistoryPaging.ts";

/**
 * Adds a write-time digest of the JSON-decoded turn item id. v2 history
 * cursors anchor on (thread digest, ordinal, item digest); resolving that
 * anchor needs the digest of the decoded id — the turn_item_id column cannot
 * supply it because the driver's UTF-8 binding folds lone surrogates while
 * payload decode preserves them, and SQLite cannot hash. A persisted column
 * keeps anchor resolution an indexed lookup instead of decoding every
 * equal-ordinal sibling's payload on each page.
 *
 * The backfill derives the digest from the stored payload — the write-time
 * preview preserves `id` verbatim, so either column yields the decoded id.
 * Rows whose payload cannot be parsed keep NULL; they were already unreadable
 * to bounded reads.
 */
const BACKFILL_PAGE_SIZE = 200;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN item_id_digest TEXT`;

  let lastRowId = 0;
  while (true) {
    const rows = yield* sql<{
      readonly row_id: number;
      readonly payload_json: string;
    }>`
      SELECT rowid AS row_id, COALESCE(bounded_json, payload_json) AS payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${lastRowId}
        AND item_id_digest IS NULL
      ORDER BY rowid ASC
      LIMIT ${BACKFILL_PAGE_SIZE}
    `;
    for (const row of rows) {
      let digest: string | null = null;
      try {
        const id = parseBoundedPayloadJson(row.payload_json).id;
        if (typeof id === "string") {
          digest = threadHistoryCursorItemTag(id);
        }
      } catch {
        digest = null;
      }
      if (digest !== null) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET item_id_digest = ${digest} WHERE rowid = ${row.row_id}`;
      }
      lastRowId = row.row_id;
    }
    if (rows.length < BACKFILL_PAGE_SIZE) break;
    yield* Effect.yieldNow;
  }

  yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_item_id_digest_idx ON orchestration_v2_projection_turn_items(thread_id, ordinal, item_id_digest)`;
});
