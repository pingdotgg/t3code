import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const childThreadId = ThreadId.make("thread-mcp-orchestrator-child");
const activeRunId = RunId.make("run-mcp-active");
const cancelledRunId = RunId.make("run-mcp-cancelled");
const childRunId = RunId.make("run-mcp-child");
const taskId = NodeId.make("node-mcp-task-1");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const codexDriver = ProviderDriverKind.make("codex");
// Distinct from driver kind so a regression that re-derives from driver fails.
const customCodexInstanceId = ProviderInstanceId.make("codex-custom-workspace");
const parentInstanceId = ProviderInstanceId.make("codex");

const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

it("readThread prefers activity-run status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("running");
    expect(result.thread.latestRunId).toBe(cancelledRunId);
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread prefers waiting activity status over a newer cancelled queued run", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent waiting",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "waiting" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) =>
            threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (projection.thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(makeScope(), { threadId: parentThreadId });
    expect(result.thread.status).toBe("waiting");
    expect(result.thread.activeRunId).toBe(activeRunId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("taskStatus returns task.providerInstanceId rather than the driver kind", async () => {
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        runId: activeRunId,
        parentNodeId: NodeId.make("node-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: codexDriver,
        providerInstanceId: customCodexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Inspect the custom instance.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: {
      ...baseThread({
        threadId: childThreadId,
        title: "Child",
        instanceId: customCodexInstanceId,
        model: "gpt-5.4",
      }),
      lineage: {
        parentThreadId,
        relationshipToParent: "subagent",
        rootThreadId: parentThreadId,
      },
      createdBy: "agent",
    },
    runs: [
      makeRun({
        id: childRunId,
        ordinal: 1,
        status: "running",
        instanceId: customCodexInstanceId,
      }),
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [
      {
        type: "subagent_spawn",
        sourceThreadId: parentThreadId,
        targetThreadId: childThreadId,
        targetRunId: childRunId,
      },
    ],
    subagents: [],
    providerThreads: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.taskStatus(makeScope(), taskId);
    expect(result.providerInstanceId).toBe(customCodexInstanceId);
    expect(result.providerInstanceId).not.toBe(ProviderInstanceId.make(String(codexDriver)));
    expect(result.status).toBe("running");
    expect(result.taskId).toBe(taskId);
    expect(result.childThreadId).toBe(childThreadId);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread and sendToThread reach threads in other projects", async () => {
  let parentRuns: ReadonlyArray<unknown> = [
    makeRun({ id: RunId.make("run-parent-live"), ordinal: 1, status: "running" }),
  ];
  const foreignProjectId = ProjectId.make("project-mcp-orchestrator-foreign");
  const foreignThreadId = ThreadId.make("thread-mcp-orchestrator-foreign");
  const parentProjection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    get runs() {
      return parentRuns;
    },
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const foreignProjection = (threadId: ThreadId) =>
    ({
      thread: {
        ...baseThread({
          threadId,
          title: "Foreign",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        projectId: foreignProjectId,
      },
      runs: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: threadId,
          sourceItemId: "item-1",
          item: {
            id: "item-1",
            type: "assistant_message",
            messageId: "assistant-1",
            status: "completed",
            title: null,
            text: "Foreign thread said hello",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === foreignThreadId) return Effect.succeed(foreignProjection(threadId));
            return Effect.die(`unexpected thread ${threadId}`);
          },
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === foreignThreadId
                ? (foreignProjection(threadId).thread as unknown as OrchestrationV2ThreadShell)
                : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.succeed({
              items: foreignProjection(threadId).visibleTurnItems,
              totalItems: 1,
              hasMore: false,
            }),
          getProjectThreadRecords: (input) =>
            input.threadId === foreignThreadId && input.projectId === foreignProjectId
              ? Effect.succeed(foreignProjection(input.threadId))
              : Effect.fail(
                  new ThreadManagementService.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                ),
          sendToThread: () =>
            Effect.succeed({
              run: { id: "run-foreign", status: "queued" },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () =>
            Effect.succeed({
              tasks: [
                {
                  id: "task-foreign",
                  projectId: foreignProjectId,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                } as never,
              ],
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const foreign = yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    expect(foreign.thread.threadId).toBe(foreignThreadId);
    expect(foreign.thread.projectId).toBe(foreignProjectId);
    expect(foreign.items.map((item) => item.text)).toEqual(["Foreign thread said hello"]);

    const sent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "hi",
    });
    expect(sent.threadId).toBe(foreignThreadId);

    // Once the caller's run ends, it can still read other threads but no longer write to them.
    parentRuns = [];
    yield* service.readThread(makeScope(), { threadId: foreignThreadId });
    const stale = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "hi again" })
      .pipe(Effect.flip);
    expect(stale.code).toBe("parent_not_active");
    const staleInterrupt = yield* service
      .interruptThread(makeScope(), { threadId: foreignThreadId })
      .pipe(Effect.flip);
    expect(staleInterrupt.code).toBe("parent_not_active");
    // Nor create, change or remove scheduled work in another project.
    const staleSchedule = yield* service
      .scheduleTask(makeScope(), {
        projectId: foreignProjectId,
        prompt: "check in later",
        schedule: { type: "interval", everyMs: 3_600_000 },
      })
      .pipe(Effect.flip);
    expect(staleSchedule.code).toBe("parent_not_active");
    const staleUpdate = yield* service
      .updateScheduledTask(makeScope(), {
        scheduledTaskId: ScheduledTaskId.make("task-foreign"),
        enabled: false,
      })
      .pipe(Effect.flip);
    expect(staleUpdate.code).toBe("parent_not_active");
    const staleDelete = yield* service
      .deleteScheduledTask(makeScope(), { scheduledTaskId: ScheduledTaskId.make("task-foreign") })
      .pipe(Effect.flip);
    expect(staleDelete.code).toBe("parent_not_active");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});
