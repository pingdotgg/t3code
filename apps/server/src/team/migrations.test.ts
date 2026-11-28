import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "@effect/vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runTeamMigrations, TEAM_MIGRATIONS } from "./migrations.ts";

describe("team sidecar migrations", () => {
  it.effect("creates all team_* tables independently without touching effect_sql_migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const upstreamBefore = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations
      `;

      const firstRun = yield* runTeamMigrations();
      expect(firstRun).toEqual(TEAM_MIGRATIONS.map((m) => [m.id, m.name]));

      // Idempotent second run executes nothing.
      const secondRun = yield* runTeamMigrations();
      expect(secondRun).toEqual([]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'team_%' ORDER BY name
      `;
      expect(tables.map((row) => row.name)).toEqual([
        "team_asset_revisions",
        "team_asset_tombstones",
        "team_automation_turn_scopes",
        "team_environments",
        "team_github_app_config",
        "team_github_automation_credentials",
        "team_github_member_credentials",
        "team_invites",
        "team_local_bindings",
        "team_local_sync_tokens",
        "team_local_sync_watermarks",
        "team_member_preferences",
        "team_members",
        "team_pairing_meta",
        "team_pending_remote_revocations",
        "team_preprompts",
        "team_project_meta",
        "team_provider_usage",
        "team_providers",
        "team_relay_binding",
        "team_scheduled_task_meta",
        "team_schema_migrations",
        "team_session_meta",
        "team_session_scope_ceilings",
        "team_skills",
        "team_thread_env_labels",
        "team_thread_follows",
        "team_thread_meta",
        "team_thread_notes",
        "team_thread_snoozes",
        "team_turn_meta",
        "team_views",
        "team_workspaces",
      ]);

      // Upstream migration ledger stays untouched and foreign keys remain intact.
      const upstreamAfter = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations
      `;
      expect(upstreamAfter[0]?.count).toBe(upstreamBefore[0]?.count);
      const fkViolations = yield* sql`PRAGMA foreign_key_check`;
      expect(fkViolations).toEqual([]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "serializes concurrent runTeamMigrations calls without UNIQUE constraint failures",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all([runTeamMigrations(), runTeamMigrations()], {
          concurrency: "unbounded",
        });
        const totalExecuted = first.length + second.length;
        expect(totalExecuted).toBe(TEAM_MIGRATIONS.length);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
