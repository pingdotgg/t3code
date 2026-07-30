import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("024_BackfillProjectionThreadShellSummary", (it) => {
  it.effect("backfills thread shell summary fields and clears stale projected approvals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 23 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required',
          'plan',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-user-1',
          'thread-1',
          'turn-1',
          'user',
          'Need help',
          NULL,
          0,
          '2026-02-24T00:01:00.000Z',
          '2026-02-24T00:01:00.000Z'
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
          sequence,
          created_at
        )
        VALUES
          (
            'activity-approval-requested',
            'thread-1',
            'turn-1',
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-1","requestKind":"command"}',
            NULL,
            '2026-02-24T00:02:00.000Z'
          ),
          (
            'activity-approval-stale',
            'thread-1',
            'turn-1',
            'error',
            'provider.approval.respond.failed',
            'Provider approval response failed',
            '{"requestId":"approval-1","detail":"Unknown pending permission request: approval-1"}',
            NULL,
            '2026-02-24T00:03:00.000Z'
          ),
          (
            'activity-user-input-requested',
            'thread-1',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-1","questions":[{"id":"area","header":"Area","question":"Which repo area should I inspect next?","options":[{"label":"Server","description":"Server orchestration."}]}]}',
            NULL,
            '2026-02-24T00:04:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Do the thing',
          NULL,
          NULL,
          '2026-02-24T00:05:00.000Z',
          '2026-02-24T00:05:00.000Z'
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
          'thread-1',
          'turn-1',
          'pending',
          NULL,
          '2026-02-24T00:02:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 24 });

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
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(threadRows, [
        {
          latestUserMessageAt: "2026-02-24T00:01:00.000Z",
          pendingApprovalCount: 0,
          pendingUserInputCount: 1,
          hasActionableProposedPlan: 1,
        },
      ]);

      const approvalRows = yield* sql<{
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = 'approval-1'
      `;
      assert.deepStrictEqual(approvalRows, [
        {
          status: "resolved",
          resolvedAt: "2026-02-24T00:03:00.000Z",
        },
      ]);
    }),
  );
});
