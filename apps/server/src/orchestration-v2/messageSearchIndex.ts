import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The messages search indexes: finished, and either written by the user or
 * answered by an agent. User-role notices that agents or the system wrote
 * stay out. Subagent threads stay out too: search never shows them, and ACP
 * subagents rewrite their whole finished answer on every streamed chunk.
 * Migration 69's triggers, its backfill, the rebuild, and the scan all use
 * it; `row` names the message row (a table alias, or `new` in a trigger).
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`
  ${row}.streaming = 0
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(json_extract(${row}.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
  )
`);

/**
 * What the index stores for a message: its text with curly apostrophes
 * straight, as search folds a query, since iOS keyboards type "’" and others
 * type "'". Migration 69's triggers use it too. `payload` is the message's
 * JSON column.
 */
export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(`replace(replace(json_extract(${payload}, '$.text'), '’', ''''), '‘', '''')`);

/**
 * Refills the search index from the messages table. The index is keyed by
 * message rowid, so anything that may renumber or copy rows (VACUUM, a dev
 * database copy) rebuilds it instead of trusting it. Databases from before
 * migration 69, or on an SQLite without FTS5 trigrams, have no index.
 */
export const rebuildMessageSearch = Effect.fn("MessageSearchIndex.rebuild")(function* (
  sql: SqlClient.SqlClient,
) {
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;
  // One transaction: an interrupt between clear and refill would leave an
  // empty index that nothing repairs, since search only checks the table exists.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
        VALUES ('delete-all')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
        FROM orchestration_v2_projection_messages AS messages
        WHERE ${indexedMessageCondition(sql)}
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      `;
    }),
  );
});
