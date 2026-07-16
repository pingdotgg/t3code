import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("016_CanonicalizeModelSelections", (it) => {
  it.effect(
    "migrates legacy projection rows and event payloads to the canonical model-selection shape",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Setup base state
        {
          yield* runMigrations({ toMigrationInclusive: 15 });

          yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          ('project-codex', 'Codex project', '/tmp/project-codex', 'gpt-5.4', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-claude', 'Claude project', '/tmp/project-claude', 'claude-sonnet-4-6', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
          ('project-null', 'Null project', '/tmp/project-null', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
      `;
          yield* sql`
        UPDATE projection_projects
        SET default_model = 'claude-opus-4-6'
        WHERE project_id = 'project-claude'
      `;
          yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES
          ('thread-session', 'project-codex', 'Session thread', 'gpt-5.4', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('thread-claude', 'project-claude', 'Claude thread', 'claude-opus-4-6', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('thread-codex', 'project-codex', 'Codex thread', 'gpt-5.4', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default'),
          ('thread-legacy-options', 'project-claude', 'Legacy options thread', 'claude-opus-4-6', NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 'full-access', 'default')
      `;
          yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode
        )
        VALUES (
          'thread-session',
          'running',
          'claudeAgent',
          'provider-session-1',
          'provider-thread-1',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          'full-access'
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
          'project-1',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created',
          NULL,
          'correlation-project-created',
          'user',
          '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-project-created-fallback',
          'project',
          'project-2',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created-fallback',
          NULL,
          'correlation-project-created-fallback',
          'user',
          '{"projectId":"project-2","title":"Fallback Project","workspaceRoot":"/tmp/project-2","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"low"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-project-created-null-model',
          'project',
          'project-3',
          1,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          'command-project-created-null-model',
          NULL,
          'correlation-project-created-null-model',
          'user',
          '{"projectId":"project-3","title":"Null Model Project","workspaceRoot":"/tmp/project-3","defaultModel":null,"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-thread-created',
          'thread',
          'thread-1',
          1,
          'thread.created',
          '2026-01-01T00:00:00.000Z',
          'command-thread-created',
          NULL,
          'correlation-thread-created',
          'user',
          '{"threadId":"thread-1","projectId":"project-1","title":"Thread","model":"claude-opus-4-6","modelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max","thinking":false}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-thread-created-fallback',
          'thread',
          'thread-2',
          1,
          'thread.created',
          '2026-01-01T00:00:00.000Z',
          'command-thread-created-fallback',
          NULL,
          'correlation-thread-created-fallback',
          'user',
          '{"threadId":"thread-2","projectId":"project-1","title":"Fallback Thread","model":"gpt-5.4","modelOptions":{"claudeAgent":{"effort":"max"}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-turn-start-requested',
          'thread',
          'thread-1',
          2,
          'thread.turn-start-requested',
          '2026-01-01T00:00:00.000Z',
          'command-turn-start-requested',
          NULL,
          'correlation-turn-start-requested',
          'user',
          '{"threadId":"thread-1","turnId":"turn-1","input":"hi","model":"gpt-5.4","modelOptions":{"codex":{"fastMode":true},"claudeAgent":{"effort":"max"}},"deliveryMode":"buffered"}',
          '{}'
        ),
        (
          'event-thread-created-no-model',
          'thread',
          'thread-3',
          1,
          'thread.created',
          '2026-01-01T00:00:00.000Z',
          'command-thread-created-no-model',
          NULL,
          'correlation-thread-created-no-model',
          'user',
          '{"threadId":"thread-3","projectId":"project-1","title":"Ancient Thread","runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        )
      `;
        }

        // Execute migration under test
        yield* runMigrations({ toMigrationInclusive: 16 });

        // Assert expected state
        {
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
          assert.deepStrictEqual(projectRows, [
            {
              projectId: "project-claude",
              defaultModelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              projectId: "project-codex",
              defaultModelSelection: '{"provider":"codex","model":"gpt-5.4"}',
            },
            { projectId: "project-null", defaultModelSelection: null },
          ]);

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
          assert.deepStrictEqual(threadRows, [
            {
              threadId: "thread-claude",
              modelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              threadId: "thread-codex",
              modelSelection: '{"provider":"codex","model":"gpt-5.4"}',
            },
            {
              threadId: "thread-legacy-options",
              modelSelection: '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
            },
            {
              threadId: "thread-session",
              modelSelection: '{"provider":"claudeAgent","model":"gpt-5.4"}',
            },
          ]);

          const eventRows = yield* sql<{
            readonly payloadJson: string;
          }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY rowid ASC
      `;
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[0]!.payloadJson), {
            projectId: "project-1",
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
              },
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[1]!.payloadJson), {
            projectId: "project-2",
            title: "Fallback Project",
            workspaceRoot: "/tmp/project-2",
            defaultModelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                reasoningEffort: "low",
              },
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[2]!.payloadJson), {
            projectId: "project-3",
            title: "Null Model Project",
            workspaceRoot: "/tmp/project-3",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[3]!.payloadJson), {
            threadId: "thread-1",
            projectId: "project-1",
            title: "Thread",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-opus-4-6",
              options: {
                effort: "max",
                thinking: false,
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[4]!.payloadJson), {
            threadId: "thread-2",
            projectId: "project-1",
            title: "Fallback Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                effort: "max",
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[5]!.payloadJson), {
            threadId: "thread-1",
            turnId: "turn-1",
            input: "hi",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                fastMode: true,
              },
            },
            deliveryMode: "buffered",
          });
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          assert.deepStrictEqual(JSON.parse(eventRows[6]!.payloadJson), {
            threadId: "thread-3",
            projectId: "project-1",
            title: "Ancient Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        }
      }),
  );
});
