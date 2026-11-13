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
  describe("checkCodexProviderStatus", () => {
    it.effect("uses the app-server account and model list for provider status", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              skills: [
                {
                  name: "github:gh-fix-ci",
                  path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                  enabled: true,
                  displayName: "CI Debug",
                  shortDescription: "Debug failing GitHub Actions checks",
                },
              ],
            }),
          ),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.version, "1.0.0");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "chatgpt");
        assert.strictEqual(status.auth.label, "ChatGPT Pro 200 Subscription");
        assert.strictEqual(status.auth.email, "test@example.com");
        assert.deepStrictEqual(status.setup, { canAuthenticate: false, canInstall: false });
        assert.deepStrictEqual(status.models, [
          {
            slug: "gpt-live-codex",
            name: "GPT Live Codex",
            isCustom: false,
            capabilities: codexModelCapabilities,
          },
        ]);
        assert.deepStrictEqual(status.skills, [
          {
            name: "github:gh-fix-ci",
            path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
            enabled: true,
            displayName: "CI Debug",
            shortDescription: "Debug failing GitHub Actions checks",
          },
        ]);
        assert.deepStrictEqual(status.slashCommands.slice(1), [
          {
            name: "goal",
            description: "Set a goal Codex keeps working toward until it is done",
            input: { hint: "Objective, or pause, resume, clear" },
          },
          {
            name: "feedback",
            description: "Send this thread and Codex logs to OpenAI",
            input: { hint: "Describe the issue (optional)" },
          },
        ]);
      }),
    );

    it.effect("labels the plan the usage read reports over the cached login plan", () =>
      Effect.gen(function* () {
        const statusWithUsagePlan = (planType: string | null) =>
          checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                rateLimits: { snapshot: { planType }, resetCredits: null },
              }),
            ),
          );

        const downgraded = yield* statusWithUsagePlan("free");
        assert.strictEqual(downgraded.auth.label, "ChatGPT Free Subscription");

        const unreported = yield* statusWithUsagePlan(null);
        assert.strictEqual(unreported.auth.label, "ChatGPT Pro 200 Subscription");

        const unknown = yield* statusWithUsagePlan("unknown");
        assert.strictEqual(unknown.auth.label, "ChatGPT Pro 200 Subscription");
      }),
    );

    it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              account: {
                account: null,
                requiresOpenaiAuth: true,
              },
            }),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
        assert.deepStrictEqual(status.usageLimits?.unavailable, {
          reason: "probeFailed",
          message: "Codex CLI is not authenticated. Run `codex login` and try again.",
        });
      }),
    );

    it.effect("returns ready with unknown auth when app-server does not require OpenAI auth", () =>
      Effect.gen(function* () {
        const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.succeed(
            makeCodexProbeSnapshot({
              account: {
                account: null,
                requiresOpenaiAuth: false,
              },
            }),
          ),
        );

        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "unknown");
      }),
    );

    it.effect("reads the version of a Codex CLI too old to run app-server (#20351)", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const codexHome = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" })),
        );
        const { binaryPath } = yield* writeFakeCodexCli(
          [
            `if [ "$1" = "--version" ]; then`,
            // The fallback runs with the provider's environment and CODEX_HOME.
            `  [ "$CODEX_HOME" = "${codexHome}" ] && [ "$FAKE_CODEX_ENV" = "kept" ] || exit 2`,
            `  echo 0.1.4161006; exit 0`,
            `fi`,
            OBSOLETE_CODEX_APP_SERVER,
          ].join("\n"),
        );
        const settings = decodeCodexSettings({ binaryPath, homePath: codexHome });

        const status = yield* checkCodexProviderStatus(settings, undefined, {
          ...process.env,
          FAKE_CODEX_ENV: "kept",
        });

        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.version, "0.1.4161006");
        assert.match(status.message ?? "", /^Codex app-server provider probe failed: /);
        const classified = withBundledCompatibility({
          ...status,
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        });
        assert.strictEqual(classified.compatibilityAdvisory?.status, "broken");
      }),
    );

    it.effect("keeps a prerelease --version unclassified instead of reading it as stable", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const { binaryPath } = yield* writeFakeCodexCli(
          [
            `[ "$1" = "--version" ] && { echo "codex-cli 0.159.0-alpha.1"; exit 0; }`,
            OBSOLETE_CODEX_APP_SERVER,
          ].join("\n"),
        );

        const status = yield* checkCodexProviderStatus(decodeCodexSettings({ binaryPath }));

        assert.strictEqual(status.version, "0.159.0-alpha.1");
        const classified = withBundledCompatibility({
          ...status,
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        });
        assert.strictEqual(classified.compatibilityAdvisory?.status, "unknown");
      }),
    );

    it.effect("keeps the probe failure without a version when --version also fails", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const { binaryPath } = yield* writeFakeCodexCli(
          [
            `[ "$1" = "--version" ] && { echo "codex 0.1.0" >&2; exit 3; }`,
            OBSOLETE_CODEX_APP_SERVER,
          ].join("\n"),
        );

        const status = yield* checkCodexProviderStatus(decodeCodexSettings({ binaryPath }));

        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.version, null);
        assert.match(status.message ?? "", /^Codex app-server provider probe failed: /);
      }),
    );

    it.effect("bounds a hanging Codex --version fallback and releases its process scope", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            return ChildProcessSpawner.makeHandle({
              ...mockHandle({ stdout: "", stderr: "", code: 0 }),
              exitCode: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            });
          }),
        );
        const fiber = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
          Effect.fail(new CodexErrors.CodexAppServerProcessExitedError({ code: 1 })),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("4 seconds");
        const status = yield* Fiber.join(fiber);
        assert.strictEqual(status.version, null);
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.match(status.message ?? "", /^Codex app-server provider probe failed: /);
        assert.isTrue(yield* Deferred.isDone(released));
      }),
    );

    it.effect("does not run --version when the Codex executable cannot start", () =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { directory, binaryPath } = yield* writeFakeCodexCli(
          `touch "$(dirname "$0")/ran"; echo 0.1.4161006`,
        );

        const status = yield* checkCodexProviderStatus(decodeCodexSettings({ binaryPath }), () =>
          Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: `${binaryPath} app-server`,
              cause: new Error("spawn ENOENT"),
            }),
          ),
        );

        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.version, null);
        assert.isFalse(yield* fs.exists(path.join(directory, "ran")));
      }),
    );
  });
});
