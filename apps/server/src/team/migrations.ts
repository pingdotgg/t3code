import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
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
  {
    id: 4,
    name: "TeamProjectsEnvironmentsAndNotes",
    up: Effect.fn("TeamMigrations.TeamProjectsEnvironmentsAndNotes")(function* (
      sql: SqlClient.SqlClient,
    ) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_project_meta (
            project_id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            default_view_id TEXT,
            repo_identity_key TEXT,
            assigned_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_project_meta_team_repo
            ON team_project_meta (team_id, repo_identity_key)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_environments (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            name TEXT NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            peer_link_id TEXT,
            access_roles_json TEXT NOT NULL,
            access_member_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_environments_team_env
            ON team_environments (team_id, environment_id)
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_environments_team_default
            ON team_environments (team_id)
            WHERE is_default = 1
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_thread_notes (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            author_member_id TEXT NOT NULL REFERENCES team_members(id),
            original_body TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            edited_body TEXT,
            edited_content_hash TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'consumed')),
            anchor_turn_id TEXT,
            anchor_seq INTEGER NOT NULL DEFAULT 0,
            included_in_turn_id TEXT,
            resolved_by_member_id TEXT REFERENCES team_members(id),
            resolved_at TEXT,
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_thread_notes_thread_order
            ON team_thread_notes (thread_id, anchor_seq, created_at)
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_thread_notes_team_thread_status
            ON team_thread_notes (team_id, thread_id, status)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_thread_env_labels (
            thread_id TEXT PRIMARY KEY,
            execution_environment_label TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_pending_remote_revocations (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            environment_id TEXT NOT NULL,
            subject_prefix TEXT NOT NULL,
            unlink_after_revoke INTEGER NOT NULL DEFAULT 0 CHECK (unlink_after_revoke IN (0, 1)),
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_pending_remote_revocations_unique
            ON team_pending_remote_revocations (team_id, environment_id, subject_prefix)
        `;
    }),
  },
  {
    id: 5,
    name: "TeamProvidersSkillsAndPreprompts",
    up: Effect.fn("TeamMigrations.TeamProvidersSkillsAndPreprompts")(function* (
      sql: SqlClient.SqlClient,
    ) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_providers (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            provider_instance_id TEXT NOT NULL,
            driver TEXT NOT NULL,
            display_name TEXT,
            delivery_strategy TEXT NOT NULL CHECK (delivery_strategy IN ('proxy', 'token-lease', 'remote-only')),
            upstream_base_url TEXT,
            api_key_header TEXT,
            api_key_prefix TEXT,
            secret_key TEXT,
            config_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            updated_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_providers_team_instance
            ON team_providers (team_id, provider_instance_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_provider_usage (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            provider_instance_id TEXT NOT NULL,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            strategy TEXT NOT NULL CHECK (strategy IN ('proxy', 'token-lease')),
            request_path TEXT,
            status_code INTEGER NOT NULL,
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_provider_usage_team_member
            ON team_provider_usage (team_id, member_id, provider_instance_id, created_at)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_skills (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            provider_driver TEXT NOT NULL,
            skill_md TEXT NOT NULL,
            references_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            revision INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            updated_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_team_skills_team_slug_driver
            ON team_skills (team_id, LOWER(slug), provider_driver)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_preprompts (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            provider_driver TEXT NOT NULL,
            injection_scope TEXT NOT NULL CHECK (injection_scope IN ('thread', 'turn')),
            content TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
            revision INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            updated_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_preprompts_team_driver
            ON team_preprompts (team_id, provider_driver, injection_scope)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_asset_revisions (
            team_id TEXT PRIMARY KEY REFERENCES team_workspaces(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_asset_tombstones (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            asset_kind TEXT NOT NULL CHECK (asset_kind IN ('skill', 'preprompt')),
            asset_id TEXT NOT NULL,
            deleted_at_revision INTEGER NOT NULL,
            deleted_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_asset_tombstones_team_rev
            ON team_asset_tombstones (team_id, deleted_at_revision)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_local_sync_tokens (
            token_hash TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            revoked_at TEXT,
            created_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_local_sync_tokens_member
            ON team_local_sync_tokens (member_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_local_bindings (
            team_id TEXT PRIMARY KEY,
            team_name TEXT NOT NULL,
            team_server_url TEXT NOT NULL,
            token_secret_key TEXT,
            providers_json TEXT NOT NULL,
            projects_json TEXT NOT NULL,
            skills_json TEXT NOT NULL DEFAULT '[]',
            preprompts_json TEXT NOT NULL DEFAULT '[]',
            assets_revision INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          )
        `;
    }),
  },
  {
    id: 6,
    name: "TeamUpstreamMobileCompat",
    up: Effect.fn("TeamMigrations.TeamUpstreamMobileCompat")(function* (sql: SqlClient.SqlClient) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_pairing_meta (
            pairing_link_id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            revoked_at TEXT
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_pairing_meta_member_id
            ON team_pairing_meta (member_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_member_preferences (
            member_id TEXT PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            upstream_client_thread_visibility TEXT NOT NULL DEFAULT 'owned_and_followed'
              CHECK (upstream_client_thread_visibility IN ('owned_and_followed', 'all_accessible')),
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_session_scope_ceilings (
            session_id TEXT PRIMARY KEY,
            max_scopes_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `;
    }),
  },
  {
    id: 7,
    name: "TeamGitHubIdentity",
    up: Effect.fn("TeamMigrations.TeamGitHubIdentity")(function* (sql: SqlClient.SqlClient) {
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_github_member_credentials (
            member_id TEXT PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
            team_id TEXT NOT NULL REFERENCES team_workspaces(id) ON DELETE CASCADE,
            auth_method TEXT NOT NULL CHECK (auth_method IN ('pat', 'oauth', 'github_app')),
            github_login TEXT NOT NULL,
            github_name TEXT,
            github_email TEXT,
            api_base_url TEXT NOT NULL,
            secret_key TEXT NOT NULL,
            connected_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
      yield* sql`
          CREATE INDEX IF NOT EXISTS idx_team_github_member_credentials_team
            ON team_github_member_credentials (team_id)
        `;
      yield* sql`
          CREATE TABLE IF NOT EXISTS team_github_automation_credentials (
            team_id TEXT PRIMARY KEY REFERENCES team_workspaces(id) ON DELETE CASCADE,
            auth_method TEXT NOT NULL CHECK (auth_method IN ('pat', 'oauth', 'github_app')),
            github_login TEXT NOT NULL,
            github_name TEXT,
            github_email TEXT,
            api_base_url TEXT NOT NULL,
            secret_key TEXT NOT NULL,
            updated_by_member_id TEXT NOT NULL REFERENCES team_members(id),
            connected_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
    }),
  },
];

const migrationLocks = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();

function getMigrationLock(sql: SqlClient.SqlClient): Semaphore.Semaphore {
  let lock = migrationLocks.get(sql);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    migrationLocks.set(sql, lock);
  }
  return lock;
}

/**
 * Runs independent `team_*` sidecar migrations tracked in `team_schema_migrations`.
 * Never touches upstream `effect_sql_migrations` or upstream tables.
 * Serialized per `SqlClient` so parallel layer startup (`TeamRepository` + `TeamAssetsRepository`) is race-free.
 */
export const runTeamMigrations = Effect.fn("TeamMigrations.run")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = getMigrationLock(sql);
  return yield* lock.withPermits(1)(
    Effect.gen(function* () {
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
        const didRun = yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly id: number }>`
              SELECT id FROM team_schema_migrations WHERE id = ${migration.id} LIMIT 1
            `;
            if (existing.length > 0) return false;
            yield* migration.up(sql);
            yield* sql`
              INSERT INTO team_schema_migrations (id, name, applied_at)
              VALUES (${migration.id}, ${migration.name}, ${appliedAt})
            `;
            return true;
          }),
        );
        if (didRun) {
          executed.push([migration.id, migration.name]);
        }
      }
      return executed;
    }),
  );
});
