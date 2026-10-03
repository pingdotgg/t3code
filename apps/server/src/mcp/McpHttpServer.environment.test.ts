import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ServerSettings,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "../orchestration-v2/ProviderContinuationRequests.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderSwitchService from "../orchestration-v2/ProviderSwitchService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment:mcp-preferences-test");
const threadId = ThreadId.make("thread:mcp-preferences-test");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings));
const caller: OrchestrationV2ThreadShell = {
  id: threadId,
  projectId: ProjectId.make("project:mcp-preferences-test"),
  title: "Synthetic caller",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "synthetic" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make("run:mcp-preferences-test"),
  activeRunId: RunId.make("run:mcp-preferences-test"),
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "session:mcp-preferences-test",
  providerInstanceId: instanceId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "synthetic-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-preferences-test-" });
const settingsLayer = Settings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(configLayer),
);
const environmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed({
      environmentId,
      label: "Synthetic environment",
      platform: { os: "windows", arch: "x64" },
      serverVersion: "test",
      orchestrationProtocolVersion: 2,
      capabilities: { repositoryIdentity: false },
    } satisfies ExecutionEnvironmentDescriptor),
  }),
);
const makeTestLayer = (getCaller = Effect.succeed(caller)) =>
  McpHttpServer.EnvironmentRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(configLayer),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => getCaller,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
const update = (arguments_: Record<string, unknown>, scope = invocation) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "t3_environment_preferences_update", arguments: arguments_ })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("updates preferences through production MCP registration and persists changes", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const before = yield* settings.getSettings;
    const noOp = yield* update({
      backgroundActivity: { profile: before.backgroundActivity.profile },
    });
    assert.isFalse(noOp.isError ?? false, JSON.stringify(noOp.content));
    assert.deepInclude(noOp.structuredContent, {
      backgroundActivity: { profile: before.backgroundActivity.profile },
    });
    assert.deepEqual(yield* settings.getSettings, before);
    const changed = yield* update({
      enableProviderUpdateChecks: !before.enableProviderUpdateChecks,
    });
    assert.isFalse(changed.isError ?? false);
    assert.deepEqual(yield* settings.getSettings, {
      ...before,
      enableProviderUpdateChecks: !before.enableProviderUpdateChecks,
    });
    const persisted = decodeSettings(yield* fs.readFileString(config.settingsPath));
    assert.equal(persisted.enableProviderUpdateChecks, !before.enableProviderUpdateChecks);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect.each([
  {
    name: "approval-required",
    patch: { runtimeMode: "approval-required" as const },
    code: "capability_denied",
    scope: invocation,
  },
  {
    name: "auto-accept-edits",
    patch: { runtimeMode: "auto-accept-edits" as const },
    code: "capability_denied",
    scope: invocation,
  },
  {
    name: "auto",
    patch: { runtimeMode: "auto" as const },
    code: "capability_denied",
    scope: invocation,
  },
  { name: "archived", patch: { archivedAt: now }, code: "parent_not_active", scope: invocation },
  {
    name: "non-default",
    patch: { interactionMode: "plan" as const },
    code: "capability_denied",
    scope: invocation,
  },
  {
    name: "read-only credential",
    patch: {},
    code: "capability_denied",
    scope: { ...invocation, capabilities: new Set<"preview" | "orchestration">() },
  },
])("denies $name callers without changing settings", ({ patch, code, scope }) =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const before = yield* settings.updateSettings({});
    const persistedBefore = yield* fs.readFileString(config.settingsPath);
    const result = yield* update(
      {
        enableProviderUpdateChecks: !before.enableProviderUpdateChecks,
      },
      scope,
    );
    assert.deepInclude(result.structuredContent, { _tag: "OrchestratorMcpFailure", code });
    assert.deepEqual(yield* settings.getSettings, before);
    assert.equal(yield* fs.readFileString(config.settingsPath), persistedBefore);
  }).pipe(Effect.provide(makeTestLayer(Effect.succeed({ ...caller, ...patch })))),
);

it.effect.each(["command", "preferences"] as const)(
  "serializes production MCP preferences with orchestrator dispatch when %s enters first",
  (first) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const milestone = (path: "command" | "preferences") =>
        Effect.gen(function* () {
          order.push(path);
          if (path === first) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          } else {
            yield* Deferred.succeed(secondEntered, undefined);
          }
        });
      // Replay a synthetic accepted command through the real dispatch entry point.
      // The receipt lookup runs inside its production thread lock; no provider runs.
      const commandLayer = Orchestrator.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({}),
            Layer.mock(CommandPolicy.CommandPolicyV2)({}),
            Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
            Layer.mock(EventSink.EventSinkV2)({
              readByCommandId: () => Stream.empty,
              latestSequence: () => Effect.succeed(0),
              stream: () => Stream.empty,
            }),
            Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
              getByCommandId: (commandId) =>
                milestone("command").pipe(
                  Effect.as(
                    Option.some({
                      commandId,
                      threadId,
                      commandType: "thread.metadata.update",
                      acceptedAt: now,
                      resultSequence: 0,
                      status: "accepted" as const,
                      error: null,
                    }),
                  ),
                ),
            }),
            IdAllocator.layer,
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([]),
            }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
            Layer.mock(ProviderContinuationRequests.ProviderContinuationRequests)({}),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(ProviderSwitchService.ProviderSwitchServiceV2)({}),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
            Layer.mock(ThreadForkService.ThreadForkServiceV2)({}),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const settings = yield* Settings.ServerSettingsService;
        const before = yield* settings.getSettings;
        const command = orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("command:mcp-lock-test"),
            threadId,
            title: "Synthetic replay",
          })
          .pipe(Effect.orDie, Effect.asVoid);
        const preferences = update({
          enableProviderUpdateChecks: !before.enableProviderUpdateChecks,
        }).pipe(
          Effect.tap((result) => Effect.sync(() => assert.isFalse(result.isError ?? false))),
          Effect.orDie,
          Effect.asVoid,
        );
        const firstFiber = yield* (first === "command" ? command : preferences).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(entered);
        const secondFiber = yield* (first === "command" ? preferences : command).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        // Both fibers have started. The other boundary must still be behind the lock.
        assert.isFalse(yield* Deferred.isDone(secondEntered));
        assert.deepEqual(yield* settings.getSettings, before);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);
        assert.deepEqual(order, [first, first === "command" ? "preferences" : "command"]);
        assert.equal(
          (yield* settings.getSettings).enableProviderUpdateChecks,
          !before.enableProviderUpdateChecks,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeTestLayer(milestone("preferences").pipe(Effect.as(caller))),
            commandLayer,
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }),
);
