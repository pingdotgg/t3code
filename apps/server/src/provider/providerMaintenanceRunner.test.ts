import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
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
const encoder = new TextEncoder();

// Pin Linux so raw command/args assertions bypass Windows shim resolution.
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

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv | undefined },
  ) => {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv | undefined };
      };
      return Effect.succeed(
        mockHandle(handler(childProcess.command, childProcess.args, childProcess.options)),
      );
    }),
  );
}

function makeRegistry(
  initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
  options?: {
    readonly installedVersionAfterUpdate?: string;
  },
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
      reloadSecretsAndRefresh: () => Ref.get(providersRef),
      refreshAfterUpdate: () => {
        const version = options?.installedVersionAfterUpdate;
        if (version === undefined) {
          return Ref.get(providersRef);
        }
        return Ref.updateAndGet(providersRef, (providers) =>
          providers.map((provider) => ({
            ...provider,
            version,
          })),
        );
      },
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

const makeTestRunner = (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [CODEX_DRIVER, OPENCODE_DRIVER].map((driver) => ({
      driver,
      t3CodeRange: ">=0.0.42",
      ranges: [],
    })),
  },
  latestVersions: Layer.Layer<ProviderLatestVersions.ProviderLatestVersions> = ProviderLatestVersions.layer,
) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            latestVersions,
          ),
        ),
      ),
    ),
  );

function layerFailingLatestLookupAfterFirst() {
  let lookups = 0;
  return Layer.succeed(ProviderLatestVersions.ProviderLatestVersions, {
    cached: (_key, lookup) =>
      Effect.gen(function* () {
        lookups += 1;
        if (lookups > 1) {
          return yield* Effect.die("latest lookup failed");
        }
        return yield* lookup;
      }),
    invalidate: () => Effect.void,
  });
}

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
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "current", probe: {}, skip: true },
    { name: "failed", probe: { status: "error" }, skip: false },
    { name: "behind", probe: { version: "2.1.309" }, skip: false },
    { name: "unknown", probe: { version: null }, skip: false },
    {
      name: "installed current",
      probe: { version: "2.1.309", installedVersion: "2.1.310" },
      skip: true,
    },
    { name: "installed behind", probe: { installedVersion: "2.1.309" }, skip: false },
    { name: "installed unknown", probe: { installedVersion: null }, skip: false },
  ] as const)("only skips a successful fresh current probe: $name", ({ probe, skip }) => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const refreshedInstanceIds: Array<ProviderInstanceId> = [];
    return Effect.gen(function* () {
      const { registry, updateStatesRef, providersRef } = yield* makeRegistry({
        ...baseProvider,
        version: "2.1.309",
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.1.309",
          latestVersion: "2.1.310",
          updateCommand: "claude update",
          canUpdate: true,
          checkedAt: "2026-04-10T00:00:00.000Z",
          message: "Update available.",
        },
      });
      const updater = yield* makeTestRunner({
        ...registry,
        refreshInstance: (instanceId) => {
          refreshedInstanceIds.push(instanceId);
          return Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) =>
              provider.instanceId === instanceId
                ? {
                    ...provider,
                    version: "2.1.310",
                    ...probe,
                    checkedAt: "2026-04-10T00:00:01.000Z",
                  }
                : provider,
            ),
          );
        },
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@anthropic-ai/claude-code",
              updateExecutable: "claude",
              updateArgs: ["update"],
              updateLockKey: "claudeAgent-native",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(refreshedInstanceIds, [CODEX_INSTANCE_ID]);
      assert.deepStrictEqual(calls, skip ? [] : [{ command: "claude", args: ["update"] }]);
      if (!skip) return;
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[0]?.updateState?.message, "Already up to date.");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => [state.status, state.message]),
        [
          ["queued", "Waiting for another provider update to finish."],
          ["running", "Checking for the latest version"],
          ["succeeded", "Already up to date."],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.1.310"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("still runs the installer when refreshInstance returns the cached snapshot", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        version: "2.1.310",
      });
      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@anthropic-ai/claude-code",
              updateExecutable: "claude",
              updateArgs: ["update"],
              updateLockKey: "claudeAgent-native",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [{ command: "claude", args: ["update"] }]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.1.310"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("still runs the installer when precheck advisory enrichment fails", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({
        ...baseProvider,
        version: "2.1.310",
        versionAdvisory: {
          status: "current",
          currentVersion: "2.1.310",
          latestVersion: "2.1.310",
          updateCommand: "claude update",
          canUpdate: true,
          checkedAt: "2026-04-10T00:00:00.000Z",
          message: null,
        },
      });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshInstance: (instanceId) =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) =>
                provider.instanceId === instanceId
                  ? { ...provider, checkedAt: "2026-04-10T00:00:01.000Z" }
                  : provider,
              ),
            ),
          getProviderMaintenanceCapabilitiesForInstance: () =>
            Effect.succeed(
              makeProviderMaintenanceCapabilities({
                provider: CODEX_DRIVER,
                packageName: "@anthropic-ai/claude-code",
                updateExecutable: "claude",
                updateArgs: ["update"],
                updateLockKey: "claudeAgent-native",
              }),
            ),
        },
        undefined,
        layerFailingLatestLookupAfterFirst(),
      );

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [{ command: "claude", args: ["update"] }]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("2.1.310"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "keeps a successful update when the binary is present but its version is unreadable",
    () => {
      return Effect.gen(function* () {
        const { registry, providersRef } = yield* makeRegistry(baseNativeCliProvider);
        const updater = yield* makeTestRunner({
          ...registry,
          refreshAfterUpdate: () =>
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
            layerLatestVersionHttpClient("1.0.0"),
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
          layerLatestVersionHttpClient("1.0.0"),
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
      assert.deepStrictEqual(fresh, [false, true, true]);
      assert.deepStrictEqual(calls, [
        { command: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner((command, args) => {
            calls.push({ command, args });
            return { stdout: "updated" };
          }),
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

    for (const redraw of [
      "\r",
      "\u001b[G",
      "\u001b[0G",
      "\u001b[1G",
      "\u001b[01G",
      "\u001b[999D",
      "\u001b[999D\u001b[J",
    ]) {
      const output = `first${redraw}second${redraw}last`;
      for (let boundary = 0; boundary <= output.length; boundary++) {
        let partialLine = "";
        for (const chunk of [output.slice(0, boundary), output.slice(boundary)]) {
          partialLine = ProviderMaintenanceRunner.splitOutputLines(partialLine, chunk).partialLine;
        }
        assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(partialLine), "last");
      }
    }
    for (const incomplete of ["\u001b", "\u001b[", "\u001b[0", "\u001b[01"]) {
      assert.strictEqual(ProviderMaintenanceRunner.toProgressLine(`progress${incomplete}`), null);
    }
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
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner((command) => {
            calls.push(command);
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
      assert.strictEqual(
        updateState?.message,
        "Update command exited with code 1: Error: Could not detect the Codex installation method.",
      );
      assert.include(updateState?.output ?? "", "checking install");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({
            stdout: "checking install\n",
            stderr: "Error: Could not detect the Codex installation method.\n\n",
            code: 1,
          })),
        ),
      ),
    ),
  );

  it.effect("keeps the exit code message when a failed command prints nothing", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);

      assert.strictEqual(
        result.providers[0]?.updateState?.message,
        "Update command exited with code 1.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({ code: 1 })),
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
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => {
            startedLatch.resolve();
            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider, {
          installedVersionAfterUpdate: "1.0.0",
        });
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
            layerLatestVersionHttpClient("1.0.0"),
            layerMockSpawner(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider, {
        installedVersionAfterUpdate: "1.0.0",
      });
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      assert.strictEqual(
        call.command,
        '^"C:\\fake\\npm\\npm.cmd^" ^"install^" ^"-g^" ^"@openai/codex@latest^"',
      );
      assert.deepEqual(call.args, []);
      assert.strictEqual(call.shell, true);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          layerLatestVersionHttpClient("1.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: { readonly shell?: boolean | string | undefined };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});

it.effect.each([
  {
    mode: "default",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted",
    version: "1.14.19",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "targeted-current",
    version: "1.14.20",
    installation: { installedVersion: "1.14.20" },
    status: "succeeded",
  },
  {
    mode: "unknown",
    version: "1.14.19",
    installation: { installedVersion: null },
    status: "unchanged",
  },
  { mode: "legacy", version: "1.14.20", installation: {}, status: "succeeded" },
] as const)(
  "verifies the $mode OpenCode update using the refreshed installation",
  ({ mode, version, installation, status }) => {
    const calls: string[] = [];
    const capabilities = lifecycleFor(OPENCODE_DRIVER);
    const pinnedCapabilities = {
      ...capabilities,
      update: { ...capabilities.update!, lockKey: "npm-global:/fixture" },
    };
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          driver: OPENCODE_DRIVER,
          t3CodeRange: ">=0.0.42",
          recommendedVersion: "1.14.20",
          ranges: [{ range: "=1.14.20", status: "supported" }],
        },
      ],
    };
    return Effect.gen(function* () {
      const { registry, providersRef } = yield* makeRegistry({ ...baseOpenCodeProvider, version });
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const updater = yield* makeTestRunner(
        {
          ...registry,
          refreshInstance: () =>
            Ref.updateAndGet(providersRef, (providers) =>
              providers.map((provider) => ({ ...provider, checkedAt: "2026-04-10T00:00:01.000Z" })),
            ),
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(pinnedCapabilities),
          refreshAfterUpdate: () =>
            Effect.gen(function* () {
              assert.strictEqual(calls.length, 1);
              const refreshed = yield* enrichProviderSnapshotWithVersionAdvisory(
                { ...baseOpenCodeProvider, version, ...installation },
                pinnedCapabilities,
              ).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              );
              return yield* Ref.updateAndGet(providersRef, (providers) =>
                providers.map((provider) => ({ ...provider, ...refreshed })),
              );
            }),
        },
        manifest,
      );

      const result = yield* updater.updateProvider({
        provider: OPENCODE_DRIVER,
        ...(mode === "default" ? {} : { targetVersion: "1.14.20" }),
      });

      assert.deepStrictEqual(calls, [
        `npm install -g opencode-ai@${mode === "default" ? "latest" : "1.14.20"}`,
      ]);
      const provider = result.providers[0];
      assert.ok(provider);
      assert.strictEqual(provider.updateState?.status, status);
      assert.strictEqual(provider.version, version);
      assert.strictEqual("installedVersion" in provider, mode !== "legacy");
      assert.strictEqual(
        provider.versionAdvisory?.status,
        mode === "unknown" ? "unknown" : "current",
      );
      assert.strictEqual(
        provider.versionAdvisory?.currentVersion,
        mode === "unknown" ? null : "1.14.20",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          ProviderLatestVersions.layer,
          layerLatestVersionHttpClient("1.14.20"),
          layerMockSpawner((command, args) => {
            calls.push([command, ...args].join(" "));
            return { stdout: "installed" };
          }),
        ),
      ),
    );
  },
);

it.effect(
  "uses fresh installer versions for post-update verification and compatibility checks",
  () => {
    const calls: string[] = [];
    let latest = "2.0.0";
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      compatibility: [
        {
          driver: "codex",
          t3CodeRange: ">=0.0.42",
          ranges: [
            { range: "<=2.0.0", status: "supported" },
            { range: ">2.0.0", status: "broken" },
          ],
        },
      ],
    };
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({ ...baseProvider, version: "1.0.0" });
      const capabilities = makeProviderMaintenanceCapabilities({
        provider: CODEX_DRIVER,
        packageName: "@openai/codex",
        updateExecutable: "/opt/homebrew/bin/brew",
        updateArgs: ["upgrade", "--cask", "codex"],
        updateLockKey: "homebrew",
        latestVersion: null,
        lookupLatestVersion: Effect.sync(() => latest),
      });
      const updater = yield* makeTestRunner(
        {
          ...registry,
          getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
        },
        manifest,
      );

      const unchanged = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(unchanged.providers[0]?.updateState?.status, "unchanged");
      assert.match(unchanged.providers[0]?.updateState?.message ?? "", /outdated provider version/);
      assert.deepStrictEqual(calls, ["upgrade --cask codex"]);

      latest = "3.0.0";
      const refused = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(refused.providers[0]?.updateState?.status, "failed");
      assert.match(refused.providers[0]?.updateState?.message ?? "", /incompatible/);
      assert.deepStrictEqual(calls, ["upgrade --cask codex"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Homebrew's latest should not come from npm")),
          ),
          layerMockSpawner((_command, args) => {
            calls.push(args.join(" "));
            latest = "2.0.0";
            return { stdout: "upgraded" };
          }),
        ),
      ),
    );
  },
);

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
