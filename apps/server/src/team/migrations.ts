import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export interface TeamMigration {
  readonly id: number;
  readonly name: string;
  readonly up: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>;
}

export const TEAM_MIGRATIONS: ReadonlyArray<TeamMigration> = [
  {
    id: 1,
    name: "TeamFoundation",
    up: Effect.fn("TeamMigrations.TeamFoundation")(function* (sql: SqlClient.SqlClient) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_workspaces (
            id TEXT PRIMARY KEY,
            singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK (singleton = 1),
            name TEXT NOT NULL,
            default_view_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_members (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            pseudo TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            github_login TEXT,
            github_name TEXT,
            github_email TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_pseudo_lower
            ON team_members (team_id, LOWER(pseudo))
            WHERE status != 'removed'
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_invites (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL,
            prefilled_pseudo TEXT,
            max_uses INTEGER NOT NULL,
            uses INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT NOT NULL,
            created_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            revoked_at TEXT,
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_session_meta (
            session_id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            bound_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_session_meta_member_id
            ON team_session_meta (member_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_thread_meta (
            thread_id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            creator_member_id TEXT NOT NULL REFERENCES team_members(id),
            view_id TEXT NOT NULL,
            locked INTEGER NOT NULL DEFAULT 0,
            locked_by_member_id TEXT,
            execution_environment_id TEXT,
            is_local_synced INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_thread_meta_team_creator
            ON team_thread_meta (team_id, creator_member_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_turn_meta (
            turn_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            author_member_id TEXT NOT NULL REFERENCES team_members(id),
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_turn_meta_thread_id
            ON team_turn_meta (thread_id)
        `;
    }),
  },
  {
    id: 2,
    name: "TeamThreadFollows",
    up: Effect.fn("TeamMigrations.TeamThreadFollows")(function* (sql: SqlClient.SqlClient) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_thread_follows (
            thread_id TEXT NOT NULL,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (thread_id, member_id)
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_thread_follows_member_id
            ON team_thread_follows (member_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_relay_binding (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            cloud_user_id TEXT,
            bound_at TEXT NOT NULL
          )
        `;
    }),
  },
  {
    id: 3,
    name: "TeamViewsAndLocking",
    up: Effect.fn("TeamMigrations.TeamViewsAndLocking")(function* (sql: SqlClient.SqlClient) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_views (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            read_roles_json TEXT NOT NULL,
            read_member_ids_json TEXT NOT NULL,
            post_roles_json TEXT NOT NULL,
            post_member_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_views_team_default
            ON team_views (team_id)
            WHERE is_default = 1
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_views_team_name_lower
            ON team_views (team_id, LOWER(name))
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_thread_meta_team_view
            ON team_thread_meta (team_id, view_id)
        `;
      // Backfill the built-in Default View for workspaces initialized before Milestone 3.
      yield* sql`
          INSERT OR IGNORE INTO team_views (
            id, team_id, name, description, is_default,
            read_roles_json, read_member_ids_json,
            post_roles_json, post_member_ids_json,
            created_at, updated_at
          )
          SELECT
            default_view_id,
            id,
            'Default',
            NULL,
            1,
            '["owner","admin","modo","regular"]',
            '[]',
            '["owner","admin","modo","regular"]',
            '[]',
            created_at,
            updated_at
          FROM team_workspaces
        `;
    }),
  },
];

/**
 * Runs independent `team_*` sidecar migrations tracked in `team_schema_migrations`.
 * Never touches upstream `effect_sql_migrations` or upstream tables.
 */
export const runTeamMigrations = Effect.fn("TeamMigrations.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `;
  const applied = yield* sql<{ readonly id: number }>`
    SELECT id FROM team_schema_migrations
  `;
  const appliedIds = new Set(applied.map((row) => row.id));
  const executed: Array<readonly [number, string]> = [];

  for (const migration of TEAM_MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;
    const appliedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* migration.up(sql);
        yield* sql`
          INSERT INTO team_schema_migrations (id, name, applied_at)
          VALUES (${migration.id}, ${migration.name}, ${appliedAt})
        `;
      }),
    );
    executed.push([migration.id, migration.name]);
  }
  return executed;
});
