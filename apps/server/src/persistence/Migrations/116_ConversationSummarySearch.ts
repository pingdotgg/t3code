import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Summaries use WITHOUT ROWID; FTS requires integer rowids.
  yield* sql`CREATE TABLE conversation_summary_search_ids (
    id INTEGER PRIMARY KEY, summary_id TEXT NOT NULL UNIQUE
  )`;
  yield* sql`CREATE VIRTUAL TABLE conversation_summary_fts USING fts5(text, tokenize = 'unicode61')`;
  yield* sql`CREATE VIRTUAL TABLE conversation_summary_tokenizer USING fts3tokenize(unicode61)`;
  yield* sql`CREATE VIRTUAL TABLE conversation_summary_terms
    USING fts5vocab(conversation_summary_fts, instance)`;
  yield* sql`INSERT INTO conversation_summary_search_ids (summary_id)
    SELECT summary_id FROM conversation_summaries`;
  yield* sql`INSERT INTO conversation_summary_fts (rowid, text)
    SELECT ids.id, (SELECT group_concat(json_extract(value, '$.text'), ' ')
      FROM json_each(summary.payload_json, '$.statements'))
    FROM conversation_summaries AS summary
    JOIN conversation_summary_search_ids AS ids USING (summary_id)
    WHERE coalesce(json_extract(summary.payload_json, '$.scrubbed'), 0) = 0
      AND coalesce(json_extract(summary.payload_json, '$.statements[0].text'), '')
        != '[Source unavailable: removed or changed.]'`;
  yield* sql`CREATE TRIGGER conversation_summary_search_insert AFTER INSERT ON conversation_summaries
    BEGIN
      INSERT INTO conversation_summary_search_ids (summary_id) VALUES (new.summary_id);
      INSERT INTO conversation_summary_fts (rowid, text)
        SELECT id, (SELECT group_concat(json_extract(value, '$.text'), ' ')
          FROM json_each(new.payload_json, '$.statements'))
        FROM conversation_summary_search_ids WHERE summary_id = new.summary_id
          AND coalesce(json_extract(new.payload_json, '$.scrubbed'), 0) = 0
          AND coalesce(json_extract(new.payload_json, '$.statements[0].text'), '')
            != '[Source unavailable: removed or changed.]';
    END`;
  yield* sql`CREATE TRIGGER conversation_summary_search_delete AFTER DELETE ON conversation_summaries
    BEGIN
      DELETE FROM conversation_summary_fts WHERE rowid = (
        SELECT id FROM conversation_summary_search_ids WHERE summary_id = old.summary_id
      );
      DELETE FROM conversation_summary_search_ids WHERE summary_id = old.summary_id;
    END`;
  yield* sql`CREATE TRIGGER conversation_summary_search_update AFTER UPDATE ON conversation_summaries
    BEGIN
      DELETE FROM conversation_summary_fts WHERE rowid = (
        SELECT id FROM conversation_summary_search_ids WHERE summary_id = old.summary_id
      );
      UPDATE conversation_summary_search_ids SET summary_id = new.summary_id
        WHERE summary_id = old.summary_id;
      INSERT INTO conversation_summary_fts (rowid, text)
        SELECT id, (SELECT group_concat(json_extract(value, '$.text'), ' ')
          FROM json_each(new.payload_json, '$.statements'))
        FROM conversation_summary_search_ids WHERE summary_id = new.summary_id
          AND coalesce(json_extract(new.payload_json, '$.scrubbed'), 0) = 0
          AND coalesce(json_extract(new.payload_json, '$.statements[0].text'), '')
            != '[Source unavailable: removed or changed.]';
    END`;
});
