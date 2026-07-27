import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_thread_message_fts
    USING fts5(
      text,
      content = 'projection_thread_messages',
      content_rowid = 'rowid',
      tokenize = 'trigram case_sensitive 0'
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_message_fts_insert
    AFTER INSERT ON projection_thread_messages
    WHEN NEW.is_streaming = 0
      AND NEW.text <> ''
      AND NEW.role IN ('user', 'assistant')
    BEGIN
      INSERT INTO projection_thread_message_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_message_fts_update
    AFTER UPDATE ON projection_thread_messages
    BEGIN
      INSERT INTO projection_thread_message_fts(projection_thread_message_fts, rowid, text)
      SELECT 'delete', OLD.rowid, OLD.text
      WHERE OLD.is_streaming = 0
        AND OLD.text <> ''
        AND OLD.role IN ('user', 'assistant')
        AND (
          NEW.is_streaming <> 0
          OR NEW.text = ''
          OR NEW.role NOT IN ('user', 'assistant')
          OR NEW.text <> OLD.text
        );

      INSERT INTO projection_thread_message_fts(rowid, text)
      SELECT NEW.rowid, NEW.text
      WHERE NEW.is_streaming = 0
        AND NEW.text <> ''
        AND NEW.role IN ('user', 'assistant')
        AND (
          OLD.is_streaming <> 0
          OR OLD.text = ''
          OR OLD.role NOT IN ('user', 'assistant')
          OR NEW.text <> OLD.text
        );
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_thread_message_fts_delete
    AFTER DELETE ON projection_thread_messages
    WHEN OLD.is_streaming = 0
      AND OLD.text <> ''
      AND OLD.role IN ('user', 'assistant')
    BEGIN
      INSERT INTO projection_thread_message_fts(projection_thread_message_fts, rowid, text)
      VALUES ('delete', OLD.rowid, OLD.text);
    END
  `;
  yield* sql`
    INSERT INTO projection_thread_message_fts(rowid, text)
    SELECT rowid, text
    FROM projection_thread_messages
    WHERE is_streaming = 0
      AND text <> ''
      AND role IN ('user', 'assistant')
  `;
});
