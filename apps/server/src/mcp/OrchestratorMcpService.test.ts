import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ScheduledTask,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import {
  ProviderAdapterRegistryLookupError,
  ProviderAdapterRegistryV2,
} from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

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
        runs: [{ id: childRunId, ordinal: 1, status: "completed" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
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
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-ack",
        providerInstanceId: ProviderInstanceId.make("codex"),
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
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
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
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel",
        providerInstanceId: ProviderInstanceId.make("codex"),
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
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child interrupt fails", () =>
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
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated interrupt failure") as never)),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel-failed",
        providerInstanceId: ProviderInstanceId.make("codex"),
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
          ["run.interrupt"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("returns cancel requested when post-interrupt disposal fails", () =>
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
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-cancel-dispose-failed",
        providerInstanceId: ProviderInstanceId.make("codex"),
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
          ["run.interrupt", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  describe("scheduled-task authorization", () => {
    const parentThreadId = ThreadId.make("thread:mcp-sched-parent");
    const destinationThreadId = ThreadId.make("thread:mcp-sched-destination");
    const projectId = ProjectId.make("project:mcp-sched");
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:mcp-sched-1");
    // The stored task is bound to a full-access/default destination thread —
    // its runs execute under that thread's modes, not the task's stored ones.
    const privilegedTask = {
      id: scheduledTaskId,
      projectId,
      title: "nightly sync",
      prompt: "run the sync",
      enabled: true,
      threadId: destinationThreadId,
      schedule: { type: "interval", everyMs: 60_000 },
      runtimeMode: "full-access",
      interactionMode: "default",
      nextRunAt: null,
      lastRunStatus: "never",
    } as unknown as ScheduledTask;

    const liveRun = {
      id: RunId.make("run:mcp-sched-live"),
      ordinal: 1,
      status: "running",
      rootNodeId: NodeId.make("node:mcp-sched-root"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    };

    const callerProjection = (
      runtimeMode: string,
      interactionMode: string,
      runs: ReadonlyArray<unknown>,
    ) =>
      ({
        thread: {
          id: parentThreadId,
          projectId,
          runtimeMode,
          interactionMode,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-terra",
          },
        },
        runs,
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
      }) as unknown as OrchestrationV2ThreadProjection;

    const schedScope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:mcp-sched"),
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-sched",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };

    const scheduleDeps = (
      projection: OrchestrationV2ThreadProjection,
      writes: Ref.Ref<number>,
      listedTask: ScheduledTask = privilegedTask,
    ) =>
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(projection),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === destinationThreadId
                ? ({
                    id: destinationThreadId,
                    projectId,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  } as never)
                : null,
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [listedTask] }),
          upsert: () =>
            Ref.update(writes, (count) => count + 1).pipe(Effect.as({ task: listedTask })),
          update: () =>
            Ref.update(writes, (count) => count + 1).pipe(
              Effect.as(Option.some({ task: listedTask })),
            ),
          delete: () =>
            Ref.update(writes, (count) => count + 1).pipe(Effect.as({ id: scheduledTaskId })),
        }),
      );

    it.effect("rejects schedule mutations when the caller owns no live run", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("full-access", "default", []);
        const dependencies = scheduleDeps(projection, writes);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const scheduled = yield* service
            .scheduleTask(schedScope, {
              prompt: "check in",
              schedule: { type: "interval", everyMs: 60_000 },
            })
            .pipe(Effect.flip);
          assert.equal(scheduled.code, "parent_not_active");
          const updated = yield* service
            .updateScheduledTask(schedScope, { scheduledTaskId, enabled: true })
            .pipe(Effect.flip);
          assert.equal(updated.code, "parent_not_active");
          const deleted = yield* service
            .deleteScheduledTask(schedScope, { scheduledTaskId })
            .pipe(Effect.flip);
          assert.equal(deleted.code, "parent_not_active");
          assert.equal(yield* Ref.get(writes), 0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );

    it.effect("rejects schedule mutations from a run owned by another provider instance", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("full-access", "default", [
          { ...liveRun, providerInstanceId: ProviderInstanceId.make("claude") },
        ]);
        const dependencies = scheduleDeps(projection, writes);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service
            .updateScheduledTask(schedScope, { scheduledTaskId, enabled: true })
            .pipe(Effect.flip);
          assert.equal(error.code, "parent_not_active");
          assert.equal(yield* Ref.get(writes), 0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );

    it.effect("rejects re-enabling a task whose runtime mode exceeds the caller's", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("approval-required", "default", [liveRun]);
        const dependencies = scheduleDeps(projection, writes);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service
            .updateScheduledTask(schedScope, { scheduledTaskId, enabled: true })
            .pipe(Effect.flip);
          assert.equal(error.code, "runtime_mode_escalation_denied");
          const deleted = yield* service
            .deleteScheduledTask(schedScope, { scheduledTaskId })
            .pipe(Effect.flip);
          assert.equal(deleted.code, "runtime_mode_escalation_denied");
          assert.equal(yield* Ref.get(writes), 0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );

    it.effect(
      "rejects re-enabling a task whose interaction mode exceeds a plan-mode caller's",
      () =>
        Effect.gen(function* () {
          const writes = yield* Ref.make(0);
          const projection = callerProjection("full-access", "plan", [liveRun]);
          const dependencies = scheduleDeps(projection, writes);
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const error = yield* service
              .updateScheduledTask(schedScope, { scheduledTaskId, enabled: true })
              .pipe(Effect.flip);
            assert.equal(error.code, "interaction_mode_escalation_denied");
            assert.equal(yield* Ref.get(writes), 0);
          }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
        }),
    );

    it.effect("denies a plan-mode caller even when it unbinds the privileged task", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("full-access", "plan", [liveRun]);
        // Unbinding leaves the task's stored default mode governing each
        // launched run, so the plan-mode caller still fails the check.
        const dependencies = scheduleDeps(projection, writes);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const error = yield* service
            .updateScheduledTask(schedScope, {
              scheduledTaskId,
              enabled: true,
              bindToCurrentThread: false,
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "interaction_mode_escalation_denied");
          assert.equal(yield* Ref.get(writes), 0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );

    it.effect("permits a plan-mode caller to mutate a task bound to its own thread", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("full-access", "plan", [liveRun]);
        // Bound to the calling thread, the run executes under the caller's own
        // modes — the stored modes never govern this binding.
        const ownBoundTask = {
          ...privilegedTask,
          threadId: parentThreadId,
        } as unknown as ScheduledTask;
        const dependencies = scheduleDeps(projection, writes, ownBoundTask);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const updated = yield* service.updateScheduledTask(schedScope, {
            scheduledTaskId,
            enabled: true,
          });
          assert.equal(updated.scheduledTaskId, scheduledTaskId);
          assert.equal(yield* Ref.get(writes), 1);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );

    it.effect("permits schedule mutations for a live caller whose modes cover the task's", () =>
      Effect.gen(function* () {
        const writes = yield* Ref.make(0);
        const projection = callerProjection("full-access", "default", [liveRun]);
        const dependencies = scheduleDeps(projection, writes);
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const updated = yield* service.updateScheduledTask(schedScope, {
            scheduledTaskId,
            enabled: true,
          });
          assert.equal(updated.scheduledTaskId, scheduledTaskId);
          const scheduled = yield* service.scheduleTask(schedScope, {
            prompt: "check in",
            schedule: { type: "interval", everyMs: 60_000 },
          });
          assert.equal(scheduled.scheduledTaskId, scheduledTaskId);
          assert.equal(yield* Ref.get(writes), 2);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
    );
  });
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
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-providers",
    providerInstanceId: codexInstanceId,
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
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistryV2,
      ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape)
            : Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId })),
      }),
    );

  const parentProjection = (subagents: ReadonlyArray<unknown>): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
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
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
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
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        const providers: ReadonlyArray<ServerProvider> = [
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
          // Antigravity has a live orchestration adapter through the provider
          // instance registry even though no adapter driver entry exists in
          // the static built-in list.
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          // A second Antigravity instance whose adapter resolves but whose
          // provider state still blocks delegation.
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          forkShadow,
        ];
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(parentProjection([])),
          }),
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );

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
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isTrue(
            fork!.constraints.includes("No V2 provider adapter is registered."),
            `expected missing-adapter constraint, got ${fork!.constraints.join(" | ")}`,
          );
          assert.isTrue(
            fork!.constraints.includes("Driver 'forkOnly' is not registered in this build."),
          );
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
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
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService)({
            getThreadProjection: (threadId) =>
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
          Layer.mock(ProviderRegistry)({
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
          Layer.mock(ScheduledTaskService)({}),
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
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }),
  );

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
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
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
        Layer.mock(ProviderRegistry)({
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
        Layer.mock(ScheduledTaskService)({}),
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
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
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
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(parentProjection([])),
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            forkShadow,
          ]),
        }),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ScheduledTaskService)({}),
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
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );
});
