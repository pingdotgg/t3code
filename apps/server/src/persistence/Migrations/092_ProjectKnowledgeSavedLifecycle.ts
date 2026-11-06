import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE project_knowledge_facts SET supersedes_id = NULL
    WHERE supersedes_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_knowledge_facts AS target
      WHERE target.id = project_knowledge_facts.supersedes_id
        AND target.project_id = project_knowledge_facts.project_id
        AND target.superseded_by_id = project_knowledge_facts.id
    )
  `;
  yield* sql`
    CREATE TABLE project_knowledge_facts_saved (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('saved', 'forgotten')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      content TEXT,
      entities_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      trust REAL NOT NULL CHECK (trust >= 0 AND trust <= 1),
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      sources_json TEXT NOT NULL,
      origin_json TEXT NOT NULL,
      supersedes_id TEXT,
      superseded_by_id TEXT,
      CHECK (status != 'forgotten' OR
        (content IS NULL AND entities_json = '[]' AND tags_json = '[]' AND sources_json = '[]'))
    )
  `;
  yield* sql`
    INSERT INTO project_knowledge_facts_saved (
      rowid, id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
      retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json,
      supersedes_id, superseded_by_id
    )
    SELECT rowid, id, project_id,
      CASE status WHEN 'forgotten' THEN 'forgotten' ELSE 'saved' END,
      revision, content, entities_json, tags_json, kind, trust,
      retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json,
      supersedes_id, superseded_by_id
    FROM project_knowledge_facts
  `;
  yield* sql`DROP TABLE project_knowledge_facts`;
  yield* sql`ALTER TABLE project_knowledge_facts_saved RENAME TO project_knowledge_facts`;
  yield* sql`CREATE INDEX project_knowledge_facts_project ON project_knowledge_facts(project_id, status, id)`;
  yield* sql`
    CREATE TRIGGER project_knowledge_insert AFTER INSERT ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(rowid, content, entities_json, tags_json)
      VALUES (new.rowid, new.content, new.entities_json, new.tags_json);
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_delete AFTER DELETE ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, content, entities_json, tags_json)
      VALUES ('delete', old.rowid, old.content, old.entities_json, old.tags_json);
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_update AFTER UPDATE OF content, entities_json, tags_json ON project_knowledge_facts BEGIN
      INSERT INTO project_knowledge_fts(project_knowledge_fts, rowid, content, entities_json, tags_json)
      VALUES ('delete', old.rowid, old.content, old.entities_json, old.tags_json);
      INSERT INTO project_knowledge_fts(rowid, content, entities_json, tags_json)
      VALUES (new.rowid, new.content, new.entities_json, new.tags_json);
    END
  `;
  yield* sql`INSERT INTO project_knowledge_fts(project_knowledge_fts) VALUES ('rebuild')`;
  yield* sql`ALTER TABLE project_knowledge_assisted_runs RENAME COLUMN proposed TO saved`;
  yield* sql`ALTER TABLE project_knowledge_assisted_runs DROP COLUMN suggested`;
});
