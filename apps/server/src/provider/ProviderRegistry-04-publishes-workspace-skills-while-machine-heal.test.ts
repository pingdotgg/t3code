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
    it.effect("publishes workspace skills while machine health is in error", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const healthyProvider = {
          instanceId,
          driver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-06-10T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [COMPACT_SLASH_COMMAND],
          skills: [],
        } as const satisfies ServerProvider;
        const unhealthyProvider = {
          ...healthyProvider,
          status: "error",
          auth: { status: "unknown" },
          message: "Codex app-server provider probe failed: unauthorized (401).",
          slashCommands: [],
        } as const satisfies ServerProvider;
        const firstSkills = [{ name: "first", path: "/workspace/first/SKILL.md", enabled: true }];
        const laterSkills = [{ name: "later", path: "/workspace/later/SKILL.md", enabled: true }];
        const scanResult = yield* Ref.make<ProviderWorkspaceSnapshot>({
          ...healthyProvider,
          skills: firstSkills,
        });
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
            getSnapshot: Effect.succeed(unhealthyProvider),
            refresh: Effect.succeed(unhealthyProvider),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          snapshotForCwd: () => Ref.get(scanResult),
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
                prefix: "t3-provider-registry-unhealthy-workspace-",
              }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const workspaceOf = Effect.map(
            registry.getProviders,
            (providers) => providers[0]?.workspaceSnapshots?.[0],
          );
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.slashCommands, [COMPACT_SLASH_COMMAND]);

          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const unhealthy = yield* workspaceOf;
          assert.deepStrictEqual(unhealthy?.skills, laterSkills);
          assert.deepStrictEqual(unhealthy?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(unhealthy?.slashCommandsPending, true);
          const provider = (yield* registry.getProviders)[0];
          assert.strictEqual(provider?.status, "error");
          assert.strictEqual(provider?.message, unhealthyProvider.message);

          yield* Ref.set(scanResult, { ...unhealthyProvider, skills: [] });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          assert.deepStrictEqual((yield* workspaceOf)?.skills, []);

          const discoveredCommand = { name: "review", description: "Review changes" };
          yield* Ref.set(scanResult, {
            ...unhealthyProvider,
            slashCommands: [discoveredCommand],
            slashCommandsPending: false,
          });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const discovered = yield* workspaceOf;
          assert.deepStrictEqual(discovered?.slashCommands, [discoveredCommand]);
          assert.strictEqual(discovered?.slashCommandsPending, undefined);

          yield* TestClock.adjust(PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS);
          yield* Ref.set(scanResult, { ...healthyProvider, skills: laterSkills });
          yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
          const recovered = yield* workspaceOf;
          assert.deepStrictEqual(recovered?.skills, laterSkills);
          assert.deepStrictEqual(recovered?.slashCommands, [COMPACT_SLASH_COMMAND]);
          assert.strictEqual(recovered?.slashCommandsPending, undefined);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("shares one in-flight pass between concurrent untargeted refreshes", () =>
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
        const refreshCalls = yield* Ref.make(0);
        const probeStarted = yield* Deferred.make<void>();
        const releaseProbe = yield* Deferred.make<void>();
        const instances = [
          {
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
              refresh: Effect.gen(function* () {
                yield* Ref.update(refreshCalls, (count) => count + 1);
                yield* Deferred.succeed(probeStarted, undefined);
                yield* Deferred.await(releaseProbe);
                return provider;
              }),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          },
        ] satisfies ReadonlyArray<ProviderInstance>;
        const instanceRegistryLayer = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (requestedId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
            listInstances: Effect.succeed(instances),
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
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-shared-refresh-",
              }),
            ),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const first = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const second = yield* registry.refresh().pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);
          yield* Deferred.succeed(releaseProbe, undefined);
          expect(yield* Fiber.join(first)).toEqual([expect.objectContaining(provider)]);
          expect(yield* Fiber.join(second)).toEqual([expect.objectContaining(provider)]);
          assert.strictEqual(yield* Ref.get(refreshCalls), 1);

          yield* registry.refresh();
          assert.strictEqual(yield* Ref.get(refreshCalls), 2);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("ignores a probe from an instance that settings replaced mid-refresh", () =>
      Effect.gen(function* () {
        const scenario = Effect.fn(function* (
          probeFails: boolean,
          run: (
            registry: ProviderRegistry.ProviderRegistry["Service"],
          ) => Effect.Effect<ReadonlyArray<ServerProvider>>,
        ) {
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
            version: "2.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const retiredProbe = {
            ...provider,
            status: "error",
            installed: false,
            version: "1.0.0",
            message: "Codex CLI is not installed.",
          } as const satisfies ServerProvider;
          const probeStarted = yield* Deferred.make<void>();
          const releaseProbe = yield* Deferred.make<void>();
          const makeInstance = (snapshot: ServerProvider, refresh: Effect.Effect<void>) =>
            ({
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
                getSnapshot: Effect.succeed(snapshot),
                refresh: Effect.as(refresh, snapshot),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            }) satisfies ProviderInstance;
          const retiredInstance = makeInstance(
            retiredProbe,
            Deferred.succeed(probeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProbe)),
              Effect.andThen(probeFails ? Effect.die(new Error("probe failed")) : Effect.void),
            ),
          );
          const rebuiltInstance = makeInstance(provider, Effect.void);
          const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([retiredInstance]);
          const changes = yield* PubSub.unbounded<void>();
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Ref.get(instances).pipe(
                  Effect.map((current) =>
                    current.find((instance) => instance.instanceId === requestedId),
                  ),
                ),
              listInstances: Ref.get(instances),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provide(layerUnusedMutator),
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-retired-refresh-",
                }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          return yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const rebuiltPublished = yield* Stream.toPull(
              registry.streamChanges.pipe(
                Stream.filter((providers) => providers[0]?.version === provider.version),
              ),
            );
            const refresh = yield* run(registry).pipe(Effect.forkChild);
            yield* Deferred.await(probeStarted);
            yield* Ref.set(instances, [rebuiltInstance]);
            yield* PubSub.publish(changes, undefined);
            yield* rebuiltPublished;
            yield* Deferred.succeed(releaseProbe, undefined);
            return {
              provider,
              result: yield* Fiber.join(refresh),
              providers: yield* registry.getProviders,
            };
          }).pipe(Effect.provide(runtimeServices));
        });
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");

        const manual = yield* scenario(false, (registry) => registry.refresh());
        expect(manual.result).toEqual([expect.objectContaining(manual.provider)]);
        expect(manual.providers).toEqual([expect.objectContaining(manual.provider)]);

        // Neither the retired probe's failure nor its cached row can stand in for the replacement.
        for (const probeFails of [true, false]) {
          const afterUpdate = yield* scenario(probeFails, (registry) =>
            registry.refreshAfterUpdate(driver, instanceId),
          );
          expect(afterUpdate.result).toEqual([]);
          expect(afterUpdate.providers).toEqual([expect.objectContaining(afterUpdate.provider)]);
        }
      }),
    );

    it.effect("keeps an enriched snapshot that streams in before a manual refresh returns", () =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("acpRegistry");
        const instanceId = ProviderInstanceId.make("gemini");
        const initialProvider = {
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
        const pendingProvider = {
          ...initialProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-06-10T00:01:00.000Z",
          message: "Checking ACP authentication, models, and commands in the background...",
        } as const satisfies ServerProvider;
        const enrichedProvider = {
          ...initialProvider,
          status: "error",
          auth: { status: "unauthenticated" },
          checkedAt: "2026-06-10T00:01:01.000Z",
          message: "Sign in to Gemini to use this agent.",
        } as const satisfies ServerProvider;
        const snapshotRef = yield* Ref.make<ServerProvider>(initialProvider);
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const publishSnapshot = (provider: ServerProvider) =>
          Ref.set(snapshotRef, provider).pipe(Effect.andThen(PubSub.publish(changes, provider)));
        const releaseRefresh = yield* Deferred.make<void>();
        const instance = {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: "acpRegistry:gemini" },
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
            getSnapshot: Ref.get(snapshotRef),
            // Like a managed provider: publish the probe, let enrichment publish its result,
            // then return the probe after a slow tail such as ACP's refreshMethods.
            refresh: Effect.gen(function* () {
              yield* publishSnapshot(pendingProvider);
              yield* publishSnapshot(enrichedProvider);
              yield* Deferred.await(releaseRefresh);
              return pendingProvider;
            }),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const instanceRegistryLayer = Layer.succeed(
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
            Layer.provideMerge(instanceRegistryLayer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-enriched-refresh-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId,
          });
          expect(yield* registry.getProviders).toEqual([expect.objectContaining(initialProvider)]);

          const enrichedObserved = yield* awaitPersistedProvider(
            registry,
            enrichedProvider.checkedAt,
          );
          const refreshed = yield* registry.refreshInstance(instanceId).pipe(Effect.forkChild);
          yield* Fiber.join(enrichedObserved);
          yield* Deferred.succeed(releaseRefresh, undefined);
          const returned = yield* Fiber.join(refreshed);

          const enriched = {
            status: enrichedProvider.status,
            auth: enrichedProvider.auth,
            message: enrichedProvider.message,
            checkedAt: enrichedProvider.checkedAt,
          };
          expect(
            yield* registry.getProviders,
            "getProviders should hold the enriched snapshot, not the stale pending one refresh returned",
          ).toEqual([expect.objectContaining(enriched)]);
          expect(returned).toEqual([expect.objectContaining(enriched)]);
          expect(yield* readProviderStatusCache(filePath)).toEqual(
            expect.objectContaining(enriched),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("persists the merged snapshot when a live update has empty models", () =>
      Effect.gen(function* () {
        const cursorDriver = ProviderDriverKind.make("cursor");
        const cursorInstanceId = ProviderInstanceId.make("cursor");
        const initialProvider = {
          instanceId: cursorInstanceId,
          driver: cursorDriver,
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
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...initialProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: cursorInstanceId,
          driverKind: cursorDriver,
          continuationIdentity: {
            driverKind: cursorDriver,
            continuationKey: "cursor:instance:cursor",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: cursorDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(refreshedProvider),
            streamChanges: Stream.fromPubSub(changes),
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
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
                prefix: "t3-provider-registry-merged-persist-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: cursorInstanceId,
          });

          assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
            ...initialProvider.models,
          ]);
          const persisted = yield* awaitPersistedProvider(registry, refreshedProvider.checkedAt);
          yield* PubSub.publish(changes, refreshedProvider);
          yield* Fiber.join(persisted);
          const cachedProvider = yield* readProviderStatusCache(filePath);

          assert.deepStrictEqual(
            cachedProvider,
            withBundledCompatibility({
              ...refreshedProvider,
              models: [...initialProvider.models],
            }),
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );
  });
});
