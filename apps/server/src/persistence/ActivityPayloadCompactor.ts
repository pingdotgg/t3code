import { NonNegativeInt } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ACTIVITY_PAYLOAD_BLOB_THRESHOLD_BYTES } from "./activityPayloadBlob.ts";

const COMPACTION_BATCH_SIZE = 8;

const LegacyPayloadRow = Schema.Struct({
  eventId: Schema.String,
  activityId: Schema.String,
  dataJson: Schema.String,
  sizeBytes: NonNegativeInt,
  sequence: NonNegativeInt,
  occurredAt: Schema.String,
});

export const compactLegacyActivityPayloadBatch = Effect.fn("compactLegacyActivityPayloadBatch")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const listRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: LegacyPayloadRow,
      execute: () =>
        sql`
        SELECT
          event_id AS "eventId",
          sequence,
          json_extract(payload_json, '$.activity.id') AS "activityId",
          json_quote(json_extract(payload_json, '$.activity.payload.data')) AS "dataJson",
          length(CAST(json_quote(json_extract(
            payload_json,
            '$.activity.payload.data'
          )) AS BLOB)) AS "sizeBytes",
          occurred_at AS "occurredAt"
        FROM orchestration_events
        WHERE event_type = 'thread.activity-appended'
          AND sequence > (
            SELECT last_sequence
            FROM activity_payload_compaction_state
            WHERE singleton = 1
          )
          AND json_extract(payload_json, '$.activity.kind') LIKE 'tool.%'
          AND json_type(payload_json, '$.activity.payload.data') IS NOT NULL
          AND length(CAST(json_quote(json_extract(
            payload_json,
            '$.activity.payload.data'
          )) AS BLOB)) >= ${ACTIVITY_PAYLOAD_BLOB_THRESHOLD_BYTES}
        ORDER BY sequence ASC
        LIMIT ${COMPACTION_BATCH_SIZE}
      `,
    });

    const rows = yield* listRows(undefined);
    if (rows.length === 0) return 0;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const row of rows) {
          yield* sql`
          INSERT INTO activity_payload_blobs (
            activity_id,
            data_json,
            size_bytes,
            created_at,
            updated_at
          )
          VALUES (
            ${row.activityId},
            ${row.dataJson},
            ${row.sizeBytes},
            ${row.occurredAt},
            ${row.occurredAt}
          )
          ON CONFLICT (activity_id) DO UPDATE SET
            data_json = excluded.data_json,
            size_bytes = excluded.size_bytes,
            updated_at = excluded.updated_at
        `;
        }
        yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_remove(payload_json, '$.activity.payload.data')
        WHERE event_id IN ${sql.in(rows.map((row) => row.eventId))}
      `;
        yield* sql`
        UPDATE projection_thread_activities
        SET payload_json = json_remove(payload_json, '$.data')
        WHERE activity_id IN ${sql.in(rows.map((row) => row.activityId))}
          AND json_type(payload_json, '$.data') IS NOT NULL
      `;
        yield* sql`
        UPDATE activity_payload_compaction_state
        SET last_sequence = ${rows[rows.length - 1]!.sequence}
        WHERE singleton = 1
      `;
      }),
    );

    return rows.length;
  },
);

export const compactLegacyActivityPayloads = Effect.gen(function* () {
  while (true) {
    const compacted = yield* compactLegacyActivityPayloadBatch();
    if (compacted === 0) {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE activity_payload_compaction_state
        SET last_sequence = COALESCE(
          (SELECT MAX(sequence) FROM orchestration_events),
          last_sequence
        )
        WHERE singleton = 1
      `;
      return;
    }
    yield* Effect.sleep("25 millis");
  }
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Activity payload compaction paused", { cause: String(cause) }),
  ),
);
