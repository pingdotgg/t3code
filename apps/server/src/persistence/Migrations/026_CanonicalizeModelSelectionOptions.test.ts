import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("026_CanonicalizeModelSelectionOptions", (it) => {
  it.effect("converts legacy object-shape options into array-shape on projections and events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 25 });

      yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'project-legacy',
              'Legacy options project',
              '/tmp/legacy',
              '{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"max","fastMode":true}}',
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL
            ),
            (
              'project-no-options',
              'No options project',
              '/tmp/no-options',
              '{"provider":"codex","model":"gpt-5.4"}',
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL
            ),
            (
              'project-null-selection',
              'Null model selection project',
              '/tmp/null-selection',
              NULL,
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL
            ),
            (
              'project-already-array',
              'Already-canonical options project',
              '/tmp/already-array',
              '{"provider":"codex","model":"gpt-5.4","options":[{"id":"reasoningEffort","value":"high"}]}',
              '[]',
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL
            )
        `;

      yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
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
            deleted_at,
            runtime_mode,
            interaction_mode
          )
          VALUES
            (
              'thread-legacy',
              'project-legacy',
              'Legacy thread',
              '{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"max","thinking":false,"contextWindow":"1m"}}',
              NULL, NULL, NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL, NULL, 0, 0, 0, NULL,
              'full-access', 'default'
            ),
            (
              'thread-empty-options',
              'project-legacy',
              'Empty options thread',
              '{"provider":"codex","model":"gpt-5.4","options":{}}',
              NULL, NULL, NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL, NULL, 0, 0, 0, NULL,
              'full-access', 'default'
            ),
            (
              'thread-drop-garbage',
              'project-legacy',
              'Thread with non-scalar entries',
              '{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"high","thinking":{"enabled":true,"budgetTokens":2000},"emptyStr":"   ","nullish":null}}',
              NULL, NULL, NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL, NULL, 0, 0, 0, NULL,
              'full-access', 'default'
            ),
            (
              'thread-no-options',
              'project-legacy',
              'No options thread',
              '{"provider":"codex","model":"gpt-5.4"}',
              NULL, NULL, NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL, NULL, 0, 0, 0, NULL,
              'full-access', 'default'
            ),
            (
              'thread-already-array',
              'project-legacy',
              'Already array thread',
              '{"provider":"codex","model":"gpt-5.4","options":[{"id":"fastMode","value":true}]}',
              NULL, NULL, NULL,
              '2026-01-01T00:00:00.000Z',
              '2026-01-01T00:00:00.000Z',
              NULL, NULL, 0, 0, 0, NULL,
              'full-access', 'default'
            )
        `;

      yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES
            (
              'event-project-created',
              'project',
              'project-legacy',
              1,
              'project.created',
              '2026-01-01T00:00:00.000Z',
              'cmd-pc',
              NULL,
              'corr-pc',
              'user',
              '{"projectId":"project-legacy","title":"Project","workspaceRoot":"/tmp/legacy","defaultModelSelection":{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"max","fastMode":true}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-project-meta-updated',
              'project',
              'project-legacy',
              2,
              'project.meta-updated',
              '2026-01-01T00:00:00.000Z',
              'cmd-pmu',
              NULL,
              'corr-pmu',
              'user',
              '{"projectId":"project-legacy","defaultModelSelection":{"provider":"codex","model":"gpt-5.4","options":{"reasoningEffort":"low"}},"updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-project-null-selection',
              'project',
              'project-legacy',
              3,
              'project.meta-updated',
              '2026-01-01T00:00:00.000Z',
              'cmd-null',
              NULL,
              'corr-null',
              'user',
              '{"projectId":"project-legacy","defaultModelSelection":null,"updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-thread-created',
              'thread',
              'thread-legacy',
              1,
              'thread.created',
              '2026-01-01T00:00:00.000Z',
              'cmd-tc',
              NULL,
              'corr-tc',
              'user',
              '{"threadId":"thread-legacy","projectId":"project-legacy","title":"Thread","modelSelection":{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"max","thinking":false}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-thread-meta-updated',
              'thread',
              'thread-legacy',
              2,
              'thread.meta-updated',
              '2026-01-01T00:00:00.000Z',
              'cmd-tmu',
              NULL,
              'corr-tmu',
              'user',
              '{"threadId":"thread-legacy","modelSelection":{"provider":"codex","model":"gpt-5.4","options":{"fastMode":true}},"updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-thread-turn-start',
              'thread',
              'thread-legacy',
              3,
              'thread.turn-start-requested',
              '2026-01-01T00:00:00.000Z',
              'cmd-tts',
              NULL,
              'corr-tts',
              'user',
              '{"threadId":"thread-legacy","messageId":"msg-1","modelSelection":{"provider":"claudeAgent","model":"claude-opus-4-6","options":{"effort":"high","contextWindow":"1m"}},"runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-thread-already-array',
              'thread',
              'thread-legacy',
              4,
              'thread.created',
              '2026-01-01T00:00:00.000Z',
              'cmd-taa',
              NULL,
              'corr-taa',
              'user',
              '{"threadId":"thread-already-array","projectId":"project-legacy","title":"Already Array","modelSelection":{"provider":"codex","model":"gpt-5.4","options":[{"id":"reasoningEffort","value":"medium"}]},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
              '{}'
            ),
            (
              'event-activity-append',
              'thread',
              'thread-legacy',
              5,
              'thread.activity-appended',
              '2026-01-01T00:00:00.000Z',
              'cmd-aa',
              NULL,
              'corr-aa',
              'user',
              '{"threadId":"thread-legacy","activity":{"id":"a","tone":"info","kind":"k","summary":"s","payload":null,"turnId":null,"createdAt":"2026-01-01T00:00:00.000Z"}}',
              '{}'
            )
        `;

      yield* runMigrations({ toMigrationInclusive: 26 });

      // Projection projects
      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly defaultModelSelection: string | null;
      }>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          ORDER BY project_id
        `;
      assert.deepStrictEqual(
        projectRows.map((row) => ({
          projectId: row.projectId,
          selection: row.defaultModelSelection ? JSON.parse(row.defaultModelSelection) : null,
        })),
        [
          {
            projectId: "project-already-array",
            selection: {
              provider: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
          {
            projectId: "project-legacy",
            selection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ],
            },
          },
          {
            projectId: "project-no-options",
            selection: { provider: "codex", model: "gpt-5.4" },
          },
          { projectId: "project-null-selection", selection: null },
        ],
      );

      // Projection threads
      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly modelSelection: string | null;
      }>`
          SELECT
            thread_id AS "threadId",
            model_selection_json AS "modelSelection"
          FROM projection_threads
          ORDER BY thread_id
        `;
      assert.deepStrictEqual(
        threadRows.map((row) => ({
          threadId: row.threadId,
          selection: row.modelSelection ? JSON.parse(row.modelSelection) : null,
        })),
        [
          {
            threadId: "thread-already-array",
            selection: {
              provider: "codex",
              model: "gpt-5.4",
              options: [{ id: "fastMode", value: true }],
            },
          },
          {
            threadId: "thread-drop-garbage",
            selection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              // Only the scalar string survives; nested object, whitespace
              // string, and null are dropped.
              options: [{ id: "effort", value: "high" }],
            },
          },
          {
            threadId: "thread-empty-options",
            selection: { provider: "codex", model: "gpt-5.4", options: [] },
          },
          {
            threadId: "thread-legacy",
            selection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: [
                { id: "effort", value: "max" },
                { id: "thinking", value: false },
                { id: "contextWindow", value: "1m" },
              ],
            },
          },
          {
            threadId: "thread-no-options",
            selection: { provider: "codex", model: "gpt-5.4" },
          },
        ],
      );

      // Orchestration events
      const eventRows = yield* sql<{
        readonly eventId: string;
        readonly payloadJson: string;
      }>`
          SELECT event_id AS "eventId", payload_json AS "payloadJson"
          FROM orchestration_events
          ORDER BY event_id
        `;

      const payloads = Object.fromEntries(
        eventRows.map((row) => [row.eventId, JSON.parse(row.payloadJson)]),
      );

      assert.deepStrictEqual(payloads["event-project-created"].defaultModelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      });

      assert.deepStrictEqual(payloads["event-project-meta-updated"].defaultModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "low" }],
      });

      assert.strictEqual(payloads["event-project-null-selection"].defaultModelSelection, null);

      assert.deepStrictEqual(payloads["event-thread-created"].modelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "max" },
          { id: "thinking", value: false },
        ],
      });

      assert.deepStrictEqual(payloads["event-thread-meta-updated"].modelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: [{ id: "fastMode", value: true }],
      });

      assert.deepStrictEqual(payloads["event-thread-turn-start"].modelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "1m" },
        ],
      });

      // Already-array records are left untouched.
      assert.deepStrictEqual(payloads["event-thread-already-array"].modelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "medium" }],
      });

      // Events with no modelSelection at all are untouched.
      assert.isUndefined(payloads["event-activity-append"].modelSelection);
      assert.isUndefined(payloads["event-activity-append"].defaultModelSelection);
    }),
  );
});
