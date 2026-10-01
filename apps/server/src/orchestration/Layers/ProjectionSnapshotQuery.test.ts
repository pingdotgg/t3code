import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  OrchestrationProjectionSnapshotQueryLive,
  ProjectionSnapshotQueryTestHooks,
} from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asProviderInstanceId = (value: string): ProviderInstanceId => ProviderInstanceId.make(value);
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
  it.effect("reads bounded history by ID without hydrating unrelated threads or checkpoints", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-16T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('cli-read-project', 'CLI', '/tmp/cli-read', '[]', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at
        ) VALUES
          ('cli-read-thread', 'cli-read-project', 'CLI history',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now}, ${now}),
          ('cli-read-unrelated', 'cli-read-project', 'CLI history',
            'invalid-json-must-not-be-decoded', 'full-access', 'default', ${now}, ${now}, NULL)
      `;
      for (let index = 0; index < 6; index++) {
        yield* sql`
          INSERT INTO projection_thread_messages
            (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
          VALUES (${`cli-read-message-${index}`}, 'cli-read-thread', 'user', ${`Message ${index}`},
            '[]', 0, ${now}, ${now})
        `;
        yield* sql`
          INSERT INTO projection_thread_activities
            (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${`cli-read-activity-${index}`}, 'cli-read-thread', 'info', 'runtime.info',
            'Activity', '{}', ${index}, ${now})
        `;
      }
      const summary = yield* query.readThread({ thread: "cli-read-thread", view: "summary" });
      assert.equal(summary.thread.archivedAt, now);
      assert.deepStrictEqual(Object.keys(summary).sort(), ["page", "thread"]);
      assert.isBelow(JSON.stringify(summary).length, 4000);
      for (const view of ["messages", "activities"] as const) {
        const first = yield* query.readThread({ thread: "cli-read-thread", view, limit: 2 });
        const second = yield* query.readThread({
          thread: "cli-read-thread",
          view,
          limit: 2,
          before: first.page.before!,
        });
        const third = yield* query.readThread({
          thread: "cli-read-thread",
          view,
          limit: 2,
          before: second.page.before!,
        });
        const ids = [first, second, third].flatMap(
          (page) => page[view]?.map((row) => row.id) ?? [],
        );
        assert.equal(new Set(ids).size, 6);
        assert.equal(first[view]?.length, 2);
        assert.equal(first[view]?.[0]?.id.endsWith("-4"), true);
        assert.equal(third.page.hasMore, false);
        assert.equal(third.page.before, null);
        assert.notProperty(first, "checkpoints");
        assert.notProperty(first, view === "messages" ? "activities" : "messages");
        const wrongView = yield* query
          .readThread({
            thread: "cli-read-thread",
            view: view === "messages" ? "activities" : "messages",
            before: first.page.before!,
          })
          .pipe(Effect.flip);
        assert.equal(wrongView._tag, "OrchestrationReadThreadInputError");
      }
      const ambiguous = yield* query
        .readThread({ thread: "CLI history", view: "summary" })
        .pipe(Effect.flip);
      assert.equal(ambiguous._tag, "OrchestrationReadThreadInputError");
      const invalidCursor = yield* query
        .readThread({
          thread: "cli-read-thread",
          view: "messages",
          before: "not-a-cursor",
        })
        .pipe(Effect.flip);
      assert.equal(invalidCursor._tag, "OrchestrationReadThreadInputError");
      const corruptProjection = yield* query
        .readThread({ thread: "cli-read-unrelated", view: "summary" })
        .pipe(Effect.flip);
      assert.equal(corruptProjection._tag, "OrchestrationGetSnapshotError");
      yield* sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = 'cli-read-thread'`;
      const deleted = yield* query
        .readThread({ thread: "cli-read-thread", view: "summary" })
        .pipe(Effect.flip);
      assert.equal(deleted._tag, "OrchestrationReadThreadInputError");
      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = 'cli-read-thread'`;
      yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = 'cli-read-thread'`;
      yield* sql`DELETE FROM projection_threads WHERE project_id = 'cli-read-project'`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'cli-read-project'`;
    }),
  );

  it.effect("loads active chat archive rows in one consistent query surface", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('archive-project', 'Archive project', '/tmp/archive-project', '[]',
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at
        ) VALUES
          ('archive-active', 'archive-project', 'Active chat',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            '2026-09-14T00:00:00.000Z', '2026-09-14T00:01:00.000Z', NULL),
          ('archive-hidden', 'archive-project', 'Archived chat',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            '2026-09-14T00:02:00.000Z', '2026-09-14T00:03:00.000Z',
            '2026-09-14T00:04:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES
          ('archive-message-active', 'archive-active', 'user', 'Export me', '[]', 0,
            '2026-09-14T00:00:30.000Z', '2026-09-14T00:00:30.000Z'),
          ('archive-message-hidden', 'archive-hidden', 'user', 'Do not export', '[]', 0,
            '2026-09-14T00:02:30.000Z', '2026-09-14T00:02:30.000Z')
      `;

      const entries = yield* query.getActiveChatArchiveEntries();

      assert.deepStrictEqual(entries, [
        {
          thread: {
            id: asThreadId("archive-active"),
            parentThreadId: null,
            title: "Active chat",
            modelSelection: {
              instanceId: asProviderInstanceId("codex"),
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-09-14T00:00:00.000Z",
            updatedAt: "2026-09-14T00:01:00.000Z",
            messages: [
              {
                role: "user",
                text: "Export me",
                turnId: null,
                createdAt: "2026-09-14T00:00:30.000Z",
                updatedAt: "2026-09-14T00:00:30.000Z",
                attachments: [],
              },
            ],
          },
          project: {
            title: "Archive project",
            workspaceRoot: "/tmp/archive-project",
          },
        },
      ]);

      yield* sql`DELETE FROM projection_thread_messages WHERE thread_id LIKE 'archive-%'`;
      yield* sql`DELETE FROM projection_threads WHERE project_id = 'archive-project'`;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'archive-project'`;
    }),
  );
  it.effect("exposes imported project kind without changing workspace project snapshots", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, kind, scripts_json, created_at, updated_at)
        VALUES
          ('workspace-project', 'Workspace', '/tmp/workspace-project', 'workspace', '[]',
            '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'),
          ('import-project', 'Imported chats', '/tmp/import-project', 'chat-import', '[]',
            '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')
      `;

      const full = yield* query.getSnapshot();
      const shell = yield* query.getShellSnapshot();

      for (const snapshot of [full, shell]) {
        assert.deepStrictEqual(
          snapshot.projects.find((project) => project.id === "workspace-project")?.kind,
          undefined,
        );
        assert.equal(
          snapshot.projects.find((project) => project.id === "import-project")?.kind,
          "chat-import",
        );
      }

      yield* sql`
        DELETE FROM projection_projects
        WHERE project_id IN ('workspace-project', 'import-project')
      `;
    }),
  );
  it.effect("hydrates auto-pull through full, shell, and targeted project reads", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
        VALUES ('auto-pull-project', 'Auto pull', '/tmp/auto-pull-project', 1, '[]',
          '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
      `;
      const full = yield* query.getSnapshot();
      const shell = yield* query.getShellSnapshot();
      const targeted = yield* query.getActiveProjectByWorkspaceRoot("/tmp/auto-pull-project");
      assert.equal(
        full.projects.find((project) => project.id === "auto-pull-project")?.autoPull,
        true,
      );
      assert.equal(
        shell.projects.find((project) => project.id === "auto-pull-project")?.autoPull,
        true,
      );
      assert.equal(Option.getOrThrow(targeted).autoPull, true);
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'auto-pull-project'`;
    }),
  );
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
          pinned_at,
          pin_order_key,
          title_regeneration_request_id,
          title_regeneration_started_at,
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
          '2026-02-24T00:00:02.500Z',
          'a0',
          'cmd-title-regenerate',
          '2026-02-24T00:00:02.750Z',
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
          autoPull: false,
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
          nudging: {},
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
          pullRequest: null,
          pullRequests: [],
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
          pinnedAt: "2026-02-24T00:00:02.500Z",
          pinOrderKey: "a0",
          titleRegeneration: {
            requestId: CommandId.make("cmd-title-regenerate"),
            startedAt: "2026-02-24T00:00:02.750Z",
          },
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
          autoPull: false,
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
          nudging: {},
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
          pullRequest: null,
          pullRequests: [],
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
          pinnedAt: "2026-02-24T00:00:02.500Z",
          pinOrderKey: "a0",
          titleRegeneration: {
            requestId: CommandId.make("cmd-title-regenerate"),
            startedAt: "2026-02-24T00:00:02.750Z",
          },
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
          hasPendingQueuedTurn: false,
        },
      ]);

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.pinnedAt, "2026-02-24T00:00:02.500Z");
        assert.equal(threadShell.value.pinOrderKey, "a0");
        assert.deepEqual(threadShell.value.titleRegeneration, {
          requestId: "cmd-title-regenerate",
          startedAt: "2026-02-24T00:00:02.750Z",
        });
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        const snapshotThread = snapshot.threads[0];
        assert.isDefined(snapshotThread);
        assert.deepEqual(threadDetail.value, {
          ...snapshotThread,
          activityContext: [],
          hasMoreActivities: false,
          hasMoreCurrentTurnActivities: false,
        });
      }

      const threadSnapshot = yield* snapshotQuery.getThreadDetailSnapshotById(
        ThreadId.make("thread-1"),
      );
      assert.equal(threadSnapshot._tag, "Some");
      if (threadDetail._tag === "Some" && threadSnapshot._tag === "Some") {
        assert.equal(threadSnapshot.value.snapshotSequence, 5);
        assert.deepEqual(threadSnapshot.value.thread, threadDetail.value);
      }
    }),
  );

  it.effect("loads a bounded recent window and pages across sequenced and legacy activities", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-pagination");

      yield* sql`DELETE FROM projection_thread_activities`;
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
          VALUES (
            'project-pagination',
            'Pagination project',
            '/tmp/project-pagination',
            '{"provider":"copilot","model":"gpt-5.4"}',
            '[]',
            '2026-07-28T00:00:00.000Z',
            '2026-07-28T00:00:00.000Z',
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
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            'thread-pagination',
            'project-pagination',
            'Pagination thread',
            '{"provider":"copilot","model":"gpt-5.4"}',
            'approval-required',
            'default',
            NULL,
            1,
            0,
            0,
            '2026-07-28T00:00:00.000Z',
            '2026-07-28T00:00:00.000Z',
            NULL
          )
        `;
      yield* sql`
          WITH RECURSIVE activity_sequence(value) AS (
            VALUES (1)
            UNION ALL
            SELECT value + 1 FROM activity_sequence WHERE value < 205
          )
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
          SELECT
            printf('sequenced-%03d', value),
            'thread-pagination',
            NULL,
            'info',
            'runtime.note',
            printf('activity %d', value),
            '{}',
            value,
            printf('2026-07-28T00:%02d:%02d.000Z', value / 60, value % 60)
          FROM activity_sequence
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
              'z-same-time-request',
              'thread-pagination',
              NULL,
              'approval',
              'approval.requested',
              'same-time approval needed',
              '{"requestId":"approval-2"}',
              NULL,
              '2026-07-27T23:59:56.000Z'
            ),
            (
              'a-same-time-resolution',
              'thread-pagination',
              NULL,
              'approval',
              'approval.resolved',
              'same-time approval resolved',
              '{"requestId":"approval-2"}',
              NULL,
              '2026-07-27T23:59:56.000Z'
            ),
            (
              'legacy-approval',
              'thread-pagination',
              NULL,
              'approval',
              'approval.requested',
              'approval needed',
              '{"requestId":"approval-1"}',
              NULL,
              '2026-07-27T23:59:57.000Z'
            ),
            (
              'legacy-2',
              'thread-pagination',
              NULL,
              'info',
              'runtime.note',
              'legacy 2',
              '{}',
              NULL,
              '2026-07-27T23:59:58.000Z'
            ),
            (
              'legacy-3',
              'thread-pagination',
              NULL,
              'info',
              'runtime.note',
              'legacy 3',
              '{}',
              NULL,
              '2026-07-27T23:59:59.000Z'
            )
        `;

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.equal(detail._tag, "Some");
      if (detail._tag === "None") return;

      assert.equal(detail.value.activities.length, 200);
      assert.deepEqual(
        detail.value.activities.map((activity) => activity.sequence),
        Array.from({ length: 200 }, (_, index) => index + 6),
      );
      assert.deepEqual(
        detail.value.activityContext?.map((activity) => activity.id),
        [asEventId("legacy-approval")],
      );

      const allActivityIds = detail.value.activities.map((activity) => activity.id);
      let hasMore = detail.value.hasMoreActivities ?? false;
      let oldestActivity = detail.value.activities[0];
      while (hasMore && oldestActivity) {
        const result = yield* snapshotQuery.getThreadActivitiesPage({
          threadId,
          beforeCreatedAt: oldestActivity.createdAt,
          beforeActivityId: oldestActivity.id,
          limit: 3,
        });
        allActivityIds.push(...result.activities.map((activity) => activity.id));
        hasMore = result.hasMore;
        oldestActivity = result.activities[0];
      }

      assert.equal(allActivityIds.length, 210);
      assert.equal(new Set(allActivityIds).size, 210);
      assert.isTrue(allActivityIds.includes(asEventId("legacy-approval")));
      assert.isTrue(allActivityIds.includes(asEventId("sequenced-001")));
      assert.isTrue(allActivityIds.includes(asEventId("sequenced-205")));
    }),
  );

  it.effect("keeps the newest background-agent runs in the per-thread shell query", () =>
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
          'project-bg-cap', 'Background cap project', '/tmp/bg-cap',
          '{"provider":"copilot","model":"gpt-5.4"}', '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-bg-cap', 'project-bg-cap', 'Background cap thread',
          '{"provider":"copilot","model":"gpt-5.4"}', 'approval-required', 'default',
          NULL, 0, 0, 0,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE task_sequence(value) AS (
          VALUES (0)
          UNION ALL
          SELECT value + 1 FROM task_sequence WHERE value < 104
        )
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
        SELECT
          printf('bg-activity-%03d', value),
          'thread-bg-cap',
          NULL,
          'info',
          'task.started',
          printf('background agent %d', value),
          printf(
            '{"taskId":"bg-task-%03d","taskType":"background-agent","name":"Agent %d"}',
            value,
            value,
            value
          ),
          NULL,
          printf('2026-09-01T00:%02d:%02d.000Z', value / 60, value % 60)
        FROM task_sequence
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
        ) VALUES (
          'bg-completed-104',
          'thread-bg-cap',
          NULL,
          'info',
          'task.completed',
          'background agent 104 completed',
          '{"taskId":"bg-task-104","status":"completed"}',
          NULL,
          '2026-09-01T00:02:00.000Z'
        )
      `;

      const context = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-bg-cap"));
      assert.equal(context._tag, "Some");
      if (context._tag === "None") return;

      const runs = context.value.backgroundAgentRuns ?? [];
      assert.lengthOf(runs, 100);
      const taskIds = new Set(runs.map((run) => run.taskId));
      assert.isTrue(taskIds.has("bg-task-104"));
      assert.isFalse(taskIds.has("bg-task-000"));
      assert.equal(runs.find((run) => run.taskId === "bg-task-104")?.status, "completed");
    }),
  );

  it.effect("caps full snapshot activities before decoding payloads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-snapshot-cap', 'Snapshot cap project', '/tmp/snapshot-cap',
          '{"provider":"copilot","model":"gpt-5.4"}', '[]',
          '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-snapshot-cap', 'project-snapshot-cap', 'Snapshot cap thread',
          '{"provider":"copilot","model":"gpt-5.4"}', 'full-access', 'default',
          NULL, 0, 0, 0, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE activity_sequence(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM activity_sequence WHERE value < 501
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          sequence, created_at
        )
        SELECT
          printf('activity-%04d', value),
          'thread-snapshot-cap',
          NULL,
          'info',
          'runtime.note',
          printf('activity %d', value),
          CASE WHEN value = 1 THEN 'invalid json' ELSE '{}' END,
          value,
          '2026-08-18T00:00:01.000Z'
        FROM activity_sequence
      `;
      yield* sql`
        WITH RECURSIVE message_sequence(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM message_sequence WHERE value < 2005
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        )
        SELECT
          printf('snapshot-message-%04d', 2006 - value),
          'thread-snapshot-cap',
          NULL,
          'user',
          printf('message %d', value),
          CASE WHEN value = 1 THEN 'not-json' ELSE NULL END,
          0,
          '2026-08-18T00:00:02.000Z',
          '2026-08-18T00:00:02.000Z'
        FROM message_sequence
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-snapshot-cap");

      assert.isDefined(thread);
      assert.equal(thread.activities.length, 500);
      assert.equal(thread.activities[0]?.id, asEventId("activity-0002"));
      assert.equal(thread.activities.at(-1)?.id, asEventId("activity-0501"));
      assert.equal(thread.messages.length, 2000);
      assert.equal(thread.messages[0]?.text, "message 6");
      assert.equal(thread.messages.at(-1)?.text, "message 2005");
    }),
  );

  it.effect(
    "retains independent chronological windows for active, archived and deleted threads",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-09-24T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('window-project', 'Windows', '/tmp/window-project', '[]', ${now}, ${now})
      `;
        for (const state of ["active", "archived", "deleted"] as const) {
          const threadId = `window-${state}`;
          yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            created_at, updated_at, archived_at, deleted_at
          ) VALUES (
            ${threadId}, 'window-project', ${state}, '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access', 'default', ${now}, ${now},
            ${state === "archived" ? now : null}, ${state === "deleted" ? now : null}
          )
        `;
          yield* sql`
          WITH RECURSIVE entries(value) AS (
            VALUES (1) UNION ALL SELECT value + 1 FROM entries WHERE value < 502
          )
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at
          )
          SELECT
            ${threadId} || printf('-%04d', value), ${threadId}, 'info', 'runtime.note', 'Activity',
            CASE WHEN value <= 2 THEN 'invalid old payload' ELSE '{}' END,
            CASE WHEN value % 2 = 0 THEN NULL ELSE 503 - value END,
            ${now}
          FROM entries
        `;
        }
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('window-orphan', 'missing-thread', 'info', 'runtime.note', 'Orphan',
          'invalid orphan payload', ${now})
      `;

        const snapshot = yield* query.getSnapshot();
        for (const state of ["active", "archived", "deleted"] as const) {
          const thread = snapshot.threads.find((entry) => entry.id === `window-${state}`);
          assert.isDefined(thread);
          assert.deepStrictEqual(
            thread.activities.map((activity) => activity.id),
            Array.from({ length: 500 }, (_, index) =>
              asEventId(`window-${state}-${String(index + 3).padStart(4, "0")}`),
            ),
          );
          assert.equal(thread.archivedAt, state === "archived" ? now : null);
          assert.equal(thread.deletedAt, state === "deleted" ? now : null);
        }
        yield* sql`DELETE FROM projection_thread_activities WHERE thread_id LIKE 'window-%' OR activity_id = 'window-orphan'`;
        yield* sql`DELETE FROM projection_threads WHERE project_id = 'window-project'`;
        yield* sql`DELETE FROM projection_projects WHERE project_id = 'window-project'`;
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
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
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
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
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
          messageId: MessageId.make("active-newer"),
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

  it.effect("keeps matching threads visible when one thread exceeds the FTS cap", () =>
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
          'project-crowd', 'Crowd Project', '/tmp/crowd', NULL, '[]',
          '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          (
            'thread-crowd', 'project-crowd', 'Crowd thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            NULL, NULL, '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:01.000Z', NULL, NULL
          ),
          (
            'thread-other', 'project-crowd', 'Other thread',
            '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
            NULL, NULL, '2026-04-05T00:00:00.000Z', '2026-04-05T00:00:02.000Z', NULL, NULL
          )
      `;
      // More matches in one thread than the global FTS candidate cap, all
      // scoring better (shorter) than the other thread's match: the other
      // thread's best match must still surface (best match per thread).
      yield* sql`
        WITH RECURSIVE crowd(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM crowd WHERE value < 10005
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('crowd-message-%04d', value),
          'thread-crowd',
          NULL,
          'user',
          'needle',
          0,
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:01.000Z'
        FROM crowd
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'other-message', 'thread-other', NULL, 'user', 'needle other', 0,
          '2026-04-05T00:00:02.000Z', '2026-04-05T00:00:02.000Z'
        )
      `;

      const searchTranscript = snapshotQuery.searchTranscript;
      assert.ok(searchTranscript);
      const result = yield* searchTranscript("needle");

      assert.deepStrictEqual(result.matches.map((match) => match.threadId).toSorted(), [
        ThreadId.make("thread-crowd"),
        ThreadId.make("thread-other"),
      ]);
      for (const match of result.matches) {
        assert.ok(match.excerpt.includes("needle"));
      }
    }),
  );

  it.effect("preserves all transcript tie-breaks beyond the former candidate caps", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-ties', 'Ties Project', '/tmp/ties', '[]',
          '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        WITH RECURSIVE threads(value) AS (
          VALUES (0)
          UNION ALL
          SELECT value + 1 FROM threads WHERE value < 20
        )
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at
        )
        SELECT
          printf('thread-%02d', value), 'project-ties', 'Tied thread',
          '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default',
          '2026-04-01T00:00:00.000Z', printf('2026-04-%02dT00:00:00.000Z', value + 1)
        FROM threads
      `;
      // 2,121 equal-score hits: the newest thread sorts last by ID.
      // Reverse message IDs so insertion order cannot resolve message ties.
      yield* sql`
        WITH RECURSIVE messages(value) AS (
          VALUES (0)
          UNION ALL
          SELECT value + 1 FROM messages WHERE value < 100
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          threads.thread_id || printf('-message-%03d', 100 - messages.value),
          threads.thread_id,
          CASE WHEN messages.value = 100 THEN 'assistant' ELSE 'user' END,
          'needle', 0, threads.created_at, threads.updated_at
        FROM projection_threads AS threads CROSS JOIN messages
      `;

      const searchTranscript = snapshotQuery.searchTranscript;
      assert.ok(searchTranscript);
      const newest = yield* searchTranscript("needle");
      assert.deepStrictEqual(
        newest.matches.map((match) => match.threadId),
        Array.from({ length: 20 }, (_, index) =>
          ThreadId.make(`thread-${String(20 - index).padStart(2, "0")}`),
        ),
      );
      assert.ok(newest.matches.every((match) => match.role === "assistant"));

      const scoped = yield* searchTranscript("needle", [ThreadId.make("thread-00")]);
      assert.deepStrictEqual(
        scoped.matches.map((match) => match.threadId),
        [ThreadId.make("thread-00")],
      );
      assert.deepStrictEqual((yield* searchTranscript("needle", [])).matches, []);

      yield* sql`UPDATE projection_thread_messages SET updated_at = '2026-04-01T00:00:00.000Z'`;
      const tied = yield* searchTranscript("needle");
      assert.deepStrictEqual(
        tied.matches.map((match) => match.threadId),
        Array.from({ length: 20 }, (_, index) =>
          ThreadId.make(`thread-${String(index).padStart(2, "0")}`),
        ),
      );
      assert.ok(tied.matches.every((match) => match.role === "assistant"));
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
        assert.equal(detail.value.hasMoreCurrentTurnActivities, false);
      }

      yield* sql`
        UPDATE projection_thread_activities
        SET turn_id = 'turn-history'
        WHERE thread_id = 'thread-history'
          AND sequence > 40
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        ) VALUES (
          'thread-history',
          'turn-history',
          'completed',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:02:00.000Z',
          '[]'
        )
      `;
      const mixedTurnDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-history"),
      );
      assert.equal(mixedTurnDetail._tag, "Some");
      if (mixedTurnDetail._tag === "Some") {
        assert.equal(mixedTurnDetail.value.hasMoreActivities, true);
        assert.equal(mixedTurnDetail.value.hasMoreCurrentTurnActivities, false);
      }

      yield* Effect.forEach(
        Array.from({ length: 200 }, (_unused, index) => index + 241),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`activity-${String(sequence).padStart(4, "0")}`},
              'thread-history', 'turn-history', 'info', 'runtime.note',
              ${`activity-${sequence}`}, '{}', ${sequence}, '2026-04-05T00:01:00.000Z'
            )
          `,
        { discard: true },
      );
      const currentTurnDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-history"),
      );
      assert.equal(currentTurnDetail._tag, "Some");
      if (currentTurnDetail._tag === "Some") {
        assert.equal(currentTurnDetail.value.hasMoreCurrentTurnActivities, true);
      }

      const olderPage = yield* snapshotQuery.getThreadActivitiesPage({
        threadId: ThreadId.make("thread-history"),
        turnId: TurnId.make("turn-history"),
        beforeCreatedAt: "2026-04-05T00:01:00.000Z",
        beforeActivityId: asEventId("activity-0241"),
      });
      assert.equal(olderPage.activities.length, 200);
      assert.equal(olderPage.activities[0]?.summary, "activity-41");
      assert.equal(olderPage.activities.at(-1)?.summary, "activity-240");
      assert.equal(olderPage.hasMore, false);

      // Latest-turn rows can sit past a boundary owned by another turn when
      // activities interleave by created_at.
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_unused, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`history-${String(sequence).padStart(4, "0")}`},
              'thread-history', 'turn-history', 'info', 'runtime.note',
              ${`history-${sequence}`}, '{}', ${sequence}, '2026-04-05T00:00:00.000Z'
            )
          `,
        { discard: true },
      );
      yield* Effect.forEach(
        Array.from({ length: 201 }, (_unused, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            ) VALUES (
              ${`other-${String(sequence).padStart(4, "0")}`},
              'thread-history', 'turn-other', 'info', 'runtime.note',
              ${`other-${sequence}`}, '{}', ${sequence + 100}, '2026-04-05T00:01:00.000Z'
            )
          `,
        { discard: true },
      );
      const interleavedDetail = yield* snapshotQuery.getThreadDetailById(
        ThreadId.make("thread-history"),
      );
      assert.equal(interleavedDetail._tag, "Some");
      if (interleavedDetail._tag === "Some") {
        assert.equal(interleavedDetail.value.hasMoreActivities, true);
        assert.equal(interleavedDetail.value.hasMoreCurrentTurnActivities, true);
      }

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
        beforeCreatedAt: "2026-04-05T00:02:00.000Z",
        beforeActivityId: asEventId("sequenced-0003"),
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

  it.effect("caps thread-detail message hydration to the newest SQL-side window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
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
          'project-message-cap',
          'Message cap',
          '/tmp/project-message-cap',
          '{"provider":"copilot","model":"gpt-5.4"}',
          '[]',
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-message-cap',
          'project-message-cap',
          'Message cap thread',
          '{"provider":"copilot","model":"gpt-5.4"}',
          'approval-required',
          'default',
          NULL,
          0,
          0,
          0,
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z',
          NULL
        )
      `;
      // 2,005 messages: five over MAX_THREAD_MESSAGES (2,000) so the
      // test proves the bound is applied in SQL before text/attachment JSON
      // is decoded, not in JS after. Message 1 carries malformed
      // attachments_json but is excluded from the newest window, so any
      // implementation that decodes before capping fails loudly.
      yield* sql`
        WITH RECURSIVE message_sequence(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM message_sequence WHERE value < 2005
        )
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
        SELECT
          printf('cap-msg-%05d', 2006 - value),
          'thread-message-cap',
          NULL,
          'user',
          printf('message %d', value),
          CASE WHEN value = 1 THEN 'not-json' ELSE NULL END,
          0,
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z'
        FROM message_sequence
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-message-cap"));
      assert.equal(detail._tag, "Some");
      if (detail._tag === "None") return;
      assert.equal(detail.value.messages.length, 2000);
      assert.equal(detail.value.messages[0]?.text, "message 6");
      assert.equal(detail.value.messages.at(-1)?.text, "message 2005");
    }),
  );

  it.effect("returns full message history for exports when unbounded", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
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
          'project-export-cap',
          'Export cap',
          '/tmp/project-export-cap',
          '{"provider":"copilot","model":"gpt-5.4"}',
          '[]',
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-export-cap',
          'project-export-cap',
          'Export cap thread',
          '{"provider":"copilot","model":"gpt-5.4"}',
          'approval-required',
          'default',
          NULL,
          0,
          0,
          0,
          '2026-07-28T00:00:00.000Z',
          '2026-07-28T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE message_sequence(value) AS (
          VALUES (1)
          UNION ALL
          SELECT value + 1 FROM message_sequence WHERE value < 2005
        )
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
        SELECT
          printf('export-msg-%05d', value),
          'thread-export-cap',
          NULL,
          'user',
          printf('message %d', value),
          0,
          printf(
            '2026-07-28T00:%02d:%02d.000Z',
            CAST(value / 60 AS INTEGER),
            value % 60
          ),
          printf(
            '2026-07-28T00:%02d:%02d.000Z',
            CAST(value / 60 AS INTEGER),
            value % 60
          )
        FROM message_sequence
      `;

      const threadId = ThreadId.make("thread-export-cap");
      const capped = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.equal(capped._tag, "Some");
      if (capped._tag === "None") return;
      assert.equal(capped.value.messages.length, 2000);
      assert.equal(capped.value.messages[0]?.text, "message 6");

      const full = yield* snapshotQuery.getThreadDetailById(threadId, {
        unboundedMessages: true,
      });
      assert.equal(full._tag, "Some");
      if (full._tag === "None") return;
      assert.equal(full.value.messages.length, 2005);
      assert.equal(full.value.messages[0]?.text, "message 1");
      assert.equal(full.value.messages.at(-1)?.text, "message 2005");
    }),
  );

  // Regression coverage for the snapshot-parallelism review (PR #289):
  // `NodeSqliteClient` is one `DatabaseSync` connection behind `Semaphore(1)`, so
  // read fan-outs cannot overlap SELECTs — and shell/full snapshot row reads must
  // stay in one read transaction with `projection_state`, otherwise `subscribeShell`
  // drops buffered live events through a mismatched `snapshotSequence` (scars #29,
  // #148). The tests below therefore assert completion under contention (no read
  // starvation) and per-snapshot cursor/row consistency — never overlap. They use a
  // barrier `Deferred` plus joined fibers instead of clock sleeps (scar #135).
  it.effect("snapshot reads do not starve a queued writer", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_queued_turns`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM provider_session_runtime`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-read-write', 'Read/write project', '/tmp/read-write',
          '{"provider":"copilot","model":"gpt-5.4"}', '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-read-write', 'project-read-write', 'Read/write thread',
          '{"provider":"copilot","model":"gpt-5.4"}', 'approval-required', 'default',
          NULL, 0, 0, 0,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;

      const blockerPaused = yield* Deferred.make<void>();
      const releaseBlocker = yield* Deferred.make<void>();
      const readersStarted = yield* Deferred.make<void>();
      const startedReaderCount = yield* Ref.make(0);
      const writerStarted = yield* Deferred.make<void>();
      const writerDone = yield* Deferred.make<void>();
      const contentionRounds = 25;

      // Hold one real shell transaction immediately before its cursor query. The
      // queued readers start first, then the writer joins the same semaphore queue.
      // Once released, readers keep submitting snapshots until the writer commits,
      // so the write must progress amid sustained snapshot traffic.
      const blockerFiber = yield* Effect.forkChild(
        snapshotQuery.getShellSnapshot().pipe(
          Effect.provideService(ProjectionSnapshotQueryTestHooks, {
            beforeShellSnapshotCursorRead: Deferred.succeed(blockerPaused, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBlocker)),
            ),
          }),
        ),
      );
      yield* Deferred.await(blockerPaused);

      const readSnapshots = Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(startedReaderCount, (n) => n + 1);
        if (count === 3) {
          yield* Deferred.succeed(readersStarted, undefined);
        }
        let sawWrite = false;
        for (let round = 0; round < contentionRounds && !sawWrite; round += 1) {
          yield* snapshotQuery.getShellSnapshot().pipe(Effect.asVoid);
          sawWrite = yield* Deferred.isDone(writerDone);
        }
        assert.isTrue(sawWrite, "late write must commit while snapshot reads keep arriving");
      });
      const readerFibers = yield* Effect.forEach([0, 1, 2], () => Effect.forkChild(readSnapshots));
      yield* Deferred.await(readersStarted);
      yield* Effect.yieldNow;

      const writerFiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(writerStarted, undefined);
          yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json, scripts_json,
            created_at, updated_at, deleted_at
          ) VALUES (
            'project-read-write-late', 'Late write', '/tmp/read-write-late',
            '{"provider":"copilot","model":"gpt-5.4"}', '[]',
            '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:01.000Z', NULL
          )
        `;
          yield* Deferred.succeed(writerDone, undefined);
        }),
      );
      yield* Deferred.await(writerStarted);
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(writerDone));
      yield* Deferred.succeed(releaseBlocker, undefined);
      yield* Fiber.join(blockerFiber);
      yield* Fiber.join(writerFiber);
      yield* Effect.forEach(readerFibers, (fiber) => Fiber.join(fiber), { discard: true });

      const reread = yield* snapshotQuery.getShellSnapshot();
      assert.isTrue(reread.projects.some((project) => project.id === "project-read-write-late"));
    }),
  );

  it.effect("shell snapshots keep rows and cursor atomic across an in-window commit", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      const projectId = "project-shell-race";
      const threadIdFor = (sequence: number): string => `thread-shell-race-${sequence}`;
      // `computeSnapshotSequence` takes the minimum over every required projector, so each
      // simulated projection commit must advance all of them together.
      const requiredProjectors = [
        ORCHESTRATION_PROJECTOR_NAMES.projects,
        ORCHESTRATION_PROJECTOR_NAMES.threads,
        ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        ORCHESTRATION_PROJECTOR_NAMES.queuedTurns,
        ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        ORCHESTRATION_PROJECTOR_NAMES.workflows,
      ] as const;

      const clearRaceTables = Effect.gen(function* () {
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_queued_turns`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM provider_session_runtime`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_state`;
      });

      const body = Effect.gen(function* () {
        yield* clearRaceTables;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json, scripts_json,
            created_at, updated_at, deleted_at
          ) VALUES (
            ${projectId}, 'Shell race project', '/tmp/shell-race',
            '{"provider":"copilot","model":"gpt-5.4"}', '[]',
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
          )
        `;
        // Explicitly sequential: every projector row starts at sequence 0.
        yield* Effect.forEach(
          requiredProjectors,
          (projector) =>
            sql`
              INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
              VALUES (${projector}, 0, '2026-09-01T00:00:00.000Z')
            `,
          { discard: true },
        );

        // One simulated projection commit: the new thread row and its cursor advance
        // commit together, exactly like the real projector.
        const commitBatch = (sequence: number) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE projection_state
                SET last_applied_sequence = ${sequence}, updated_at = '2026-09-01T00:00:00.000Z'
              `;
              yield* sql`
                INSERT INTO projection_threads (
                  thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
                  latest_user_message_at, pending_approval_count, pending_user_input_count,
                  has_actionable_proposed_plan, created_at, updated_at, deleted_at
                ) VALUES (
                  ${threadIdFor(sequence)}, ${projectId}, ${`Race thread ${sequence}`},
                  '{"provider":"copilot","model":"gpt-5.4"}', 'approval-required', 'default',
                  NULL, 0, 0, 0,
                  '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
                )
              `;
            }),
          );

        const snapshotPaused = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const writerStarted = yield* Deferred.make<void>();
        const writerDone = yield* Deferred.make<void>();

        const snapshotFiber = yield* Effect.forkChild(
          snapshotQuery.getShellSnapshot().pipe(
            Effect.provideService(ProjectionSnapshotQueryTestHooks, {
              beforeShellSnapshotCursorRead: Deferred.succeed(snapshotPaused, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
              ),
            }),
          ),
        );
        yield* Deferred.await(snapshotPaused);

        const writerFiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Deferred.succeed(writerStarted, undefined);
            yield* commitBatch(1);
            yield* Deferred.succeed(writerDone, undefined);
          }),
        );
        yield* Deferred.await(writerStarted);
        yield* Effect.yieldNow;

        // The commit was released after shell rows were read but before the cursor
        // query. The snapshot transaction must keep it queued until the cursor is
        // read; without `withTransaction`, the writer completes here and the
        // snapshot returns old rows with cursor 1.
        assert.isFalse(yield* Deferred.isDone(writerDone));
        yield* Deferred.succeed(releaseSnapshot, undefined);

        const snapshot = yield* Fiber.join(snapshotFiber);
        yield* Fiber.join(writerFiber);
        assert.equal(snapshot.snapshotSequence, 0);
        assert.isFalse(snapshot.threads.some((thread) => thread.id === threadIdFor(1)));

        const after = yield* snapshotQuery.getShellSnapshot();
        assert.equal(after.snapshotSequence, 1);
        assert.isTrue(after.threads.some((thread) => thread.id === threadIdFor(1)));
      });

      yield* Effect.ensuring(body, Effect.ignore(clearRaceTables));
    }),
  );

  it.effect("resolves owning projects for live threads in one narrow query", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      assert.ok(snapshotQuery.listThreadProjectIds);
      const listThreadProjectIds = snapshotQuery.listThreadProjectIds;
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('search-project', 'Search Project', '/tmp/search-project', '[]',
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        ) VALUES
          ('search-live', 'search-project', 'Live thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z', NULL),
          ('search-deleted', 'search-project', 'Deleted thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z',
            '2026-09-14T00:00:01.000Z')
      `;

      // Empty input short-circuits without touching SQL.
      assert.strictEqual((yield* listThreadProjectIds([])).size, 0);

      const projectIds = yield* listThreadProjectIds([
        asThreadId("search-live"),
        asThreadId("search-deleted"),
        asThreadId("search-missing"),
      ]);
      // Live threads resolve; soft-deleted and unknown threads are absent,
      // matching getThreadDetailById filtering for search enrichment.
      assert.deepStrictEqual(
        [...projectIds],
        [[asThreadId("search-live"), asProjectId("search-project")]],
      );
    }),
  );
});
