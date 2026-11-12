import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
      invalidateModelCaches: () => Effect.void,
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
});

