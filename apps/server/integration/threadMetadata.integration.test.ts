import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ServerConfig } from "../src/config.ts";
import { ServerEnvironment } from "../src/environment/ServerEnvironment.ts";
import { McpInvocationContext } from "../src/mcp/McpInvocationContext.ts";
import { ThreadToolkitHandlersLive } from "../src/mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../src/mcp/toolkits/thread/tools.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../src/project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../src/provider/Services/ProviderRegistry.ts";

const EngineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provide(SqlitePersistenceMemory),
);

const TestLayer = McpServer.toolkit(ThreadToolkit).pipe(
  Layer.provide(ThreadToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(EngineLayer),
  Layer.provide(
    Layer.mergeAll(Layer.mock(ProviderRegistry)({}), Layer.mock(ServerEnvironment)({})),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-metadata-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("persists a scoped MCP rename and protects it from a late generated title", () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const projectId = ProjectId.make("metadata-project");
    const threadId = ThreadId.make("metadata-thread");
    const otherThreadId = ThreadId.make("other-thread");
    const instanceId = ProviderInstanceId.make("codex");
    const createdAt = "2026-09-23T00:00:00.000Z";
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("metadata-project-create"),
      projectId,
      title: "Metadata project",
      workspaceRoot: "/workspace/metadata-project",
      createdAt,
    });
    for (const id of [threadId, otherThreadId]) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: id,
        projectId,
        title: "Original name",
        modelSelection: { instanceId, model: "gpt-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
    }
    const server = yield* McpServer.McpServer;
    const renamed = yield* server.callTool({
      name: "set_thread_name",
      arguments: { name: "  Agent-chosen name  " },
    });
    expect(renamed.isError).toBe(false);
    expect(renamed.content).toEqual([
      { type: "text", text: '{"id":"metadata-thread","name":"Agent-chosen name"}' },
    ]);

    yield* engine.dispatch({
      type: "thread.title.generate.complete",
      commandId: CommandId.make("late-generated-title"),
      threadId,
      expectedTitle: "Original name",
      expectedVersion: null,
      title: "Late generated name",
      needsRefinement: true,
    });
    const metadata = yield* server.callTool({
      name: "get_thread_metadata",
      arguments: { fields: ["name"] },
    });
    expect(metadata.isError).toBe(false);
    expect(metadata.content).toEqual([{ type: "text", text: '{"name":"Agent-chosen name"}' }]);
    const saved = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
    expect(saved.titleState).toMatchObject({ source: "manual", needsRefinement: false });
    const other = Option.getOrThrow(yield* snapshots.getThreadShellById(otherThreadId));
    expect(other.title).toBe("Original name");
  }).pipe(
    Effect.provideService(McpSchema.McpServerClient, {
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "metadata-test", version: "1.0" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "metadata-test", version: "1.0" },
      },
      getClient: Effect.die("unused"),
    }),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("metadata-environment"),
      threadId: ThreadId.make("metadata-thread"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "metadata-session",
      capabilities: new Set(["thread"] as const),
      issuedAt: 1,
    }),
    Effect.scoped,
    Effect.provide(TestLayer),
  ),
);
