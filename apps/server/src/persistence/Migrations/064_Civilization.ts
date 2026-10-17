import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Civilization is authoritative in the host database, but deliberately has
  // no foreign keys into projection tables: core projection rebuild deletes and
  // repopulates those rows while feature identity must survive unchanged.
  yield* sql`
    CREATE TABLE civilization_environment_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      override_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO civilization_environment_config (singleton, revision, override_json, updated_at)
    VALUES (1, 0, NULL, datetime('now'))
  `;

  yield* sql`
    CREATE TABLE civilization_project_config (
      project_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      override_json TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE civilization_citizens (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT,
      relationship_to_parent TEXT CHECK (relationship_to_parent IS NULL OR relationship_to_parent IN ('fork', 'subagent')),
      root_thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      lineage_status TEXT NOT NULL CHECK (lineage_status IN ('resolved', 'missing', 'cycle', 'cross_project', 'depth_limit')),
      observed_only INTEGER NOT NULL CHECK (observed_only IN (0, 1)),
      birth_sequence INTEGER NOT NULL CHECK (birth_sequence >= 0),
      last_applied_sequence INTEGER NOT NULL CHECK (last_applied_sequence >= 0),

      name_entry_id TEXT NOT NULL,
      name_generator_version INTEGER NOT NULL CHECK (name_generator_version >= 1),
      name_base TEXT NOT NULL,
      name_display TEXT NOT NULL,
      name_key TEXT NOT NULL,
      name_pool_id TEXT NOT NULL,
      name_environment_revision INTEGER NOT NULL,
      name_project_revision INTEGER NOT NULL,

      profile_entry_id TEXT NOT NULL,
      profile_label TEXT NOT NULL,
      profile_traits_json TEXT NOT NULL,
      profile_style_text TEXT NOT NULL,
      profile_pool_id TEXT NOT NULL,
      profile_environment_revision INTEGER NOT NULL,
      profile_project_revision INTEGER NOT NULL,

      title_managed INTEGER NOT NULL CHECK (title_managed IN (0, 1)),
      preserved_title TEXT,
      last_managed_title TEXT,
      title_topic TEXT NOT NULL,
      pending_title_command_id TEXT,
      pending_managed_title TEXT,
      pending_title_topic TEXT,

      epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
      deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      UNIQUE (project_id, name_key)
    )
  `;

  yield* sql`
    CREATE INDEX civilization_citizens_project_thread_idx
    ON civilization_citizens(project_id, thread_id)
  `;

  yield* sql`
    CREATE INDEX civilization_citizens_project_closed_idx
    ON civilization_citizens(project_id, closed, deleted, thread_id)
  `;

  // Packet construction repeatedly needs project-local visibility/lifecycle
  // counts and the first bounded roster page. Keep those reads index-covered
  // instead of revisiting every citizen row in a large project.
  yield* sql`
    CREATE INDEX civilization_citizens_project_packet_idx
    ON civilization_citizens(project_id, deleted, observed_only, name_key, thread_id, closed)
  `;

  yield* sql`
    CREATE INDEX civilization_citizens_watermark_idx
    ON civilization_citizens(last_applied_sequence, thread_id)
  `;
});
