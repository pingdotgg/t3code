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
  it.effect.each([
    { runFor: "6 minutes", status: "succeeded", message: "Provider updated." },
    { runFor: "31 minutes", status: "failed", message: "Update timed out after 30 minutes." },
  ] as const)("lets a slow installer run for $runFor", ({ runFor, status, message }) => {
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseNativeCliProvider);
      const updater = yield* makeTestRunner(registry);

      const update = yield* updater.updateProvider(NATIVE_CLI_DRIVER).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(runFor);
      const result = yield* Fiber.join(update);

      assert.strictEqual(result.providers[0]?.updateState?.status, status);
      assert.strictEqual(result.providers[0]?.updateState?.message, message);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerNonWindowsPlatform,
          layerLatestVersionHttpClient("1.0.0"),
          layerMockSpawner(() => ({
            exitCode: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.sleep(runFor)),
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            ),
          })),
        ),
      ),
    );
  });
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
  it.effect("resolves npm to a .cmd shim from the provider's PATH on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
      readonly env: NodeJS.ProcessEnv | undefined;
    }> = [];
    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider, {
        installedVersionAfterUpdate: "1.0.0",
      });
      const runner = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            makeProviderMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
              env: { PATH: "C:\\fake\\npm" },
            }),
          ),
      });

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
      assert.deepStrictEqual(call.env, { PATH: "C:\\fake\\npm" });
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          // Only the provider's PATH has npm.
          Layer.succeed(HostProcess.Environment, {
            PATH: "C:\\Windows\\System32",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command, _platform, env) =>
            command === "npm" && env.PATH === "C:\\fake\\npm"
              ? "C:\\fake\\npm\\npm.cmd"
              : undefined,
          ),
          layerLatestVersionHttpClient("1.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const childProcess = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options: {
                  readonly shell?: boolean | string | undefined;
                  readonly env?: NodeJS.ProcessEnv | undefined;
                };
              };
              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
                env: childProcess.options.env,
              });
              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});

