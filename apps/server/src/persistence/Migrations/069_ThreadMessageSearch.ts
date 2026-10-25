import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import {
  indexedMessageCondition,
  indexedMessageText,
} from "../../orchestration-v2/messageSearchIndex.ts";

/**
 * Trigrams match 3+ character substrings without a scan, ignoring case and accents.
 * Generated user-role notices would flood results and appear as "You".
 * VACUUM can change rowids, so `t3 doctor` must rebuild this contentless index afterward.
 * Index only finished messages, folding apostrophes as queries do; scan if the index is missing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older system SQLite builds may lack these FTS5 options; search can scan messages instead.
  // Only SQLITE_ERROR signals unsupported options. Disk and I/O failures must fail the migration
  // so the next startup retries creating the index.
  const created = yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning(
          "Message search index unavailable; search will scan messages.",
          cause,
        ).pipe(Effect.as(false)),
    ),
  );
  if (!created) return;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_insert
    AFTER INSERT ON orchestration_v2_projection_messages
    WHEN ${indexedMessageCondition(sql, "new")}
    BEGIN
      INSERT INTO orchestration_v2_message_search (rowid, text)
      SELECT new.rowid, ${indexedMessageText(sql, "new.payload_json")}
      WHERE json_extract(new.payload_json, '$.text') IS NOT NULL;
    END
  `;
  // Streaming deltas rewrite the row many times a second; skip them until the
  // message settles. Upserts rewrite every column, so a finished message
  // re-indexes only when what the index reads changed. Deleting a rowid the
  // index never held is a no-op.
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_update
    AFTER UPDATE OF payload_json, streaming, role ON orchestration_v2_projection_messages
    WHEN (old.streaming = 0 OR new.streaming = 0)
      AND (
        old.streaming IS NOT new.streaming
        OR old.role IS NOT new.role
        OR json_extract(old.payload_json, '$.text') IS NOT json_extract(new.payload_json, '$.text')
        OR json_extract(old.payload_json, '$.createdBy')
          IS NOT json_extract(new.payload_json, '$.createdBy')
      )
    BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid AND old.streaming = 0;
      INSERT INTO orchestration_v2_message_search (rowid, text)
      SELECT new.rowid, ${indexedMessageText(sql, "new.payload_json")}
      WHERE ${indexedMessageCondition(sql, "new")}
        AND json_extract(new.payload_json, '$.text') IS NOT NULL;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_search_delete
    AFTER DELETE ON orchestration_v2_projection_messages
    WHEN old.streaming = 0
    BEGIN
      DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid;
    END
  `;
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
    FROM orchestration_v2_projection_messages AS messages
    WHERE ${indexedMessageCondition(sql)}
      AND json_extract(messages.payload_json, '$.text') IS NOT NULL
  `;
});
