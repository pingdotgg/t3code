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
  describe("checkClaudeProviderStatus", () => {
    it.effect("reports a logged-out CLI as unauthenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          { ANTHROPIC_BASE_URL: "" },
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("tells a logged-out CLI which models need a Claude Code update", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          { ANTHROPIC_BASE_URL: "" },
          undefined,
          {
            models: [
              {
                model: { slug: "claude-next", name: "Next", isCustom: false, capabilities: null },
                runtime: {},
                compatibility: { minVersion: "1.1.0" },
              },
            ],
          },
        );
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.deepStrictEqual(status.updateRequiredModels, [
          { slug: "claude-next", name: "Next", minVersion: "1.1.0" },
        ]);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.each([
      { source: "inherited HTTPS endpoint", baseUrl: "https://proxy.example/api", overrides: [] },
      {
        source: "instance HTTP endpoint overriding Anthropic",
        baseUrl: "https://api.anthropic.com",
        overrides: [
          { name: "ANTHROPIC_BASE_URL", value: "http://localhost:8080", sensitive: false },
        ],
      },
    ])("keeps Claude ready with an empty first-party account: $source", ({ baseUrl, overrides }) =>
      Effect.gen(function* () {
        const environment = yield* mergeProviderInstanceEnvironment(overrides, {
          ANTHROPIC_BASE_URL: baseUrl,
        });
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          environment,
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "customEndpoint");
        assert.strictEqual(status.auth.label, "Custom API endpoint");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.each([
      {
        settings: { env: { ANTHROPIC_BASE_URL: "https://hub.example.ts.net:8317" } },
        baseUrl: "https://api.anthropic.com",
        type: "customEndpoint",
        label: "Custom API endpoint",
      },
      {
        settings: { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
        baseUrl: "https://proxy.example",
        type: "apiKey",
        label: "Claude API Key",
      },
      {
        settings: {},
        baseUrl: "https://proxy.example",
        type: "customEndpoint",
        label: "Custom API endpoint",
      },
    ])(
      "uses the settings endpoint before the process endpoint: $type / $baseUrl",
      ({ settings, baseUrl, type, label }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-settings-",
          });
          yield* fileSystem.writeFileString(
            path.join(configDir, "settings.json"),
            JSON.stringify(settings),
          );
          const stateDir = yield* fileSystem.makeTempDirectoryScoped();
          yield* fileSystem.makeDirectory(path.join(stateDir, ".claude"));
          yield* fileSystem.writeFileString(
            path.join(stateDir, ".claude", "settings.json"),
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://state-dir.example" } }),
          );
          const status = yield* checkClaudeProviderStatus(
            { ...defaultClaudeSettings, homePath: configDir },
            claudeCapabilities({
              tokenSource: "ANTHROPIC_AUTH_TOKEN",
              apiKeySource: "none",
              apiProvider: "firstParty",
            }),
            { ANTHROPIC_BASE_URL: baseUrl },
            stateDir,
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.type, type);
          assert.strictEqual(status.auth.label, label);
        }).pipe(
          Effect.provide(
            layerMockSpawner((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
    );

    it.effect.each([
      "https://api.anthropic.com",
      "https://api.anthropic.com:443",
      "https://api.anthropic.com:8443",
      "openrouter.ai/api",
      "localhost:8080",
      "ftp://proxy.example",
    ])("keeps Claude logged out when the instance endpoint is %s", (baseUrl) =>
      Effect.gen(function* () {
        const environment = yield* mergeProviderInstanceEnvironment(
          [{ name: "ANTHROPIC_BASE_URL", value: baseUrl, sensitive: false }],
          { ANTHROPIC_BASE_URL: "https://proxy.example/api" },
        );
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "none",
            apiProvider: "firstParty",
          }),
          environment,
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(status.auth.type, undefined);
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps an API key install authenticated when it reports no token source", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities({
            tokenSource: "none",
            apiKeySource: "ANTHROPIC_API_KEY",
            apiProvider: "firstParty",
          }),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps a CLI that says nothing about its account authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(
          defaultClaudeSettings,
          claudeCapabilities(),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          layerMockSpawner((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });
});
