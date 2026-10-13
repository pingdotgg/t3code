// @effect-diagnostics nodeBuiltinImport:off - real detached installers and lock files are Node boundaries
import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderAutoUpdater from "../updates/ProviderAutoUpdater.ts";
import * as RestartWork from "../updates/RestartWork.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";

import * as ProviderInstallLock from "./ProviderInstallLock.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const NATIVE_CLI_DRIVER = ProviderDriverKind.make("nativeCli");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const NATIVE_CLI_INSTANCE_ID = ProviderInstanceId.make("nativeCli");
const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// `{ command, args }` assertions below hold deterministically on any host
// (including Windows). Windows-specific resolution is covered by the dedicated
// win32 case at the end of this suite.
const layerNonWindowsPlatform = Layer.succeed(HostProcess.Platform, "linux");

function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
  if (provider === NATIVE_CLI_DRIVER) {
    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: null,
      updateExecutable: "native-agent",
      updateArgs: ["update"],
      updateLockKey: "native-agent",
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider,
    packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
    updateExecutable: "npm",
    updateArgs:
      provider === OPENCODE_DRIVER
        ? ["install", "-g", "opencode-ai@latest"]
        : ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });
}

const baseProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE_ID,
  driver: CODEX_DRIVER,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseNativeCliProvider: ServerProvider = {
  ...baseProvider,
  instanceId: NATIVE_CLI_INSTANCE_ID,
  driver: NATIVE_CLI_DRIVER,
};

const baseOpenCodeProvider: ServerProvider = {
  ...baseProvider,
  instanceId: OPENCODE_INSTANCE_ID,
  driver: OPENCODE_DRIVER,
};

const layerLatestVersionHttpClient = (version: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ version }, { headers: { "content-type": "application/json" } }),
        ),
      ),
    ),
  );

/** Stands in for the detached installer: `handler` decides what the installer does. */
function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv | undefined },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<number>;
    readonly progress?: ReadonlyArray<string>;
  },
) {
  return Layer.succeed(ProviderMaintenanceRunner.ProviderInstaller, {
    run: (input) =>
      Effect.gen(function* () {
        const result = handler(input.command, input.args, { env: input.env });
        for (const line of result.progress ?? []) yield* input.onProgress?.(line) ?? Effect.void;
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ? yield* result.exitCode : (result.code ?? 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      Array.isArray(initialProviders) ? initialProviders : [initialProviders],
    );
    const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

    const setProviderMaintenanceActionState = Effect.fn(
      "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
    )(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: "update";
      readonly state: ServerProviderUpdateState | null;
    }) {
      const updateState = input.state;
      if (updateState) {
        yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
      }
      return yield* Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) => {
          if (candidate.instanceId !== input.instanceId) {
            return candidate;
          }
          if (!updateState) {
            const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;
            return providerWithoutUpdateState;
          }
          return {
            ...candidate,
            updateState,
          };
        }),
      );
    });

    const registry: ProviderRegistry.ProviderRegistry["Service"] = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(lifecycleFor(provider)),
      setProviderMaintenanceActionState,
      streamChanges: Stream.empty,
    };

    return {
      registry,
      providersRef,
      updateStatesRef,
    };
  });
}

/** Locks live under `<home>/t3/provider-install`; servers sharing a home share their locks. */
const layerLockAt = (cacheHome: string) =>
  ProviderInstallLock.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcess.Environment, { XDG_CACHE_HOME: cacheHome }),
      ),
    ),
  );

// Generic updater fixtures use synthetic versions. Keep their compatibility
// unknown so real harness minimums do not bypass the command under test.
const defaultManifest: ModelManifest.ModelManifestData = {
  version: 1,
  currentModels: {},
  compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
    driver,
    t3CodeRange: ">=0.0.42",
    ranges: [],
  })),
};

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData = defaultManifest,
) =>
  Effect.gen(function* () {
    const lockHome = yield* FileSystem.FileSystem.use((fileSystem) =>
      fileSystem.makeTempDirectoryScoped({ prefix: "t3-install-lock-" }),
    ).pipe(Effect.provide(NodeServices.layer));
    return yield* makeRunnerWithLock(registry, manifest, layerLockAt(lockHome));
  });

const makeRunnerWithLock = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData,
  lock: Layer.Layer<ProviderInstallLock.ProviderInstallLock>,
) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            lock,
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            // Fresh per runner so a version cached by one test cannot leak into another.
            ProviderLatestVersions.layer,
          ),
        ),
      ),
    ),
  );

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "native-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
        [
          ["queued", "Waiting for another provider update to finish."],
          ["running", "Checking for the latest version"],
          ["running", "Running native-agent update"],
          ["running", "Verifying the installed version"],
          ["succeeded", "Provider updated."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("reports unchanged when the updater exits 0 but the provider is gone", () => {
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry(baseProvider);
      // After the update, the refreshed snapshot no longer sees an install.
      const updater = yield* makeTestRunner({
        ...registry,
        refreshInstance: () =>
          Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) => ({ ...provider, installed: false, version: null })),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
      assert.match(result.providers[0]?.updateState?.message ?? "", /could not verify/);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stdout: "updated" })),
        ),
      ),
    );
  });

  it.effect(
    "keeps a successful update when the binary is present but its version is unreadable",
    () => {
      return Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
        // A native CLI version probe can fail immediately after a successful update.
        const updater = yield* makeTestRunner({
          ...registry,
          refreshInstance: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, installed: true, version: null })),
            ),
        });

        const result = yield* updater.updateProvider(NATIVE_CLI_DRIVER);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      );
    },
  );

  it.effect("spawns the updater with the environment its capabilities declare", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed({
            ...lifecycleFor(provider),
            update: {
              command: "codex update",
              executable: "/work/codex-home/packages/standalone/bin/codex",
              args: ["update"],
              lockKey: "codex-native",
              env: { CODEX_HOME: "/work/codex-home" },
            },
          }),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(seen, [{ CODEX_HOME: "/work/codex-home" }]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((_command, _args, options) => {
            seen.push(options.env);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("re-resolves ownership before running and executes the fresh command", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const fresh: Array<boolean> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) => {
          fresh.push(options?.fresh === true);
          return Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: options?.fresh ? "/opt/homebrew/bin/brew" : "brew",
              updateArgs: ["upgrade", "--cask", "codex"],
              updateLockKey: "homebrew",
            }),
          );
        },
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      // Cached read picks the lock; the two fresh reads bracket the command.
      assert.deepStrictEqual(fresh, [false, true, true]);
      assert.deepStrictEqual(calls, [
        { command: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("reports the installer's latest output line while the update runs", () => {
    const exited = Deferred.makeUnsafe<number>();
    const reached = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);
      const runningMessages = Ref.get(updateStatesRef).pipe(
        Effect.map((states) =>
          states.filter((state) => state.status === "running").map((state) => state.message),
        ),
      );

      const fiber = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      assert.deepStrictEqual(yield* runningMessages, [
        "Checking for the latest version",
        "Running native-agent update",
        "80%",
      ]);

      yield* Deferred.succeed(exited, 0);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({
            progress: ["80%"],
            exitCode: Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(exited)),
            ),
          })),
        ),
      ),
    );
  });

  it("splits installer output into clean status lines", () => {
    assert.deepStrictEqual(ProviderMaintenanceRunner.splitOutputLines("Down", "loading\r\n 5"), {
      lines: ["Downloading"],
      partialLine: " 5",
    });
    assert.strictEqual(
      ProviderMaintenanceRunner.toProgressLine("\u001b[1m==>\u001b[0m  Pouring"),
      "==> Pouring",
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(" \t "), null);
    assert.strictEqual(
      ProviderMaintenanceRunner.splitOutputLines("x".repeat(5_000), "y").partialLine.length,
      4_096,
    );
    assert.strictEqual(ProviderMaintenanceRunner.toProgressLine("x".repeat(300))?.length, 200);
  });

  it.effect("aborts without running when the installation changed since the advisory", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider, options) =>
          Effect.succeed(
            options?.fresh
              ? makeProviderMaintenanceCapabilities({
                  provider,
                  packageName: "@openai/codex",
                  updateExecutable: null,
                  updateArgs: [],
                  updateLockKey: null,
                })
              : lifecycleFor(provider),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Provider installation changed. Refresh and try again.",
      );
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "failed"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];
      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.124.0-alpha.3"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });
        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseLatch: { resolve: () => void } = { resolve: () => {} };
    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);
      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);
        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(Effect.as(0)),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch: { resolve: () => void } = { resolve: () => {} };
    const releaseFirstLatch: { resolve: () => void } = { resolve: () => {} };
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;
        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;
        if (queuedStatus === "queued") {
          break;
        }
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            if (calls.length === 1) {
              firstStartedLatch.resolve();
              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(Effect.as(0)),
              };
            }
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("0.0.0"),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch: { resolve: () => void } = { resolve: () => {} };
        const releaseQueuedStateLatch: { resolve: () => void } = { resolve: () => {} };
        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });
        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);
            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }
            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);
        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("spawns a win32 .cmd shim through the shell, hidden and detached", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: NodeChildProcess.SpawnOptions;
    }> = [];
    const spawnProcess = ((
      command: string,
      args: ReadonlyArray<string>,
      options: NodeChildProcess.SpawnOptions,
    ) => {
      captured.push({ command, args, options });
      const child = Object.assign(new NodeEvents.EventEmitter(), { pid: 4242, unref: () => {} });
      setImmediate(() => {
        child.emit("spawn");
        child.emit("exit", 0);
      });
      return child;
    }) as unknown as typeof NodeChildProcess.spawn;
    return Effect.gen(function* () {
      const recorded: Array<number> = [];
      const result = yield* ProviderMaintenanceRunner.runDetachedInstall(
        {
          command: "npm",
          args: ["install", "-g", "@openai/codex@latest"],
          recordChildPid: (pid) => Effect.sync(() => void recorded.push(pid)),
        },
        spawnProcess,
      );

      // resolveSpawnCommand resolves `npm` to the `.cmd` shim and routes it through cmd.exe.
      assert.strictEqual(captured.length, 1);
      const call = captured[0]!;
      assert.match(call.command, /npm\.cmd/i);
      assert.strictEqual(call.options.shell, true);
      assert.strictEqual(call.options.detached, true);
      assert.strictEqual(call.options.windowsHide, true);
      assert.strictEqual(call.args.length, 3);
      assert.match(call.args[2] ?? "", /@openai\/codex@latest/);
      assert.deepStrictEqual(recorded, [4242]);
      assert.strictEqual(result.exitCode, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
        ),
      ),
    );
  });

  describe("background installs", () => {
    const npmCapabilities = (lockKey = "npm-global:/fixture") =>
      makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "npm",
        updateArgs: ["install", "-g", "@openai/codex@latest"],
        updateLockKey: lockKey,
      });
    /** A registry whose codex version follows `version()`, so an install can change it. */
    const makeVersionedRegistry = (
      version: () => string,
      capabilities: ProviderMaintenanceCapabilities = npmCapabilities(),
    ) =>
      Effect.gen(function* () {
        const { registry, updateStatesRef } = yield* makeRegistry();
        const current = Effect.sync(() => [{ ...baseProvider, version: version() }]);
        return {
          updateStatesRef,
          registry: {
            ...registry,
            getProviders: current,
            refreshInstance: () => current,
            getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
          },
        };
      });
    const logs: Array<string> = [];
    const layerCaptureLogs = Logger.layer([
      Logger.make(({ message }) => void logs.push(JSON.stringify(message))),
    ]);

    it.effect("installs the pinned release silently and publishes no update state", () => {
      const calls: Array<string> = [];
      let installed = false;
      return Effect.gen(function* () {
        const { registry, updateStatesRef } = yield* makeVersionedRegistry(() =>
          installed ? "9.9.9" : "0.0.0",
        );
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider({
          provider: CODEX_DRIVER,
          targetVersion: "9.9.9",
          background: true,
        });

        assert.deepStrictEqual(calls, ["install -g @openai/codex@9.9.9"]);
        assert.deepStrictEqual(yield* Ref.get(updateStatesRef), []);
        assert.strictEqual(result.providers[0]?.updateState, undefined);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner((_command, args) => {
              calls.push(args.join(" "));
              installed = true;
              return {};
            }),
          ),
        ),
      );
    });

    it.effect("skips when the installed version already reaches the target", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        for (const installedVersion of ["9.9.9", "10.0.0-beta.1"]) {
          const { registry } = yield* makeVersionedRegistry(() => installedVersion);
          const runner = yield* makeTestRunner(registry);
          yield* runner.updateProvider({
            provider: CODEX_DRIVER,
            targetVersion: "9.9.9",
            background: true,
          });
        }
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner((_command, args) => {
              calls.push(args.join(" "));
              return {};
            }),
          ),
        ),
      );
    });

    it.effect(
      "refuses a broken release, an unpinnable package manager, and a closed window",
      () => {
        const calls: Array<string> = [];
        const manifest: ModelManifest.ModelManifestData = {
          version: 1,
          currentModels: {},
          compatibility: [
            {
              driver: "codex",
              t3CodeRange: ">=0.0.42",
              ranges: [{ range: ">2.0.0", status: "broken" }],
            },
          ],
        };
        return Effect.gen(function* () {
          const target = { provider: CODEX_DRIVER, background: true } as const;
          const make = (capabilities?: ProviderMaintenanceCapabilities) =>
            makeVersionedRegistry(() => "0.0.0", capabilities).pipe(
              Effect.flatMap(({ registry }) => makeTestRunner(registry, manifest)),
            );
          yield* (yield* make()).updateProvider({ ...target, targetVersion: "3.0.0" });
          yield* (yield* make(npmCapabilities("unknown-lock-key"))).updateProvider({
            ...target,
            targetVersion: "1.0.0",
          });
          yield* (yield* make()).updateProvider({
            ...target,
            targetVersion: "1.0.0",
            beforeInstall: Effect.succeed(false),
          });
          assert.deepStrictEqual(calls, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerNonWindowsPlatform,
              layerLatestVersionHttpClient("3.0.0"),
              layerMockSpawner((_command, args) => {
                calls.push(args.join(" "));
                return {};
              }),
            ),
          ),
        );
      },
    );

    it.effect("lets a native self-updater run unpinned", () => {
      const calls: Array<string> = [];
      let installed = false;
      return Effect.gen(function* () {
        const { registry } = yield* makeVersionedRegistry(
          () => (installed ? "9.9.9" : "0.0.0"),
          makeProviderMaintenanceCapabilities({
            provider: CODEX_DRIVER,
            packageName: "@openai/codex",
            updateExecutable: "codex",
            updateArgs: ["update"],
            updateLockKey: "codex-native",
          }),
        );
        const runner = yield* makeTestRunner(registry);
        yield* runner.updateProvider({
          provider: CODEX_DRIVER,
          targetVersion: "9.9.9",
          background: true,
        });
        assert.deepStrictEqual(calls, ["update"]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerMockSpawner((_command, args) => {
              calls.push(args.join(" "));
              installed = true;
              return {};
            }),
          ),
        ),
      );
    });

    it.effect("logs an install that failed or left the version unchanged", () => {
      logs.length = 0;
      let code = 1;
      return Effect.gen(function* () {
        const { registry, updateStatesRef } = yield* makeVersionedRegistry(() => "0.0.0");
        const runner = yield* makeTestRunner(registry);
        const target = { provider: CODEX_DRIVER, targetVersion: "9.9.9", background: true };

        yield* runner.updateProvider(target);
        code = 0;
        yield* runner.updateProvider(target);

        assert.deepStrictEqual(yield* Ref.get(updateStatesRef), []);
        const text = logs.join("\n");
        assert.include(text, '"status":"failed"');
        assert.include(text, '"status":"unchanged"');
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("9.9.9"),
            layerCaptureLogs,
            layerMockSpawner(() => ({ code })),
          ),
        ),
      );
    });

    it.effect("tells a manual update another server holds the install lock", () => {
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        const home = yield* FileSystem.FileSystem.use((fileSystem) =>
          fileSystem.makeTempDirectoryScoped({ prefix: "t3-install-lock-" }),
        ).pipe(Effect.provide(NodeServices.layer));
        const { registry } = yield* makeVersionedRegistry(
          () => "0.0.0",
          npmCapabilities("npm-global"),
        );
        const otherServer = yield* Effect.service(ProviderInstallLock.ProviderInstallLock).pipe(
          Effect.provide(layerLockAt(home)),
        );
        const runner = yield* makeRunnerWithLock(registry, defaultManifest, layerLockAt(home));

        const blocked = yield* otherServer.tryRun("npm-global", () =>
          runner.updateProvider(CODEX_DRIVER),
        );

        assert.strictEqual(
          Option.getOrThrow(blocked).providers[0]?.updateState?.message,
          "Another T3 server is already updating this provider.",
        );
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerNonWindowsPlatform,
            layerLatestVersionHttpClient("0.0.0"),
            layerMockSpawner((_command, args) => {
              calls.push(args.join(" "));
              return {};
            }),
          ),
        ),
      );
    });
  });
});

describe("ProviderInstallLock", () => {
  const withHome = Effect.gen(function* () {
    const home = yield* FileSystem.FileSystem.use((fileSystem) =>
      fileSystem.makeTempDirectoryScoped({ prefix: "t3-install-lock-" }),
    ).pipe(Effect.provide(NodeServices.layer));
    const instance = () =>
      Effect.service(ProviderInstallLock.ProviderInstallLock).pipe(
        Effect.provide(layerLockAt(home)),
      );
    return {
      directory: NodePath.join(home, "t3", "provider-install"),
      first: yield* instance(),
      second: yield* instance(),
    };
  });
  const lockFile = (directory: string, key: string) =>
    NodePath.join(directory, `${encodeURIComponent(key)}.lock`);

  it.effect("holds a key against another lock on the same directory but not other keys", () =>
    Effect.gen(function* () {
      const { first, second } = yield* withHome;
      const held = yield* first.tryRun("npm-global:/prefix", () =>
        Effect.gen(function* () {
          const sameKey = yield* second.tryRun("npm-global:/prefix", () => Effect.succeed(1));
          const otherKey = yield* second.tryRun("homebrew", () => Effect.succeed(2));
          return { sameKey, otherKey, anyHeld: yield* second.anyHeld };
        }),
      );
      assert.deepStrictEqual(Option.getOrThrow(held), {
        sameKey: Option.none(),
        otherKey: Option.some(2),
        anyHeld: true,
      });
      assert.isFalse(yield* second.anyHeld);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reclaims a lock left by a process that is gone", () =>
    Effect.gen(function* () {
      const { directory, first, second } = yield* withHome;
      const fileSystem = yield* FileSystem.FileSystem;
      const deadPid = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(lockFile(directory, "k"), String(deadPid));

      assert.isFalse(yield* second.anyHeld);
      assert.deepStrictEqual(
        yield* first.tryRun("k", () => Effect.succeed("ran")),
        Option.some("ran"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("two servers reclaiming the same stale lock leave exactly one owner", () =>
    Effect.gen(function* () {
      const { directory, first, second } = yield* withHome;
      const fileSystem = yield* FileSystem.FileSystem;
      const deadPid = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(lockFile(directory, "k"), String(deadPid));
      const runs = yield* Ref.make(0);
      // Hold the lock long enough for the other reclaimer to finish its attempt.
      // @effect-diagnostics-next-line globalTimers:off
      const hold = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      const attempt = (lock: typeof first) =>
        lock.tryRun("k", () => Ref.update(runs, (count) => count + 1).pipe(Effect.andThen(hold)));

      const results = yield* Effect.all([attempt(first), attempt(second)], {
        concurrency: "unbounded",
      });

      assert.strictEqual(results.filter(Option.isSome).length, 1);
      assert.strictEqual(yield* Ref.get(runs), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("untilIdle waits for a held lock, then resumes", () =>
    Effect.gen(function* () {
      const { directory, first } = yield* withHome;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(lockFile(directory, "k"), String(process.pid));
      const resumed = yield* Deferred.make<void>();
      yield* first.untilIdle.pipe(
        Effect.andThen(Deferred.succeed(resumed, undefined)),
        Effect.forkScoped,
      );

      // The lock files are read from disk, so give each clock tick real time to settle.
      // @effect-diagnostics-next-line globalTimers:off
      const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      const tick = TestClock.adjust(Duration.seconds(1)).pipe(Effect.andThen(settle));
      yield* Effect.all([tick, tick, tick]);
      assert.isFalse(yield* Deferred.isDone(resumed));

      yield* fileSystem.remove(lockFile(directory, "k"));
      for (let attempt = 0; attempt < 50 && !(yield* Deferred.isDone(resumed)); attempt += 1) {
        yield* tick;
      }
      assert.isTrue(yield* Deferred.isDone(resumed));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("a detached installer outlives the scope that ran it and keeps its lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { directory, first, second } = yield* withHome;
      const marker = NodePath.join(NodePath.dirname(directory), "done");
      const installer = yield* Effect.service(ProviderMaintenanceRunner.ProviderInstaller).pipe(
        Effect.provide(ProviderMaintenanceRunner.layerInstaller),
      );
      const started = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* first
        .tryRun("k", (recordChildPid) =>
          installer.run({
            command: process.execPath,
            args: [
              "-e",
              "console.log('hello');setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'finished'),1500)",
              marker,
            ],
            recordChildPid: (pid) =>
              recordChildPid(pid).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
          }),
        )
        .pipe(Effect.forkIn(scope));
      yield* Deferred.await(started);

      // Closing the scope interrupts the runner; the installer keeps going and keeps the lock.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(yield* second.anyHeld);
      assert.deepStrictEqual(yield* second.tryRun("k", () => Effect.void), Option.none());

      for (let attempt = 0; attempt < 100 && !(yield* fileSystem.exists(marker)); attempt += 1) {
        yield* Effect.sleep(Duration.millis(100));
      }
      assert.strictEqual(yield* fileSystem.readFileString(marker), "finished");
      yield* Effect.sleep(Duration.millis(200));
      assert.isFalse(yield* second.anyHeld);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("captures installer output and reports its latest line", () =>
    Effect.gen(function* () {
      const installer = yield* Effect.service(ProviderMaintenanceRunner.ProviderInstaller).pipe(
        Effect.provide(ProviderMaintenanceRunner.layerInstaller),
      );
      const lines: Array<string> = [];
      const result = yield* installer.run({
        command: process.execPath,
        args: ["-e", "console.log('hello');setTimeout(()=>{},1300)"],
        onProgress: (line) => Effect.sync(() => void lines.push(line)),
        recordChildPid: () => Effect.void,
      });
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "hello");
      assert.include(lines, "hello");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("ProviderAutoUpdater", () => {
  const harness = (input: {
    readonly automaticUpdates?: boolean;
    readonly window: { open: boolean };
    readonly latest: { version: string };
  }) =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly targetVersion?: string | undefined;
        readonly beforeInstall?: Effect.Effect<boolean> | undefined;
      }> = [];
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      yield* Layer.build(
        ProviderAutoUpdater.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, { devUrl: undefined } as never),
              Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
              Layer.succeed(ProviderMaintenanceRunner.ProviderMaintenanceRunner, {
                updateProvider: (target) =>
                  Effect.sync(() => {
                    if (typeof target !== "string") calls.push(target);
                    return { providers: [] };
                  }),
              }),
              Layer.succeed(UpdateWindow.UpdateWindow, {
                isOpen: () => Effect.sync(() => input.window.open),
                runIfOpen: (effect) =>
                  input.window.open ? Effect.asSome(effect) : Effect.succeedNone,
              }),
              ServerSettings.layerTest({ automaticUpdates: input.automaticUpdates ?? true }),
              ProviderLatestVersions.layer,
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      Response.json({ version: input.latest.version }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const advance = (duration: Duration.Duration) =>
        TestClock.adjust(duration).pipe(
          Effect.andThen(Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow)),
        );
      return { calls, advance };
    });

  it.effect("installs the newest release once the first pass runs", () =>
    Effect.gen(function* () {
      const { calls, advance } = yield* harness({
        window: { open: true },
        latest: { version: "2.0.0" },
      });
      yield* advance(Duration.minutes(1));
      assert.strictEqual(calls.length, 0);
      yield* advance(Duration.minutes(1));
      assert.deepStrictEqual(
        calls.map((call) => call.targetVersion),
        ["2.0.0"],
      );
    }),
  );

  it.effect("does nothing when automatic updates are off", () =>
    Effect.gen(function* () {
      const { calls, advance } = yield* harness({
        automaticUpdates: false,
        window: { open: true },
        latest: { version: "2.0.0" },
      });
      yield* advance(Duration.minutes(30));
      assert.strictEqual(calls.length, 0);
    }),
  );

  it.effect("waits for the window, and tries again once a postponed install's window reopens", () =>
    Effect.gen(function* () {
      const window = { open: false };
      const { calls, advance } = yield* harness({ window, latest: { version: "2.0.0" } });
      yield* advance(Duration.minutes(12));
      assert.strictEqual(calls.length, 0);

      window.open = true;
      yield* advance(Duration.minutes(10));
      assert.strictEqual(calls.length, 1);

      // The window closed again before the installer started: that is not a failed try.
      window.open = false;
      assert.isFalse(yield* calls[0]!.beforeInstall!);
      window.open = true;
      yield* advance(Duration.minutes(10));
      assert.strictEqual(calls.length, 2);
    }),
  );

  it.effect("tries a release once per six hours but a newer release at once", () =>
    Effect.gen(function* () {
      const latest = { version: "2.0.0" };
      const { calls, advance } = yield* harness({ window: { open: true }, latest });
      yield* advance(Duration.minutes(2));
      yield* advance(Duration.minutes(10));
      assert.strictEqual(calls.length, 1);

      latest.version = "2.1.0";
      yield* advance(Duration.minutes(70));
      assert.deepStrictEqual(
        calls.map((call) => call.targetVersion),
        ["2.0.0", "2.1.0"],
      );

      yield* advance(Duration.hours(7));
      assert.deepStrictEqual(
        calls.map((call) => call.targetVersion),
        ["2.0.0", "2.1.0", "2.1.0"],
      );
    }),
  );
});

describe("UpdateWindow", () => {
  const makeWindow = (state: {
    quietFor: Duration.Duration;
    active: ReadonlyArray<ThreadId> | "unreadable";
    installing: boolean;
    restartWork?: number;
    busyTerminals?: boolean;
  }) =>
    Effect.service(UpdateWindow.UpdateWindow).pipe(
      Effect.provide(
        UpdateWindow.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                sinceLastClientInteraction: Effect.sync(() => state.quietFor),
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () =>
                  state.active === "unreadable"
                    ? Effect.fail(new ProjectionStore.ProjectionStoreSetupError({ cause: "x" }))
                    : Effect.succeed(state.active),
              }),
              Layer.mock(ProviderInstallLock.ProviderInstallLock)({
                anyHeld: Effect.sync(() => state.installing),
              }),
              Layer.mock(RestartWork.RestartWork)({
                count: Effect.sync(() => state.restartWork ?? 0),
              }),
              Layer.mock(TerminalManager.TerminalManager)({
                hasBusyTerminals: Effect.sync(() => state.busyTerminals ?? false),
              }),
            ),
          ),
        ),
      ),
    );

  it.effect(
    "is open only when clients are quiet, no run is active, and no install is running",
    () =>
      Effect.gen(function* () {
        const state = {
          quietFor: Duration.minutes(15),
          active: [] as ReadonlyArray<ThreadId> | "unreadable",
          installing: false,
        };
        const window = yield* makeWindow(state);
        assert.isTrue(yield* window.isOpen());

        state.quietFor = Duration.minutes(14);
        assert.isFalse(yield* window.isOpen());
        state.quietFor = Duration.minutes(15);

        state.active = [ThreadId.make("thread:busy")];
        assert.isFalse(yield* window.isOpen());
        state.active = "unreadable";
        assert.isFalse(yield* window.isOpen());
        state.active = [];

        state.installing = true;
        assert.isFalse(yield* window.isOpen());
        assert.isTrue(yield* window.isOpen({ ignoreInstallLocks: true }));
        assert.deepStrictEqual(yield* window.runIfOpen(Effect.succeed("ran")), Option.none());
        state.installing = false;
        assert.deepStrictEqual(yield* window.runIfOpen(Effect.succeed("ran")), Option.some("ran"));
      }),
  );

  it.effect("keeps a server restart out while work or a terminal command would be lost", () =>
    Effect.gen(function* () {
      const state = {
        quietFor: Duration.minutes(15),
        active: [] as ReadonlyArray<ThreadId> | "unreadable",
        installing: false,
        restartWork: 1,
        busyTerminals: false,
      };
      const window = yield* makeWindow(state);
      const restart = { restartsServer: true };
      // Provider installs do not restart the server, so they ignore both blockers.
      assert.isTrue(yield* window.isOpen());
      assert.isFalse(yield* window.isOpen(restart));
      assert.deepStrictEqual(
        yield* window.runIfOpen(Effect.succeed("ran"), restart),
        Option.none(),
      );

      state.restartWork = 0;
      state.busyTerminals = true;
      assert.isTrue(yield* window.isOpen());
      assert.isFalse(yield* window.isOpen({ ...restart, ignoreInstallLocks: true }));

      state.busyTerminals = false;
      assert.deepStrictEqual(
        yield* window.runIfOpen(Effect.succeed("ran"), restart),
        Option.some("ran"),
      );
    }),
  );
});

it.effect("refuses incompatible latest versions and unapproved or unpinnable targets", () => {
  const calls: string[] = [];
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [
      {
        driver: "codex",
        t3CodeRange: ">=0.0.42",
        recommendedVersion: "2.0.0",
        ranges: [
          { range: "=2.0.0", status: "supported" },
          { range: ">2.0.0", status: "broken" },
        ],
      },
    ],
  };
  return Effect.gen(function* () {
    const { registry, providersRef } = yield* makeRegistry();
    const pinnedCapabilities = makeProviderMaintenanceCapabilities({
      provider: CODEX_DRIVER,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global:/fixture",
    });
    const updater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
      },
      manifest,
    );
    for (const targetVersion of [undefined, "", "1.0.0", "2.0.0; echo unsafe"]) {
      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        ...(targetVersion !== undefined ? { targetVersion } : {}),
      });
      assert.strictEqual(result.providers[0]?.updateState?.status, "failed");
    }
    assert.deepStrictEqual(calls, []);
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "2.0.0" })),
    );
    const installed = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.deepStrictEqual(calls, ["install -g @openai/codex@2.0.0"]);
    assert.strictEqual(installed.providers[0]?.updateState?.status, "succeeded");
    yield* Ref.update(providersRef, (providers) =>
      providers.map((entry) => ({ ...entry, version: "1.0.0" })),
    );
    const unchanged = yield* updater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(unchanged.providers[0]?.updateState?.status, "unchanged");
    const nativeUpdater = yield* makeTestRunner(
      {
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed({
            ...pinnedCapabilities,
            update: { ...pinnedCapabilities.update!, lockKey: "codex-native" },
          }),
      },
      manifest,
    );
    const refused = yield* nativeUpdater.updateProvider({
      provider: CODEX_DRIVER,
      targetVersion: "2.0.0",
    });
    assert.strictEqual(refused.providers[0]?.updateState?.status, "failed");
    assert.strictEqual(calls.length, 2);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        layerNonWindowsPlatform,
        layerLatestVersionHttpClient("3.0.0"),
        layerMockSpawner((_command, args) => {
          calls.push(args.join(" "));
          return { stdout: "installed" };
        }),
      ),
    ),
  );
});
