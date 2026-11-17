import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Existing facts keep a NULL verdict: unchecked, and recallable exactly as before, so the recall
// term counts from migration 114 stay correct without a rebuild.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict TEXT
    CHECK (verdict IN ('standing', 'task', 'code'))`;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict_by TEXT
    CHECK (verdict_by IN ('check', 'person', 'agent'))`;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict_at TEXT`;
  yield* sql`ALTER TABLE project_knowledge_learning_queue ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_knowledge_learning_queue ADD COLUMN retry_at INTEGER`;

  // Recall's term statistics count exactly the facts recall may offer (`recallable` in
  // project/knowledge/persistence.ts), so set-aside facts never change term weights.
  for (const name of [
    "project_knowledge_recall_insert",
    "project_knowledge_recall_delete",
    "project_knowledge_recall_update_old",
    "project_knowledge_recall_update_new",
  ])
    yield* sql`DROP TRIGGER ${sql(name)}`;
  yield* sql`DROP INDEX project_knowledge_recall_current`;
  yield* sql`CREATE INDEX project_knowledge_recall_current ON project_knowledge_facts(project_id)
    WHERE status = 'saved' AND superseded_by_id IS NULL AND (verdict IS NULL OR verdict = 'standing')`;
  yield* sql`
    CREATE TRIGGER project_knowledge_recall_insert AFTER INSERT ON project_knowledge_facts
    WHEN new.status = 'saved' AND new.superseded_by_id IS NULL
      AND (new.verdict IS NULL OR new.verdict = 'standing')
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
      AND (old.verdict IS NULL OR old.verdict = 'standing')
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
    CREATE TRIGGER project_knowledge_recall_update_old BEFORE UPDATE OF content, entities_json, tags_json, project_id, status, superseded_by_id, verdict ON project_knowledge_facts
    WHEN old.status = 'saved' AND old.superseded_by_id IS NULL
      AND (old.verdict IS NULL OR old.verdict = 'standing')
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
    CREATE TRIGGER project_knowledge_recall_update_new AFTER UPDATE OF content, entities_json, tags_json, project_id, status, superseded_by_id, verdict ON project_knowledge_facts
    WHEN new.status = 'saved' AND new.superseded_by_id IS NULL
      AND (new.verdict IS NULL OR new.verdict = 'standing')
    BEGIN
      INSERT INTO project_knowledge_recall_terms (project_id, term, doc)
      SELECT new.project_id, token, 1 FROM project_knowledge_tokenizer
      WHERE input = new.content || ' ' || new.entities_json || ' ' || new.tags_json
      GROUP BY token
      ON CONFLICT (project_id, term) DO UPDATE SET doc = doc + 1;
    END
  `;
});
