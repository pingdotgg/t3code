import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// Previews used V2 ids 53/54; preserve their schema and import progress while reserving main's ids.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      const legacy = history.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
      );
      if (!legacy) return [];
      const valid = history.every(
        (row) =>
          row === legacy ||
          (legacy.migration_id === 54 &&
            ((row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
              (row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
      );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (legacy.migration_id === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (legacy.migration_id === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});

const PEER_LINKS_PREVIEW_HISTORY = [
  [68, "PeerLinks"],
  [69, "PeerLinkFence"],
  [70, "WaitingLinkRequestIndex"],
] as const;

// v0.1.2 previews recorded peer links as 68-70 before main took 68/69. Forget that history so
// main's 68+ run and later peer link migrations can recreate the schema. Stored links block this
// so they are never dropped silently; unlinking them in the preview build clears the way.
export const reconcilePeerLinksPreviewMigrations = Effect.fn("reconcilePeerLinksPreviewMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return;
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 68 ORDER BY migration_id
      `;
        const isPreviewHistory =
          history.length === PEER_LINKS_PREVIEW_HISTORY.length &&
          history.every(
            (row, index) =>
              row.migration_id === PEER_LINKS_PREVIEW_HISTORY[index]?.[0] &&
              row.name === PEER_LINKS_PREVIEW_HISTORY[index]?.[1],
          );
        if (!isPreviewHistory) return;
        const links = yield* sql`SELECT 1 FROM peer_environment_links LIMIT 1`;
        if (links.length > 0) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "This database was migrated by a v0.1.2 preview build and still has peer environment links, which this build cannot keep. Start the preview build, unlink every linked environment, then start this build again.",
          });
        }
        yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx`;
        yield* sql`DROP TABLE peer_environment_links`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 68`;
        yield* Effect.log("Removed empty peer links schema left by a preview build");
      }),
    );
  },
);
