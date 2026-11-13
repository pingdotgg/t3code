import {
  EnvironmentId,
  NodeId,
  type OrchestratorMcpThreadReadResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  SECRET_REQUEST_UNSAVED_NOTE,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

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

it("readThread preserves caller access errors and prefers activity-run status over a newer cancelled queued run", async () => {
  let callerUnavailable = false;
  const pullRequestLink = (number: number, state: "open" | "merged", watched: boolean) => ({
    host: "github.com",
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    source: "agent",
    linkedAt: `2026-08-04T11:0${number}:00.000Z`,
    snapshot: { state },
    stack: null,
    ...(watched
      ? {
          watch: {
            startedAt: "2026-08-04T11:30:00.000Z",
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: "2026-08-04T11:30:00.000Z",
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        }
      : {}),
  });
  const projection = {
    thread: {
      ...baseThread({
        threadId: parentThreadId,
        title: "Parent",
        instanceId: parentInstanceId,
        model: "gpt-5.4",
      }),
      pullRequests: [
        pullRequestLink(1, "merged", false),
        pullRequestLink(2, "open", true),
        ...[3, 4, 5, 6, 7, 8].map((number) => pullRequestLink(number, "open", false)),
      ],
    },
    runs: [
      makeRun({ id: activeRunId, ordinal: 1, status: "running" }),
      makeRun({ id: cancelledRunId, ordinal: 2, status: "cancelled" }),
    ],
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () =>
            Effect.succeed({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
          getThreadRecords: (threadId) =>
            callerUnavailable
              ? Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: "Caller unavailable",
                  }),
                )
              : threadId === parentThreadId
                ? Effect.succeed(projection)
                : Effect.die(`unexpected thread ${threadId}`),
          getThreadShell: (threadId) =>
            callerUnavailable
              ? Effect.die("A failed caller read must not reach the target")
              : Effect.succeed(
                  threadId === parentThreadId
                    ? ({
                        ...projection.thread,
                        blockedOnThreadWait: true,
                        pendingBackgroundTasks: [
                          {
                            taskId: "task-subagent",
                            kind: "subagent",
                            parentTaskId: "task-parent",
                            providerInstanceId: parentInstanceId,
                            childThreadId,
                          },
                        ],
                      } as unknown as OrchestrationV2ThreadShell)
                    : null,
                ),
          getProjectThreadRecords: (input) =>
            input.threadId === parentThreadId
              ? Effect.succeed(projection)
              : Effect.die(`unexpected thread ${input.threadId}`),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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
    expect(result.thread.blockedOnThreadWait).toBe(true);
    expect(result.thread.pendingBackgroundTasks).toEqual([
      { taskId: "task-subagent", kind: "subagent", childThreadId },
    ]);
    // Every page read must not repeat each linked PR, and an open PR shows whether it is watched.
    // A thread with many open PRs previews a few, watched first, then newest.
    const listed = result.thread.pullRequests ?? [];
    expect(listed.map((link) => link.number)).toEqual([2, 8, 7, 6, 5]);
    expect(result.thread.openPullRequestCount).toBe(7);
    expect(listed.find((link) => link.number === 2)).toMatchObject({
      watching: true,
      watchStartedAt: "2026-08-04T11:30:00.000Z",
    });
    const laterPage = yield* service.readThread(makeScope(), {
      threadId: parentThreadId,
      afterPosition: 0,
    });
    expect(laterPage.thread.pullRequests).toBeUndefined();
    expect(laterPage.thread.pullRequestCount).toBe(8);

    callerUnavailable = true;
    const denied = yield* service
      .readThread({ ...makeScope(), capabilities: new Set() }, { threadId: parentThreadId })
      .pipe(Effect.flip);
    expect(denied.code).toBe("capability_denied");
    const missingCaller = yield* service
      .readThread(makeScope(), { threadId: parentThreadId })
      .pipe(Effect.flip);
    expect(missingCaller.code).toBe("orchestration_error");
    expect(missingCaller.message).toContain(`Unable to read thread ${parentThreadId}:`);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread pages cut-off text without splitting an emoji across pages", async () => {
  const text = "a😀bc";
  const itemId = TurnItemId.make("turn-item-mcp-reasoning");
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const row = {
    position: 0,
    visibility: "visible",
    sourceThreadId: parentThreadId,
    sourceItemId: itemId,
    item: {
      type: "reasoning",
      runId: activeRunId,
      status: "completed",
      title: null,
      text,
      updatedAt: now,
    },
  };
  const rows = [
    row,
    ...Array.from({ length: 11 }, (_, index) => ({
      ...row,
      position: index + 1,
      sourceItemId: TurnItemId.make(`turn-item-mcp-${index}`),
      item: { ...row.item, text: "x".repeat(600) },
    })),
  ];

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: (_threadId, options) => {
            const remaining = rows.filter(
              (candidate) =>
                candidate.position > (options.afterPosition ?? -1) &&
                (options.itemId === undefined || candidate.sourceItemId === options.itemId),
            );
            return Effect.succeed({
              items: remaining.slice(
                0,
                options.limit,
              ) as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
              totalItems: rows.length,
              hasMore: remaining.length > options.limit,
              hasEarlier: false,
            });
          },
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getThreadShell: () =>
            Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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
    for (const [maxCharsPerItem, expected] of [
      [2, ["a", "😀", "bc"]],
      [1, ["a", "😀", "b", "c"]],
    ] as const) {
      let textOffset = 0;
      for (const [index, text] of expected.entries()) {
        const result = yield* service.readThread(makeScope(), {
          threadId: parentThreadId,
          view: "activity",
          itemId,
          textOffset,
          maxCharsPerItem,
        });
        textOffset += text.length;
        expect(result.items[0]).toMatchObject({
          text,
          textTruncated: index < expected.length - 1,
          nextTextOffset: index < expected.length - 1 ? textOffset : null,
        });
      }
    }
    const first = yield* service.readThread(makeScope(), {
      threadId: parentThreadId,
      view: "activity",
    });
    expect(first.items[1]).toMatchObject({
      text: "x".repeat(500),
      textTruncated: true,
      nextTextOffset: 500,
    });
    expect(first.items).toHaveLength(10);
    expect(first).toMatchObject({ nextPosition: 9, hasMore: true });
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread returns the newest items that fit the response budget", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  // A long thread's newest 100 activity items, the read agents make most.
  const rows = Array.from({ length: 100 }, (_, position) => ({
    position,
    visibility: "local",
    sourceThreadId: parentThreadId,
    sourceItemId: TurnItemId.make(`turn-item-mcp-long-${position}`),
    item: {
      type: "reasoning",
      runId: activeRunId,
      status: "completed",
      title: null,
      text: "x".repeat(1_500),
      updatedAt: now,
    },
  }));
  const pageOptions: Array<unknown> = [];

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: (_threadId, options) => {
            pageOptions.push(options);
            return Effect.succeed({
              items: rows as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
              totalItems: 3_000,
              hasMore: false,
              hasEarlier: true,
            });
          },
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getThreadShell: () =>
            Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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
    const read = {
      threadId: parentThreadId,
      view: "activity" as const,
      limit: 100,
      maxCharsPerItem: 1_500,
    };
    const result = yield* service.readThread(makeScope(), read);
    // Linked environments and the CLI read as clients without a cursor and follow only hasMore.
    const first = yield* service.readThread({ ...makeScope(), thread: undefined }, read);
    const fromStart = yield* service.readThread(makeScope(), { ...read, afterPosition: -1 });

    expect(pageOptions).toEqual([
      { beforePosition: Number.POSITIVE_INFINITY, limit: 100, view: "activity" },
      { limit: 100, view: "activity" },
      { afterPosition: -1, limit: 100, view: "activity" },
    ]);
    // Claude Code saves results over ~50k chars of this JSON to a file instead of showing them.
    expect(JSON.stringify(result).length).toBeLessThan(31_000);
    expect(result.items.length).toBeLessThan(100);
    expect(result.items.at(-1)?.position).toBe(99);
    expect(result.earlierPosition).toBe(result.items[0]?.position);
    expect(result.hasMore).toBe(false);
    expect(first.items[0]?.position).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.nextPosition).toBe(first.items.at(-1)?.position);
    expect(fromStart.items[0]?.position).toBe(0);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread keeps an activity page within an MCP client's output limit and pages the rest", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const rows = Array.from({ length: 60 }, (_, position) => ({
    position,
    visibility: "visible",
    sourceThreadId: parentThreadId,
    sourceItemId: TurnItemId.make(`turn-item-mcp-reasoning-${position}`),
    item: {
      type: "reasoning",
      runId: activeRunId,
      status: "completed",
      // Command titles can carry a whole command.
      title: position === 1 ? "標".repeat(60_000) : null,
      text: position === 0 ? "😀a".repeat(30_000) : `${position} `.padEnd(3_000, "x"),
      updatedAt: now,
    },
  }));

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: (_threadId, options) => {
            const after =
              options.itemId === undefined
                ? rows.filter((row) => row.position > (options.afterPosition ?? -1))
                : rows.filter((row) => row.sourceItemId === options.itemId);
            return Effect.succeed({
              items: after.slice(
                0,
                options.limit,
              ) as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
              totalItems: rows.length,
              hasMore: after.length > options.limit,
              hasEarlier: false,
            });
          },
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getThreadShell: () =>
            Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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
    const positions: Array<number> = [];
    let afterPosition: number | undefined;
    for (let page = 0; page < rows.length; page++) {
      const result = yield* service.readThread(makeScope(), {
        threadId: parentThreadId,
        view: "activity",
        limit: 100,
        maxCharsPerItem: 1_500,
        afterPosition: afterPosition ?? -1,
      });
      // Claude Code rejects MCP results over 25k tokens; CJK text is about a token per char.
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
      if (page === 0) expect(result.hasMore).toBe(true);
      positions.push(...result.items.map((item) => item.position));
      if (!result.hasMore) break;
      afterPosition = result.nextPosition ?? undefined;
    }
    expect(positions).toEqual(rows.map((row) => row.position));

    const longText = rows[0]!.item.text;
    const pages: Array<string> = [];
    let textOffset: number | null = 0;
    while (textOffset !== null) {
      const result: OrchestratorMcpThreadReadResult = yield* service.readThread(makeScope(), {
        threadId: parentThreadId,
        view: "activity",
        itemId: rows[0]!.sourceItemId,
        textOffset,
        maxCharsPerItem: 50_000,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
      const [item] = result.items;
      expect(item?.text?.isWellFormed()).toBe(true);
      pages.push(item!.text!);
      textOffset = item!.nextTextOffset ?? null;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(longText);

    (projection.thread as { title: string }).title = "標".repeat(30_000);
    const underHugeTitle = yield* service.readThread(makeScope(), {
      threadId: parentThreadId,
      view: "activity",
      itemId: rows[0]!.sourceItemId,
      maxCharsPerItem: 50_000,
    });
    expect(underHugeTitle.items[0]?.text?.length).toBeGreaterThan(1_000);
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
    providerTurns: [],
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
    providerTurns: [],
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

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage: () =>
            Effect.succeed({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
          getThreadRecords: (threadId) => {
            if (threadId === parentThreadId) return Effect.succeed(parentProjection);
            if (threadId === childThreadId) return Effect.succeed(childProjection);
            return Effect.die(`unexpected thread ${threadId}`);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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
  let parentShell: OrchestrationV2ThreadShell | null = null;
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
    providerTurns: [],
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
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      contextTransfers: [],
      subagents: [],
      updatedAt: now,
    }) as unknown as OrchestrationV2ThreadProjection;

  const layer = layerOrchestratorService.pipe(
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
                : threadId === parentThreadId
                  ? parentShell
                  : null,
            ),
          getTimelinePage: (threadId) =>
            Effect.succeed({
              items: foreignProjection(threadId).visibleTurnItems,
              totalItems: 1,
              hasMore: false,
              hasEarlier: false,
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
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
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

    const backgroundTasks = [
      {
        taskId: "background-subagent",
        kind: "subagent" as const,
        providerInstanceId: parentInstanceId,
      },
    ];
    parentShell = {
      ...liveThreadShell(parentThreadId, { activeRunId: null }),
      pendingBackgroundTasks: backgroundTasks,
    };
    const backgroundSent = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "background",
    });
    expect(backgroundSent.threadId).toBe(foreignThreadId);
    const delegate = yield* service
      .delegateTask(makeScope(), { task: "requires a run" })
      .pipe(Effect.flip);
    expect(delegate.code).toBe("parent_not_active");
    const create = yield* service
      .createThreads(makeScope(), { threads: [{ prompt: "requires a run" }] })
      .pipe(Effect.flip);
    expect(create.code).toBe("parent_not_active");
    const secret = yield* service
      .requestSecret(makeScope(), { label: "Secret", reason: "requires a run" })
      .pipe(Effect.flip);
    expect(secret.code).toBe("parent_not_active");

    parentShell = { ...parentShell, providerInstanceId: customCodexInstanceId };
    const switchedScope = {
      ...makeScope(),
      thread: { ...makeScope().thread!, providerInstanceId: customCodexInstanceId },
    };
    const switched = yield* service
      .sendToThread(switchedScope, { threadId: foreignThreadId, message: "wrong owner" })
      .pipe(Effect.flip);
    expect(switched.code).toBe("parent_not_active");
    const mismatched = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "stale provider" })
      .pipe(Effect.flip);
    expect(mismatched.code).toBe("parent_not_active");

    parentShell = liveThreadShell(parentThreadId);
    const restarted = yield* service.sendToThread(makeScope(), {
      threadId: foreignThreadId,
      message: "new run",
    });
    expect(restarted.threadId).toBe(foreignThreadId);

    parentShell = {
      ...parentShell,
      activeRunId: null,
      pendingBackgroundTasks: backgroundTasks,
      archivedAt: now,
    };
    const archived = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "archived" })
      .pipe(Effect.flip);
    expect(archived.code).toBe("parent_not_active");

    parentShell = { ...parentShell, archivedAt: null, pendingBackgroundTasks: [] };
    const stopped = yield* service
      .sendToThread(makeScope(), { threadId: foreignThreadId, message: "after stop" })
      .pipe(Effect.flip);
    expect(stopped.code).toBe("parent_not_active");
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("requestSecret saves a pasted value to a file without opening a card", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [{ ...makeRun({ id: activeRunId, ordinal: 1, status: "running" }), rootNodeId: taskId }],
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const dispatched: Array<unknown> = [];
  const saved: Array<{
    readonly requestNamespace: string;
    readonly requestKey: string;
    readonly value: string;
  }> = [];
  const file = "/home/user/.t3/userdata/secrets/files/0123456789abcdef0123456789abcdef";

  const layer = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
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
          dispatch: (command) => Effect.sync(() => void dispatched.push(command) as never),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({
          savePasted: (input) =>
            Effect.sync(() => {
              saved.push({
                requestNamespace: input.requestNamespace,
                requestKey: input.requestKey,
                value: input.value,
              });
              return file;
            }),
        }),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        NodeCrypto.layer,
      ),
    ),
  );
  const counted = Metric.snapshot.pipe(
    Effect.map((snapshots) => {
      const found = snapshots.find(
        (snapshot) =>
          snapshot.id === "t3_secret_requests_total" &&
          snapshot.attributes?.status === "saved_pasted",
      );
      return found?.type === "Counter" ? Number(found.state.count) : 0;
    }),
  );

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const before = yield* counted;
    const result = yield* service.requestSecret(makeScope(), {
      label: "Pixel PIN",
      reason: "Unlocks the test phone.",
      value: "482916",
      clientRequestId: "pin-1",
    });
    expect(result).toEqual({ status: "saved", file });
    expect(JSON.stringify(result)).not.toContain("482916");
    expect(saved).toEqual([
      {
        requestNamespace: "provider-session-mcp-orchestrator-detail",
        requestKey: "pin-1",
        value: "482916",
      },
    ]);
    expect(dispatched).toEqual([]);
    expect((yield* counted) - before).toBe(1);

    const asRef = yield* service
      .requestSecret(makeScope(), {
        label: "Pixel PIN",
        reason: "Unlocks the test phone.",
        value: "482916",
        delivery: "secretRef",
      })
      .pipe(Effect.flip);
    expect(asRef.code).toBe("invalid_request");
    expect(asRef.message).not.toContain("482916");
    expect(saved).toHaveLength(1);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("requestSecret returns the unsaved note for a declined, cancelled or timed-out card", async () => {
  const outcomes = ["declined", "cancelled", "pending"] as const;
  const results = await Effect.forEach(outcomes, (outcome) => {
    const dispatched: Array<{ readonly type: string; readonly turnItemId?: string }> = [];
    const projection = () => {
      const card = dispatched.find((command) => command.type === "secret_request.record");
      return {
        thread: baseThread({
          threadId: parentThreadId,
          title: "Parent",
          instanceId: parentInstanceId,
          model: "gpt-5.4",
        }),
        runs: [
          { ...makeRun({ id: activeRunId, ordinal: 1, status: "running" }), rootNodeId: taskId },
        ],
        visibleTurnItems: [],
        turnItems:
          card === undefined
            ? []
            : [{ type: "secret_request", id: card.turnItemId, secretStatus: outcome }],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        contextTransfers: [],
        subagents: [],
        updatedAt: now,
      } as unknown as OrchestrationV2ThreadProjection;
    };
    const layer = layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.sync(projection),
            getThreadShell: () =>
              Effect.sync(() => projection().thread as unknown as OrchestrationV2ThreadShell),
            dispatch: (command) => Effect.sync(() => void dispatched.push(command) as never),
          } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
          } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          NodeCrypto.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const request = yield* service
        .requestSecret(makeScope(), {
          label: "Staging password",
          reason: "Signs in the QA account.",
          delivery: "file",
          timeoutMs: 1_000,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      return yield* Fiber.join(request);
    }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer())));
  }).pipe(Effect.runPromise);

  expect(results).toEqual([
    { status: "declined", note: SECRET_REQUEST_UNSAVED_NOTE.declined },
    { status: "cancelled", note: SECRET_REQUEST_UNSAVED_NOTE.cancelled },
    { status: "timed_out", note: SECRET_REQUEST_UNSAVED_NOTE.timed_out },
  ]);
});
