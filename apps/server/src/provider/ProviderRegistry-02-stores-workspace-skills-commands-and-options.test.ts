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
    it("stores workspace skills, commands and options without changing machine metadata", () => {
      const provider = {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [{ name: "global" }],
        skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
      } satisfies ServerProvider;
      const scopedSnapshot = {
        ...provider,
        checkedAt: "2026-03-25T00:01:00.000Z",
        slashCommands: [{ name: "project" }],
        skills: [{ name: "project", path: "/project/SKILL.md", enabled: true }],
        optionDescriptors: [
          {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: "readonly", label: "Readonly" }],
          },
        ],
      } satisfies ProviderWorkspaceSnapshot;

      const result = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        scopedSnapshot,
      );

      assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
      assert.deepStrictEqual(result.skills, provider.skills);
      assert.strictEqual(result.models, provider.models);
      const decoded = decodeServerProvider(encodeServerProvider(result));
      assert.deepStrictEqual(decoded.workspaceSnapshots, [
        {
          cwd: "/project",
          checkedAt: scopedSnapshot.checkedAt,
          slashCommands: scopedSnapshot.slashCommands,
          skills: scopedSnapshot.skills,
          optionDescriptors: scopedSnapshot.optionDescriptors,
        },
      ]);

      const pendingSnapshot = {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
      } satisfies ProviderWorkspaceSnapshot;
      const partial = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        result,
        "/project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(partial.workspaceSnapshots?.[0]?.slashCommands, [{ name: "project" }]);
      assert.strictEqual(partial.workspaceSnapshots?.[0]?.slashCommandsPending, true);
      const otherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        partial,
        "/other-project",
        pendingSnapshot,
      );
      assert.deepStrictEqual(otherProject.workspaceSnapshots?.[1]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
      ]);
      const recovered = ProviderRegistry.upsertProviderWorkspaceSnapshot(partial, "/project", {
        ...scopedSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, { name: "replacement" }],
      });
      assert.deepStrictEqual(recovered.workspaceSnapshots?.[0]?.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "replacement" },
      ]);
      assert.strictEqual(recovered.workspaceSnapshots?.[0]?.slashCommandsPending, undefined);

      const { optionDescriptors, ...failedSnapshot } = scopedSnapshot;
      const firstFailure = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        provider,
        "/project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(firstFailure.workspaceSnapshots![0]!, "optionDescriptors"),
        false,
      );
      const failedOtherProject = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        recovered,
        "/other-project",
        failedSnapshot,
      );
      assert.strictEqual(
        Object.hasOwn(failedOtherProject.workspaceSnapshots![1]!, "optionDescriptors"),
        false,
      );

      for (const clearedDescriptors of [[], [{ ...optionDescriptors[0]!, options: [] }]]) {
        const cleared = ProviderRegistry.upsertProviderWorkspaceSnapshot(recovered, "/project", {
          ...scopedSnapshot,
          optionDescriptors: clearedDescriptors,
        });
        assert.deepStrictEqual(
          cleared.workspaceSnapshots?.[0]?.optionDescriptors,
          clearedDescriptors,
        );
      }

      const failedRefresh = ProviderRegistry.upsertProviderWorkspaceSnapshot(
        failedOtherProject,
        "/project",
        failedSnapshot,
      );
      assert.deepStrictEqual(
        failedRefresh.workspaceSnapshots?.[1]?.optionDescriptors,
        optionDescriptors,
      );
    });

    it("preserves previously discovered provider models when a refresh returns none", () => {
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
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-04-14T00:01:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        [],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        [],
      );
    });

    it("does not bring back models the installed CLI is too old to run", () => {
      const pendingProvider = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        status: "warning",
        enabled: true,
        installed: false,
        auth: { status: "unknown" },
        checkedAt: "2026-04-14T00:00:00.000Z",
        version: null,
        models: [
          { slug: "claude-old", name: "Old", isCustom: false, capabilities: null },
          { slug: "claude-next", name: "Next", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const probedProvider = {
        ...pendingProvider,
        status: "ready",
        installed: true,
        auth: { status: "authenticated" },
        version: "1.0.0",
        models: [pendingProvider.models[0]],
        updateRequiredModels: [{ slug: "claude-next", name: "Next", minVersion: "1.1.0" }],
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(pendingProvider, probedProvider).models,
        [...probedProvider.models],
      );
    });

    it("retains ACP Registry models while discovery has not completed", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("acpRegistry_codex"),
        driver: ProviderDriverKind.make("acpRegistry"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-08-13T00:00:00.000Z",
        version: "1.2.0",
        models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const checkingProvider = {
        ...previousProvider,
        checkedAt: "2026-08-13T00:01:00.000Z",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
        models: [{ slug: "default", name: "Default", isCustom: false, capabilities: null }],
      } satisfies ServerProvider;
      const confirmedCheckingProvider = {
        ...checkingProvider,
        auth: { status: "authenticated" },
      } satisfies ServerProvider;
      const failedProbeProvider = {
        ...checkingProvider,
        status: "warning",
        message: "ACP discovery failed.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, checkingProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, confirmedCheckingProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, failedProbeProvider).models,
        [
          { slug: "default", name: "Default", isCustom: false, capabilities: null },
          { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
        ],
      );
    });

    it("drops Grok models a completed probe no longer advertises", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("grok"),
        driver: ProviderDriverKind.make("grok"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-09-30T00:00:00.000Z",
        version: "1.0.44",
        models: [
          { slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null },
          { slug: "codexhub-removed", name: "Removed", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        checkedAt: "2026-09-30T00:01:00.000Z",
        models: [previousProvider.models[0]],
      } satisfies ServerProvider;
      const acpFailedProvider = {
        ...refreshedProvider,
        status: "warning",
        message: "Grok CLI is installed but ACP initialize failed.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [previousProvider.models[0]],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, acpFailedProvider).models,
        [...previousProvider.models],
      );
    });

    it("retains stale OpenCode models when a refresh fails", () => {
      const previousProvider = {
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
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
        ],
        slashCommands: [{ name: "review", description: "Review changes" }],
        skills: [
          {
            name: "typescript",
            description: "TypeScript help",
            path: "/skills/typescript/SKILL.md",
            enabled: true,
          },
        ],
      } as const satisfies ServerProvider;
      const refreshedProvider = {
        ...previousProvider,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-07-17T00:01:00.000Z",
        models: [],
        message: "Failed to refresh OpenCode models.",
      } satisfies ServerProvider;

      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
        [...previousProvider.models],
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
        previousProvider.slashCommands,
      );
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
        previousProvider.skills,
      );
    });

    describe("Pi model inventories", () => {
      const defaultModel = {
        slug: "default",
        name: "Pi default",
        isCustom: false,
        capabilities: null,
      } as const;
      const currentModel = {
        slug: "openai/gpt-6.1-sol",
        name: "GPT-6.1-Sol",
        isCustom: false,
        capabilities: null,
      } as const;
      const removedModel = {
        slug: "openrouter/google/gemini-2.5-pro",
        name: "Google: Gemini 2.5 Pro",
        isCustom: false,
        capabilities: null,
      } as const;
      const customModel = {
        slug: "custom-model",
        name: "Custom model",
        isCustom: true,
        capabilities: null,
      } as const;
      const cachedProvider = {
        instanceId: ProviderInstanceId.make("pi-personal"),
        driver: ProviderDriverKind.make("pi"),
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", type: "pi" },
        checkedAt: "2026-10-03T00:00:00.000Z",
        version: "1.0.0",
        models: [
          defaultModel,
          currentModel,
          removedModel,
          { ...customModel, slug: "removed-custom" },
        ],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const refreshedProvider = {
        ...cachedProvider,
        checkedAt: "2026-10-03T00:01:00.000Z",
        models: [defaultModel, currentModel, customModel],
      } satisfies ServerProvider;
      const pendingProvider = {
        ...cachedProvider,
        status: "warning",
        version: null,
        auth: { status: "unknown" },
        models: [defaultModel, customModel],
      } satisfies ServerProvider;
      const failedProvider = {
        ...pendingProvider,
        checkedAt: "2026-10-03T00:02:00.000Z",
        status: "ready",
        version: "1.0.0",
        message: "Pi is available, but T3 Code could not refresh its models and commands.",
      } satisfies ServerProvider;

      it("retains Pi inventories during incomplete probes without restoring removed custom models", () => {
        const incompleteProviders = [
          pendingProvider,
          { ...pendingProvider, installed: false },
          failedProvider,
          { ...failedProvider, status: "error" },
        ] satisfies ReadonlyArray<ServerProvider>;

        for (const provider of incompleteProviders) {
          assert.deepStrictEqual(
            ProviderRegistry.mergeProviderSnapshot(cachedProvider, provider).models,
            [defaultModel, customModel, currentModel, removedModel],
          );
        }
      });

      it("does not restore disconnected Pi models after a later discovery failure", () => {
        const afterRemoval = ProviderRegistry.mergeProviderSnapshot(
          cachedProvider,
          refreshedProvider,
        );
        assert.deepStrictEqual(
          ProviderRegistry.mergeProviderSnapshot(afterRemoval, failedProvider).models,
          [defaultModel, customModel, currentModel],
        );
      });

      it.effect(
        "persists Pi inventory removals across failed refreshes and registry restarts",
        () =>
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
                continuationKey: "pi:instance:pi-personal",
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
            const retainedModels = [defaultModel, customModel, currentModel];

            for (const restarted of [false, true]) {
              yield* Ref.set(currentProvider, pendingProvider);
              yield* Effect.gen(function* () {
                const registry = yield* ProviderRegistry.ProviderRegistry;
                assert.deepStrictEqual(
                  (yield* registry.getProviders)[0]?.models,
                  restarted
                    ? retainedModels
                    : [defaultModel, customModel, currentModel, removedModel],
                );

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
                prefix: "t3-pi-model-cache-",
              }).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
            ),
          ),
      );
    });
  });
});
