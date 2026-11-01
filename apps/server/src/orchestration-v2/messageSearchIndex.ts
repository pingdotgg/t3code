import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
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

// Curly apostrophes straight, as search folds a query, since iOS keyboards
// type "’" and others type "'".
const foldApostrophes = (text: string) => `replace(replace(${text}, '’', ''''), '‘', '''')`;

const readableText = (row: string) =>
  `COALESCE(${row}.search_text, json_extract(${row}.payload_json, '$.text'))`;

/**
 * What search_text holds for a message: its text as it reads, a quote's
 * percent-encoded link replaced by its words and comment. NULL when that is
 * the stored text, so most messages store nothing extra.
 */
export const readableSearchText = (text: string) => {
  const readable = assistantCitationsToPlainText(text);
  return readable === text ? null : readable;
};

/** A message's text as it reads, for thread search. */
export const messageSearchText = (sql: SqlClient.SqlClient) =>
  sql.literal(readableText("messages"));

/**
 * A message's stored text with apostrophes folded, what the index held before
 * migration 77. Migration 69's backfill uses it. `payload` is the message's
 * JSON column.
 */
export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(foldApostrophes(`json_extract(${payload}, '$.text')`));

// What the index stores: a message's readable text with apostrophes folded.
// Migrations 69 and 74 create the triggers before migration 77 adds
// search_text, and `t3 doctor` can rebuild a database that has not migrated,
// so those fall back to the stored text.
const indexedText = Effect.fn("MessageSearchIndex.indexedText")(function* (
  sql: SqlClient.SqlClient,
) {
  const column = yield* sql`
    SELECT 1 FROM pragma_table_info('orchestration_v2_projection_messages')
    WHERE name = 'search_text'
  `;
  return column.length > 0
    ? (row: string) => sql.literal(foldApostrophes(readableText(row)))
    : (row: string) => indexedMessageText(sql, `${row}.payload_json`);
});

export const createMessageSearchTriggers = Effect.fn("MessageSearchIndex.createTriggers")(
  function* (sql: SqlClient.SqlClient) {
    const text = yield* indexedText(sql);
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_insert
      AFTER INSERT ON orchestration_v2_projection_messages
      WHEN ${indexedMessageCondition(sql, "new")}
      BEGIN
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, ${text("new")}
        WHERE json_extract(new.payload_json, '$.text') IS NOT NULL;
      END
    `;
    // Streaming deltas rewrite the row many times a second; skip them until the
    // message settles. Upserts rewrite every column, so re-index only when what
    // the index stores changed; migration 77's backfill writes only search_text.
    // Deleting a rowid the index never held is a no-op.
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_update
      AFTER UPDATE ON orchestration_v2_projection_messages
      WHEN (old.streaming = 0 OR new.streaming = 0)
        AND (
          old.streaming IS NOT new.streaming
          OR old.role IS NOT new.role
          OR ${text("old")} IS NOT ${text("new")}
          OR json_extract(old.payload_json, '$.createdBy')
            IS NOT json_extract(new.payload_json, '$.createdBy')
        )
      BEGIN
        DELETE FROM orchestration_v2_message_search WHERE rowid = old.rowid AND old.streaming = 0;
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT new.rowid, ${text("new")}
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

/** Replaces the search triggers with their current definition, where the index exists. */
export const recreateMessageSearchTriggers = Effect.fn("MessageSearchIndex.recreateTriggers")(
  function* (sql: SqlClient.SqlClient) {
    const index = yield* sql`
      SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
    `;
    if (index.length === 0) return;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
    yield* createMessageSearchTriggers(sql);
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
  const text = yield* indexedText(sql);
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
        SELECT messages.rowid, ${text("messages")}
        FROM orchestration_v2_projection_messages AS messages
        WHERE ${indexedMessageCondition(sql)}
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      `;
    }),
  );
});
