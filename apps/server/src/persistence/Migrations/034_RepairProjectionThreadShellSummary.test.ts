import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_RepairProjectionThreadShellSummary", (it) => {
  it.effect("repairs legacy databases whose migration ids 23 and 24 were already used", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (23, 'ProjectionThreadsAssociatedWorktreeRef'),
          (24, 'ProjectionThreadsArchivedAt')
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          latest_turn_id,
          created_at,
          updated_at
        )
        VALUES (
          'thread-legacy',
          'project-1',
          'Legacy thread',
          'turn-1',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-legacy',
          'turn-1',
          'user',
          'Please repair this database',
          0,
          '2026-07-19T00:01:00.000Z',
          '2026-07-19T00:01:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-approval-requested',
          'thread-legacy',
          'turn-1',
          'approval',
          'approval.requested',
          'Command approval requested',
          '{"requestId":"approval-1","requestKind":"command"}',
          '2026-07-19T00:02:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES (
          'approval-1',
          'thread-legacy',
          'turn-1',
          'pending',
          NULL,
          '2026-07-19T00:02:00.000Z',
          NULL
        )
      `;

      const executedMigrations = yield* runMigrations();
      assert.deepStrictEqual(
        executedMigrations.map(([id, name]) => `${id}_${name}`),
        [
          "25_CleanupInvalidProjectionPendingApprovals",
          "26_CanonicalizeModelSelectionOptions",
          "27_ProviderSessionRuntimeInstanceId",
          "28_ProjectionThreadSessionInstanceId",
          "29_ProjectionThreadDetailOrderingIndexes",
          "30_ProjectionThreadShellArchiveIndexes",
          "31_AuthAuthorizationScopes",
          "32_AuthPairingProofKeyThumbprint",
          "34_RepairProjectionThreadShellSummary",
        ],
      );

      const projectionThreadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      for (const expectedColumn of [
        "latest_user_message_at",
        "pending_approval_count",
        "pending_user_input_count",
        "has_actionable_proposed_plan",
      ]) {
        assert.isTrue(
          projectionThreadColumns.some((column) => column.name === expectedColumn),
          `expected projection_threads.${expectedColumn}`,
        );
      }

      const threadRows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
      assert.deepStrictEqual(threadRows, [
        {
          latestUserMessageAt: "2026-07-19T00:01:00.000Z",
          pendingApprovalCount: 1,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
        },
      ]);

      const migrationRows = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id IN (23, 24, 34)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrationRows, [
        {
          migrationId: 23,
          name: "ProjectionThreadsAssociatedWorktreeRef",
        },
        {
          migrationId: 24,
          name: "ProjectionThreadsArchivedAt",
        },
        {
          migrationId: 34,
          name: "RepairProjectionThreadShellSummary",
        },
      ]);
    }),
  );
});
