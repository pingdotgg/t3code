// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeProviderInstanceEnvironmentSource } from "../ProviderInstanceEnvironment.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilitiesSource,
  normalizeCommandPath,
} from "../providerMaintenance.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import {
  refreshProviderInstancesAfterEnvironmentHydration,
  SettingsWatcherLive,
} from "./ProviderInstanceRegistryHydration.ts";

it.effect("reconciles the subscribed settings payload without re-reading secrets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("delivered_settings");
      const driverKind = ProviderDriverKind.make("delivered");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver: driverKind,
            config: { enabled: true },
          },
        },
      };
      const consumed = yield* Deferred.make<void>();
      const reconciled = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const settingsReads = yield* Ref.make(0);
      const registryChanges = yield* PubSub.unbounded<void>();
      const settingsChanges = Stream.make(settings).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain)),
      );
      const registry = ProviderInstanceRegistry.of({
        getInstance: () => Effect.sync(() => undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: PubSub.subscribe(registryChanges),
      });
      const mutator = ProviderInstanceRegistryMutator.of({
        reconcile: (configMap) => Ref.update(reconciled, (seen) => [...seen, configMap]),
      });
      const serverSettings = ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.update(settingsReads, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("must not re-read an emitted settings payload")),
        ),
        updateSettings: () => Effect.die("unused"),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      yield* Layer.build(
        SettingsWatcherLive(settingsChanges).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderInstanceRegistry, registry),
              Layer.succeed(ProviderInstanceRegistryMutator, mutator),
              Layer.succeed(ServerSettingsService, serverSettings),
            ),
          ),
        ),
      );
      yield* Deferred.await(consumed);

      expect(yield* Ref.get(settingsReads)).toBe(0);
      expect(yield* Ref.get(reconciled)).toEqual([
        expect.objectContaining({
          [instanceId]: expect.objectContaining({ driver: driverKind }),
        }),
      ]);
    }),
  ),
);

it.effect("refreshes profile-discovered tools without replacing active provider instances", () =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make<ReadonlyArray<string>>([]);
    const stopped = yield* Ref.make(0);
    const driverKind = ProviderDriverKind.make("test");
    const active = {
      instanceId: ProviderInstanceId.make("active"),
      driverKind,
      continuationIdentity: { driverKind, continuationKey: "test:active" },
      displayName: "active",
      enabled: true,
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh: Ref.update(refreshes, (ids) => [...ids, "active"]).pipe(
          Effect.andThen(Effect.die("profile refresh failure")),
        ),
      } as unknown as ProviderInstance["snapshot"],
      adapter: {
        listSessions: () =>
          Effect.succeed([
            {
              activeTurnId: "turn-active",
            },
          ]),
        stopAll: () => Ref.update(stopped, (count) => count + 1),
      } as unknown as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance;
    const idle = {
      ...active,
      instanceId: ProviderInstanceId.make("idle"),
      displayName: "idle",
      continuationIdentity: { driverKind, continuationKey: "test:idle" },
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh: Ref.update(refreshes, (ids) => [...ids, "idle"]).pipe(Effect.as({} as never)),
      } as unknown as ProviderInstance["snapshot"],
    } satisfies ProviderInstance;
    const instances = [active, idle] as const;
    const registry = ProviderInstanceRegistry.of({
      getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused"),
    });

    yield* refreshProviderInstancesAfterEnvironmentHydration(registry);

    expect(yield* registry.getInstance(active.instanceId)).toBe(active);
    expect([...(yield* Ref.get(refreshes))].toSorted()).toEqual(["active", "idle"]);
    expect(yield* Ref.get(stopped)).toBe(0);
  }),
);

it.effect("does not restore a stale instance when settings overlap profile hydration", () =>
  Effect.gen(function* () {
    const driverKind = ProviderDriverKind.make("test");
    const instanceId = ProviderInstanceId.make("test_default");
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const makeInstance = (
      displayName: string,
      refresh: Effect.Effect<never>,
    ): ProviderInstance => ({
      instanceId,
      driverKind,
      continuationIdentity: { driverKind, continuationKey: `test:${displayName}` },
      displayName,
      enabled: true,
      snapshot: {
        getSnapshot: Effect.die("unused"),
        refresh,
      } as unknown as ProviderInstance["snapshot"],
      adapter: {} as ProviderInstance["adapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    });
    const stale = makeInstance(
      "stale",
      Deferred.succeed(refreshStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRefresh)),
        Effect.andThen(Effect.die("unused result")),
      ),
    );
    const newest = makeInstance("newest", Effect.die("must not refresh the replacement"));
    const current = yield* Ref.make(stale);
    const registry = ProviderInstanceRegistry.of({
      getInstance: () => Ref.get(current).pipe(Effect.map((instance) => instance)),
      listInstances: Ref.get(current).pipe(Effect.map((instance) => [instance])),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused"),
    });

    const hydration = yield* Effect.forkChild(
      refreshProviderInstancesAfterEnvironmentHydration(registry),
      { startImmediately: true },
    );
    yield* Deferred.await(refreshStarted);
    yield* Ref.set(current, newest);
    yield* Deferred.succeed(releaseRefresh, undefined);
    yield* Fiber.join(hydration);

    expect(yield* registry.getInstance(instanceId)).toBe(newest);
  }),
);

it.effect("refreshes a profile-only CLI through an existing provider environment", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-profile-provider-"))),
    (tempDir) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        const nativeBinDir = NodePath.join(tempDir, ".local", "bin");
        const executableName = platform === "win32" ? "profile-tool.exe" : "profile-tool";
        const executable = NodePath.join(nativeBinDir, executableName);
        NodeFS.mkdirSync(nativeBinDir, { recursive: true });
        NodeFS.writeFileSync(executable, platform === "win32" ? "MZ" : "#!/bin/sh\n");
        if (platform !== "win32") NodeFS.chmodSync(executable, 0o755);

        const baseEnv: NodeJS.ProcessEnv = {
          PATH: tempDir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          PROFILE_VALUE: "host-before",
        };
        const environmentSource = makeProviderInstanceEnvironmentSource(
          [
            { name: "UNRELATED", value: "custom", sensitive: false },
            { name: "PROFILE_VALUE", value: "instance", sensitive: false },
          ],
          baseEnv,
        );
        const capturedEnvironment = environmentSource.environment;
        const driverKind = ProviderDriverKind.make("profileTool");
        const maintenance = yield* makeProviderMaintenanceCapabilitiesSource(
          makePackageManagedProviderMaintenanceResolver({
            provider: driverKind,
            npmPackageName: "@example/profile-tool",
            homebrewFormula: null,
            nativeUpdate: {
              executable: "profile-tool",
              args: ["update"],
              lockKey: "profile-tool-native",
              isCommandPath: (commandPath) =>
                normalizeCommandPath(commandPath).includes("/.local/bin/profile-tool"),
            },
          }),
          { binaryPath: "profile-tool", env: capturedEnvironment },
        );
        const state = yield* Ref.make({ installed: false, maintenance: "npm-global" });
        const refreshSnapshot = resolveCommandPath("profile-tool", {
          env: capturedEnvironment,
        }).pipe(
          Effect.option,
          Effect.flatMap((resolved) =>
            maintenance.refresh.pipe(Effect.as(resolved._tag === "Some")),
          ),
          Effect.flatMap((installed) =>
            Ref.set(state, {
              installed,
              maintenance: maintenance.get().update?.lockKey ?? "manual",
            }),
          ),
        );
        const instanceId = ProviderInstanceId.make("profile-tool");
        const instance = {
          instanceId,
          driverKind,
          continuationIdentity: { driverKind, continuationKey: "profileTool:profile-tool" },
          displayName: "Profile tool",
          enabled: true,
          refreshEnvironment: environmentSource.refresh.pipe(
            Effect.andThen(maintenance.invalidate),
          ),
          snapshot: {
            getSnapshot: Effect.die("unused"),
            refresh: refreshSnapshot,
          } as unknown as ProviderInstance["snapshot"],
          adapter: {} as ProviderInstance["adapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const registry = ProviderInstanceRegistry.of({
          getInstance: () => Effect.succeed(instance),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("unused"),
        });

        yield* refreshSnapshot;
        expect(yield* Ref.get(state)).toEqual({ installed: false, maintenance: "npm-global" });

        const releaseProfile = yield* Deferred.make<void>();
        const profilePatch = yield* Deferred.await(releaseProfile).pipe(
          Effect.andThen(
            Effect.sync(() => {
              baseEnv.PATH = nativeBinDir;
              baseEnv.PROFILE_VALUE = "host-after";
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseProfile, undefined);
        yield* Fiber.join(profilePatch);
        yield* refreshProviderInstancesAfterEnvironmentHydration(registry);

        expect(yield* registry.getInstance(instanceId)).toBe(instance);
        expect(environmentSource.environment).toBe(capturedEnvironment);
        expect(capturedEnvironment.UNRELATED).toBe("custom");
        expect(capturedEnvironment.PROFILE_VALUE).toBe("instance");
        expect(yield* Ref.get(state)).toEqual({
          installed: true,
          maintenance: "profile-tool-native",
        });
      }),
    (tempDir) => Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
  ).pipe(Effect.provide(NodeServices.layer)),
);
