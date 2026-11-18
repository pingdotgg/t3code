import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const projectId = ProjectId.make("project-mcp-fyi");
const parentThreadId = ThreadId.make("thread-mcp-fyi-parent");
const activeRunId = RunId.make("run-mcp-fyi-active");
const instanceId = ProviderInstanceId.make("codex");

const layerOrchestratorService = (
  threadManagement: Partial<ThreadManagementService.ThreadManagementService["Service"]>,
) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)(threadManagement),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        }),
      ),
    ),
  );

it("readThread reports each FYI's state from its run in the thread the row comes from", async () => {
  const sourceThreadId = ThreadId.make("thread-mcp-fyi-source");
  const node = NodeId.make("node-mcp-fyi");
  const run = (id: RunId, threadId: ThreadId, status: "running" | "completed", ordinal = 2) => ({
    id,
    threadId,
    ordinal,
    status,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerInstanceId: instanceId,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    rootNodeId: node,
  });
  const fyiRow = (key: string, sourceThread: ThreadId, runId: RunId | null) => ({
    position: Number(key.length),
    visibility: "visible",
    sourceThreadId: sourceThread,
    sourceItemId: TurnItemId.make(`turn-item-fyi-${key}`),
    item: {
      type: "user_message",
      messageId: `message-fyi-${key}`,
      runId,
      nodeId: runId === null ? null : node,
      status: runId === null ? "pending" : "completed",
      title: null,
      text: key,
      fyi: true,
      updatedAt: now,
    },
  });
  const rows = [
    fyiRow("w", parentThreadId, null),
    fyiRow("se", parentThreadId, activeRunId),
    fyiRow("inh", sourceThreadId, RunId.make("run-mcp-fyi-source")),
    fyiRow("lost", parentThreadId, RunId.make("run-mcp-fyi-missing")),
    fyiRow("older", parentThreadId, RunId.make("run-mcp-fyi-old")),
  ];
  const runsByThread = new Map([
    [
      parentThreadId,
      [
        run(RunId.make("run-mcp-fyi-old"), parentThreadId, "completed", 1),
        run(activeRunId, parentThreadId, "running"),
      ],
    ],
    [sourceThreadId, [run(RunId.make("run-mcp-fyi-source"), sourceThreadId, "completed")]],
  ]);
  const projection = {
    thread: {
      id: parentThreadId,
      projectId,
      title: "Parent",
      createdBy: "user" as const,
      creationSource: "mcp" as const,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
      archivedAt: null,
      deletedAt: null,
      providerInstanceId: instanceId,
      createdAt: now,
      updatedAt: now,
    },
    runs: runsByThread.get(parentThreadId),
    visibleTurnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-mcp-fyi"),
    requestNamespace: "provider-session-mcp-fyi",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session-mcp-fyi",
      providerInstanceId: instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const result = yield* service.readThread(scope, {
      threadId: parentThreadId,
      afterPosition: -1,
      runLimit: 1,
    });
    // The read loads only the latest run; the old FYI's run is looked up by its id.
    assert.deepEqual(
      result.recentRuns.map((recent) => recent.runId),
      [activeRunId],
    );
    assert.deepEqual(
      result.items.map((item) => [item.text, item.fyi]),
      [
        ["w", "waiting"],
        ["se", "sent"],
        ["inh", "delivered"],
        ["lost", "unknown"],
        ["older", "delivered"],
      ],
    );
  }).pipe(
    Effect.provide(
      layerOrchestratorService({
        getTimelinePage: () =>
          Effect.succeed({
            items: rows as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
            totalItems: rows.length,
            hasMore: false,
            hasEarlier: false,
          }),
        getThreadRecords: (threadId, _fields, filter) =>
          Effect.succeed({
            ...projection,
            runs: (runsByThread.get(threadId) ?? []).filter(
              (run) => filter?.runIds === undefined || filter.runIds.includes(run.id),
            ),
          } as unknown as OrchestrationV2ThreadProjection),
        getProjectThreadRecords: (_input, _fields, filter) =>
          Effect.succeed({
            ...projection,
            runs: projection.runs
              .toSorted((left, right) => right.ordinal - left.ordinal)
              .filter(
                (run, index) =>
                  filter?.latestRunLimit === undefined ||
                  index < filter.latestRunLimit ||
                  filter.runStatuses?.includes(run.status) === true,
              ),
          } as unknown as OrchestrationV2ThreadProjection),
        getRunCount: () => Effect.succeed(projection.runs.length),
        getThreadShell: () =>
          Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
      }),
    ),
    Effect.runPromise,
  );
});

it.effect(
  "posts an FYI that answers held, with no run or task, never as a fresh context or past 16,000 characters",
  () =>
    Effect.gen(function* () {
      const target = liveThreadShell(ThreadId.make("thread:target"));
      const client: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:thread-lookup"),
        requestNamespace: "client:thread-lookup",
        thread: undefined,
        client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const sent = yield* Ref.make(0);
      const posted: Array<ThreadManagementService.ThreadManagementFyiInput> = [];
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const fresh = yield* mcp
          .sendToThread(client, {
            threadId: target.id,
            message: "main moved",
            mode: "fyi",
            freshContext: true,
          })
          .pipe(Effect.flip);
        assert.equal(fresh.code, "invalid_request");
        const long = yield* mcp
          .sendToThread(client, {
            threadId: target.id,
            message: "x".repeat(16_001),
            mode: "fyi",
          })
          .pipe(Effect.flip);
        assert.equal(long.code, "invalid_request");
        assert.lengthOf(posted, 0, "refused before any write");
        const held = yield* mcp.sendToThread(client, {
          threadId: target.id,
          message: "main moved",
          mode: "fyi",
        });
        assert.strictEqual(held.delivery, "held");
        assert.notProperty(held, "runId");
        assert.notProperty(held, "taskId");
        assert.strictEqual(held.messageId, posted[0]?.messageId);
        assert.strictEqual(posted[0]?.text, "main moved");
        assert.strictEqual(yield* Ref.get(sent), 0, "an FYI sends no turn");
      }).pipe(
        Effect.provide(
          layerOrchestratorService({
            getThreadShell: (threadId) =>
              Effect.succeed(
                [target].find((shell: OrchestrationV2ThreadShell) => shell.id === threadId) ?? null,
              ),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(target)),
            postFyi: (input) => {
              posted.push(input);
              return Effect.succeed({ sequence: 1, storedEvents: [] });
            },
          }),
        ),
      );
    }),
);
