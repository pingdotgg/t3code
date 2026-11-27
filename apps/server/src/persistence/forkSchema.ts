import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// This fork merges upstream, whose migrator skips every id up to the highest recorded, so a
// fork-only numbered migration breaks startup on a later merge. Fork schema goes in here instead.
const THREAD_TAG_OBJECTS = [
  "orchestration_v2_projection_thread_tags",
  "orchestration_v2_projection_thread_tags_tag_idx",
  "orchestration_v2_projection_thread_tags_insert",
  "orchestration_v2_projection_thread_tags_update",
  "orchestration_v2_projection_thread_tags_delete",
];

export const hasForkSchema = Effect.fn("forkSchema.isCurrent")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const present = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE name IN ${sql.in(THREAD_TAG_OBJECTS)}
  `;
  return present.length === THREAD_TAG_OBJECTS.length;
});

/**
 * One row per tag a thread carries, so folder reads find a tag's threads by index instead of
 * scanning every payload's JSON. Triggers keep it exact on every write to the thread rows.
 */
export const ensureForkSchema = Effect.fn("forkSchema.ensure")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasForkSchema()) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS orchestration_v2_projection_thread_tags (
          thread_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (thread_id, tag)
        ) WITHOUT ROWID
      `;
      yield* sql`
        CREATE INDEX IF NOT EXISTS orchestration_v2_projection_thread_tags_tag_idx
        ON orchestration_v2_projection_thread_tags(tag, thread_id)
      `;
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_tags_insert
        AFTER INSERT ON orchestration_v2_projection_threads
        WHEN json_valid(new.payload_json)
        BEGIN
          INSERT OR IGNORE INTO orchestration_v2_projection_thread_tags (thread_id, tag)
          SELECT new.thread_id, value FROM json_each(new.payload_json, '$.tags') WHERE type = 'text';
        END
      `;
      // Most payload writes leave tags alone; the WHEN keeps those from rewriting the rows.
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_tags_update
        AFTER UPDATE OF payload_json ON orchestration_v2_projection_threads
        WHEN CASE WHEN json_valid(old.payload_json) THEN json_extract(old.payload_json, '$.tags') END
          IS NOT CASE WHEN json_valid(new.payload_json) THEN json_extract(new.payload_json, '$.tags') END
        BEGIN
          DELETE FROM orchestration_v2_projection_thread_tags WHERE thread_id = old.thread_id;
          INSERT OR IGNORE INTO orchestration_v2_projection_thread_tags (thread_id, tag)
          SELECT new.thread_id, value
          FROM json_each(CASE WHEN json_valid(new.payload_json) THEN new.payload_json ELSE '{}' END, '$.tags')
          WHERE type = 'text';
        END
      `;
      yield* sql`
        CREATE TRIGGER IF NOT EXISTS orchestration_v2_projection_thread_tags_delete
        AFTER DELETE ON orchestration_v2_projection_threads
        BEGIN
          DELETE FROM orchestration_v2_projection_thread_tags WHERE thread_id = old.thread_id;
        END
      `;
      // A missing trigger (an upstream table rebuild drops them) may have let rows drift.
      yield* sql`DELETE FROM orchestration_v2_projection_thread_tags`;
      yield* sql`
        INSERT OR IGNORE INTO orchestration_v2_projection_thread_tags (thread_id, tag)
        SELECT t.thread_id, tag.value
        FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.tags') tag
        WHERE json_valid(t.payload_json) AND tag.type = 'text'
      `;
    }),
  );
});
