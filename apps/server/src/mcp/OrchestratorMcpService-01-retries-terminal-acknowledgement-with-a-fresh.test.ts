import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpTarget,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  decodeTarget,
  layerOrchestratorService,
} from "./OrchestratorMcpService-fixtures.testkit.ts";

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const resultTransferId = ContextTransferId.make("transfer:mcp-ack-result");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [
          {
            id: resultTransferId,
            type: "subagent_result",
            sourceThreadId: childThreadId,
            targetThreadId: parentThreadId,
            sourcePoint: { runId: childRunId },
          },
        ],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [
          {
            id: MessageId.make("message:mcp-ack-result"),
            runId: childRunId,
            role: "assistant",
            text: "terminal result",
            createdAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
        ],
        turnItems: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      let settleAfterTaskRead = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.sync(() => {
              if (threadId !== parentThreadId) {
                return hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection;
              }
              const snapshot = hasNestedWork
                ? {
                    ...parentProjection,
                    contextTransfers: [],
                    subagents: parentProjection.subagents.map((task) => ({
                      ...task,
                      result: null,
                      status: "running" as const,
                    })),
                  }
                : parentProjection;
              if (settleAfterTaskRead) {
                settleAfterTaskRead = false;
                hasNestedWork = false;
              }
              return snapshot;
            }),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.isNull(pending.resultContextTransferId);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        // Completion lands after task selection, before the remaining parent/child reads.
        hasNestedWork = true;
        settleAfterTaskRead = true;
        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        assert.equal(result.resultContextTransferId, resultTransferId);
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [
          {
            id: RunId.make("run:mcp-restart-child"),
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
          },
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isNull(held.summary);
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("tells the parent to end its turn only while its task still runs", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-next-parent");
      const childThreadId = ThreadId.make("thread:mcp-next-child");
      const taskId = NodeId.make("node:mcp-next-task");
      let finished = false;
      let pendingRequest = false;
      const parentProjection = () =>
        ({
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: finished ? "completed" : "running",
              result: finished ? "done" : null,
              completionDelivery: { state: "pending" },
            },
          ],
        }) as unknown as OrchestrationV2ThreadProjection;
      const childRun = () => ({
        id: RunId.make("run:mcp-next-child"),
        ordinal: 1,
        status: finished ? ("completed" as const) : ("running" as const),
        delegatedTaskId: taskId,
      });
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs: [childRun()],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: pendingRequest ? [{ status: "pending" }] : [],
          nodes: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection() : childProjection()),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getProjectThreadRecords: () => Effect.succeed(childProjection()),
          waitForThread: () =>
            Effect.succeed({
              threadId: childThreadId,
              run: childRun() as unknown as OrchestrationV2ThreadProjection["runs"][number],
              timedOut: !finished,
            }),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-next"),
        requestNamespace: "provider-session:mcp-next",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-next",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const running = yield* service.taskStatus(scope, taskId);
        assert.equal(running.status, "running");
        assert.equal(running.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        const waiting = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(waiting.timedOut);
        assert.equal(waiting.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

        // A child waiting on a question or approval needs an answer, not a wake.
        pendingRequest = true;
        const asking = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(asking.timedOut);
        assert.notProperty(asking, "next");
        pendingRequest = false;

        finished = true;
        const completed = yield* service.taskStatus(scope, taskId);
        assert.equal(completed.status, "completed");
        assert.notProperty(completed, "next");
        const waited = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(waited.status, "completed");
        assert.notProperty(waited, "next");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["no runs", "a finished run"] as const)(
    "cancels an orphaned follow-up through its parent when the child has %s",
    (childState) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-orphan-parent");
        const childThreadId = ThreadId.make("thread:mcp-orphan-child");
        const taskId = NodeId.make("node:mcp-orphan-task");
        const parentRunId = RunId.make("run:mcp-orphan-parent");
        const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
        const status = yield* Ref.make("running");
        const parentProjection = (taskStatus: string) =>
          ({
            thread: { id: parentThreadId },
            runs: [],
            contextTransfers: [],
            subagents: [
              {
                id: taskId,
                threadId: parentThreadId,
                runId: parentRunId,
                origin: "app_owned",
                childThreadId,
                driver: "codex",
                model: "gpt-5.6-terra",
                status: taskStatus,
                result: null,
                completionDelivery: { state: "pending" },
              },
            ],
          }) as unknown as OrchestrationV2ThreadProjection;
        // A finished run whose binding to the follow-up was lost.
        const childProjection = {
          thread: { id: childThreadId, title: "Child" },
          runs:
            childState === "no runs"
              ? []
              : [{ id: RunId.make("run:mcp-orphan-child"), ordinal: 1, status: "completed" }],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              threadId === parentThreadId
                ? Effect.map(Ref.get(status), parentProjection)
                : Effect.succeed(childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            listAppOwnedChildThreadIds: () => Effect.succeed([]),
            delegatedTaskResultPending: () => Effect.succeed(false),
            stopDelegatedTasks: () => Effect.void,
            // The orchestrator's subagent.stop repair is covered in ThreadStop.test.ts.
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  command.type === "subagent.stop" ? Ref.set(status, "cancelled") : Effect.void,
                ),
                Effect.as({} as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-orphan"),
          requestNamespace: "provider-session:mcp-orphan",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-orphan",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.cancelTask(scope, {
            taskId,
            clientRequestId: "cancel-orphan-task",
          });
          assert.deepEqual(result, { taskId, status: "cancelled" });
          const commands = yield* Ref.get(dispatched);
          // A child whose run finished can still run another turn's work, so it is stopped too.
          assert.deepEqual(
            commands.flatMap((command) =>
              command.type === "thread.stop" ? [command.threadId] : [],
            ),
            childState === "a finished run" ? [childThreadId] : [],
          );
          const stop = commands.find((command) => command.type === "subagent.stop");
          if (stop?.type !== "subagent.stop") return;
          assert.deepEqual(
            { threadId: stop.threadId, runId: stop.runId, subagentId: stop.subagentId },
            { threadId: parentThreadId, runId: parentRunId, subagentId: taskId },
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );
});
