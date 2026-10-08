import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import ProjectionThreadIssues from "./Migrations/059_ProjectionThreadIssues.ts";
import WorkItemLinks from "./Migrations/060_WorkItemLinks.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

// The V2 schema is unchanged from the published September 15–16 previews.
const seedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2 }),
  });
  yield* sql`
    INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
    VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
  `;
  yield* sql`
    UPDATE effect_sql_migrations SET created_at = '2026-09-15 00:00:00' WHERE migration_id = 53
  `;
});

describe("V2 preview upgrade", () => {
  it.effect("upgrades a published preview without replaying V2 or losing import progress", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      const imports = yield* sql`SELECT * FROM orchestration_v2_legacy_imports`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "ProjectionThreadIssues"],
        [62, "WorkItemLinks"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_v2_legacy_imports`, imports);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 55`,
        [{ created_at: "2026-09-15 00:00:00" }],
      );
      yield* sql`
        INSERT INTO pull_request_files_viewed
          (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'owner/repo', 1, 'viewer', 'file.ts', 'revision', '2026-09-17')
      `;
      assert.strictEqual((yield* sql`SELECT * FROM pull_request_files_viewed`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades preview migration 54 with index cleanup %s",
    (withIndexes) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "53_PullRequestFilesViewed": PullRequestFilesViewed,
            "54_OrchestrationV2": OrchestrationV2,
            ...(withIndexes
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          history.map((row) => [row.migration_id, row.name] as const),
          migrationManifest,
        );
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back schema and ledger together on failure and can retry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`
        CREATE TRIGGER fail_preview_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'PullRequestFilesViewed'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53`,
        [{ migration_id: 53, name: "OrchestrationV2" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'`,
        [],
      );
      assert.strictEqual((yield* sql`SELECT * FROM orchestration_v2_legacy_imports`).length, 1);
      yield* sql`DROP TRIGGER fail_preview_upgrade`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [53, "PullRequestFilesViewed"],
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "ProjectionThreadIssues"],
        [62, "WorkItemLinks"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([59, 60])("upgrades main migration %s without losing MCP app context", (mainId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: mainId });
      yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-07')`;
      const context = yield* sql`SELECT * FROM mcp_app_model_context`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > mainId),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM mcp_app_model_context`, context);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${mainId} ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([57, 59, 60, 61])("upgrades issue migration %s without losing links", (issueId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: issueId - 1 });
      const baseHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          [`${issueId}_ProjectionThreadIssues`]: ProjectionThreadIssues,
          [`${issueId + 1}_WorkItemLinks`]: WorkItemLinks,
        }),
      });
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, created_at, updated_at, issue_links_json)
        VALUES ('thread', 'project', 'Thread', '2026-10-07', '2026-10-07', '[{"url":"https://github.com/a/b/issues/1"}]')`;
      const threads = yield* sql`SELECT * FROM projection_threads`;
      yield* sql`INSERT INTO work_item_links VALUES ('github', 'https://github.com/a/b/issues/1', 'a/b', 1, 'Issue', 'github', 'https://github.com/a/b/pull/2', 'a/b', 2, 'Fix')`;
      const links = yield* sql`SELECT * FROM work_item_links`;
      const issueHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
          'orchestration_v2_projection_turn_items_user_message_idx',
          'orchestration_v2_projection_nodes_live_idx'
        ) ORDER BY name`,
        [
          { name: "orchestration_v2_projection_nodes_live_idx" },
          { name: "orchestration_v2_projection_turn_items_user_message_idx" },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
      assert.deepStrictEqual(yield* sql`SELECT * FROM work_item_links`, links);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id < ${issueId} ORDER BY migration_id`,
        baseHistory,
      );
      if (issueId === 61) {
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          issueHistory,
        );
      }
      yield* sql`INSERT INTO mcp_app_model_context VALUES ('thread', 'item', 'server', 'tool', 'context', '2026-10-07')`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([59, 60])(
    "refuses unknown migrations after old issue migration %s without changing links",
    (issueId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: issueId - 1 });
        yield* ProjectionThreadIssues;
        yield* WorkItemLinks;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${issueId}, 'ProjectionThreadIssues'), (${issueId + 1}, 'UnknownFork')`;
        yield* sql`INSERT INTO work_item_links VALUES ('github', 'issue', 'a/b', 1, 'Issue', 'github', 'pr', 'a/b', 2, 'Fix')`;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const links = yield* sql`SELECT * FROM work_item_links`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM work_item_links`, links);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses unexpected later migrations without modifying their history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedPreview;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'UnknownFork')`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
