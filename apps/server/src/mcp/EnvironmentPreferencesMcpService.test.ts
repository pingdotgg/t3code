import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
  EnvironmentMcpPreferencesUpdateInput,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type KeyedSerialExecutor,
  makeKeyedSerialExecutor,
} from "../orchestration-v2/KeyedSerialExecutor.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ThreadCommandExecutor,
  layer as threadCommandExecutorLayer,
} from "../orchestration-v2/ThreadCommandExecutor.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  layer as threadManagementLayer,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  EnvironmentMcpService,
  layer as environmentMcpLayer,
  make as makeEnvironmentMcpService,
} from "./EnvironmentMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const decodePreferencesUpdate = Schema.decodeUnknownEffect(EnvironmentMcpPreferencesUpdateInput);
const decodePersistedSettings = Schema.decodeUnknownEffect(fromLenientJson(ServerSettings));
const environmentId = EnvironmentId.make("environment-preferences-test");
const threadId = ThreadId.make("thread:environment-preferences-test");
const projectId = ProjectId.make("project:environment-preferences-test");
const scope: McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session:environment-preferences-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const environmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("descriptor must not be read by preference updates"),
  }),
);

const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
const fullAccessShell = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Environment preference caller",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: threadId,
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
} satisfies OrchestrationV2ThreadShell;

const threadLayer = Layer.mock(ThreadManagementService)({
  getThreadShell: () => Effect.succeed(fullAccessShell),
});

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-environment-preferences-test-",
        }),
      ),
    ),
  );

it.effect("persists only allowlisted preferences and publishes the normalized settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* EnvironmentMcpService;
      const settingsService = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* settingsService.updateSettings({
        enableProviderUpdateChecks: false,
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "Keep this seeded instruction unless it is explicitly cleared.",
          followChangeRequestTemplates: true,
        },
      });
      const changes = yield* settingsService.subscribeChanges;

      const result = yield* service.updatePreferences(scope, {
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: false,
        backgroundActivity: { profile: "performance" },
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "",
          followChangeRequestTemplates: false,
        },
      });
      const published = Option.getOrThrow(yield* Stream.runHead(changes));
      const readBack = yield* settingsService.getSettings;
      const persistedRaw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = yield* decodePersistedSettings(persistedRaw);

      expect(result.preferences).toMatchObject({
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: false,
        enableProviderUpdateChecks: false,
        backgroundActivity: { profile: "performance", baseProfile: null },
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: {
            text: "",
            characters: 0,
            maximumCharacters: ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS,
            truncated: false,
          },
          followChangeRequestTemplates: false,
        },
      });
      expect(readBack.defaultThreadEnvMode).toBe("worktree");
      expect(readBack.enableProviderUpdateChecks).toBe(false);
      expect(readBack.enableAgentBrowserAccess).toBe(true);
      expect(readBack.backgroundActivity).toEqual({
        schemaVersion: 1,
        profile: "performance",
        overrides: {},
      });
      expect(published.sourceControlWritingStyle.customInstructions).toBe("");
      expect(persisted.defaultThreadEnvMode).toBe("worktree");
      expect(persisted.enableProviderUpdateChecks).toBe(false);
      expect(persisted.sourceControlWritingStyle.customInstructions).toBe("");
    }),
  ).pipe(
    Effect.provide(
      environmentMcpLayer.pipe(
        Layer.provideMerge(makeServerSettingsLayer()),
        Layer.provide(
          Layer.mergeAll(
            environmentLayer,
            Layer.succeed(ProviderRegistry, makeProviderRegistryMock()),
            threadLayer,
            threadCommandExecutorLayer,
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("validates writing instructions by Unicode code points", () =>
  Effect.gen(function* () {
    const exact = "😀".repeat(ENVIRONMENT_MCP_MAX_WRITING_INSTRUCTIONS);
    const accepted = yield* decodePreferencesUpdate({
      sourceControlWritingStyle: { customInstructions: exact },
    });
    expect(accepted.sourceControlWritingStyle?.customInstructions).toBe(exact);

    const rejected = yield* Effect.exit(
      decodePreferencesUpdate({
        sourceControlWritingStyle: { customInstructions: `${exact}😀` },
      }),
    );
    expect(rejected._tag).toBe("Failure");
  }),
);

it.effect("observes a real caller downgrade before preference persistence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDispatch = yield* makeKeyedSerialExecutor<ThreadId>();
      const raceActive = yield* Ref.make(false);
      const acquisitionCount = yield* Ref.make(0);
      const writerHolding = yield* Deferred.make<void>();
      const updateWaiting = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const instrumentedDispatch: KeyedSerialExecutor<ThreadId> = {
        withLock: (requestedThreadId, effect) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(raceActive)) || requestedThreadId !== threadId) {
              return yield* baseDispatch.withLock(requestedThreadId, effect);
            }
            const count = yield* Ref.updateAndGet(acquisitionCount, (value) => value + 1);
            if (count === 1) {
              return yield* baseDispatch.withLock(
                requestedThreadId,
                Deferred.succeed(writerHolding, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseWriter)),
                  Effect.andThen(effect),
                ),
              );
            }
            yield* Deferred.succeed(updateWaiting, undefined);
            return yield* baseDispatch.withLock(requestedThreadId, effect);
          }),
      };
      const dispatchLayer = Layer.succeed(ThreadCommandExecutor, instrumentedDispatch);
      const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name: "environment-preferences-policy-race",
          runtimePolicyOverride: {
            cwd: "/tmp/environment-preferences-policy-race",
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        },
        makeProviderAdapterRegistryLayer([]),
        { runEffectWorker: false, threadCommandExecutorLayer: dispatchLayer },
      );
      const applicationLayer = Layer.merge(
        orchestratorLayer,
        threadManagementLayer.pipe(Layer.provide(orchestratorLayer)),
      );

      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService;
        const sharedDispatch = yield* ThreadCommandExecutor;
        const orchestrator = yield* OrchestratorV2;
        yield* threads.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:environment-preferences:create"),
          threadId,
          projectId,
          title: "Environment preference caller",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });

        let updateCalls = 0;
        const settingsService = ServerSettingsModule.ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: (_patch) =>
            Effect.sync(() => {
              updateCalls += 1;
              return DEFAULT_SERVER_SETTINGS;
            }),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.succeed(Stream.empty),
        });
        const service = yield* makeEnvironmentMcpService.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ThreadCommandExecutor, sharedDispatch),
          Effect.provideService(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(environmentId),
              getDescriptor: Effect.die("descriptor must not be read"),
            }),
          ),
          Effect.provideService(ProviderRegistry, makeProviderRegistryMock()),
          Effect.provideService(ServerSettingsModule.ServerSettingsService, settingsService),
        );

        yield* Ref.set(raceActive, true);
        const downgrade = yield* threads
          .dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("command:environment-preferences:downgrade"),
            threadId,
            interactionMode: "plan",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(writerHolding);

        const update = yield* service
          .updatePreferences(scope, { enableProviderUpdateChecks: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(updateWaiting);
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(downgrade);
        const denied = yield* Fiber.join(update).pipe(Effect.flip);

        assert.equal(denied.code, "permission_denied");
        assert.equal(updateCalls, 0);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.interactionMode,
          "plan",
        );
      }).pipe(Effect.provide(applicationLayer));
    }),
  ),
);
