import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ModelManifest from "./ModelManifest.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import {
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
} from "./providerMaintenance.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

const driver = ProviderDriverKind.make("cursor");
const maintenance = makeProviderMaintenanceCapabilities({
  provider: driver,
  packageName: "@example/provider",
  updateExecutable: "example-provider",
  updateArgs: ["update"],
  updateLockKey: "example-provider",
  latestVersion: "2.0.0",
});
const manifest = {
  version: 1,
  currentModels: {},
  compatibility: [{ driver, t3CodeRange: ">=0.0.44", ranges: [] }],
} satisfies ModelManifest.ModelManifestData;

for (const outcome of ["success", "update-failed", "discovery-failed"] as const) {
  it.effect(`refreshes account catalogs after a provider update (${outcome})`, () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const versionCache = new Map([
        ["@example/provider", { expiresAt: Number.MAX_SAFE_INTEGER, version: "1.0.0" }],
        ["@example/unrelated", { expiresAt: Number.MAX_SAFE_INTEGER, version: "1.0.0" }],
      ]);
      const makeSnapshot = (id: string, enabled = true, kind = driver): ServerProvider => ({
        instanceId: ProviderInstanceId.make(id),
        driver: kind,
        enabled,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            slug: `${id}-old`,
            name: "Existing model",
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
          {
            slug: `${id}-custom`,
            name: "Custom model",
            isCustom: true,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          },
        ],
        slashCommands: [],
        skills: [],
      });
      const initial = [
        makeSnapshot("primary"),
        makeSnapshot("secondary"),
        makeSnapshot("disabled", false),
        makeSnapshot("unrelated", true, ProviderDriverKind.make("codex")),
      ];
      const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>(initial);
      const instances = initial.map((snapshot): ProviderInstance => {
        let cached = true;
        const unexpected = () => Effect.die("Discovery must not operate on conversation sessions.");
        return {
          instanceId: snapshot.instanceId,
          driverKind: snapshot.driver,
          continuationIdentity: {
            driverKind: snapshot.driver,
            continuationKey: snapshot.instanceId,
          },
          displayName: undefined,
          enabled: snapshot.enabled,
          invalidateCaches: Effect.sync(() => {
            cached = false;
            events.push(`invalidate:${snapshot.instanceId}`);
          }),
          snapshot: {
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.sync(() => {
              events.push(`probe:${snapshot.instanceId}`);
              if (outcome === "discovery-failed")
                return { ...snapshot, status: "error" as const, message: "Discovery failed." };
              return cached
                ? snapshot
                : {
                    ...snapshot,
                    version: "2.0.0",
                    models: [
                      ...snapshot.models,
                      {
                        slug: `${snapshot.instanceId}-new`,
                        name: "New model",
                        isCustom: false,
                        capabilities: createModelCapabilities({ optionDescriptors: [] }),
                      },
                    ],
                  };
            }),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
            resolveMaintenance: (options) =>
              Effect.sync(() => {
                assert.isTrue(options?.fresh);
                events.push(`maintenance:${snapshot.instanceId}`);
                return maintenance;
              }),
          },
          adapter: {
            provider: snapshot.driver,
            capabilities: { sessionModelSwitch: "in-session" },
            startSession: unexpected,
            sendTurn: unexpected,
            interruptTurn: unexpected,
            respondToRequest: unexpected,
            respondToUserInput: unexpected,
            stopSession: unexpected,
            listSessions: unexpected,
            hasSession: unexpected,
            readThread: unexpected,
            rollbackThread: unexpected,
            stopAll: unexpected,
            streamEvents: Stream.empty,
          },
          textGeneration: {
            generateCommitMessage: unexpected,
            generatePrContent: unexpected,
            generateBranchName: unexpected,
            generateThreadTitle: unexpected,
          },
        };
      });
      const runner = yield* ProviderMaintenanceRunner.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Unexpected HTTP request")),
            ),
            Layer.succeed(ProviderVersionCache, versionCache),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.sync(() => {
                events.push("manifest");
                return manifest;
              }),
              refreshInBackground: Effect.void,
            }),
            Layer.mock(ProviderInstanceRegistry)({ listInstances: Effect.succeed(instances) }),
            Layer.mock(ProviderRegistry)({
              getProviders: Ref.get(providers),
              getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(maintenance),
              refreshInstance: (id) =>
                Effect.gen(function* () {
                  const instance = instances.find((value) => value.instanceId === id)!;
                  const next = yield* instance.snapshot.refresh;
                  return yield* Ref.updateAndGet(providers, (values) =>
                    values.map((value) => (value.instanceId === id ? next : value)),
                  );
                }),
              setProviderMaintenanceActionState: ({ instanceId, state }) =>
                Ref.updateAndGet(providers, (values) =>
                  values.map((value) =>
                    value.instanceId === instanceId && state
                      ? { ...value, updateState: state }
                      : value,
                  ),
                ),
            }),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.sync(() => {
                  events.push("update");
                  return ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    exitCode: Effect.succeed(
                      ChildProcessSpawner.ExitCode(outcome === "update-failed" ? 1 : 0),
                    ),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    unref: Effect.succeed(Effect.void),
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                  });
                }),
              ),
            ),
          ),
        ),
      );
      const result = yield* runner.updateProvider({
        provider: driver,
        instanceId: initial[0]!.instanceId,
      });
      if (outcome === "update-failed") {
        assert.deepEqual(events, ["update"]);
        assert.equal(result.providers[0]?.updateState?.status, "failed");
        assert.deepEqual(result.providers[1], initial[1]);
        assert.isTrue(versionCache.has("@example/provider"));
        return;
      }
      assert.equal(events[0], "update");
      assert.equal(events[1], "manifest");
      assert.deepEqual(events.filter((event) => event.startsWith("invalidate:")).toSorted(), [
        "invalidate:primary",
        "invalidate:secondary",
      ]);
      assert.deepEqual(events.filter((event) => event.startsWith("probe:")).toSorted(), [
        "probe:primary",
        "probe:secondary",
      ]);
      assert.isFalse(versionCache.has("@example/provider"));
      assert.isTrue(versionCache.has("@example/unrelated"));
      for (const snapshot of result.providers.slice(0, 2)) {
        const before = initial.find((value) => value.instanceId === snapshot.instanceId)!;
        assert.deepEqual(snapshot.auth, before.auth);
        assert.deepEqual(snapshot.models.slice(0, 2), before.models);
        assert.equal(snapshot.models.length, outcome === "success" ? 3 : 2);
        if (outcome === "success")
          assert.equal(snapshot.models[2]?.slug, `${snapshot.instanceId}-new`);
      }
      assert.equal(
        result.providers[0]?.updateState?.status,
        outcome === "success" ? "succeeded" : "unchanged",
      );
      assert.deepEqual(result.providers.slice(2), initial.slice(2));
      assert.isUndefined(result.providers[1]?.updateState);
    }),
  );
}
