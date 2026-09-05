import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
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
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
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

  it.effect("lists archived shells with organization metadata without loading transcripts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:mcp-list-archived");
      const projectId = ProjectId.make("project:mcp-list-archived");
      const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");
      const completedAt = DateTime.makeUnsafe("2026-08-29T11:00:00.000Z");
      const visitedAt = DateTime.makeUnsafe("2026-08-29T10:00:00.000Z");
      const parentProjection = {
        thread: { id: threadId, projectId },
      } as unknown as OrchestrationV2ThreadProjection;
      const shell = {
        id: threadId,
        projectId,
        title: "Archived agent work",
        createdBy: "user",
        creationSource: "web",
        status: "failed",
        activityRunStatus: null,
        latestRunId: RunId.make("run:mcp-list-archived"),
        latestRunCompletedAt: completedAt,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "agents/archived",
        worktreePath: "/tmp/archived",
        linkedPullRequest: {
          projectId,
          repository: "pingdotgg/t3code",
          number: 9001,
          url: "https://github.com/pingdotgg/t3code/pull/9001",
        },
        pinnedAt: null,
        pinOrderKey: null,
        settledOverride: "settled",
        settledAt: completedAt,
        snoozedUntil: null,
        snoozedAt: null,
        archivedAt: now,
        lastVisitedAt: visitedAt,
        lineage: { parentThreadId: null, relationshipToParent: null },
        visibleItemCount: 4,
        createdAt: visitedAt,
        updatedAt: now,
      } as unknown as OrchestrationV2ThreadShell;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(parentProjection),
          listProjectThreads: () => Effect.succeed([shell]),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-list-archived"),
        threadId,
        providerSessionId: "provider-session:mcp-list-archived",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.listThreads(scope, { archived: true, unread: true });
        assert.equal(result.total, 1);
        assert.deepInclude(result.threads[0], {
          threadId,
          archived: true,
          archivedAt: "2026-08-29T12:00:00.000Z",
          settledOverride: "settled",
          readState: "unread",
          branch: "agents/archived",
          worktreePath: "/tmp/archived",
        });
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("organizes the calling thread and returns the resultant durable state", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:mcp-organize-self");
      const projectId = ProjectId.make("project:mcp-organize-self");
      const now = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");
      const projection = yield* Ref.make({
        thread: {
          id: threadId,
          projectId,
          pinnedAt: null,
          pinOrderKey: null,
          settledOverride: "settled",
          settledAt: now,
          snoozedUntil: now,
          snoozedAt: now,
          archivedAt: null,
          lastVisitedAt: DateTime.makeUnsafe("2026-08-29T11:00:00.000Z"),
        },
        runs: [
          {
            id: RunId.make("run:mcp-organize-cancelled"),
            ordinal: 1,
            status: "cancelled",
            completedAt: now,
          },
        ],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection);
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Ref.get(projection),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "thread.pin"
                  ? Ref.update(projection, (current) => ({
                      ...current,
                      thread: {
                        ...current.thread,
                        pinnedAt: now,
                        pinOrderKey: command.orderKey ?? null,
                        settledOverride: "active" as const,
                        settledAt: null,
                        snoozedUntil: null,
                        snoozedAt: null,
                      },
                    }))
                  : Effect.void,
              ),
              Effect.as({} as never),
            ),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-organize-self"),
        threadId,
        providerSessionId: "provider-session:mcp-organize-self",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.organizeThreads(scope, {
          action: { type: "pin", orderKey: "m0" },
          clientRequestId: "pin-self",
        });
        assert.deepInclude(result.outcomes[0], {
          threadId,
          action: "pin",
          status: "applied",
          error: null,
        });
        assert.deepInclude(result.outcomes[0]?.state, {
          pinnedAt: "2026-08-29T12:00:00.000Z",
          pinOrderKey: "m0",
          settledOverride: "active",
          settledAt: null,
          snoozedUntil: null,
          readState: "unread",
        });
        assert.equal((yield* Ref.get(dispatched)).length, 1);
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("uses only the latest run completion watermark for read state", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:mcp-read-latest-run");
      const projectId = ProjectId.make("project:mcp-read-latest-run");
      const createdAt = DateTime.makeUnsafe("2026-08-29T09:00:00.000Z");
      const completedAt = DateTime.makeUnsafe("2026-08-29T11:00:00.000Z");
      const activeAt = DateTime.makeUnsafe("2026-08-29T12:00:00.000Z");
      const projection = {
        thread: {
          id: threadId,
          projectId,
          title: "Latest run watermark",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          linkedPullRequest: null,
          lineage: { parentThreadId: null, relationshipToParent: null },
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          pinOrderKey: null,
          lastVisitedAt: DateTime.makeUnsafe("2026-08-29T10:00:00.000Z"),
          createdAt,
          updatedAt: activeAt,
        },
        runs: [
          {
            id: RunId.make("run:mcp-read-completed"),
            ordinal: 1,
            status: "completed",
            completedAt,
            requestedAt: createdAt,
            startedAt: createdAt,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
            },
          },
          {
            id: RunId.make("run:mcp-read-running"),
            ordinal: 2,
            status: "running",
            completedAt: null,
            requestedAt: activeAt,
            startedAt: activeAt,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
            },
          },
        ],
        runtimeRequests: [],
        visibleTurnItems: [],
        messages: [],
        subagents: [],
        contextTransfers: [],
        updatedAt: activeAt,
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-read-latest-run"),
        threadId,
        providerSessionId: "provider-session:mcp-read-latest-run",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.readThread(scope, { threadId });
        assert.equal(result.thread.latestRunId, "run:mcp-read-running");
        assert.equal(result.thread.readState, "read");
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
    }),
  );
});
