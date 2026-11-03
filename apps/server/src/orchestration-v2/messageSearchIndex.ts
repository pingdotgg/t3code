import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// SQLite's ltrim needs the characters matched by isAttachmentOnlyBootstrapPrompt's \s explicitly.
const BOOTSTRAP_PREFIX_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const nonPlaceholderMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`
  CASE
    WHEN substr(json_extract(${row}.payload_json, '$.text'), 1, 11) = 'Ultrathink:' COLLATE NOCASE
      THEN ltrim(substr(json_extract(${row}.payload_json, '$.text'), 12), '${BOOTSTRAP_PREFIX_WHITESPACE}')
    ELSE json_extract(${row}.payload_json, '$.text')
  END COLLATE BINARY <> '${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.replaceAll("'", "''")}'
`);

/**
 * Exclude attachment placeholders, generated notices and subagent threads. ACP subagents
 * rewrite their finished answer on every streamed chunk.
 * Migration triggers, backfill, rebuild and scans share this predicate; `row` may be `new`.
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql`
  ${sql.literal(`
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
`)}
  AND ${nonPlaceholderMessageCondition(sql, row)}
`;

/**
 * What the index stores for a message: its text with curly apostrophes
 * straight, as search folds a query, since iOS keyboards type "’" and others
 * type "'". Migration 69's triggers use it too. `payload` is the message's
 * JSON column.
 */
export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(`replace(replace(json_extract(${payload}, '$.text'), '’', ''''), '‘', '''')`);

export const createMessageSearchTriggers = Effect.fn("MessageSearchIndex.createTriggers")(
  function* (sql: SqlClient.SqlClient) {
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
  },
);

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
