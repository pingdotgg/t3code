import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE VIRTUAL TABLE project_knowledge_fts_vocab USING fts5vocab(project_knowledge_fts, 'row')`;
  yield* sql`CREATE VIRTUAL TABLE project_knowledge_tokenizer USING fts3tokenize(unicode61)`;
  yield* sql`CREATE TABLE project_knowledge_recall_terms (project_id TEXT NOT NULL, term TEXT NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (project_id, term)) WITHOUT ROWID`;
  yield* sql`CREATE INDEX project_knowledge_recall_current ON project_knowledge_facts(project_id) WHERE status = 'saved' AND superseded_by_id IS NULL`;
  yield* sql`INSERT INTO project_knowledge_recall_terms
    SELECT f.project_id, t.token, count(DISTINCT f.rowid)
    FROM project_knowledge_facts f CROSS JOIN project_knowledge_tokenizer t
    WHERE f.status = 'saved' AND f.superseded_by_id IS NULL
      AND t.input = f.content || ' ' || f.entities_json || ' ' || f.tags_json
    GROUP BY f.project_id, t.token`;
  yield* sql`
    CREATE TRIGGER project_knowledge_recall_insert AFTER INSERT ON project_knowledge_facts
    WHEN new.status = 'saved' AND new.superseded_by_id IS NULL
    BEGIN
      INSERT INTO project_knowledge_recall_terms (project_id, term, doc)
      SELECT new.project_id, token, 1 FROM project_knowledge_tokenizer
      WHERE input = new.content || ' ' || new.entities_json || ' ' || new.tags_json
      GROUP BY token
      ON CONFLICT (project_id, term) DO UPDATE SET doc = doc + 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_recall_delete AFTER DELETE ON project_knowledge_facts
    WHEN old.status = 'saved' AND old.superseded_by_id IS NULL
    BEGIN
      UPDATE project_knowledge_recall_terms SET doc = doc - 1
      WHERE project_id = old.project_id AND term IN (
        SELECT token FROM project_knowledge_tokenizer
        WHERE input = old.content || ' ' || old.entities_json || ' ' || old.tags_json
      );
      DELETE FROM project_knowledge_recall_terms WHERE project_id = old.project_id AND doc = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_recall_update_old BEFORE UPDATE OF content, entities_json, tags_json, project_id, status, superseded_by_id ON project_knowledge_facts
    WHEN old.status = 'saved' AND old.superseded_by_id IS NULL
    BEGIN
      UPDATE project_knowledge_recall_terms SET doc = doc - 1
      WHERE project_id = old.project_id AND term IN (
        SELECT token FROM project_knowledge_tokenizer
        WHERE input = old.content || ' ' || old.entities_json || ' ' || old.tags_json
      );
      DELETE FROM project_knowledge_recall_terms WHERE project_id = old.project_id AND doc = 0;
    END
  `;
  yield* sql`
    CREATE TRIGGER project_knowledge_recall_update_new AFTER UPDATE OF content, entities_json, tags_json, project_id, status, superseded_by_id ON project_knowledge_facts
    WHEN new.status = 'saved' AND new.superseded_by_id IS NULL
    BEGIN
      INSERT INTO project_knowledge_recall_terms (project_id, term, doc)
      SELECT new.project_id, token, 1 FROM project_knowledge_tokenizer
      WHERE input = new.content || ' ' || new.entities_json || ' ' || new.tags_json
      GROUP BY token
      ON CONFLICT (project_id, term) DO UPDATE SET doc = doc + 1;
    END
  `;
});
