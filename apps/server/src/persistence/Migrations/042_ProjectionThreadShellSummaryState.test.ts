import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadShellSummaryState", (it) => {
  it.effect("upgrades recorded migration 41 and reconciles shell summaries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
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
        ) VALUES
          (
            'thread-cleared',
            'project-1',
            'Cleared',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-19T00:00:00.000Z',
            '2026-08-19T00:00:00.000Z',
            NULL,
            '2026-08-19T00:00:05.000Z',
            0,
            1,
            0,
            NULL
          ),
          (
            'thread-pending',
            'project-1',
            'Pending',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-19T00:00:00.000Z',
            '2026-08-19T00:00:00.000Z',
            NULL,
            NULL,
            0,
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
        ) VALUES
          (
            'A',
            'thread-cleared',
            NULL,
            'info',
            'user-input.requested',
            'Tie requested',
            '{"requestId":"request-tie"}',
            NULL,
            '2026-08-19T00:00:02.000Z'
          ),
          (
            'a',
            'thread-cleared',
            NULL,
            'info',
            'user-input.resolved',
            'Tie resolved',
            '{"requestId":"request-tie"}',
            NULL,
            '2026-08-19T00:00:02.000Z'
          ),
          (
            'activity-pending',
            'thread-pending',
            NULL,
            'info',
            'user-input.requested',
            'Pending request',
            '{"requestId":"request-pending"}',
            NULL,
            '2026-08-19T00:00:01.000Z'
          ),
          (
            'activity-object-detail',
            'thread-pending',
            NULL,
            'error',
            'provider.user-input.respond.failed',
            'Object detail',
            '{"requestId":"request-pending","detail":{"message":"stale pending user-input request"}}',
            NULL,
            '2026-08-19T00:00:02.000Z'
          ),
          (
            'activity-malformed',
            'thread-pending',
            NULL,
            'info',
            'user-input.requested',
            'Malformed',
            '{',
            NULL,
            '2026-08-19T00:00:03.000Z'
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
        ) VALUES
          (
            'message-assistant',
            'thread-cleared',
            NULL,
            'assistant',
            'No user message remains',
            NULL,
            0,
            '2026-08-19T00:00:05.000Z',
            '2026-08-19T00:00:05.000Z'
          ),
          (
            'message-user',
            'thread-pending',
            NULL,
            'user',
            'Latest user message',
            NULL,
            0,
            '2026-08-19T00:00:06.000Z',
            '2026-08-19T00:00:06.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const normalizedRows = yield* sql<{
        readonly activityId: string;
        readonly requestId: string | null;
        readonly state: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          user_input_request_id AS "requestId",
          user_input_state AS "state"
        FROM projection_thread_activities
        WHERE activity_id IN ('activity-malformed', 'activity-object-detail')
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(normalizedRows, [
        { activityId: "activity-malformed", requestId: null, state: null },
        { activityId: "activity-object-detail", requestId: null, state: null },
      ]);

      const summaryRows = yield* sql<{
        readonly threadId: string;
        readonly pendingCount: number;
      }>`
        SELECT
          thread_id AS "threadId",
          pending_count AS "pendingCount"
        FROM projection_thread_user_input_summaries
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(summaryRows, [
        { threadId: "thread-cleared", pendingCount: 0 },
        { threadId: "thread-pending", pendingCount: 1 },
      ]);

      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly latestUserMessageAt: string | null;
        readonly pendingUserInputCount: number;
      }>`
        SELECT
          thread_id AS "threadId",
          latest_user_message_at AS "latestUserMessageAt",
          pending_user_input_count AS "pendingUserInputCount"
        FROM projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(threadRows, [
        {
          threadId: "thread-cleared",
          latestUserMessageAt: null,
          pendingUserInputCount: 0,
        },
        {
          threadId: "thread-pending",
          latestUserMessageAt: "2026-08-19T00:00:06.000Z",
          pendingUserInputCount: 1,
        },
      ]);

      const legacyIndexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_thread_activities_thread_user_input_lifecycle'
      `;
      assert.deepStrictEqual(legacyIndexes, []);

      const lifecycleIndexColumns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_user_input_state')
      `;
      assert.deepStrictEqual(
        lifecycleIndexColumns.map((column) => column.name),
        ["thread_id", "user_input_request_id", "created_at", "activity_id"],
      );

      const lifecyclePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT user_input_state
        FROM projection_thread_activities
        WHERE thread_id = 'thread-pending'
          AND user_input_request_id = 'request-pending'
          AND user_input_state IS NOT NULL
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 1
      `;
      const lifecyclePlanText = lifecyclePlan.map((row) => row.detail).join("\n");
      assert.match(
        lifecyclePlanText,
        /USING INDEX idx_projection_thread_activities_user_input_state/,
      );
      assert.notMatch(lifecyclePlanText, /USE TEMP B-TREE/);

      const summaryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT pending_count
        FROM projection_thread_user_input_summaries
        WHERE thread_id = 'thread-pending'
        LIMIT 1
      `;
      assert.match(summaryPlan.map((row) => row.detail).join("\n"), /USING INDEX/);

      const messagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT created_at
        FROM projection_thread_messages
        WHERE thread_id = 'thread-pending'
          AND role = 'user'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const messagePlanText = messagePlan.map((row) => row.detail).join("\n");
      assert.match(
        messagePlanText,
        /USING COVERING INDEX idx_projection_thread_messages_latest_user/,
      );
      assert.notMatch(messagePlanText, /USE TEMP B-TREE/);
    }),
  );
});
