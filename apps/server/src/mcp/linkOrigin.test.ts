import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "../orchestration-v2/SubagentProjection.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

// A linked environment's session drives this one's real orchestrator through
// its real T3 tools. What the link starts carries its origin, and the link
// changes only that.

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:link-origin");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for these commands"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "link-origin" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerOrchestration = ThreadManagement.layer.pipe(Layer.provideMerge(layerOrchestrator));

/** Launches dispatch the real thread.create, and nothing more: no workspace, no run. */
const layerLaunches = Layer.effect(
  ThreadLaunch.ThreadLaunchService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return ThreadLaunch.ThreadLaunchService.of({
      launch: (input: ThreadLaunch.ThreadLaunchInput) =>
        threads
          .dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: input.threadId!,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
            ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(
            Effect.flatMap(() => threads.getThreadProjection(input.threadId!)),
            Effect.map((projection) => ({
              threadId: input.threadId!,
              projection,
              resumed: false,
            })),
            Effect.orDie,
          ),
    } as unknown as ThreadLaunch.ThreadLaunchService["Service"]);
  }),
);

const layerTools = Layer.mergeAll(
  McpHttpServer.layerOrchestratorToolkit,
  McpHttpServer.layerThreadToolkit,
  McpHttpServer.layerProjectRegistration,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(layerLaunches),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.die("unused"),
      update: () => Effect.die("A linked caller must never reach a project update."),
    }),
  ),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
  ),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-origin-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "link-origin", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "link-origin", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  sessionId: string,
  linked: boolean,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:box"),
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, label: `T3 Code · ${sessionId}`, access: "full-access", linked },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
});
const laptop = clientScope("laptop", true);
const desk = clientScope("desk", true);
const claudeCode = clientScope("claude-code", false);

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const failureCode = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code: string }).code
    : undefined;
};

const launch = (
  scope: McpInvocationContext.McpInvocationScope,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  call(scope, "t3_thread_launch", {
    projectId,
    title,
    modelSelection: { instanceId, model: "gpt-5" },
    ...extra,
  }).pipe(
    Effect.map((result) => {
      assert.equal(result.isError, false, JSON.stringify(result.content));
      return (result.structuredContent as { threadId: ThreadId }).threadId;
    }),
  );

const usersOwnThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:users-own");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:users-own"),
    threadId,
    projectId,
    title: "The user's own",
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

it.layer(Layer.provideMerge(layerTools, layerOrchestration))("work a link starts", (it) => {
  it.effect("is stamped, and so is the work it derives", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const launched = yield* launch(laptop, "Started from the laptop");
      const shell = yield* projections.getThreadShell(launched);
      assert.deepEqual(shell?.linkOrigin, { sessionId: "laptop", label: "T3 Code · laptop" });

      // A subagent of it and a fork of it are built from its thread, origin included.
      const thread = (yield* ThreadManagement.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadProjection(launched)),
      )).thread;
      const child = makeSubagentChildThread({
        parentThread: thread,
        childThreadId: ThreadId.make("thread:child"),
        parentNodeId: NodeId.make("node:child"),
        activeProviderThreadId: null,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        title: "Child",
        now: thread.createdAt,
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.deepEqual(child.linkOrigin, shell?.linkOrigin);
      const fork = yield* ThreadForkService.ThreadForkServiceV2.pipe(
        Effect.flatMap((forks) =>
          forks.plan({
            sourceProjection: { thread },
            sourceRun: { id: RunId.make("run:source"), status: "completed" } as OrchestrationV2Run,
            sourceProviderThread: undefined,
            canonicalSourcePoint: { threadId: launched },
            transferId: ContextTransferId.make("transfer:fork"),
            targetThreadId: ThreadId.make("thread:fork"),
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: thread.createdAt,
          }),
        ),
        Effect.provide(ThreadForkService.layer),
      );
      assert.deepEqual(fork.targetThread.linkOrigin, shell?.linkOrigin);

      // An ordinary outside agent's launch is not a link's.
      const plain = yield* launch(claudeCode, "Started by Claude Code");
      assert.equal((yield* projections.getThreadShell(plain))?.linkOrigin, undefined);

      // A link's delegated task names its parent there; only a link's launch may.
      const delegatedFrom = {
        environmentId: "environment-laptop",
        threadId: "thread:laptop-parent",
        title: "Laptop parent",
      };
      const task = yield* launch(laptop, "Delegated from the laptop", { delegatedFrom });
      assert.deepEqual((yield* projections.getThreadShell(task))?.delegatedFrom, delegatedFrom);
      const claimed = yield* launch(claudeCode, "Claims a parent", { delegatedFrom });
      assert.equal((yield* projections.getThreadShell(claimed))?.delegatedFrom, undefined);
    }),
  );

  it.effect("changes only that link's threads, and never the environment", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const ownLaunch = yield* launch(laptop, "The laptop's");
      const rename = (scope: McpInvocationContext.McpInvocationScope, threadId: ThreadId) =>
        call(scope, "t3_thread_update", {
          threadId,
          action: "rename",
          title: `Renamed by ${scope.client!.sessionId}`,
        });

      // The link may change what it started.
      assert.equal((yield* rename(laptop, ownLaunch)).isError, false);
      assert.equal((yield* projections.getThreadShell(ownLaunch))?.title, "Renamed by laptop");
      // Not the user's own thread, nor another link's.
      assert.equal(failureCode(yield* rename(laptop, users)), "capability_denied");
      assert.equal(failureCode(yield* rename(desk, ownLaunch)), "capability_denied");
      assert.equal((yield* projections.getThreadShell(users))?.title, "The user's own");
      // An ordinary outside agent is not fenced.
      assert.equal((yield* rename(claudeCode, users)).isError, false);
      // Naming this environment's own id is still this environment's thread.
      for (const [name, args] of [
        ["t3_thread_send", { message: "From the laptop." }],
        ["t3_thread_interrupt", {}],
      ] as const) {
        const result = yield* call(laptop, name, {
          ...args,
          environmentId: laptop.environmentId,
          threadId: users,
        });
        assert.equal(failureCode(result), "capability_denied", name);
      }

      // Nor the environment itself: projects and settings (one declaration
      // covers both), and scheduled tasks.
      assert.equal(
        failureCode(yield* call(laptop, "t3_project_update", { projectId, title: "Mine now" })),
        "capability_denied",
      );
      assert.equal(
        failureCode(yield* call(laptop, "delete_scheduled_task", { scheduledTaskId: "any" })),
        "capability_denied",
      );

      // Reads are not fenced.
      const read = yield* call(laptop, "t3_thread_read", { threadId: users });
      assert.equal(read.isError, false);
    }),
  );
});
