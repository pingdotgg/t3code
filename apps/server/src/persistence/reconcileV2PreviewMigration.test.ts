import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import PeerLinks from "./Migrations/070_PeerLinks.ts";

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
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "AuthConnectDevices"],
        [91, "AuthConnectDeniedRequests"],
        [92, "QueuedTurnInputIndexJsonValid"],
        [93, "ProviderTurnAttemptIndex"],
        [94, "TurnItemMessageOrdinalIndex"],
        [95, "TurnItemInlineWorkOutput"],
        [96, "RepairStaleTitleRegeneration"],
        [97, "IssueTrackerBindings"],
        [98, "ActiveShellIndexIndexes"],
        [99, "BackgroundRecoveryIndexes"],
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
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ActiveTurnItemIndexes"],
        [74, "ExcludeAttachmentPlaceholdersFromSearch"],
        [75, "SubagentDeliveryState"],
        [76, "ProjectionProjectsPinArchive"],
        [77, "RepairBooleanSettledOverride"],
        [78, "DropOrchestrationEventCorrelationIndex"],
        [79, "DelegatedRecoveryIndexes"],
        [80, "ScheduledTaskThreadMode"],
        [81, "ProjectionMessageSearchText"],
        [82, "TurnItemConversationIndex"],
        [83, "CommandReadIndexes"],
        [84, "LastExecutedRunIndex"],
        [85, "TurnItemCounts"],
        [86, "QueuedTurnInputIndex"],
        [87, "ProjectionProjectsCustomTitle"],
        [88, "TurnItemTypeStatusIndex"],
        [89, "ShellThreadReadIndexes"],
        [90, "AuthConnectDevices"],
        [91, "AuthConnectDeniedRequests"],
        [92, "QueuedTurnInputIndexJsonValid"],
        [93, "ProviderTurnAttemptIndex"],
        [94, "TurnItemMessageOrdinalIndex"],
        [95, "TurnItemInlineWorkOutput"],
        [96, "RepairStaleTitleRegeneration"],
        [97, "IssueTrackerBindings"],
        [98, "ActiveShellIndexIndexes"],
        [99, "BackgroundRecoveryIndexes"],
      ]);
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

// Conn recorded PeerLinks at 61-65, 68 and 69, ids upstream main gives to its own
// migrations; Conn keeps PeerLinks at 70 (see Migrations.ts).
const seedPeerLink = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
    VALUES ('peer', 'peer-secret', 'Peer', '[]', 'read-only', '2026-10-10', '2026-11-10')
  `;
});
const assertReconciled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* runMigrations(), []);
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  assert.deepStrictEqual(
    history.map((row) => [row.migration_id, row.name] as const),
    migrationManifest,
  );
  assert.deepStrictEqual(
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'pull_request_review_guides'`,
    [{ name: "pull_request_review_guides" }],
  );
  assert.deepStrictEqual(
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_failed_error_idx'`,
    [{ name: "orchestration_v2_projection_turn_items_failed_error_idx" }],
  );
  assert.deepStrictEqual(
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'scheduled_task_webhook_pending'`,
    [{ name: "scheduled_task_webhook_pending" }],
  );
  assert.deepStrictEqual(
    yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'`,
    [{ name: "orchestration_v2_projection_turn_items_stop_request_idx" }],
  );
  assert.strictEqual((yield* sql`SELECT * FROM peer_environment_links`).length, 1);
});
/** The released migrations after `id`, as `runMigrations` reports them; later upstream syncs add to it. */
const releasedAfter = (id: number) =>
  migrationManifest
    .filter(([entryId]) => entryId > id)
    .map(([entryId, name]): [number, string] => [entryId, name]);

describe("Conn PeerLinks upgrade", () => {
  it.effect("moves PeerLinks from 61 to 70 and runs the migrations it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "61_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 62 to 70 and runs the migrations it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 61 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "62_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [62, "ThreadFailureLookupIndex"],
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 63 to 70 and runs the migrations it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "63_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [63, "DropUnusedV1Projections"],
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 64 to 70 and runs the link canonicalization it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 63 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "64_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [64, "CanonicalizeThreadPullRequestLinks"],
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 65 to 70 and runs the migrations it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "65_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 68 to 70 and runs the shell stop index it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "68_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [68, "ShellStopRequestIndex"],
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect("moves PeerLinks from 69 to 70 and runs the message search index it displaced", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({ "69_PeerLinks": PeerLinks }),
      });
      yield* seedPeerLink;
      assert.deepStrictEqual(yield* runMigrations(), [
        [69, "ThreadMessageSearch"],
        ...releasedAfter(70),
      ]);
      yield* assertReconciled;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
