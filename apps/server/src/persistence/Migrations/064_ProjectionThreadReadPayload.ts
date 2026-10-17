import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import ProjectionThreadSweepIndexes from "./063_ProjectionThreadSweepIndexes.ts";

import {
  compactThreadPullRequests,
  encodeThreadReadPayload,
} from "../../orchestration-v2/ThreadReadPayload.ts";

// Startup also ensures this table when another build recorded migration 64 or above.
// Triggers invalidate read rows when a build that does not maintain them writes a thread.
const ensureInTransaction = (sql: SqlClient.SqlClient, rebuild: boolean) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('orchestration_v2_projection_thread_reads')
    `;
    const current = columns.some((column) => column.name === "source_stale");
    if (current && rebuild) {
      yield* sql`DELETE FROM orchestration_v2_projection_thread_reads`;
    } else if (!current) {
      // Early builds lacked source_stale; the derived rows can be rebuilt.
      yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_thread_reads`;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_thread_reads (
          thread_id TEXT PRIMARY KEY NOT NULL,
          source_stale INTEGER NOT NULL DEFAULT 0,
          compact_payload_json TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
    }
    if (!current || rebuild) {
      const decode = Schema.decodeUnknownEffect(
        Schema.fromJsonString(OrchestrationV2AppThreadJson),
      );
      let after = "";
      while (true) {
        const rows = yield* sql<{ thread_id: string; payload_json: string }>`
          SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id > ${after} ORDER BY thread_id LIMIT 100
        `;
        if (rows.length === 0) break;
        for (const row of rows) {
          // A payload this build cannot decode keeps no read row; readers use the thread payload.
          const encoded = yield* decode(row.payload_json).pipe(
            Effect.flatMap((thread) =>
              Effect.all([
                encodeThreadReadPayload(thread),
                encodeThreadReadPayload(compactThreadPullRequests(thread)),
              ]),
            ),
            Effect.option,
          );
          if (Option.isNone(encoded)) continue;
          const [payload, compact] = encoded.value;
          yield* sql`
            INSERT INTO orchestration_v2_projection_thread_reads (thread_id, payload_json, compact_payload_json)
            VALUES (${row.thread_id}, ${payload}, ${compact})
          `;
        }
        after = rows[rows.length - 1]!.thread_id;
      }
    }
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_reads_stale_on_insert
      AFTER INSERT ON orchestration_v2_projection_threads
      BEGIN
        UPDATE orchestration_v2_projection_thread_reads SET source_stale = 1
        WHERE thread_id = NEW.thread_id;
      END
    `;
    yield* sql`
      CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_reads_stale_on_update
      AFTER UPDATE OF payload_json ON orchestration_v2_projection_threads
      BEGIN
        UPDATE orchestration_v2_projection_thread_reads SET source_stale = 1
        WHERE thread_id = NEW.thread_id;
      END
    `;
  });

const ensureThreadReadProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(ensureInTransaction(sql, false));
});

export default ensureThreadReadProjection;

/**
 * Migration 64 itself rebuilds every row. Early builds of this change ran it as 62 or 63 and wrote
 * compact rows in an older format that the triggers never mark stale.
 */
export const migrateThreadReadProjection = Effect.gen(function* () {
  // An old wave-2 ledger at 63 skipped the sweep migration on upgrade.
  yield* ProjectionThreadSweepIndexes;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(ensureInTransaction(sql, true));
});
