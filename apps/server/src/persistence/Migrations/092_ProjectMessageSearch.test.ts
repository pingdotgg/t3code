import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { rebuildMessageSearch } from "../../orchestration-v2/messageSearchIndex.ts";
import { runMigrations } from "../Migrations.ts";

it.effect.each([true, false])(
  "maintains project message indexes across migration, parent writes, moves and rebuilds (FTS: %s)",
  (indexed) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`
      INSERT INTO projection_projects (rowid, project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (1, 'a', 'A', '/a', '[]', '2026-10-01', '2026-10-01'),
        (10, 'b', 'B', '/b', '[]', '2026-10-01', '2026-10-01')
    `;
      const thread = (id: string, projectId: string) => sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, ${projectId}, 'Notes', 'codex', 'full-access', 'default', '2026-10-01', '2026-10-01', '{}')
      `;
      yield* thread("t", "a");
      const insert = (id: string, threadId = "t") => sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, 'user', 0, '2026-10-01', '2026-10-01', '{"text":"Release checklist complete."}')
    `;
      yield* insert("before");
      if (!indexed) {
        yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
        yield* sql`DROP TABLE orchestration_v2_message_search`;
      }
      yield* runMigrations();
      yield* insert("after");
      const projects = () =>
        sql<{ readonly project_rowid: number }>`
      SELECT project_rowid FROM orchestration_v2_message_projects ORDER BY message_rowid
    `.pipe(Effect.map((rows) => rows.map((row) => row.project_rowid)));
      const hits = (project: number) => sql<{ readonly rowid: number }>`
      SELECT rowid FROM orchestration_v2_message_search
      WHERE orchestration_v2_message_search MATCH ${`text : "release" AND project : ":${project}:"`}
    `;
      yield* sql`UPDATE orchestration_v2_projection_messages
        SET payload_json = '{"text":"Release checklist complete. Updated notes."}'
        WHERE message_id = 'after'`;
      assert.deepEqual(yield* projects(), [1, 1]);
      if (indexed) assert.lengthOf(yield* hits(1), 2);
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = 'b' WHERE thread_id = 't'`;
      assert.deepEqual(yield* projects(), [10, 10]);
      if (indexed) {
        assert.lengthOf(yield* hits(1), 0);
        assert.lengthOf(yield* hits(10), 2);
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = 'missing' WHERE thread_id = 't'`;
      assert.deepEqual(yield* projects(), []);
      if (indexed) assert.lengthOf(yield* hits(10), 0);
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = 'b' WHERE thread_id = 't'`;
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'before'`;
      assert.deepEqual(yield* projects(), [10]);
      if (indexed) assert.lengthOf(yield* hits(10), 1);
      yield* sql`UPDATE projection_projects SET rowid = 20 WHERE project_id = 'b'`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET rowid = 30 WHERE message_id = 'after'`;
      yield* rebuildMessageSearch(sql);
      assert.deepEqual(yield* projects(), [20]);
      assert.deepEqual(yield* sql`SELECT message_rowid FROM orchestration_v2_message_projects`, [
        { message_rowid: 30 },
      ]);
      if (indexed) {
        assert.lengthOf(yield* hits(10), 0);
        assert.deepEqual(yield* hits(20), [{ rowid: 30 }]);
      }
      yield* insert("late-thread-message", "late-thread");
      yield* thread("late-thread", "a");
      yield* thread("late-project-thread", "c");
      yield* insert("late-project-message", "late-project-thread");
      yield* sql`
        INSERT INTO projection_projects (rowid, project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (30, 'c', 'C', '/c', '[]', '2026-10-01', '2026-10-01')
      `;
      assert.deepEqual(yield* projects(), [20, 1, 30]);
      if (indexed) {
        assert.lengthOf(yield* hits(1), 1);
        assert.lengthOf(yield* hits(30), 1);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
