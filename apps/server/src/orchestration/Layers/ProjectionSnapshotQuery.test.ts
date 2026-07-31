import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

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
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
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
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
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
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
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
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          checkpoint_agent_touched_paths_json,
          checkpoint_turn_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]',
          '["README.md"]',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          parentThreadId: null,
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          pendingRuntimeMode: null,
          branch: null,
          worktreePath: null,
          reviewResult: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "running",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: null,
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          queuedTurns: [],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          hasMoreActivities: false,
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              agentTouchedPaths: ["README.md"],
              turnFiles: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.equal(yield* snapshotQuery.getSnapshotSequence(), 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          parentThreadId: null,
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          pendingRuntimeMode: null,
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "running",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: null,
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  it.effect(
    "falls back to provider runtime resume cursors when thread session projections are stale",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM provider_session_runtime`;

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
          VALUES (
            'project-1',
            'Project 1',
            '/tmp/project-1',
            '{"provider":"copilot","model":"gpt-5.4"}',
            '[]',
            '2026-02-24T00:00:00.000Z',
            '2026-02-24T00:00:01.000Z',
            NULL
          )
        `;

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
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-1',
            'project-1',
            'Thread 1',
            '{"provider":"copilot","model":"gpt-5.4"}',
            'approval-required',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-02-24T00:00:02.000Z',
            '2026-02-24T00:00:03.000Z',
            NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            runtime_mode,
            active_turn_id,
            resume_cursor_json,
            last_error,
            updated_at
          )
          VALUES (
            'thread-1',
            'ready',
            'copilot',
            'approval-required',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:04.000Z'
          )
        `;

        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            resume_cursor_json,
            runtime_payload_json
          )
          VALUES (
            'thread-1',
            'copilot',
            'copilot',
            'approval-required',
            'running',
            '2026-02-24T00:00:05.000Z',
            '{"schemaVersion":1,"sessionId":"resume-123"}',
            '{"cwd":"/tmp/project-1"}'
          )
        `;

        const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
        assert.deepEqual(shellSnapshot.threads[0]?.session?.resumeCursor, {
          schemaVersion: 1,
          sessionId: "resume-123",
        });

        const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
        assert.equal(threadDetail._tag, "Some");
        if (threadDetail._tag === "Some") {
          assert.deepEqual(threadDetail.value.session?.resumeCursor, {
            schemaVersion: 1,
            sessionId: "resume-123",
          });
        }
      }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

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
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

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
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

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
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

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
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              agentTouchedPaths: [],
              turnFiles: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              agentTouchedPaths: [],
              turnFiles: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

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
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
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
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

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
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-completed',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:01:00.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-completed"));
        assert.equal(threadShell.value.latestTurn?.state, "completed");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:06.000Z");
      }
      const threadProjectContext = yield* snapshotQuery.getThreadShellProjectContextById(
        ThreadId.make("thread-1"),
      );
      assert.equal(threadProjectContext._tag, "Some");
      if (threadProjectContext._tag === "Some") {
        assert.equal(threadProjectContext.value.project?.title, "Project 1");
        assert.equal(threadProjectContext.value.thread.id, ThreadId.make("thread-1"));
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-completed"));
        assert.equal(threadDetail.value.latestTurn?.state, "completed");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:06.000Z");
      }

      yield* sql`
        UPDATE projection_threads
        SET latest_turn_id = NULL
        WHERE thread_id = 'thread-1'
      `;

      const fallbackThreadShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-1"),
      );
      assert.equal(fallbackThreadShell._tag, "Some");
      if (fallbackThreadShell._tag === "Some") {
        assert.equal(fallbackThreadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(fallbackThreadShell.value.latestTurn?.state, "running");
        assert.equal(fallbackThreadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const fallbackThreadDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-1"),
      );
      assert.equal(fallbackThreadDetail._tag, "Some");
      if (fallbackThreadDetail._tag === "Some") {
        assert.equal(fallbackThreadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(fallbackThreadDetail.value.latestTurn?.state, "running");
        assert.equal(fallbackThreadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      const shellThread = shellSnapshot.threads.find((thread) => thread.id === "thread-1");
      assert.equal(shellThread?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellThread?.latestTurn?.state, "running");
      if (shellThread?.latestTurn) {
        assert.equal(shellThread.latestTurn.startedAt, "2026-04-02T00:00:30.000Z");
      }
      assert.equal(shellSnapshot.updatedAt, "2026-04-02T00:01:00.000Z");
    }),
  );

  it.effect("preserves snapshot update time when only orphan turns remain", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'orphan-thread',
          'orphan-turn',
          'completed',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          '2026-04-03T00:00:02.000Z',
          '[]'
        )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();

      assert.deepStrictEqual(shellSnapshot.threads, []);
      assert.equal(shellSnapshot.updatedAt, "2026-04-03T00:00:02.000Z");
    }),
  );

  it.effect("searches active transcripts and returns the best match per thread", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-search', 'Search Project', '/tmp/search', NULL, '[]',
          '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'thread-active', 'project-search', 'Active thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            NULL, NULL, '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:03.000Z', NULL, NULL
          ),
          (
            'thread-archived', 'project-search', 'Archived thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            NULL, NULL, '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:03.000Z',
            '2026-04-04T00:00:04.000Z', NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          (
            'active-older', 'thread-active', NULL, 'user', 'needle in an older message', 0,
            '2026-04-04T00:00:01.000Z', '2026-04-04T00:00:01.000Z'
          ),
          (
            'active-newer', 'thread-active', NULL, 'assistant', 'needle in a newer message', 0,
            '2026-04-04T00:00:02.000Z', '2026-04-04T00:00:02.000Z'
          ),
          (
            'archived', 'thread-archived', NULL, 'assistant', 'needle in archived text', 0,
            '2026-04-04T00:00:02.000Z', '2026-04-04T00:00:02.000Z'
          )
      `;

      const searchTranscript = snapshotQuery.searchTranscript;
      assert.ok(searchTranscript);
      const result = yield* searchTranscript("needle");

      assert.deepStrictEqual(result.matches, [
        {
          threadId: ThreadId.make("thread-active"),
          title: "Active thread",
          projectTitle: "Search Project",
          branch: null,
          role: "assistant",
          excerpt: "needle in a newer mess...",
          updatedAt: "2026-04-04T00:00:02.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "excludes soft-deleted projects and threads from the shell snapshot while still tracking their update time",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;

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
              'live-project',
              'Live project',
              '/tmp/live-project',
              '{"provider":"codex","model":"gpt-5-codex"}',
              '[]',
              '2026-05-01T00:00:00.000Z',
              '2026-05-01T00:00:01.000Z',
              NULL
            ),
            (
              'deleted-project',
              'Deleted project',
              '/tmp/deleted-project',
              '{"provider":"codex","model":"gpt-5-codex"}',
              '[]',
              '2026-05-01T00:00:00.000Z',
              '2026-05-09T00:00:00.000Z',
              '2026-05-09T00:00:00.000Z'
            )
        `;

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
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES
            (
              'live-thread',
              'live-project',
              'Live thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              NULL,
              NULL,
              NULL,
              NULL,
              0,
              0,
              0,
              '2026-05-01T00:00:00.000Z',
              '2026-05-01T00:00:02.000Z',
              NULL
            ),
            (
              'deleted-thread',
              'live-project',
              'Deleted thread',
              '{"provider":"codex","model":"gpt-5-codex"}',
              'full-access',
              'default',
              NULL,
              NULL,
              NULL,
              NULL,
              0,
              0,
              0,
              '2026-05-01T00:00:00.000Z',
              '2026-05-10T00:00:00.000Z',
              '2026-05-10T00:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id,
            status,
            provider_name,
            provider_session_id,
            provider_thread_id,
            runtime_mode,
            active_turn_id,
            resume_cursor_json,
            last_error,
            updated_at
          )
          VALUES
            (
              'live-thread',
              'running',
              'codex',
              'live-session',
              'provider-live-thread',
              'full-access',
              NULL,
              NULL,
              NULL,
              '2026-05-01T00:00:03.000Z'
            ),
            (
              'deleted-thread',
              'running',
              'codex',
              'deleted-session',
              'provider-deleted-thread',
              'full-access',
              NULL,
              'not-json',
              NULL,
              '2026-05-02T00:00:00.000Z'
            )
        `;

        yield* sql`
          INSERT INTO projection_turns (
            thread_id,
            turn_id,
            state,
            requested_at,
            started_at,
            completed_at,
            assistant_message_id,
            checkpoint_turn_count,
            checkpoint_files_json,
            checkpoint_agent_touched_paths_json,
            checkpoint_turn_files_json
          )
          VALUES
            (
              'live-thread',
              'live-turn',
              'completed',
              '2026-05-01T00:00:04.000Z',
              NULL,
              NULL,
              NULL,
              0,
              '[]',
              '[]',
              '[]'
            ),
            (
              'deleted-thread',
              'deleted-turn',
              'completed',
              '2026-05-01T00:00:05.000Z',
              NULL,
              NULL,
              '   ',
              0,
              '[]',
              '[]',
              '[]'
            )
        `;

        const shellSnapshot = yield* snapshotQuery.getShellSnapshot();

        assert.deepStrictEqual(
          shellSnapshot.projects.map((project) => project.id),
          ["live-project"],
        );
        assert.deepStrictEqual(
          shellSnapshot.threads.map((thread) => thread.id),
          ["live-thread"],
        );
        // The deleted thread's session and turn carry values that cannot be
        // decoded, so these assertions fail loudly if the live-only session or
        // latest-turn queries ever stop filtering deleted threads in SQL.
        assert.equal(shellSnapshot.threads[0]?.session?.threadId, "live-thread");
        assert.equal(shellSnapshot.threads[0]?.session?.updatedAt, "2026-05-01T00:00:03.000Z");
        assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, "live-turn");
        // Soft-deleted rows are no longer loaded, but deleting still bumps
        // `updated_at`, so snapshot freshness must keep reflecting it.
        assert.equal(shellSnapshot.updatedAt, "2026-05-10T00:00:00.000Z");
      }),
  );

  it.effect("windows thread activities and pages older history without data loss", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-history', 'History Project', '/tmp/history', NULL, '[]',
          '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'thread-history', 'project-history', 'History thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
          NULL, NULL, '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z', NULL, NULL
        )
      `;

      yield* Effect.forEach(
        Array.from({ length: 240 }, (_unused, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`activity-${String(sequence).padStart(4, "0")}`},
              'thread-history', NULL, 'info', 'runtime.note', ${`activity-${sequence}`}, '{}',
              ${sequence}, '2026-04-05T00:01:00.000Z'
            )
          `,
        { discard: true },
      );

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-history"));
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.equal(detail.value.activities.length, 200);
        assert.equal(detail.value.activities[0]?.summary, "activity-41");
        assert.equal(detail.value.activities.at(-1)?.summary, "activity-240");
        assert.equal(detail.value.hasMoreActivities, true);
      }

      const olderPage = yield* snapshotQuery.getThreadActivitiesPage({
        threadId: ThreadId.make("thread-history"),
        beforeSequence: 41,
      });
      assert.equal(olderPage.activities.length, 40);
      assert.equal(olderPage.activities[0]?.summary, "activity-1");
      assert.equal(olderPage.activities.at(-1)?.summary, "activity-40");
      assert.equal(olderPage.hasMore, false);

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* Effect.forEach(
        Array.from({ length: 240 }, (_unused, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`legacy-${String(sequence).padStart(4, "0")}`},
              'thread-history', NULL, 'info', 'runtime.note', ${`legacy-${sequence}`}, '{}',
              NULL, '2026-04-05T00:01:00.000Z'
            )
          `,
        { discard: true },
      );

      const legacyDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-history"),
      );
      assert.equal(legacyDetail._tag, "Some");
      if (legacyDetail._tag === "Some") {
        const oldest = legacyDetail.value.activities[0];
        assert.equal(legacyDetail.value.activities.length, 200);
        assert.equal(oldest?.summary, "legacy-41");
        assert.equal(legacyDetail.value.activities.at(-1)?.summary, "legacy-240");
        assert.equal(legacyDetail.value.hasMoreActivities, true);
        assert.ok(oldest);

        const legacyOlderPage = yield* snapshotQuery.getThreadActivitiesPage({
          threadId: ThreadId.make("thread-history"),
          beforeCreatedAt: oldest.createdAt,
          beforeActivityId: oldest.id,
        });
        assert.equal(legacyOlderPage.activities.length, 40);
        assert.equal(legacyOlderPage.activities[0]?.summary, "legacy-1");
        assert.equal(legacyOlderPage.activities.at(-1)?.summary, "legacy-40");
        assert.equal(legacyOlderPage.hasMore, false);
      }

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* Effect.forEach(
        Array.from({ length: 4 }, (_unused, index) => index + 1),
        (index) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`legacy-${String(index).padStart(4, "0")}`},
              'thread-history', NULL, 'info', 'runtime.note', ${`legacy-${index}`}, '{}',
              NULL, '2026-04-05T00:01:00.000Z'
            )
          `,
        { discard: true },
      );
      yield* Effect.forEach(
        Array.from({ length: 4 }, (_unused, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`sequenced-${String(sequence).padStart(4, "0")}`},
              'thread-history', NULL, 'info', 'runtime.note', ${`sequenced-${sequence}`}, '{}',
              ${sequence}, '2026-04-05T00:02:00.000Z'
            )
          `,
        { discard: true },
      );

      const transitionPage = yield* snapshotQuery.getThreadActivitiesPage({
        threadId: ThreadId.make("thread-history"),
        beforeSequence: 3,
        limit: 3,
      });
      assert.deepStrictEqual(
        transitionPage.activities.map((activity) => activity.summary),
        ["legacy-4", "sequenced-1", "sequenced-2"],
      );
      assert.equal(transitionPage.hasMore, true);

      const remainingLegacyPage = yield* snapshotQuery.getThreadActivitiesPage({
        threadId: ThreadId.make("thread-history"),
        beforeCreatedAt: transitionPage.activities[0]!.createdAt,
        beforeActivityId: transitionPage.activities[0]!.id,
        limit: 3,
      });
      assert.deepStrictEqual(
        remainingLegacyPage.activities.map((activity) => activity.summary),
        ["legacy-1", "legacy-2", "legacy-3"],
      );
      assert.equal(remainingLegacyPage.hasMore, false);
    }),
  );
});
