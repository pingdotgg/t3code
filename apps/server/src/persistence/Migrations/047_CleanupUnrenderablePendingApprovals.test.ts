import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_CleanupUnrenderablePendingApprovals", (it) => {
  it.effect("removes generic approval rows while retaining actionable approvals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
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
        VALUES
          (
            'thread-actionable',
            'project-1',
            'Actionable thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-07-24T21:00:00.000Z',
            '2026-07-24T21:00:00.000Z',
            NULL,
            NULL,
            1,
            0,
            0,
            NULL
          ),
          (
            'thread-unrenderable',
            'project-1',
            'Unrenderable thread',
            '{"provider":"copilot","model":"gpt-5.6"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-07-24T21:00:00.000Z',
            '2026-07-24T21:00:00.000Z',
            NULL,
            NULL,
            1,
            0,
            0,
            NULL
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
            'activity-actionable',
            'thread-actionable',
            NULL,
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-actionable","requestKind":"command"}',
            NULL,
            '2026-07-24T21:00:00.000Z'
          ),
          (
            'activity-unrenderable',
            'thread-unrenderable',
            NULL,
            'approval',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-unrenderable","requestType":"unknown"}',
            NULL,
            '2026-07-24T21:00:00.000Z'
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
        VALUES
          (
            'approval-actionable',
            'thread-actionable',
            NULL,
            'pending',
            NULL,
            '2026-07-24T21:00:00.000Z',
            NULL
          ),
          (
            'approval-unrenderable',
            'thread-unrenderable',
            NULL,
            'pending',
            NULL,
            '2026-07-24T21:00:00.000Z',
            NULL
          ),
          (
            'approval-resolved',
            'thread-unrenderable',
            NULL,
            'resolved',
            'denied',
            '2026-07-24T21:00:00.000Z',
            '2026-07-24T21:01:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const approvalRows = yield* sql<{
        readonly requestId: string;
        readonly threadId: string;
        readonly status: string;
      }>`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          status
        FROM projection_pending_approvals
        ORDER BY request_id ASC
      `;
      assert.deepStrictEqual(approvalRows, [
        {
          requestId: "approval-actionable",
          threadId: "thread-actionable",
          status: "pending",
        },
        {
          requestId: "approval-resolved",
          threadId: "thread-unrenderable",
          status: "resolved",
        },
      ]);

      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly pendingApprovalCount: number;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_approval_count AS "pendingApprovalCount"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(threadRows, [
        {
          threadId: "thread-actionable",
          pendingApprovalCount: 1,
        },
        {
          threadId: "thread-unrenderable",
          pendingApprovalCount: 0,
        },
      ]);
    }),
  );
});
