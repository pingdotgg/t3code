import * as CodexErrors from "effect-codex-app-server/errors";
import { vi } from "vite-plus/test";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert, expect } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deepMerge } from "@t3tools/shared/Struct";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
process.env.T3CODE_CURSOR_ENABLED = "1";

import {
  OBSOLETE_CODEX_APP_SERVER,
  TEST_EPOCH,
  awaitPersistedProvider,
  booleanDescriptor,
  claudeCapabilities,
  codexModelCapabilities,
  decodeCodexSettings,
  decodeServerProvider,
  decodeServerSettings,
  defaultClaudeSettings,
  defaultCodexSettings,
  disabledDefaultSlots,
  encodeServerProvider,
  encodeServerSettings,
  encodedDefaultServerSettings,
  encoder,
  layerBackgroundPolicyAlwaysRun,
  layerMockSpawner,
  layerTestHttpClient,
  layerTestNodeServices,
  layerUnusedMutator,
  makeCodexProbeSnapshot,
  makeMutableServerSettingsService,
  mockHandle,
  selectDescriptor,
  withBundledCompatibility,
  writeFakeCodexCli,
} from "./ProviderRegistry-fixtures.testkit.ts";
import type { TestClaudeCapabilities } from "./ProviderRegistry-fixtures.testkit.ts";

it.layer(
  Layer.mergeAll(layerTestNodeServices, ServerSettingsModule.layerTest(), layerTestHttpClient),
)("ProviderRegistry", (it) => {
  describe("ProviderRegistry.layer", () => {
    describe("Codex model inventories", () => {
      const cachedProvider = {
        instanceId: ProviderInstanceId.make("codex-personal"),
        driver: ProviderDriverKind.make("codex"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-04T19:00:00.000Z",
        version: "0.153.3",
        models: ["vega-alpha", "joule-alpha", "kindle-alpha", "ultima-alpha", "solstice-alpha"].map(
          (slug) => ({ slug, name: slug, isCustom: false, capabilities: null }),
        ),
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const customModel = {
        slug: "custom-model",
        name: "Custom model",
        isCustom: true,
        capabilities: null,
      } as const;
      const refreshedProvider = {
        ...cachedProvider,
        checkedAt: "2026-09-04T19:01:00.000Z",
        models: [
          { slug: "gpt-6-astra", name: "GPT 6 Astra", isCustom: false, capabilities: null },
          cachedProvider.models[0]!,
          customModel,
        ],
      } satisfies ServerProvider;
      const pendingProvider = {
        ...cachedProvider,
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        models: [customModel],
      } satisfies ServerProvider;
      const failedProvider = {
        ...pendingProvider,
        checkedAt: "2026-09-04T19:02:00.000Z",
        status: "error",
        installed: true,
      } satisfies ServerProvider;

      it.effect("persists removals across failed refreshes and registry restarts", () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cachedProvider.instanceId,
          });
          yield* writeProviderStatusCache({ filePath, provider: cachedProvider });
          const nextProvider = yield* Ref.make<ServerProvider>(refreshedProvider);
          const currentProvider = yield* Ref.make<ServerProvider>(pendingProvider);
          const instance = {
            instanceId: cachedProvider.instanceId,
            driverKind: cachedProvider.driver,
            continuationIdentity: {
              driverKind: cachedProvider.driver,
              continuationKey: "codex:instance:codex-personal",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: cachedProvider.driver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Ref.get(currentProvider),
              refresh: Ref.get(nextProvider).pipe(
                Effect.tap((provider) => Ref.set(currentProvider, provider)),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (id) =>
                Effect.succeed(id === instance.instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const retainedModels = [
            customModel,
            ...refreshedProvider.models.filter((model) => !model.isCustom),
          ];

          for (const restarted of [false, true]) {
            yield* Ref.set(currentProvider, pendingProvider);
            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const expectedModels = restarted
                ? retainedModels
                : [customModel, ...cachedProvider.models];
              assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, expectedModels);

              yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                restarted ? retainedModels : refreshedProvider.models,
              );

              yield* Ref.set(nextProvider, failedProvider);
              const afterFailure = yield* registry.refreshInstance(instance.instanceId);
              assert.deepStrictEqual(afterFailure[0]?.models, retainedModels);
              assert.deepStrictEqual(
                (yield* readProviderStatusCache(filePath))?.models,
                retainedModels,
              );
            }).pipe(
              Effect.provide(
                ProviderRegistry.layer.pipe(
                  Layer.provide(layerInstanceRegistry),
                  Layer.provide(layerUnusedMutator),
                ),
              ),
              Effect.scoped,
            );
          }
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-codex-retired-model-cache-",
            }).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
          ),
        ),
      );
    });

    describe("Antigravity model inventories", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("antigravity-personal"),
        driver: ProviderDriverKind.make("antigravity"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-02T00:00:00.000Z",
        version: "0.1.3",
        models: [
          {
            slug: "gemini-3.1-pro-high",
            name: "Gemini 3.1 Pro High",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gemini-3-flash",
            name: "Gemini 3 Flash",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;

      it("clears models after sign-out, disable, uninstall, or an empty successful refresh", () => {
        const emptyProvider = {
          ...previousProvider,
          checkedAt: "2026-09-02T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const clearedProviders = [
          { ...emptyProvider, status: "warning", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "error", auth: { status: "unauthenticated" } },
          { ...emptyProvider, status: "disabled", enabled: false },
          { ...emptyProvider, status: "error", enabled: false },
          { ...emptyProvider, status: "error", installed: false, auth: { status: "unknown" } },
          emptyProvider,
        ] satisfies ReadonlyArray<ServerProvider>;

        for (const provider of clearedProviders) {
          const afterRemoval = ProviderRegistry.mergeProviderSnapshot(previousProvider, provider);
          assert.deepStrictEqual(afterRemoval.models, []);

          const afterFailure = ProviderRegistry.mergeProviderSnapshot(afterRemoval, {
            ...emptyProvider,
            status: "error",
            auth: { status: "unknown" },
          });
          assert.deepStrictEqual(afterFailure.models, []);
        }
      });
    });

    describe("Antigravity saved account", () => {
      const signedIn = {
        instanceId: ProviderInstanceId.make("antigravity-personal"),
        driver: ProviderDriverKind.make("antigravity"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
        checkedAt: "2026-09-05T00:00:00.000Z",
        version: "agy_acp_server_1.1.1",
        models: [
          {
            slug: "gemini-3.7-flash-high",
            name: "Gemini 3.7 Flash",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [{ name: "plan" }],
        skills: [],
      } as const satisfies ServerProvider;
      const uncheckedMessage =
        "Antigravity is installed. Google account access is not checked yet.";
      const restartProbe = {
        ...signedIn,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-09-05T00:01:00.000Z",
        message: uncheckedMessage,
        models: [],
      } as const satisfies ServerProvider;

      it("keeps the saved Google account through restart health checks", () => {
        const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, restartProbe);
        const { message: _uncheckedMessage, ...probeWithoutMessage } = restartProbe;
        assert.deepStrictEqual(merged, {
          ...probeWithoutMessage,
          status: "ready",
          auth: signedIn.auth,
          models: signedIn.models,
        });
        assert.equal("message" in merged, false);
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(merged, restartProbe),
          merged,
        );
      });

      it("does not invent an account after sign-out, disable, uninstall, or for other providers", () => {
        const untouched = [
          { ...restartProbe, auth: { status: "unauthenticated" } },
          { ...restartProbe, status: "disabled", enabled: false },
          { ...restartProbe, status: "error", installed: false },
          { ...restartProbe, driver: ProviderDriverKind.make("codex") },
          { ...restartProbe, auth: { status: "unknown", type: "gemini-api-key" } },
        ] satisfies ReadonlyArray<ServerProvider>;
        for (const next of untouched) {
          const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, next);
          assert.deepStrictEqual(merged.auth, next.auth);
          assert.equal(merged.status, next.status);
          assert.equal(merged.message, next.message);
        }
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(
            { ...signedIn, auth: { status: "unknown" } },
            restartProbe,
          ).auth,
          { status: "unknown" },
        );
        assert.equal(
          ProviderRegistry.mergeProviderSnapshot(
            { ...signedIn, driver: ProviderDriverKind.make("codex") },
            restartProbe,
          ).auth.status,
          "unknown",
        );
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(signedIn, {
            ...restartProbe,
            auth: { status: "unknown", type: "oauth-personal" },
          }).auth,
          signedIn.auth,
        );
      });
    });

    it("fills missing capabilities from the previous provider snapshot", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: "2026.04.09-f2b0fcd",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Reasoning", [
                  { id: "high", label: "High", isDefault: true },
                ]),
                booleanDescriptor("fastMode", "Fast Mode"),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [],
            }),
          },
        ],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
    });

    it.effect("invalidates model caches only for an explicit model refresh", () =>
      Effect.gen(function* () {
        const forceRefreshCalls = yield* Ref.make(0);
        const makeInstance = (name: string) =>
          Effect.gen(function* () {
            const driver = ProviderDriverKind.make("codex");
            const instanceId = ProviderInstanceId.make(name);
            const provider = {
              instanceId,
              driver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt: "2026-06-10T00:00:00.000Z",
              version: "1.0.0",
              models: [],
              slashCommands: [],
              skills: [],
            } as const satisfies ServerProvider;
            const invalidations = yield* Ref.make(0);
            const maintenanceReads = yield* Ref.make<ReadonlyArray<boolean>>([]);
            const instance = {
              instanceId,
              driverKind: driver,
              continuationIdentity: {
                driverKind: driver,
                continuationKey: `codex:instance:${name}`,
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                resolveMaintenance: (options) =>
                  Ref.update(maintenanceReads, (reads) => [...reads, options?.fresh === true]).pipe(
                    Effect.as(
                      makeManualOnlyProviderMaintenanceCapabilities({
                        provider: driver,
                        packageName: `${name}-package`,
                      }),
                    ),
                  ),
                getSnapshot: Effect.succeed(provider),
                refresh: Effect.succeed(provider),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              invalidateCaches: Ref.update(invalidations, (count) => count + 1),
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const takeMaintenanceReads = Ref.getAndSet(maintenanceReads, []);
            return { instance, invalidations, takeMaintenanceReads };
          });
        const first = yield* makeInstance("codex_first");
        const second = yield* makeInstance("codex_second");
        const instances = [first.instance, second.instance];
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          },
        );
        const layerModelManifest = Layer.succeed(ModelManifest.ModelManifest, {
          current: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          refresh: Effect.succeed(ModelManifest.BUNDLED_MODEL_MANIFEST),
          forceRefresh: Ref.update(forceRefreshCalls, (count) => count + 1).pipe(
            Effect.as(ModelManifest.BUNDLED_MODEL_MANIFEST),
          ),
          refreshInBackground: Effect.void,
        });
        const layerLatestVersions = Layer.effect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([
            ["codex_first-package", "1.0.0"],
            ["codex_second-package", "1.0.0"],
          ]),
        );
        const readCachedVersion = (key: string) =>
          ProviderLatestVersions.ProviderLatestVersions.use((latestVersions) =>
            latestVersions.cached(key, Effect.succeed("2.0.0")),
          );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          yield* registry.refreshInstance(first.instance.instanceId);
          yield* registry.refresh();
          assert.strictEqual(yield* Ref.get(forceRefreshCalls), 0);
          assert.strictEqual(yield* Ref.get(first.invalidations), 0);
          assert.strictEqual(yield* readCachedVersion("codex_first-package"), "1.0.0");
          yield* first.takeMaintenanceReads;

          yield* registry.invalidateModelCaches({ instanceId: first.instance.instanceId });
          // The instance refresh that follows resolves installer metadata fresh itself.
          assert.deepStrictEqual(yield* first.takeMaintenanceReads, [false]);
          assert.strictEqual(yield* Ref.get(forceRefreshCalls), 1);
          assert.strictEqual(yield* Ref.get(first.invalidations), 1);
          assert.strictEqual(yield* Ref.get(second.invalidations), 0);
          assert.strictEqual(yield* readCachedVersion("codex_first-package"), "2.0.0");
          assert.strictEqual(yield* readCachedVersion("codex_second-package"), "1.0.0");

          yield* registry.invalidateModelCaches({});
          assert.strictEqual(yield* Ref.get(first.invalidations), 2);
          assert.strictEqual(yield* Ref.get(second.invalidations), 1);
          assert.strictEqual(yield* readCachedVersion("codex_second-package"), "2.0.0");
          yield* first.takeMaintenanceReads;

          // Only a cached workspace refresh leaves the fresh resolution to this call.
          const workspace = { instanceId: first.instance.instanceId, cwd: process.cwd() };
          yield* registry.invalidateModelCaches(workspace);
          assert.deepStrictEqual(yield* first.takeMaintenanceReads, [true]);
          yield* registry.invalidateModelCaches({ ...workspace, fresh: true });
          assert.deepStrictEqual(yield* first.takeMaintenanceReads, [false]);
        }).pipe(
          Effect.provide(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provideMerge(layerModelManifest),
              Layer.provideMerge(layerLatestVersions),
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-model-cache-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    );

    it.effect(
      "a second request for a cwd being scanned gets its result, even if the first leaves",
      () =>
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("codex");
          const instanceId = ProviderInstanceId.make("codex");
          const provider = {
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const scanStarted = yield* Deferred.make<void>();
          const releaseScan = yield* Deferred.make<void>();
          const scans = yield* Ref.make(0);
          const instance: ProviderInstance = {
            instanceId,
            driverKind: driver,
            continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: driver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            snapshotForCwd: () =>
              Ref.update(scans, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(scanStarted, undefined)),
                Effect.andThen(Deferred.await(releaseScan)),
                Effect.as(provider),
              ),
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          };
          const layerInstanceRegistry = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Effect.succeed(requestedId === instanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(layerInstanceRegistry),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-shared-workspace-scan-",
                }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const refresh = registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
            const first = yield* Effect.forkChild(refresh);
            yield* Deferred.await(scanStarted);
            const second = yield* Effect.forkChild(refresh, { startImmediately: true });
            yield* Fiber.interrupt(first);
            yield* Deferred.succeed(releaseScan, undefined);
            assert.deepStrictEqual(
              (yield* Fiber.join(second))[0]?.workspaceSnapshots?.map((snapshot) => snapshot.cwd),
              ["/workspace"],
            );
            assert.strictEqual(yield* Ref.get(scans), 1);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );
  });
});
