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

