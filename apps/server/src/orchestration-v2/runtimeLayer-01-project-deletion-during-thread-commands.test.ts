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

import { modelSelection, layerProjectDeletionTest } from "./runtimeLayer-fixtures.testkit.ts";

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["thread", "project"] as const)(
    "deleting a %s removes its thread-bound automations through the effect worker",
    (deletion) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const projectId = ProjectId.make(`automation-delete-project:${deletion}`);
        const threadId = ThreadId.make(`automation-delete-thread:${deletion}`);
        const otherThreadId = ThreadId.make(`automation-surviving-thread:${deletion}`);
        yield* projects.create({
          commandId: CommandId.make(`automation-create-project:${deletion}`),
          projectId,
          title: "Automation lifecycle",
          workspaceRoot: `/work/automation-lifecycle/${deletion}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`automation-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : ProjectId.make("automation-other-project"),
            title: "Automation target",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        const save = (name: string, target: ThreadId | null, webhook = false) =>
          tasks.upsert({
            id: ScheduledTaskId.make(`automation:${deletion}:${name}`),
            title: name,
            prompt: "Check orchestration progress",
            enabled: !webhook,
            schedule: webhook ? { type: "webhook" } : { type: "interval", everyMs: 60_000 },
            projectId,
            threadId: target,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          });
        const { task: bound } = yield* save("bound", threadId);
        const { task: webhook } = yield* save("webhook", threadId, true);
        const { task: independent } = yield* save("independent", null);
        yield* save("detached", threadId);
        const { task: detached } = yield* save("detached", null);
        yield* save("moved", threadId);
        const { task: moved } = yield* save("moved", otherThreadId);
        const { task: other } = yield* save("other", otherThreadId);
        yield* tasks.triggerWebhook({
          hookId: webhook.id,
          token: webhook.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: webhook.webhook!.path,
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
        });
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 1);

        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`automation-archive:${deletion}`),
          threadId,
        });
        yield* worker.drain();
        assert.include(
          (yield* tasks.list()).tasks.map((task) => task.id),
          bound.id,
        );

        if (deletion === "thread") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`automation-delete:${deletion}`),
            threadId,
          });
        } else {
          yield* projects.delete({
            commandId: CommandId.make(`automation-delete:${deletion}`),
            projectId,
            force: true,
          });
        }
        yield* worker.drain();
        const remainingIds = (yield* tasks.list()).tasks.map((task) => task.id);
        assert.notInclude(remainingIds, bound.id);
        assert.notInclude(remainingIds, webhook.id);
        assert.includeMembers(remainingIds, [independent.id, detached.id, moved.id, other.id]);
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 0);
        const rejected = yield* tasks.runNow({ id: bound.id }).pipe(Effect.flip);
        assert.equal(rejected.message, "Schedule task not found.");
        assert.equal(
          (yield* tasks.triggerWebhook({
            hookId: webhook.id,
            token: webhook.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: webhook.webhook!.path,
            query: "",
            headers: {},
            body: new Uint8Array(),
            bodyText: "",
          }))._tag,
          "not_found",
        );
        // Retried cleanup is harmless and cannot affect unrelated tasks.
        yield* tasks.deleteForThread(threadId);
        assert.sameMembers(
          (yield* tasks.list()).tasks.map((task) => task.id),
          remainingIds,
        );
      }),
  );

  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect(
    "deletes a side chat with its parent only after the side chat's in-flight command",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projectId = ProjectId.make("runtime-side-chat-delete");
        const parentId = ThreadId.make("runtime-side-chat-delete-parent");
        const sideChatId = ThreadId.make("runtime-side-chat-delete-child");
        const updateCommandId = CommandId.make("runtime-side-chat-delete-update");
        yield* projects.create({
          commandId: CommandId.make("runtime-side-chat-delete-project"),
          projectId,
          title: "Side chat deletion",
          workspaceRoot: "/work/side-chat-deletion",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("runtime-side-chat-delete-create"),
          createdBy: "user",
          creationSource: "web",
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("runtime-side-chat-delete-fork"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        const updateReady = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const deletionQueued = yield* Deferred.make<void>();
        const commitCommand = eventSink.commitCommand;
        const withLock = executor.withLock;
        let sideChatLockRequests = 0;
        const commitSpy = vi
          .spyOn(eventSink, "commitCommand")
          .mockImplementation((input) =>
            input.commandId === updateCommandId
              ? Deferred.succeed(updateReady, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseUpdate)),
                  Effect.andThen(commitCommand(input)),
                )
              : commitCommand(input),
          );
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) => {
          if (key !== sideChatId || ++sideChatLockRequests !== 2) return withLock(key, effect);
          return Deferred.succeed(deletionQueued, undefined).pipe(
            Effect.andThen(withLock(key, effect)),
          );
        };
        const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const updateFiber = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: updateCommandId,
              threadId: sideChatId,
              title: "Updated before deletion",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(updateReady),
            Fiber.join(updateFiber).pipe(
              Effect.andThen(
                Effect.die("The update completed before reaching its commit barrier."),
              ),
            ),
          );
          const deleteFiber = yield* orchestrator
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make("runtime-side-chat-delete-parent"),
              threadId: parentId,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(deletionQueued),
            Fiber.join(deleteFiber).pipe(
              Effect.andThen(Effect.die("Parent deletion bypassed the side chat's command.")),
            ),
          );
          yield* Deferred.succeed(releaseUpdate, undefined);
          yield* Fiber.join(updateFiber);
          yield* Fiber.join(deleteFiber);
          const sideChat = yield* orchestrator.getThreadProjection(sideChatId);
          assert.isNotNull(sideChat.thread.deletedAt);
          assert.equal(sideChat.thread.title, "Updated before deletion");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              commitSpy.mockRestore();
              lockSpy.mockRestore();
            }),
          ),
        );
      }),
  );

  // A fork from a side chat onto its parent used to lock the side chat, then the parent: the
  // reverse of the parent delete's order.
  it.effect("a parent delete and a fork from its side chat onto the parent do not deadlock", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-side-chat-lock-order");
      const parentId = ThreadId.make("runtime-side-chat-lock-order-parent");
      const sideChatId = ThreadId.make("runtime-side-chat-lock-order-child");
      yield* projects.create({
        commandId: CommandId.make("runtime-side-chat-lock-order-project"),
        projectId,
        title: "Side chat lock order",
        workspaceRoot: "/work/side-chat-lock-order",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-side-chat-lock-order-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("runtime-side-chat-lock-order-fork"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

      const deleteHoldsParent = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      const forkWaitsForParent = yield* Deferred.make<void>();
      const withLock = executor.withLock;
      let parentLockRequests = 0;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== parentId) return withLock(key, effect);
        // Dispatch builds locks it may not run, so count when one runs.
        return Effect.suspend(() =>
          ++parentLockRequests === 1
            ? withLock(
                key,
                Deferred.succeed(deleteHoldsParent, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDelete)),
                  Effect.andThen(effect),
                ),
              )
            : Deferred.succeed(forkWaitsForParent, undefined).pipe(
                Effect.andThen(withLock(key, effect)),
              ),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const deleteFiber = yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-side-chat-lock-order-delete"),
            threadId: parentId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deleteHoldsParent);
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-side-chat-lock-order-fork-back"),
            sourceThreadId: sideChatId,
            targetThreadId: parentId,
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(forkWaitsForParent);
        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(deleteFiber);
        yield* Fiber.join(forkFiber);
        assert.isNotNull((yield* orchestrator.getThreadProjection(parentId)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
      }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
    }),
  );
});
