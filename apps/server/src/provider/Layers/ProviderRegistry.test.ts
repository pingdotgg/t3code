import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
  type ServerProviderSlashCommand,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@t3tools/shared/Struct";
import { createModelCapabilities } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as CodexResetCredit from "./codexResetCredit.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  upsertProviderWorkspaceSnapshot,
  ProviderRegistryLive,
} from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodedDefaultServerSettings = encodeServerSettings(DEFAULT_SERVER_SETTINGS);

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});
const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const disabledCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({
  enabled: false,
});

process.env.T3CODE_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      ...overrides,
    });
}

const noClaudeCapabilities = () =>
  Effect.sync(() => undefined as TestClaudeCapabilities | undefined);

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function recordingMockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  const commands: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }> = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options?: {
          readonly env?: NodeJS.ProcessEnv;
        };
      };
      commands.push({ args: cmd.args, env: cmd.options?.env });
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
  return { layer, commands };
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingScopedSpawnerLayer(killCalls: Ref.Ref<number>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Ref.update(killCalls, (current) => current + 1),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        return handle;
      }),
    ),
  );
}

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    selectDescriptor("reasoningEffort", "Reasoning", [
      { id: "high", label: "High", isDefault: true },
      { id: "low", label: "Low" },
    ]),
    booleanDescriptor("fastMode", "Fast Mode"),
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = applyServerSettingsPatch(current, patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
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
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
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
              name: "feedback",
              description: "Send this thread and Codex logs to OpenAI",
              input: { hint: "Describe the issue (optional)" },
            },
          ]);
        }),
      );

      it.effect("passes configured launch args to the Codex provider probe", () =>
        Effect.gen(function* () {
          let observedLaunchArgs: string | undefined;
          const settings = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });

          const status = yield* checkCodexProviderStatus(settings, (input) => {
            observedLaunchArgs = input.launchArgs;
            return Effect.succeed(makeCodexProbeSnapshot());
          });

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(observedLaunchArgs, "--strict-config --enable foo");
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
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
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

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("returns an Amazon Bedrock label for codex Bedrock auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "amazonBedrock" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "amazonBedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(status.message, "Codex CLI (`codex`) was not found on PATH.");
        }),
      );

      it.effect("closes the app-server probe scope when provider status times out", () =>
        Effect.gen(function* () {
          const killCalls = yield* Ref.make(0);
          const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(hangingScopedSpawnerLayer(killCalls)),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          yield* TestClock.adjust("11 seconds");
          yield* Effect.yieldNow;

          const status = yield* Fiber.join(statusFiber);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(
            status.message,
            "Timed out while checking Codex app-server provider status.",
          );
          assert.strictEqual(yield* Ref.get(killCalls), 1);
        }),
      );
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("stores workspace skills and commands without changing machine metadata", () => {
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
        } satisfies ServerProvider;

        const result = upsertProviderWorkspaceSnapshot(provider, "/project", scopedSnapshot);

        assert.deepStrictEqual(result.slashCommands, provider.slashCommands);
        assert.deepStrictEqual(result.skills, provider.skills);
        assert.deepStrictEqual(result.workspaceSnapshots, [
          {
            cwd: "/project",
            checkedAt: scopedSnapshot.checkedAt,
            slashCommands: scopedSnapshot.slashCommands,
            skills: scopedSnapshot.skills,
          },
        ]);
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

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
          [],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
          [],
        );
      });

      it("drops custom models the refreshed snapshot no longer carries", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2.1.0",
          models: [
            {
              slug: "claude-sonnet-4-6",
              name: "Sonnet 4.6",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-custom",
              name: "removed-custom",
              isCustom: true,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [previousProvider.models[0]],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
      });

      it("drops stale OpenCode models missing from a successful refresh", () => {
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
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
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

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).slashCommands,
          previousProvider.slashCommands,
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, refreshedProvider).skills,
          previousProvider.skills,
        );
      });

      it("classifies pending, logout, uninstall, and reconnect OpenCode inventories", () => {
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
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
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
        const pendingProvider = {
          ...previousProvider,
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          version: null,
          models: [],
          message: "OpenCode provider status has not been checked in this session yet.",
        } satisfies ServerProvider;
        const loggedOutProvider = {
          ...previousProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:02:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          message: "OpenCode is available, but it did not report any connected upstream providers.",
        } satisfies ServerProvider;
        const missingProvider = {
          ...previousProvider,
          status: "error",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:03:00.000Z",
          version: null,
          models: [],
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        } satisfies ServerProvider;
        const authoritativeProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:04:00.000Z",
          models: [previousProvider.models[0]!],
        } satisfies ServerProvider;
        const failedProvider = {
          ...authoritativeProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:05:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, pendingProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).models,
          [],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).slashCommands,
          [],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).skills,
          [],
        );
        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, missingProvider).models, []);

        const afterRemoval = mergeProviderSnapshot(previousProvider, authoritativeProvider);
        const afterFailure = mergeProviderSnapshot(afterRemoval, failedProvider);

        assert.deepStrictEqual(afterFailure.models, [authoritativeProvider.models[0]!]);
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

        it("removes unavailable models after a successful refresh", () => {
          for (const status of ["ready", "warning"] as const) {
            const refreshedProvider = {
              ...previousProvider,
              status,
              checkedAt: "2026-09-02T00:01:00.000Z",
              models: [previousProvider.models[1]],
            } satisfies ServerProvider;
            const afterRefresh = mergeProviderSnapshot(previousProvider, refreshedProvider);

            assert.deepStrictEqual(afterRefresh.models, refreshedProvider.models);

            const afterFailure = mergeProviderSnapshot(afterRefresh, {
              ...refreshedProvider,
              status: "error",
              auth: { status: "unknown" },
              models: [],
            });
            assert.deepStrictEqual(afterFailure.models, refreshedProvider.models);
          }
        });

        it("keeps cached models during health checks and temporary failures", () => {
          for (const installed of [false, true]) {
            const pendingProvider = {
              ...previousProvider,
              status: "warning",
              installed,
              auth: { status: "unknown" },
              checkedAt: "2026-09-02T00:01:00.000Z",
              version: installed ? previousProvider.version : null,
              models: [],
            } satisfies ServerProvider;

            assert.deepStrictEqual(
              mergeProviderSnapshot(previousProvider, pendingProvider).models,
              previousProvider.models,
            );
          }

          for (const authStatus of ["unknown", "authenticated"] as const) {
            const failedProvider = {
              ...previousProvider,
              status: "error",
              auth: { status: authStatus },
              checkedAt: "2026-09-02T00:02:00.000Z",
              models: [],
            } satisfies ServerProvider;

            assert.deepStrictEqual(
              mergeProviderSnapshot(previousProvider, failedProvider).models,
              previousProvider.models,
            );
          }
        });

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
            const afterRemoval = mergeProviderSnapshot(previousProvider, provider);
            assert.deepStrictEqual(afterRemoval.models, []);

            const afterFailure = mergeProviderSnapshot(afterRemoval, {
              ...emptyProvider,
              status: "error",
              auth: { status: "unknown" },
            });
            assert.deepStrictEqual(afterFailure.models, []);
          }
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

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it.effect("does not run provider probes during layer construction", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const initialProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "warning",
            enabled: true,
            installed: false,
            auth: { status: "unknown" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: null,
            message: "Checking Codex provider status.",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const refreshCalls = yield* Ref.make(0);
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
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Effect.never),
              ),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-background-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));
          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
            assert.strictEqual(yield* Ref.get(refreshCalls), 0);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("deduplicates cwd probes and clears snapshots when an instance rebuilds", () =>
        Effect.gen(function* () {
          const driver = ProviderDriverKind.make("codex");
          const instanceId = ProviderInstanceId.make("codex");
          const machineProvider = {
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [{ name: "global" }],
            skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
          } as const satisfies ServerProvider;
          const scopedProvider = {
            ...machineProvider,
            checkedAt: "2026-06-10T00:01:00.000Z",
            slashCommands: [{ name: "project" }],
            skills: [{ name: "project", path: "/workspace/SKILL.md", enabled: true }],
          } as const satisfies ServerProvider;
          const pendingScopedProvider = {
            ...scopedProvider,
            status: "error",
            installed: false,
            slashCommands: [],
          } as const satisfies ServerProvider;
          const snapshotCalls = yield* Ref.make(0);
          const returnPendingSnapshot = yield* Ref.make(true);
          const probeStarted = yield* Deferred.make<void>();
          const releaseProbe = yield* Deferred.make<void>();
          const makeInstance = (
            provider: ServerProvider,
            snapshotForCwd: NonNullable<ProviderInstance["snapshotForCwd"]>,
          ): ProviderInstance => ({
            instanceId,
            driverKind: driver,
            continuationIdentity: {
              driverKind: driver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            snapshotForCwd,
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const firstInstance = makeInstance(machineProvider, () =>
            Effect.gen(function* () {
              yield* Ref.update(snapshotCalls, (count) => count + 1);
              if (yield* Ref.get(returnPendingSnapshot)) return pendingScopedProvider;
              yield* Deferred.succeed(probeStarted, undefined);
              yield* Deferred.await(releaseProbe);
              return scopedProvider;
            }),
          );
          const rebuiltProvider = {
            ...machineProvider,
            checkedAt: "2026-06-10T00:02:00.000Z",
            status: "warning",
            installed: false,
            auth: { status: "unknown" },
          } satisfies ServerProvider;
          const rebuiltInstance = makeInstance(rebuiltProvider, () =>
            Ref.update(snapshotCalls, (count) => count + 1).pipe(Effect.as(scopedProvider)),
          );
          const registryChanges = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([firstInstance]);
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === requestedId),
                  ),
                ),
              listInstances: Ref.get(instancesRef),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(registryChanges),
              subscribeChanges: PubSub.subscribe(registryChanges),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-workspace-snapshot-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
            assert.strictEqual((yield* registry.getProviders)[0]?.workspaceSnapshots, undefined);
            yield* Ref.set(returnPendingSnapshot, false);
            const workspaceUpdate = yield* registry.streamChanges.pipe(
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            const firstRefresh = yield* registry
              .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(probeStarted);
            const duplicateRefresh = yield* registry
              .refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" })
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            assert.strictEqual(yield* Ref.get(snapshotCalls), 2);
            yield* Deferred.succeed(releaseProbe, undefined);
            yield* Fiber.join(firstRefresh);
            yield* Fiber.join(duplicateRefresh);
            const published = yield* Fiber.join(workspaceUpdate);
            assert.strictEqual(published._tag, "Some");
            const providers = yield* registry.getProviders;
            assert.deepStrictEqual(providers[0]?.skills, machineProvider.skills);
            assert.deepStrictEqual(
              providers[0]?.workspaceSnapshots?.[0]?.skills,
              scopedProvider.skills,
            );
            yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
            assert.strictEqual(yield* Ref.get(snapshotCalls), 2);

            yield* Ref.set(instancesRef, [rebuiltInstance]);
            yield* PubSub.publish(registryChanges, undefined);
            let rebuilt = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 && rebuilt[0]?.checkedAt !== rebuiltProvider.checkedAt;
              attempt += 1
            ) {
              yield* Effect.yieldNow;
              rebuilt = yield* registry.getProviders;
            }
            assert.strictEqual(rebuilt[0]?.checkedAt, rebuiltProvider.checkedAt);
            assert.strictEqual(rebuilt[0]?.workspaceSnapshots, undefined);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("refreshes OpenCode catalogs and preserves other providers", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const openCodeDriver = ProviderDriverKind.make("opencode");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const openCodeInstanceId = ProviderInstanceId.make("opencode");
          const codexRefreshCalls = yield* Ref.make(0);
          const openCodeRefreshCalls = yield* Ref.make(0);
          const codexProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
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
          const failedOpenCodeProvider = {
            instanceId: openCodeInstanceId,
            driver: openCodeDriver,
            status: "error",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "1.0.0",
            message: "Failed to refresh OpenCode models.",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const recoveredOpenCodeProvider = {
            ...failedOpenCodeProvider,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:01:00.000Z",
            message: "One upstream provider connected through OpenCode.",
            models: [
              {
                slug: "github/gpt-5",
                name: "GPT-5",
                subProvider: "GitHub",
                isCustom: false,
                capabilities: null,
              },
            ],
          } as const satisfies ServerProvider;
          const changedCatalogProvider = {
            ...recoveredOpenCodeProvider,
            checkedAt: "2026-06-10T00:02:00.000Z",
            models: [
              {
                slug: "anthropic/claude-sonnet-4",
                name: "Claude Sonnet 4",
                subProvider: "Anthropic",
                isCustom: false,
                capabilities: null,
              },
            ],
          } as const satisfies ServerProvider;
          const catalogSnapshot = yield* Ref.make<ServerProvider>(recoveredOpenCodeProvider);
          const instances = [
            {
              instanceId: codexInstanceId,
              driverKind: codexDriver,
              continuationIdentity: {
                driverKind: codexDriver,
                continuationKey: "codex:instance:codex",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: codexDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(codexProvider),
                refresh: Ref.update(codexRefreshCalls, (count) => count + 1).pipe(
                  Effect.as(codexProvider),
                ),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            },
            {
              instanceId: openCodeInstanceId,
              driverKind: openCodeDriver,
              continuationIdentity: {
                driverKind: openCodeDriver,
                continuationKey: "opencode:instance:opencode",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: openCodeDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(failedOpenCodeProvider),
                refresh: Ref.update(openCodeRefreshCalls, (count) => count + 1).pipe(
                  Effect.andThen(Ref.get(catalogSnapshot)),
                ),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            },
          ] satisfies ReadonlyArray<ProviderInstance>;
          const instanceRegistryLayer = Layer.succeed(
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
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-reconnect-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const initialProviders = yield* registry.getProviders;
            assert.strictEqual(
              initialProviders.find((provider) => provider.instanceId === openCodeInstanceId)
                ?.status,
              "error",
            );

            const recoveredProviders = yield* registry.refresh();
            assert.deepStrictEqual(
              recoveredProviders.find((provider) => provider.instanceId === openCodeInstanceId)
                ?.models,
              recoveredOpenCodeProvider.models,
            );
            assert.deepStrictEqual(
              recoveredProviders.find((provider) => provider.instanceId === codexInstanceId),
              codexProvider,
            );

            yield* Ref.set(catalogSnapshot, changedCatalogProvider);
            const changedProviders = yield* registry.refresh();
            assert.deepStrictEqual(
              changedProviders.find((provider) => provider.instanceId === openCodeInstanceId)
                ?.models,
              changedCatalogProvider.models,
            );
            assert.deepStrictEqual(
              changedProviders.find((provider) => provider.instanceId === codexInstanceId),
              codexProvider,
            );
          }).pipe(Effect.provide(runtimeServices));

          assert.strictEqual(yield* Ref.get(codexRefreshCalls), 2);
          assert.strictEqual(yield* Ref.get(openCodeRefreshCalls), 2);
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
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: cursorDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
              applyUsageLimits: () => Effect.void,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
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
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
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
            yield* PubSub.publish(changes, refreshedProvider);

            let cachedProvider = yield* readProviderStatusCache(filePath);
            for (
              let attempt = 0;
              attempt < 50 && cachedProvider?.checkedAt !== refreshedProvider.checkedAt;
              attempt += 1
            ) {
              yield* TestClock.adjust("10 millis");
              yield* Effect.yieldNow;
              cachedProvider = yield* readProviderStatusCache(filePath);
            }

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
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
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: openCodeDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(initialProvider),
                refresh: Effect.succeed(authoritativeProvider),
                streamChanges: Stream.fromPubSub(changes),
                applyUsageLimits: () => Effect.void,
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;
            const instanceRegistryLayer = Layer.succeed(
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
              ProviderRegistryLive.pipe(
                Layer.provideMerge(instanceRegistryLayer),
                Layer.provideMerge(
                  ServerConfig.layerTest(process.cwd(), {
                    prefix: "t3-provider-registry-opencode-authoritative-persist-",
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
                instanceId: openCodeInstanceId,
              });

              yield* PubSub.publish(changes, authoritativeProvider);

              let cachedProvider = yield* readProviderStatusCache(filePath);
              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== authoritativeProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

              yield* PubSub.publish(changes, failedProvider);
              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== failedProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

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
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;
          const instanceRegistryLayer = Layer.succeed(
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
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
          const codexProvider = {
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
          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = () => Effect.yieldNow;
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === instanceId),
                  ),
                ),
              listInstances: Effect.gen(function* () {
                const shouldFail = yield* Ref.get(failNextList);
                if (shouldFail) {
                  yield* Ref.set(failNextList, false);
                  return yield* Effect.die(new Error("simulated registry list failure"));
                }
                return yield* Ref.get(instancesRef);
              }),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;
            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait();
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // This test intentionally avoids `mockCommandSpawnerLayer` so the real
      // `probeCodexAppServerProvider` path runs — including the full
      // `codex app-server` RPC handshake via `CodexClient.layerChildProcess`.
      // We point `binaryPath` at a name that cannot exist on any machine so
      // the real `ChildProcessSpawner` deterministically returns ENOENT; the
      // probe wraps that as `CodexAppServerSpawnError` and
      // `checkCodexProviderStatus` turns it into the user-visible "not
      // installed" error snapshot. If the aggregator's `syncLiveSources`
      // breaks — the `codex_personal`-never-probes bug we are guarding
      // against — that snapshot never lands in `getProviders` and the
      // assertions below fail.
      it.effect("propagates real Codex probe failures to the aggregator at boot", () =>
        Effect.gen(function* () {
          const missingBinary = `t3code_codex_missing_`;
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  // Disable every built-in probe that would otherwise spawn
                  // on the CI host. `enabled: false` short-circuits each
                  // driver's probe *before* it touches the spawner, so the
                  // test environment stays isolated from the dev
                  // machine's PATH.
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
                // `providerInstances` keys are branded `ProviderInstanceId`;
                // the branded index signature rejects plain string literals
                // at the TS level even though the runtime schema happily
                // accepts + decodes them. Cast the patch to `unknown` so
                // the `Schema.decodeSync` below does the real validation.
                providerInstances: {
                  // Matches the shape the user had in `.t3/dev/settings.json`
                  // when the bug was reported: a custom enabled Codex instance
                  // pointing at a binary the server has to actually spawn.
                  codex_personal: {
                    driver: "codex",
                    displayName: "Codex Personal",
                    enabled: true,
                    config: {
                      binaryPath: missingBinary,
                      homePath: `/tmp/${missingBinary}_home`,
                    },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(AntigravityInstallation.layer),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(CodexResetCredit.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
            // NO spawner mock — `ChildProcessSpawner` is supplied by the
            // outer `NodeServices.layer` on `it.layer(...)` and will
            // genuinely spawn a subprocess. The missing-binary ENOENT is
            // what exercises the same failure mode as a misconfigured
            // production `binaryPath`.
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            let providers = yield* registry.getProviders;
            for (
              let attempts = 0;
              attempts < 50 &&
              providers.find((provider) => provider.instanceId === "codex_personal")?.status !==
                "error";
              attempts += 1
            ) {
              yield* Effect.yieldNow;
              providers = yield* registry.getProviders;
            }
            const codexPersonal = providers.find(
              (provider) => provider.instanceId === "codex_personal",
            );
            assert.notStrictEqual(
              codexPersonal,
              undefined,
              `Expected the aggregator to know about codex_personal; instead saw: ${providers
                .map((provider) => provider.instanceId)
                .join(", ")}`,
            );
            assert.strictEqual(
              codexPersonal?.status,
              "error",
              "Real Codex probe against a missing binary should surface as 'error' in the aggregator",
            );
            assert.strictEqual(codexPersonal?.installed, false);
            assert.strictEqual(
              codexPersonal?.message,
              "Codex CLI (`codex`) was not found on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      // A binary path change must rebuild Codex and publish its new probe result.
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
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
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
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(AntigravityInstallation.layer),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(CodexResetCredit.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
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
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
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
              providers: {
                codex: { enabled: true, binaryPath: secondMissing },
              },
            });
            // Start the lazy stream only after publishing. A watcher that did
            // not subscribe before forking has already lost this update.
            yield* Deferred.succeed(allowLazySettingsStream, undefined);

            // Hold the second probe until the aggregator sees the rebuilt
            // instance. Its next error must come from the new executable.
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
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  cursor: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as unknown as ContractServerSettings["providerInstances"],
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(AntigravityInstallation.layer),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(CodexResetCredit.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps Cursor disabled and skips provider probing when settings use their defaults",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              decodeServerSettings(
                deepMerge(encodedDefaultServerSettings, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    grok: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );
            let cursorSpawned = false;
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(AntigravityInstallation.layer),
              Layer.provideMerge(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              ),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-",
                }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provideMerge(ModelManifest.layerTest),
              Layer.provideMerge(CodexResetCredit.layerTest),
              Layer.provideMerge(CodexResetCredit.layerTest),
              Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  if (command === "cursor-agent") {
                    cursorSpawned = true;
                  }
                  const joined = args.join(" ");
                  if (joined === "--version") {
                    return {
                      stdout: `${command} 1.0.0\n`,
                      stderr: "",
                      code: 0,
                    };
                  }
                  if (joined === "auth status") {
                    return {
                      stdout: '{"authenticated":true}\n',
                      stderr: "",
                      code: 0,
                    };
                  }
                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );
            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const providers = yield* registry.getProviders;
              const cursorProvider = providers.find(
                (provider) => provider.instanceId === ProviderInstanceId.make("cursor"),
              );

              assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
                "antigravity",
                "claudeAgent",
                "codex",
                "cursor",
                "grok",
                "opencode",
              ]);
              assert.strictEqual(cursorProvider?.enabled, false);
              assert.strictEqual(cursorProvider?.status, "disabled");
              assert.strictEqual(
                cursorProvider?.message,
                "Cursor is disabled in T3 Code settings.",
              );
              assert.strictEqual(cursorSpawned, false);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in T3 Code settings.");
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns ready and labels Bedrock-backed Claude as authenticated", () =>
        Effect.gen(function* () {
          // Bedrock authenticates via external AWS credentials, so the SDK init
          // reports only `apiProvider` with no subscription or token.
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ apiProvider: "bedrock" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "bedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ subscriptionType: "maxplan" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in full subscription labels", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max Subscription",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max Subscription");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("does not duplicate Claude in provider-prefixed subscription names", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "Claude Max",
            }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "Claude Max");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns claude auth email from initialization result", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ email: "claude@example.com" }),
          );
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.email, "claude@example.com");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout:
                    '{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"claude@example.com"}}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("runs Claude status probes with the configured CLAUDE_CONFIG_DIR", () => {
        const claudeConfigDir = "/tmp/t3code-claude-home";
        const recorded = recordingMockSpawnerLayer((args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
          if (joined === "auth status")
            return {
              stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
              stderr: "",
              code: 0,
            };
          throw new Error(`Unexpected args: ${joined}`);
        });

        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            {
              ...defaultClaudeSettings,
              homePath: claudeConfigDir,
            },
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "ready");
          assert.deepStrictEqual(
            recorded.commands.map((command) => command.env?.CLAUDE_CONFIG_DIR),
            [claudeConfigDir],
          );
        }).pipe(Effect.provide(recorded.layer));
      });

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands.slice(1), [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({
              subscriptionType: "maxplan",
              slashCommands: [
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ],
            }),
          );

          assert.deepStrictEqual(status.slashCommands, [
            COMPACT_SLASH_COMMAND,
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(status.message, "Claude Agent CLI (`claude`) was not found on PATH.");
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () => {
        const secretStderr = "Something went wrong: secret-token-value";
        return Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities(),
          );
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.message, "Claude Agent CLI is installed but failed to run.");
          assert.ok(!(status.message ?? "").includes(secretStderr));
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return {
                  stdout: "",
                  stderr: secretStderr,
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );
      });

      it.effect("returns warning when the Claude initialization result is unavailable", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            noClaudeCapabilities,
          );
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Could not verify Claude authentication status from initialization result.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
