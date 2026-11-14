import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createMessageSearchTriggers,
  rebuildMessageSearch,
} from "../../orchestration-v2/messageSearchIndex.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      CREATE TABLE orchestration_v2_message_projects (
        message_rowid INTEGER PRIMARY KEY,
        project_rowid INTEGER NOT NULL
      )
    `;
  yield* sql`CREATE INDEX orchestration_v2_message_projects_project_idx
      ON orchestration_v2_message_projects (project_rowid, message_rowid)`;
  yield* sql`
      CREATE TRIGGER orchestration_v2_message_projects_insert
      AFTER INSERT ON orchestration_v2_projection_messages
      BEGIN
        INSERT INTO orchestration_v2_message_projects (message_rowid, project_rowid)
        SELECT new.rowid, projects.rowid
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.thread_id = new.thread_id;
      END
    `;
  yield* sql`
      CREATE TRIGGER orchestration_v2_message_projects_update
      AFTER UPDATE OF thread_id ON orchestration_v2_projection_messages
      WHEN old.thread_id IS NOT new.thread_id
      BEGIN
        DELETE FROM orchestration_v2_message_projects WHERE message_rowid = old.rowid;
        INSERT INTO orchestration_v2_message_projects (message_rowid, project_rowid)
        SELECT new.rowid, projects.rowid
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.thread_id = new.thread_id;
      END
    `;
  yield* sql`
      CREATE TRIGGER orchestration_v2_message_projects_delete
      AFTER DELETE ON orchestration_v2_projection_messages
      BEGIN
        DELETE FROM orchestration_v2_message_projects WHERE message_rowid = old.rowid;
      END
    `;
  yield* sql`
      CREATE TRIGGER orchestration_v2_message_projects_move
      AFTER UPDATE OF project_id ON orchestration_v2_projection_threads
      WHEN old.project_id IS NOT new.project_id
      BEGIN
        DELETE FROM orchestration_v2_message_projects WHERE message_rowid IN (
          SELECT rowid FROM orchestration_v2_projection_messages WHERE thread_id = new.thread_id
        );
        INSERT INTO orchestration_v2_message_projects (message_rowid, project_rowid)
        SELECT messages.rowid, projects.rowid
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN projection_projects AS projects ON projects.project_id = new.project_id
        WHERE messages.thread_id = new.thread_id;
      END
    `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_projects_thread_insert
    AFTER INSERT ON orchestration_v2_projection_threads
    BEGIN
      INSERT OR REPLACE INTO orchestration_v2_message_projects (message_rowid, project_rowid)
      SELECT messages.rowid, projects.rowid
      FROM orchestration_v2_projection_messages AS messages
      INNER JOIN projection_projects AS projects ON projects.project_id = new.project_id
      WHERE messages.thread_id = new.thread_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_message_projects_project_insert
    AFTER INSERT ON projection_projects
    BEGIN
      INSERT OR REPLACE INTO orchestration_v2_message_projects (message_rowid, project_rowid)
      SELECT messages.rowid, new.rowid
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN orchestration_v2_projection_messages AS messages ON messages.thread_id = threads.thread_id
      WHERE threads.project_id = new.project_id;
    END
  `;
  const index =
    yield* sql`SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'`;
  if (index.length > 0) {
    yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
    yield* sql`DROP TABLE orchestration_v2_message_search`;
    yield* sql`
      CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(
        text, project,
        content = '',
        contentless_delete = 1,
        tokenize = 'trigram remove_diacritics 1'
      )
    `;
    yield* createMessageSearchTriggers(sql);
  }
  yield* rebuildMessageSearch(sql);
});
