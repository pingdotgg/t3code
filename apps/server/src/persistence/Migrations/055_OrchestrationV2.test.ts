import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 70 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
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
        [68, "PeerLinks"],
        [69, "PeerLinkFence"],
        [70, "WaitingLinkRequestIndex"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 49, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 50, name: "ProjectionThreadPullRequests" },
        { migration_id: 51, name: "ProjectionThreadMessageContext" },
        { migration_id: 52, name: "ProjectionThreadTitleState" },
        { migration_id: 53, name: "PullRequestFilesViewed" },
        { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 55, name: "OrchestrationV2" },
        { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 57, name: "ScheduledTaskWebhooks" },
        { migration_id: 58, name: "WebhookRelayDeliveries" },
        { migration_id: 59, name: "McpAppModelContext" },
        { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 61, name: "PullRequestReviewGuides" },
        { migration_id: 62, name: "ThreadFailureLookupIndex" },
        { migration_id: 63, name: "DropUnusedV1Projections" },
        { migration_id: 64, name: "CanonicalizeThreadPullRequestLinks" },
        { migration_id: 65, name: "CodexUsageNativeTurnIndex" },
        { migration_id: 66, name: "RepairClientSettlementTimestamps" },
        { migration_id: 67, name: "WebhookDedupe" },
        { migration_id: 68, name: "PeerLinks" },
        { migration_id: 69, name: "PeerLinkFence" },
        { migration_id: 70, name: "WaitingLinkRequestIndex" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});

it.effect("indexes batched Codex native turns without discarding duplicate candidates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 64 });
    for (const [id, driver, nativeId] of [
      ["match", "codex", "requested"],
      ["duplicate", "codex", "requested"],
      ["second", "codex", "requested-second"],
      ["other-provider", "claudeAgent", "requested"],
      ["unrelated", "codex", "unrelated"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: `attempt-${id}`,
        thread_id: `thread-${id}`,
        run_id: `run-${id}`,
        attempt_ordinal: 1,
        root_node_id: `node-${id}`,
        provider: driver,
        provider_thread_id: `provider-thread-${id}`,
        status: "completed",
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
        provider_turn_id: `turn-${id}`,
        thread_id: `thread-${id}`,
        provider_thread_id: `provider-thread-${id}`,
        node_id: `node-${id}`,
        run_attempt_id: `attempt-${id}`,
        ordinal: 1,
        status: "completed",
        payload_json: encodeJson({ nativeTurnRef: { driver, nativeId, strength: "strong" } }),
      })}`;
    }
    const lookup = sql<{ readonly provider_turn_id: string }>`
      SELECT turn.provider_turn_id
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${encodeJson(["requested", "requested-second", "missing"])})
        )
    `;
    const before = (yield* lookup).map((row) => row.provider_turn_id).toSorted();
    assert.deepStrictEqual(before, ["turn-duplicate", "turn-match", "turn-second"]);
    yield* runMigrations();
    assert.deepStrictEqual((yield* lookup).map((row) => row.provider_turn_id).toSorted(), before);

    const [statement, parameters] = lookup.compile();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
      parameters,
    );
    assert.isTrue(
      plan.some(({ detail }) =>
        /SEARCH turn USING INDEX orchestration_v2_provider_turns_codex_native_id_idx\b/.test(
          detail,
        ),
      ),
      plan.map(({ detail }) => detail).join("\n"),
    );
    assert.isFalse(plan.some(({ detail }) => /SCAN turn\b/.test(detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
