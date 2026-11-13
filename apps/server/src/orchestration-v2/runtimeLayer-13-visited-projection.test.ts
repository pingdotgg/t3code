import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ROLLBACK_FAILED_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./pullRequestWatch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { modelSelection, layerSharedApplicationDataPlaneTest } from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerSharedApplicationDataPlaneTest)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, Orchestrator.OrchestratorDispatchError);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        'item:visited:unreadable-history', ${threadId}, 1, 'dynamic_tool', 'completed',
        ${visitedAt}, '{broken'
      )`;
      const nextVisitedAt = "2026-07-24T02:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-without-history"),
        threadId,
        visitedAt: nextVisitedAt,
      });
      const [watermark] = yield* sql<{ readonly visited_at: string; readonly updated_at: string }>`
        SELECT json_extract(payload_json, '$.lastVisitedAt') AS visited_at, updated_at
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      assert.equal(watermark!.visited_at, nextVisitedAt);
      assert.equal(watermark!.updated_at, DateTime.formatIso(createdUpdatedAt));
      const invalidVisit = yield* orchestrator
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("runtime-layer-visited-invalid-timestamp"),
          threadId,
          visitedAt: "invalid-timestamp",
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalidVisit, Orchestrator.OrchestratorDispatchError);
    }),
  );

  it.effect("marks unread before the user's last turn when an automatic compaction followed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-mark-unread-compacted");
      const turnCompletedAt = DateTime.makeUnsafe("2026-07-24T10:00:00.000Z");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Compacted thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const runs = [
        { text: "Continue", at: turnCompletedAt },
        {
          text: "/compact",
          idleCompaction: "beforeCacheExpires" as const,
          at: DateTime.makeUnsafe("2026-07-24T11:00:00.000Z"),
        },
      ];
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make(`${threadId}:seed`),
        events: runs.flatMap(({ at, ...message }, index) => {
          const runId = RunId.make(`${threadId}:run-${index}`);
          const messageId = MessageId.make(`${threadId}:message-${index}`);
          return [
            {
              id: EventId.make(`${messageId}:event`),
              type: "message.updated" as const,
              threadId,
              occurredAt: at,
              payload: {
                ...message,
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                attachments: [],
                streaming: false,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: at,
                updatedAt: at,
              },
            },
            {
              id: EventId.make(`${runId}:event`),
              type: "run.created" as const,
              threadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: at,
              payload: {
                id: runId,
                threadId,
                ordinal: index + 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                queuePosition: null,
                requestedAt: at,
                startedAt: at,
                completedAt: at,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ];
        }),
      });

      yield* orchestrator.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`${threadId}:mark-unread`),
        threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.thread.lastVisitedAt,
        DateTime.subtract(turnCompletedAt, { milliseconds: 1 }),
      );
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(shell!.latestRunCompletedAt, turnCompletedAt);
      assert.deepEqual(shell!.lastVisitedAt, projection.thread.lastVisitedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make(`${threadId}:visit`),
        threadId,
        visitedAt: DateTime.formatIso(turnCompletedAt),
      });
      const revisited = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(revisited!.lastVisitedAt, turnCompletedAt);
    }),
  );
});
it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("thread opens", (it) => {
  it.effect(
    "counts opens on the server clock, merges quick reopens, and keeps picked queries",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-opened-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-opened-thread-create"),
          threadId,
          projectId: ProjectId.make("runtime-layer-opened-project"),
          title: "Opened thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        let visits = 0;
        const visit = (input: { readonly opened?: boolean; readonly searchQuery?: string }) =>
          orchestrator.dispatch({
            type: "thread.visit",
            commandId: CommandId.make(`runtime-layer-opened-visit-${++visits}`),
            threadId,
            // A client clock far in the past must not move the open time.
            visitedAt: "2000-01-01T00:00:00.000Z",
            ...input,
          });
        const opens = Effect.map(
          orchestrator.getShellSnapshot(),
          (shell) => shell.threads.find((thread) => thread.id === threadId)?.opens ?? null,
        );
        const start = DateTime.toEpochMillis(yield* DateTime.now);

        yield* visit({ opened: true, searchQuery: "  Upl " });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [{ query: "upl", at: start }],
        });

        yield* TestClock.adjust("1 minute");
        yield* visit({ opened: true, searchQuery: "Uploadthing docs" });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [
            { query: "uploadthing docs", at: start + 60_000 },
            { query: "upl", at: start },
          ],
        });

        yield* TestClock.adjust("14 days");
        yield* visit({});
        yield* visit({ opened: true });
        const later = yield* opens;
        assert.closeTo(later!.score, 1 + 2 ** (-(14 * 24 * 60 + 1) / (14 * 24 * 60)), 1e-9);
        assert.equal(later!.openedAt, DateTime.toEpochMillis(yield* DateTime.now));
        // Opening without a query keeps each pick and its time.
        assert.deepEqual(later!.picks, [
          { query: "uploadthing docs", at: start + 60_000 },
          { query: "upl", at: start },
        ]);
      }),
  );
});
it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("PR link events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      const repositoryWebUrl = "https://github.com/pingdotgg/t3code/pull/2";
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
          ...(number === 2 ? { repositoryWebUrl } : {}),
        });
      }
      const watchedLink = {
        url: "https://github.com/pingdotgg/t3code/pull/3",
        repositoryWebUrl: "https://github.com/pingdotgg/t3code/pull/3",
        source: "manual" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-new"),
        threadId,
        ...key,
        number: 3,
        watching: true,
        link: watchedLink,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-existing"),
        threadId,
        ...key,
        number: 2,
        watching: true,
      });
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/pingdotgg/t3code/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.propertyVal(after?.pullRequests?.[1], "repositoryWebUrl", repositoryWebUrl);
      assert.deepInclude(after?.pullRequests?.[2], watchedLink);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
    }),
  );
});
it.layer(layerSharedApplicationDataPlaneTest)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectInput = {
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
      };

      const created = yield* projects.create(projectInput);
      const retried = yield* projects.create(projectInput);
      assert.deepEqual(retried, created);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.isTrue("aggregateKind" in projectEvent && projectEvent.aggregateId === projectId);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projects.getById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});
