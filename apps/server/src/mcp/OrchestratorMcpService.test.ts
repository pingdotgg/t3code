import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

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

  it.effect(
    "resolves inherited provider instances for driver-only delegate targets by availability",
    () =>
      Effect.gen(function* () {
        const inheritedInstanceId = ProviderInstanceId.make("codex-inherited");
        const healthyInstanceId = ProviderInstanceId.make("codex-healthy");
        const driverKind = ProviderDriverKind.make("codex");
        const parentThreadId = ThreadId.make("thread:mcp-target-parent");
        const parentProjection = {
          thread: {
            id: parentThreadId,
            modelSelection: { instanceId: inheritedInstanceId, model: "gpt-5.6-terra" },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          runs: [
            {
              id: RunId.make("run:mcp-target-parent"),
              ordinal: 1,
              status: "running",
              rootNodeId: NodeId.make("node:mcp-target-root"),
              providerInstanceId: inheritedInstanceId,
            },
          ],
          contextTransfers: [],
          subagents: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-target"),
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-target",
          providerInstanceId: inheritedInstanceId,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const provider = (instanceId: ProviderInstanceId, enabled: boolean): ServerProvider =>
          decodeServerProvider({
            instanceId,
            driver: driverKind,
            enabled,
            installed: true,
            version: "1.0.0",
            status: enabled ? "ready" : "disabled",
            auth: { status: "authenticated" },
            checkedAt: "2026-04-10T00:00:00.000Z",
            availability: enabled ? "available" : "unavailable",
            models: [
              { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra", isCustom: false, capabilities: null },
            ],
          });
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            explicit: false,
            selectedInstanceId: inheritedInstanceId,
          },
          {
            name: "unavailable-inherited-fallback",
            inheritedEnabled: false,
            explicit: false,
            selectedInstanceId: healthyInstanceId,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            explicit: true,
            selectedInstanceId: null,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2Command>>([]);
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService)({
              getThreadProjection: () => Effect.succeed(parentProjection),
              dispatch: (command: OrchestrationV2Command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        cause: "simulated child creation failure",
                      }),
                    ),
                  ),
                ),
            }),
            Layer.mock(ProviderRegistry)({
              getProviders: Effect.succeed([
                provider(healthyInstanceId, true),
                provider(inheritedInstanceId, testCase.inheritedEnabled),
              ]),
            }),
            Layer.mock(ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const error = yield* service
              .delegateTask(scope, {
                task: "Resolve the child provider instance.",
                target: testCase.explicit
                  ? { providerInstanceId: inheritedInstanceId }
                  : { driverKind },
                clientRequestId: testCase.name,
              })
              .pipe(Effect.flip);
            const commands = yield* Ref.get(dispatched);
            if (testCase.selectedInstanceId === null) {
              assert.equal(error.code, "provider_unavailable");
              assert.deepEqual(commands, []);
              return;
            }
            assert.equal(error.code, "orchestration_error");
            assert.equal(commands.length, 1);
            assert.equal(commands[0]?.type, "delegated_task.request");
            assert.equal(
              commands[0]?.type === "delegated_task.request"
                ? commands[0].modelSelection.instanceId
                : undefined,
              testCase.selectedInstanceId,
            );
          }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
        }
      }),
  );
});
