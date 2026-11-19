import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_knowledge_fact_history_curated (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      event TEXT NOT NULL CHECK (event IN (
        'baseline', 'created', 'edited', 'confirmed', 'forgotten', 'feedback', 'superseded',
        'curated', 'restored'
      )),
      actor_json TEXT NOT NULL,
      content_digest TEXT,
      content TEXT,
      sources_json TEXT NOT NULL,
      trust_before REAL,
      trust_after REAL NOT NULL,
      helpful INTEGER,
      related_fact_id TEXT,
      created_at TEXT NOT NULL,
      reason TEXT,
      reviewed_fact_ids_json TEXT NOT NULL DEFAULT '[]'
    )
  `;
  yield* sql`
    INSERT INTO project_knowledge_fact_history_curated (
      sequence, project_id, fact_id, revision, event, actor_json, content_digest, content,
      sources_json, trust_before, trust_after, helpful, related_fact_id, created_at
    ) SELECT sequence, project_id, fact_id, revision, event, actor_json, content_digest, content,
      sources_json, trust_before, trust_after, helpful, related_fact_id, created_at
    FROM project_knowledge_fact_history
  `;
  yield* sql`DROP TABLE project_knowledge_fact_history`;
  yield* sql`ALTER TABLE project_knowledge_fact_history_curated RENAME TO project_knowledge_fact_history`;
  yield* sql`CREATE INDEX project_knowledge_fact_history_fact ON project_knowledge_fact_history(project_id, fact_id, sequence)`;
  yield* sql`CREATE INDEX project_knowledge_fact_history_feedback ON project_knowledge_fact_history(project_id, event)`;
  yield* sql`
    CREATE TABLE project_knowledge_curation_state (
      project_id TEXT PRIMARY KEY NOT NULL,
      cursor TEXT,
      next_due_at INTEGER NOT NULL,
      last_started_at INTEGER NOT NULL,
      last_completed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'ran', 'skipped', 'failed')),
      reason TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed >= 0),
      changed INTEGER NOT NULL DEFAULT 0 CHECK (changed >= 0),
      skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_knowledge_curation_due ON project_knowledge_curation_state(next_due_at, project_id)`;
});
