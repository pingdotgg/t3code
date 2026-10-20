import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  OrchestratorMcpTarget,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
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
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const decodeTarget = Schema.decodeUnknownEffect(OrchestratorMcpTarget);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
);

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
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
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
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
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
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
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
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
        thread: { id: childThreadId },
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
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
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
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
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

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
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
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
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
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
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
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("leaves models the user hid out of the capability catalog", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-5.4-mini", "my-model"], modelOrder: [] },
          },
        }),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              ...codex.models,
              { slug: "gpt-5.4-mini", name: "Mini", isCustom: false, capabilities: null },
              { slug: "my-model", name: "Mine", isCustom: true, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((model) => model.id),
          ["gpt-5.4", "my-model"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    {
      name: "installation",
      snapshot: { installed: false, version: null, status: "warning", auth: { status: "unknown" } },
      constraints: ["Provider executable is not installed."],
    },
    {
      name: "health",
      snapshot: { status: "error", message: "Provider health check failed." },
      constraints: ["Provider health check failed."],
    },
    {
      name: "authentication",
      snapshot: { auth: { status: "unauthenticated" } },
      constraints: ["Provider is not authenticated."],
    },
    {
      name: "combined installation and health",
      snapshot: {
        installed: false,
        version: null,
        status: "error",
        message: "Provider executable could not be found.",
        auth: { status: "unknown" },
      },
      constraints: [
        "Provider executable is not installed.",
        "Provider executable could not be found.",
      ],
    },
    {
      name: "disabled with stale probe failures",
      snapshot: {
        enabled: false,
        installed: false,
        version: null,
        status: "error",
        message: "Stale provider health failure.",
        auth: { status: "unauthenticated" },
      },
      constraints: ["Provider instance is disabled."],
    },
  ] as const)("reports $name provider constraints", (testCase) =>
    Effect.gen(function* () {
      const provider: ServerProvider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...testCase.snapshot,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const entry = capabilities.providers.find(
          (candidate) => candidate.providerInstanceId === codexInstanceId,
        );
        assert.isDefined(entry);
        assert.isFalse(entry!.canRunChildTask);
        assert.isFalse(entry!.canRunCrossProviderChildTask);
        assert.deepEqual(entry!.constraints, testCase.constraints);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  for (const vcs of ["git", "jj"] as const) {
    it.effect.each([true, false])(
      `checks project containment of the parent's ${vcs} checkout revision (contained: %s)`,
      (containsBase) =>
        Effect.gen(function* () {
          let delegated = false;
          const task = {
            id: taskId,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver: ProviderDriverKind.make("antigravity"),
            providerInstanceId: antigravityInstanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: "Summarize the diff.",
            title: null,
            model: "ant-model",
            status: "running",
            result: null,
            startedAt: null,
            completedAt: null,
          };
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const parentCwd = "/parent/secondary-workspace";
          const resolvedCwds: string[] = [];
          const containmentChecks: Array<{ readonly cwd: string; readonly refName: string }> = [];
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? {
                        ...parentProjection(delegated ? [task] : []),
                        thread: {
                          ...parentProjection([]).thread,
                          worktreePath: parentCwd,
                        },
                      }
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitWorkflowService.GitWorkflowService)({
              committedBase: (cwd) => {
                assert.equal(cwd, parentCwd);
                resolvedCwds.push(cwd);
                return Effect.succeed(vcs === "jj" ? "jj-current-commit" : "git-head-commit");
              },
              hasCommit: (input) => {
                containmentChecks.push(input);
                return Effect.succeed(containsBase);
              },
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                providerSnapshot({
                  instanceId: codexInstanceId,
                  driver: ProviderDriverKind.make("codex"),
                  model: "gpt-5.4",
                }),
                providerSnapshot({
                  instanceId: antigravityInstanceId,
                  driver: ProviderDriverKind.make("antigravity"),
                  model: "ant-model",
                }),
              ]),
            }),
            adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeed(
                  Option.some({
                    id: projectId,
                    title: "Parent project",
                    workspaceRoot: "/parent/main",
                  } as unknown as ProjectRecord),
                ),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const delegation = service.delegateTask(scope, {
              task: "Summarize the diff.",
              target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
              mode: "async",
              isolation: "worktree",
              clientRequestId: "delegate-antigravity-1",
            });
            if (!containsBase) {
              const error = yield* delegation.pipe(Effect.flip);
              assert.deepEqual(resolvedCwds, [parentCwd]);
              assert.equal(error.code, "invalid_request");
              assert.equal(
                error.message,
                `Isolation "worktree" creates the child checkout in project "Parent project" (/parent/main), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
              );
              assert.deepEqual(yield* Ref.get(dispatched), []);
              assert.deepEqual(containmentChecks, [
                {
                  cwd: "/parent/main",
                  refName: vcs === "jj" ? "jj-current-commit" : "git-head-commit",
                },
              ]);
              return;
            }
            const result = yield* delegation;
            assert.deepEqual(containmentChecks, [
              {
                cwd: "/parent/main",
                refName: vcs === "jj" ? "jj-current-commit" : "git-head-commit",
              },
            ]);
            assert.equal(result.status, "running");
            assert.equal(result.providerInstanceId, antigravityInstanceId);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1);
            const request = commands[0] as {
              type: string;
              modelSelection: { instanceId: string; model: string };
              workspaceStrategy: unknown;
            };
            assert.equal(request.type, "delegated_task.request");
            assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
            assert.equal(request.modelSelection.model, "ant-model");
            assert.deepEqual(request.workspaceStrategy, {
              type: "worktree",
              baseRef: vcs === "jj" ? "jj-current-commit" : "git-head-commit",
              startFromOrigin: false,
            });
            assert.deepEqual(resolvedCwds, [parentCwd]);
          }).pipe(
            Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))),
          );
        }),
    );
  }

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses delegation to a provider the project turned off", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: codexInstanceId,
              }),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-disabled-1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.live.each([
    { name: "parent instance", parentEnabled: true, model: "gpt-5.4" },
    { name: "alternate instance", parentEnabled: false, model: "gpt-5.5" },
  ])(
    "replays accepted creation on the $name without authorizing new disabled work",
    ({ parentEnabled, model }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const altInstanceId = ProviderInstanceId.make("codex-alt");
          const driver = ProviderDriverKind.make("codex");
          const cwd = yield* checkpointWorkspace("mcp-create-retry");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
            [codexInstanceId, altInstanceId].map((instanceId) => ({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.die("These tests exercise committed commands before provider execution."),
            })),
          );
          const layerDatabase = SqlitePersistence.layerMemory;
          const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
            { name: "mcp-create-retry", runtimePolicyOverride: { cwd } },
            layerRegistry,
            { databaseLayer: layerDatabase, runEffectWorker: false },
          );
          const layerSettings = ServerSettings.layerTest({
            providerInstances: {
              [codexInstanceId]: { driver: "codex", enabled: true },
              [altInstanceId]: { driver: "codex", enabled: true },
            },
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [codexInstanceId]: { enabled: parentEnabled } } },
            },
          });
          const layerThreads = ThreadManagementService.layer.pipe(
            Layer.provideMerge(layerOrchestrator),
            Layer.provide(
              LegacyV1ThreadImporter.layer.pipe(
                Layer.provide(layerOrchestrator),
                Layer.provide(layerDatabase),
              ),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
            Layer.provideMerge(layerSettings),
          );
          const layerTest = layerOrchestratorService.pipe(
            Layer.provideMerge(layerThreads),
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                layerRegistry,
                layerSettings,
                providerRegistryLayer([
                  providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                  providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
                ]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("parent:message"),
              text: "Create a thread.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const request = {
              threads: [{ target: { driverKind: driver, model } }],
              clientRequestId: "create-retry",
            };
            const first = yield* service.createThreads(scope, request);
            const child = first.threads[0]!;
            const selection = parentEnabled
              ? { instanceId: codexInstanceId, model: "gpt-5.4" }
              : { instanceId: altInstanceId, model: "gpt-5.5" };
            assert.equal(first.threads.length, 1);
            assert.equal(child.providerInstanceId, selection.instanceId);
            assert.equal(child.model, selection.model);
            assert.deepEqual(yield* service.createThreads(scope, request), first);

            // The creation receipt exists, but this prompt has not been accepted yet.
            const withPrompt = {
              ...request,
              threads: [{ ...request.threads[0]!, prompt: "Start work." }],
            };
            const started = yield* service.createThreads(scope, withPrompt);
            assert.equal(started.threads[0]?.threadId, child.threadId);
            const before = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(before.runs[0]?.modelSelection, selection);
            assert.equal(before.messages.length, 1);
            const empty = yield* service.createThreads(scope, {
              ...request,
              clientRequestId: "empty",
            });

            yield* settings.updateSettings({
              projectSettingsOverrides: {
                [projectId]: {
                  providerInstances: {
                    [codexInstanceId]: { enabled: false },
                    [altInstanceId]: { enabled: false },
                  },
                },
              },
            });
            assert.deepEqual(yield* service.createThreads(scope, withPrompt), started);
            const after = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(after.thread.modelSelection, selection);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);

            const freshError = yield* service
              .createThreads(scope, {
                ...request,
                clientRequestId: "fresh",
              })
              .pipe(Effect.flip);
            assert.equal(freshError.code, "provider_unavailable");
            const promptError = yield* service
              .createThreads(scope, {
                ...withPrompt,
                clientRequestId: "empty",
              })
              .pipe(Effect.flip);
            assert.equal(promptError.code, "invalid_request");
            assert.include(promptError.message, "disabled");
            const untouched = yield* orchestrator.getThreadProjection(empty.threads[0]!.threadId);
            assert.equal(untouched.messages.length, 0);
            assert.equal(untouched.runs.length, 0);
          }).pipe(Effect.provide(layerTest));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.equal(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.equal(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });
  it.effect(
    "reports the child run's selection after a restart and the thread selection before launch",
    () =>
      Effect.gen(function* () {
        const runSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent-personal"),
          model: "claude-opus-4-6",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        } as const;
        const threadSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        let hasRun = true;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection([task])
                  : ({
                      ...childProjection,
                      thread: { ...childProjection.thread, modelSelection: threadSelection },
                      runs: hasRun
                        ? [
                            {
                              id: RunId.make("run:mcp-restarted-child"),
                              ordinal: 1,
                              status: "running",
                              modelSelection: runSelection,
                            },
                          ]
                        : [],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const selection of [runSelection, threadSelection]) {
            const result = yield* service.taskStatus(scope, taskId);
            assert.equal(result.providerInstanceId, selection.instanceId);
            assert.equal(result.model, selection.model);
            assert.deepEqual(result.options, selection.options);
            hasRun = false;
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect(
    "inherits delegated options, merges overrides, and resets on explicit clearing or a new target",
    () =>
      Effect.gen(function* () {
        const peerId = ProviderInstanceId.make("codex-subscription-2");
        const driver = ProviderDriverKind.make("codex");
        const inherited = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        } as const;
        const override = [{ id: "reasoningEffort", value: "max" }] as const;
        const cases = [
          {
            name: "partial override",
            target: { options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            name: "clear with array",
            target: { options: [] },
            expected: { ...inherited, options: [] },
          },
          {
            name: "clear with object",
            target: { options: {} },
            expected: { ...inherited, options: [] },
          },
          {
            name: "change model",
            target: { model: "other-model" },
            expected: { instanceId: codexInstanceId, model: "other-model" },
          },
          {
            name: "change provider with override",
            target: { providerInstanceId: peerId, options: { reasoningEffort: "max" } },
            expected: { instanceId: peerId, model: inherited.model, options: override },
          },
        ] as const;
        for (const testCase of cases) {
          const commands: Array<unknown> = [];
          const task = {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            providerInstanceId: testCase.expected.instanceId,
            model: testCase.expected.model,
            status: "running",
            result: null,
          };
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                    : childProjection,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return {
                    sequence: 1,
                    storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                  } as never;
                }),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: inherited.model,
                }),
                models: [inherited.model, "other-model"].map((model) => ({
                  slug: model,
                  name: model,
                  isCustom: false,
                  capabilities: null,
                })),
              },
              providerSnapshot({ instanceId: peerId, driver, model: inherited.model }),
            ]),
            adapterRegistryLayer([codexInstanceId, peerId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(capabilities.inheritedOptions, inherited.options);
            yield* service.delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget(testCase.target),
              mode: "async",
              clientRequestId: testCase.name,
            });
            assert.deepEqual(
              (commands[0] as { modelSelection: unknown }).modelSelection,
              testCase.expected,
              testCase.name,
            );
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }
      }),
  );

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* OrchestratorMcpService.resolveRuntimeMode(
          "full-access",
          "auto-accept-edits",
          muse,
        ).pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("full-access", "inherit", muse),
          "full-access",
        );
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("auto", undefined, muse),
          "approval-required",
        );
      }),
    );
  });
});
