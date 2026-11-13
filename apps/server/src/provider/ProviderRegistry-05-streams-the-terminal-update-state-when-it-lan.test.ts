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
    it.effect("streams the terminal update state when it lands during a slow cache write", () =>
      Effect.gen(function* () {
        const claudeDriver = ProviderDriverKind.make("claude");
        const claudeInstanceId = ProviderInstanceId.make("claude");
        const initialProvider = {
          instanceId: claudeInstanceId,
          driver: claudeDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2.1.300",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const verifyingProvider = { ...initialProvider, checkedAt: "2026-04-14T00:01:00.000Z" };
        const laterProvider = { ...initialProvider, checkedAt: "2026-04-14T00:02:00.000Z" };
        const changes = yield* PubSub.unbounded<ServerProvider>();
        const instance = {
          instanceId: claudeInstanceId,
          driverKind: claudeDriver,
          continuationIdentity: {
            driverKind: claudeDriver,
            continuationKey: "claude:instance:claude",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: claudeDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(initialProvider),
            refresh: Effect.succeed(initialProvider),
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
              Effect.succeed(instanceId === claudeInstanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          },
        );
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const gatedCachePath = yield* Ref.make<string | undefined>(undefined);
        const layerGatedFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            return {
              ...fileSystem,
              rename: (from, to) =>
                Ref.modify(gatedCachePath, (path) =>
                  path === to ? [true, undefined] : [false, path],
                ).pipe(
                  Effect.flatMap((gated) =>
                    gated
                      ? Deferred.succeed(writeStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseWrite)),
                        )
                      : Effect.void,
                  ),
                  Effect.andThen(fileSystem.rename(from, to)),
                ),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer));
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistry.layer.pipe(
            Layer.provide(layerUnusedMutator),
            Layer.provideMerge(layerInstanceRegistry),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-update-state-race-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(layerGatedFileSystem),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const config = yield* ServerConfig.ServerConfig;
          const running = {
            status: "running",
            startedAt: "2026-04-14T00:00:30.000Z",
            finishedAt: null,
            message: "Verifying the installed version",
            output: null,
          } as const;
          const unchanged = {
            ...running,
            status: "unchanged",
            finishedAt: "2026-04-14T00:01:30.000Z",
            message:
              "Update command completed, but T3 Code still detects an outdated provider version.",
          } as const;
          yield* registry.setProviderMaintenanceActionState({
            instanceId: claudeInstanceId,
            action: "update",
            state: running,
          });
          const streamed = yield* registry.streamChanges.pipe(
            Stream.takeUntil((providers) =>
              providers.some((provider) => provider.checkedAt === laterProvider.checkedAt),
            ),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );

          yield* Ref.set(
            gatedCachePath,
            yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: claudeInstanceId,
            }),
          );
          yield* PubSub.publish(changes, verifyingProvider);
          yield* Deferred.await(writeStarted);
          yield* registry.setProviderMaintenanceActionState({
            instanceId: claudeInstanceId,
            action: "update",
            state: unchanged,
          });
          yield* Deferred.succeed(releaseWrite, undefined);
          // The snapshot stream is consumed in order, so this lands after the slow write publishes.
          yield* PubSub.publish(changes, laterProvider);

          const updateStateOf = (providers: ReadonlyArray<ServerProvider> | undefined) =>
            providers?.find((provider) => provider.instanceId === claudeInstanceId)?.updateState;
          const beforeLater = (yield* Fiber.join(streamed)).slice(0, -1);
          assert.deepStrictEqual(updateStateOf(yield* registry.getProviders), unchanged);
          assert.deepStrictEqual(
            updateStateOf(beforeLater.at(-1)),
            unchanged,
            "the last streamed providers before the next snapshot should carry the terminal update state",
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect(
      "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
      () =>
        Effect.gen(function* () {
          const openCodeDriver = ProviderDriverKind.make("opencode");
          const openCodeInstanceId = ProviderInstanceId.make("opencode");
          const initialProvider = {
            instanceId: openCodeInstanceId,
            driver: openCodeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-07-17T00:00:00.000Z",
            version: "1.0.0",
            models: [
              {
                slug: "github/gpt-5",
                name: "GPT-5",
                subProvider: "GitHub",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "removed-plugin/model",
                name: "Removed Plugin Model",
                subProvider: "Removed Plugin",
                isCustom: false,
                capabilities: null,
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const authoritativeProvider = {
            ...initialProvider,
            checkedAt: "2026-07-17T00:01:00.000Z",
            models: [initialProvider.models[0]!],
          } satisfies ServerProvider;
          const failedProvider = {
            ...authoritativeProvider,
            status: "error",
            auth: { status: "unknown" },
            checkedAt: "2026-07-17T00:02:00.000Z",
            models: [],
            message: "Failed to refresh OpenCode models.",
          } satisfies ServerProvider;
          const changes = yield* PubSub.unbounded<ServerProvider>();
          const instance = {
            instanceId: openCodeInstanceId,
            driverKind: openCodeDriver,
            continuationIdentity: {
              driverKind: openCodeDriver,
              continuationKey: "opencode:instance:opencode",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              resolveMaintenance: () =>
                Effect.succeed(
                  makeManualOnlyProviderMaintenanceCapabilities({
                    provider: openCodeDriver,
                    packageName: null,
                  }),
                ),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(authoritativeProvider),
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
                Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
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
                  prefix: "t3-provider-registry-opencode-authoritative-persist-",
                }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;
            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: openCodeInstanceId,
            });

            const authoritativePersisted = yield* awaitPersistedProvider(
              registry,
              authoritativeProvider.checkedAt,
            );
            yield* PubSub.publish(changes, authoritativeProvider);
            yield* Fiber.join(authoritativePersisted);
            let cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

            const failedPersisted = yield* awaitPersistedProvider(
              registry,
              failedProvider.checkedAt,
            );
            yield* PubSub.publish(changes, failedProvider);
            yield* Fiber.join(failedPersisted);
            cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);
            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              authoritativeProvider.models[0]!,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
    );

    it.effect("returns the cached provider list when a manual refresh fails", () =>
      Effect.gen(function* () {
        const codexDriver = ProviderDriverKind.make("codex");
        const codexInstanceId = ProviderInstanceId.make("codex");
        const cachedProvider = {
          instanceId: codexInstanceId,
          driver: codexDriver,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-29T10:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const instance = {
          instanceId: codexInstanceId,
          driverKind: codexDriver,
          continuationIdentity: {
            driverKind: codexDriver,
            continuationKey: "codex:instance:codex",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
              ),
            getSnapshot: Effect.succeed(cachedProvider),
            refresh: Effect.die(new Error("simulated refresh failure")),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const layerInstanceRegistry = Layer.succeed(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          {
            getInstance: (instanceId) =>
              Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
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
                prefix: "t3-provider-registry-refresh-failure-",
              }),
            ),
            Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;

          assert.deepStrictEqual(yield* registry.getProviders, [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refresh(codexDriver), [
            withBundledCompatibility(cachedProvider),
          ]);
          assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
            withBundledCompatibility(cachedProvider),
          ]);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("re-probes when settings change the codex binaryPath", () =>
      Effect.gen(function* () {
        const firstMissing = `t3code_codex_first_`;
        const secondMissing = `t3code_codex_second_`;
        const spawnedCommands: Array<string> = [];
        const secondProbeStarted = yield* Deferred.make<void>();
        const releaseSecondProbe = yield* Deferred.make<void>();
        const allowLazySettingsStream = yield* Deferred.make<void>();
        const mutableServerSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances: {
                ...disabledDefaultSlots("claudeAgent", "cursor", "grok", "opencode"),
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  config: { binaryPath: firstMissing },
                },
              },
            }),
          ),
        );
        const serverSettings = {
          ...mutableServerSettings,
          streamChanges: Stream.unwrap(
            Deferred.await(allowLazySettingsStream).pipe(
              Effect.as(mutableServerSettings.streamChanges),
            ),
          ),
        } satisfies ServerSettingsModule.ServerSettingsService["Service"];
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(
            ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(PortScanner.layerTest)),
          ),
          Layer.provideMerge(AntigravityInstallation.AntigravityInstallation.layer),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
            ChildProcessSpawner.make((command) => {
              if (command._tag !== "StandardCommand") return spawner.spawn(command);
              spawnedCommands.push(command.command);
              const beforeSpawn =
                command.command === secondMissing
                  ? Deferred.succeed(secondProbeStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSecondProbe)),
                    )
                  : Effect.void;
              return beforeSpawn.pipe(Effect.andThen(spawner.spawn(command)));
            }),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const codexSnapshots = registry.streamChanges.pipe(
            Stream.map((providers) =>
              providers.find((provider) => provider.instanceId === "codex"),
            ),
            Stream.filter((provider): provider is ServerProvider => provider !== undefined),
          );
          const firstError = yield* Stream.toPull(
            codexSnapshots.pipe(Stream.filter((provider) => provider.status === "error")),
          );
          const currentCodex = (yield* registry.getProviders).find(
            (provider) => provider.instanceId === "codex",
          );
          const initialCodex =
            currentCodex?.status === "error" ? currentCodex : (yield* firstError)[0];
          assert.strictEqual(initialCodex?.status, "error");
          assert.strictEqual(initialCodex?.installed, false);
          assert.deepStrictEqual(spawnedCommands, [firstMissing]);

          const pendingRebuild = yield* Stream.toPull(
            codexSnapshots.pipe(
              Stream.filter((provider) => provider.status === "warning" && !provider.installed),
            ),
          );
          yield* serverSettings.updateSettings({
            providerInstances: {
              ...disabledDefaultSlots("claudeAgent", "cursor", "grok", "opencode"),
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: { binaryPath: secondMissing },
              },
            },
          });
          yield* Deferred.succeed(allowLazySettingsStream, undefined);

          yield* Deferred.await(secondProbeStarted);
          yield* pendingRebuild;
          const rebuiltError = yield* Stream.toPull(
            codexSnapshots.pipe(Stream.filter((provider) => provider.status === "error")),
          );
          yield* Deferred.succeed(releaseSecondProbe, undefined);
          const [reprobedCodex] = yield* rebuiltError;
          assert.deepStrictEqual(spawnedCommands, [firstMissing, secondMissing]);
          assert.strictEqual(reprobedCodex?.status, "error");
          assert.strictEqual(reprobedCodex?.installed, false);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("includes unavailable instance snapshots in getProviders", () =>
      Effect.gen(function* () {
        const serverSettings = yield* makeMutableServerSettingsService(
          decodeServerSettings(
            deepMerge(encodedDefaultServerSettings, {
              providerInstances: {
                ...disabledDefaultSlots("codex", "claudeAgent", "cursor", "grok", "opencode"),
                ghost_main: {
                  driver: "ghostDriver",
                  displayName: "A fork-only driver we don't ship",
                  enabled: false,
                  config: { arbitrary: "payload" },
                },
              } as unknown as (typeof ServerSettings.Encoded)["providerInstances"],
            }),
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const layerProviderRegistry = ProviderRegistry.layer.pipe(
          Layer.provideMerge(
            ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(PortScanner.layerTest)),
          ),
          Layer.provideMerge(AntigravityInstallation.AntigravityInstallation.layer),
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-provider-registry-",
            }),
          ),
          Layer.provideMerge(layerTestHttpClient),
          Layer.provideMerge(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
          Layer.provideMerge(ProviderLatestVersions.layer),
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(ModelManifest.layerTest),
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(
            OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        );
        const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const providers = yield* registry.getProviders;
          const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

          assert.notStrictEqual(ghost, undefined);
          assert.strictEqual(ghost?.driver, "ghostDriver");
          assert.strictEqual(ghost?.availability, "unavailable");
          assert.strictEqual(Object.hasOwn(ghost ?? {}, "setup"), false);
          assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
        }).pipe(Effect.provide(runtimeServices));
      }),
    );
  });
});
