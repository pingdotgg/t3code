import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provideMerge(
    ThreadManagement.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          layerDatabase,
          ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
          ProviderReplayHarness.layerWithRegistry(
            { name: "mcp-queue-hold" },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            { databaseLayer: layerDatabase, runEffectWorker: false },
          ),
        ),
      ),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    ),
  ),
);

// An OAuth client outside any thread, like the dispatcher that drives threads
// from scheduled tasks and webhooks.
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-queue-hold"),
  requestNamespace: "client:queue-hold",
  thread: undefined,
  client: { sessionId: "queue-hold", label: "Dispatcher", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-queue-hold", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-queue-hold", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const invoke = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/**
 * A thread whose first run failed with every later message queued behind it,
 * the state the orchestrator leaves when a queued run shares the failed run's
 * provider: the queue is held until someone resumes it.
 */
const heldThread = (threadId: ThreadId, failure?: { readonly usageLimit: true }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:mcp-queue-hold"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "first", "start_immediately");
    yield* send(threadId, "second", "queue_after_active");
    yield* send(threadId, "third", "queue_after_active");
    const now = yield* DateTime.now;
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const [failed, ...queued] = runs as [OrchestrationV2Run, ...OrchestrationV2Run[]];
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:fail`),
      type: "run.updated",
      threadId,
      runId: failed.id,
      occurredAt: now,
      payload: { ...failed, status: "failed", startedAt: now, completedAt: now },
    });
    if (failure?.usageLimit) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:limit`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${threadId}:limit`),
          threadId,
          runId: failed.id,
          nodeId: failed.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "failed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: {
            class: "usage_limit",
            message: "Usage limit reached",
            code: "usage_limit",
            retryable: false,
          },
        },
      });
    }
    for (const run of queued) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:hold:${run.id}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, queueHeld: true },
      });
    }
    return { failed, queued };
  });

it.layer(layerTest)("MCP queue hold", (it) => {
  it.effect("lists the hold and resumes it so the next queued run starts", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:queue-hold");
      const { queued } = yield* heldThread(threadId);

      const held = yield* invoke("t3_queue_list", { threadId });
      assert.deepEqual(held.structuredContent, {
        held: true,
        items: queued.map((run) => ({
          queuedRunId: run.id,
          text: run === queued[0] ? "second" : "third",
          truncated: false,
          held: true,
        })),
        nextCursor: null,
      });

      const resumed = yield* invoke("t3_queue_resume", { threadId });
      assert.deepEqual(resumed.structuredContent, { released: 2 });

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        queued.map((run) => after.runs.find((candidate) => candidate.id === run.id)?.status),
        ["starting", "queued"],
      );
      assert.deepEqual(
        yield* invoke("t3_queue_list", { threadId }).pipe(Effect.map((r) => r.structuredContent)),
        {
          held: false,
          items: [{ queuedRunId: queued[1]!.id, text: "third", truncated: false, held: false }],
          nextCursor: null,
        },
      );
    }),
  );

  it.effect("refuses to resume a thread stopped by a usage limit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:queue-hold-limit");
      const { queued } = yield* heldThread(threadId, { usageLimit: true });

      const result = yield* invoke("t3_queue_resume", { threadId });
      assert.isTrue(result.isError);
      assert.deepInclude(declaredFailure(result), {
        code: "orchestration_error",
        message: "Continue the limited thread before resuming its queue.",
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        queued.map((run) => after.runs.find((candidate) => candidate.id === run.id)?.queueHeld),
        [true, true],
      );
    }),
  );
});
