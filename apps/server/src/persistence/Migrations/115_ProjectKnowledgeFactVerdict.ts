import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Existing facts keep a NULL verdict: unchecked, and recallable exactly as before.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict TEXT
    CHECK (verdict IN ('standing', 'task', 'code'))`;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict_by TEXT
    CHECK (verdict_by IN ('check', 'person', 'agent'))`;
  yield* sql`ALTER TABLE project_knowledge_facts ADD COLUMN verdict_at TEXT`;
  yield* sql`ALTER TABLE project_knowledge_learning_queue ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE project_knowledge_learning_queue ADD COLUMN retry_at INTEGER`;
});
