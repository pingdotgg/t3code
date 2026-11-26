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
        "team_environments",
        "team_invites",
        "team_members",
        "team_pending_remote_revocations",
        "team_project_meta",
        "team_relay_binding",
        "team_schema_migrations",
        "team_session_meta",
        "team_thread_env_labels",
        "team_thread_follows",
        "team_thread_meta",
        "team_thread_notes",
        "team_turn_meta",
        "team_views",
        "team_workspaces",
      ]);

      // Upstream migration ledger stays untouched.
      const upstreamAfter = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM effect_sql_migrations
      `;
      expect(upstreamAfter[0]?.count).toBe(upstreamBefore[0]?.count);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
