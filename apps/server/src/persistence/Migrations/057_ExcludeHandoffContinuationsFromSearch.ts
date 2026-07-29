import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A dispatched workspace-handoff continuation is a settled `user` message, so
 * the transcript FTS triggers from migration 048 indexed it like any other. The
 * chat UI hides that message because its text is fixed T3 boilerplate, which
 * left searching for the boilerplate as the one way to surface a turn the user
 * never wrote -- and, because the search picks one excerpt per thread, it could
 * stand in as the thread's user-authored excerpt.
 *
 * Recreate the triggers with the continuation excluded and drop any rows that
 * were already indexed. The marker is deliberately still not indexed: the
 * transcript search result schema only accepts `user`/`assistant` roles, so
 * indexing a system-role marker would fail to decode and break search for the
 * whole thread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER IF EXISTS projection_thread_message_fts_insert`;
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_message_fts_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_message_fts_delete`;

  yield* sql`
    CREATE TRIGGER projection_thread_message_fts_insert
    AFTER INSERT ON projection_thread_messages
    WHEN NEW.is_streaming = 0
      AND NEW.text <> ''
      AND NEW.role IN ('user', 'assistant')
      AND COALESCE(json_extract(NEW.origin_json, '$.kind'), '') <> 'workspace-handoff'
    BEGIN
      INSERT INTO projection_thread_message_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_message_fts_update
    AFTER UPDATE ON projection_thread_messages
    BEGIN
      INSERT INTO projection_thread_message_fts(projection_thread_message_fts, rowid, text)
      SELECT 'delete', OLD.rowid, OLD.text
      WHERE OLD.is_streaming = 0
        AND OLD.text <> ''
        AND OLD.role IN ('user', 'assistant')
        AND COALESCE(json_extract(OLD.origin_json, '$.kind'), '') <> 'workspace-handoff'
        AND (
          NEW.is_streaming <> 0
          OR NEW.text = ''
          OR NEW.role NOT IN ('user', 'assistant')
          OR COALESCE(json_extract(NEW.origin_json, '$.kind'), '') = 'workspace-handoff'
          OR NEW.text <> OLD.text
        );

      INSERT INTO projection_thread_message_fts(rowid, text)
      SELECT NEW.rowid, NEW.text
      WHERE NEW.is_streaming = 0
        AND NEW.text <> ''
        AND NEW.role IN ('user', 'assistant')
        AND COALESCE(json_extract(NEW.origin_json, '$.kind'), '') <> 'workspace-handoff'
        AND (
          OLD.is_streaming <> 0
          OR OLD.text = ''
          OR OLD.role NOT IN ('user', 'assistant')
          OR COALESCE(json_extract(OLD.origin_json, '$.kind'), '') = 'workspace-handoff'
          OR NEW.text <> OLD.text
        );
    END
  `;
  yield* sql`
    CREATE TRIGGER projection_thread_message_fts_delete
    AFTER DELETE ON projection_thread_messages
    WHEN OLD.is_streaming = 0
      AND OLD.text <> ''
      AND OLD.role IN ('user', 'assistant')
      AND COALESCE(json_extract(OLD.origin_json, '$.kind'), '') <> 'workspace-handoff'
    BEGIN
      INSERT INTO projection_thread_message_fts(projection_thread_message_fts, rowid, text)
      VALUES ('delete', OLD.rowid, OLD.text);
    END
  `;

  yield* sql`
    INSERT INTO projection_thread_message_fts(projection_thread_message_fts, rowid, text)
    SELECT 'delete', rowid, text
    FROM projection_thread_messages
    WHERE is_streaming = 0
      AND text <> ''
      AND role IN ('user', 'assistant')
      AND COALESCE(json_extract(origin_json, '$.kind'), '') = 'workspace-handoff'
  `;
});
