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
    const startupSettings = (instanceId?: string) =>
      decodeServerSettings({
        ...encodedDefaultServerSettings,
        providerInstances: {
          ...disabledDefaultSlots(
            "codex",
            "claudeAgent",
            "cursor",
            "grok",
            "opencode",
            "antigravity",
            "pi",
            "muse",
          ),
          ...(instanceId ? { [instanceId]: { driver: "ghostDriver" } } : {}),
        },
      });

    const hydrateDuringSettingsChange = Effect.fnUntraced(function* (input: {
      seed: ContractServerSettings;
      saved: ContractServerSettings;
      current: ContractServerSettings;
      failCurrentRead?: boolean;
    }) {
      const changes = yield* PubSub.unbounded<ContractServerSettings | undefined>();
      const consume = yield* Deferred.make<void>();
      const drained: Array<Deferred.Deferred<void>> = [];
      let readSeed = true;
      let failCurrentRead = false;
      const settings = yield* makeMutableServerSettingsService(input.current);
      const serverSettings = {
        ...settings,
        getSettings: Effect.suspend(() => {
          if (!readSeed) {
            readSeed = true;
            return PubSub.publish(changes, input.saved).pipe(Effect.as(input.seed));
          }
          return failCurrentRead
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  operation: "read-secret",
                  cause: new Error("secret materialization failed"),
                }),
              )
            : settings.getSettings;
        }),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const done = yield* Deferred.make<void>();
          drained.push(done);
          // The terminal marker acknowledges preceding reconciles, including no-op/failed reads.
          return Stream.fromEffectRepeat(
            Deferred.await(consume).pipe(Effect.andThen(PubSub.take(subscription))),
          ).pipe(
            Stream.takeWhile((next): next is ContractServerSettings => next !== undefined),
            Stream.ensuring(Deferred.succeed(done, undefined)),
          );
        }),
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
      const dependencies = yield* Layer.build(
        Layer.mergeAll(
          AntigravityInstallation.AntigravityInstallation.layer,
          ServerSecretStore.layer,
          OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
        ).pipe(
          Layer.provideMerge(
            Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-registry-" }),
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
          Layer.provideMerge(ResetCreditCoordinator.layerTest),
          Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
        ),
      );
      readSeed = false;
      const services = yield* Layer.build(
        ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(PortScanner.layerTest)),
      ).pipe(Effect.provide(dependencies));
      failCurrentRead = input.failCurrentRead ?? false;
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.succeed(consume, undefined);
      yield* Effect.forEach(drained, Deferred.await);
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry.pipe(
        Effect.provide(services),
      );
      return (yield* registry.listUnavailable).map(
        (provider): string | undefined => provider.instanceId,
      );
    });

    it.effect("applies a settings change saved while the provider registry starts", () =>
      Effect.gen(function* () {
        const saved = startupSettings("ghost_late");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed: startupSettings(),
          saved,
          current: saved,
        });
        assert.include(unavailable, "ghost_late");
      }),
    );

    it.effect("does not apply a queued settings change older than the registry seed", () =>
      Effect.gen(function* () {
        const seed = startupSettings("ghost_current");
        const unavailable = yield* hydrateDuringSettingsChange({
          seed,
          saved: startupSettings("ghost_stale"),
          current: seed,
        });
        assert.include(unavailable, "ghost_current");
        assert.notInclude(unavailable, "ghost_stale");
      }),
    );

    it.effect(
      "retains the newer registry seed when a queued stale change cannot read current settings",
      () =>
        Effect.gen(function* () {
          const seed = startupSettings("ghost_current");
          const unavailable = yield* hydrateDuringSettingsChange({
            seed,
            saved: startupSettings("ghost_stale"),
            current: seed,
            failCurrentRead: true,
          });
          assert.include(unavailable, "ghost_current");
          assert.notInclude(unavailable, "ghost_stale");
        }),
    );
  });
});
