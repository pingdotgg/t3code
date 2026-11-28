import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstallation from "./providerInstallation.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const driver = ProviderDriverKind.make("antigravity");
const state: ProviderInstallState = {
  driver,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  canRemove: false,
  message: null,
};

function instance(kind = driver, id = instanceId): ProviderInstance {
  return {
    instanceId: id,
    driverKind: kind,
    enabled: false,
    displayName: undefined,
    continuationIdentity: { driverKind: kind, continuationKey: instanceId },
    get orchestrationAdapter(): never {
      throw new Error("Installation must not start a provider session.");
    },
    get snapshot(): never {
      throw new Error("Installation routing must not probe the provider.");
    },
    get textGeneration(): never {
      throw new Error("Installation must not generate text.");
    },
  };
}

const makeHarness = Effect.fn("providerInstallation.test.makeHarness")(function* (
  input: {
    instance?: ProviderInstance;
    others?: ReadonlyArray<ProviderInstance>;
    settings?: Parameters<typeof ServerSettings.layerTest>[0];
    /** The states an install passes through, whoever started it. */
    installStates?: ReadonlyArray<ProviderInstallState>;
  } = {},
) {
  const calls: string[] = [];
  const observed = yield* Deferred.make<void>();
  let protectedPaths: ReadonlyArray<string> = [];
  const configured = input.instance ?? instance();
  const all = [configured, ...(input.others ?? [])];
  const refreshedInstances: ProviderInstanceId[] = [];
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest(input.settings),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.succeed(all.find((entry) => entry.instanceId === id)),
      listInstances: Effect.succeed(all),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: (id) =>
        Effect.sync(() => {
          calls.push("refresh");
          refreshedInstances.push(id);
          return [];
        }),
    }),
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "/unused-managed-codex",
      start: Effect.sync(() => {
        calls.push("codex-start");
        return { ...state, driver: ProviderDriverKind.make("codex") };
      }),
      cancel: () =>
        Effect.sync(() => {
          calls.push("codex-cancel");
          return { ...state, driver: ProviderDriverKind.make("codex") };
        }),
      state: Effect.succeed({ ...state, driver: ProviderDriverKind.make("codex") }),
      changes: Stream.succeed({ ...state, driver: ProviderDriverKind.make("codex") }),
      checkForUpdate: Effect.void,
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("codex-remove");
        }),
    }),
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: "/unused-managed-runtime",
      checkForUpdate: Effect.void,
      start: Effect.sync(() => {
        calls.push("start");
        return { ...state, operationId: "install-1", phase: "downloading" as const };
      }),
      cancel: () =>
        Effect.sync(() => {
          calls.push("cancel");
          return state;
        }),
      state: Effect.succeed(state),
      // Ends after its last state is handled, so `observed` marks the end of the service's watch.
      changes: Stream.fromIterable(input.installStates ?? [state]).pipe(
        Stream.ensuring(Deferred.succeed(observed, undefined)),
      ),
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("remove");
        }),
    }),
  );
  const context = yield* Layer.build(ProviderInstallation.layer.pipe(Layer.provide(dependencies)));
  const router = yield* Effect.service(ProviderInstallation.ProviderInstallation).pipe(
    Effect.provide(context),
  );
  return {
    router,
    calls,
    observed,
    refreshedInstances,
    protectedPaths: () => protectedPaths,
  };
});

const installed = (operationId: string, phase: ProviderInstallState["phase"]) => ({
  ...state,
  operationId,
  phase,
  installedVersion: phase === "succeeded" ? "1.5.8" : null,
});

describe("provider installation routing", () => {
  it.effect.each([
    { phase: "succeeded", enabled: true, checkFails: false, expectedChecks: 1 },
    { phase: "succeeded", enabled: true, checkFails: true, expectedChecks: 1 },
    { phase: "succeeded", enabled: false, checkFails: false, expectedChecks: 0 },
    { phase: "cancelled", enabled: true, checkFails: false, expectedChecks: 0 },
    { phase: "failed", enabled: true, checkFails: false, expectedChecks: 0 },
  ] as const)(
    "checks account access once after an installation is $phase, enabled=$enabled, checkFails=$checkFails",
    ({ phase, enabled, checkFails, expectedChecks }) =>
      Effect.gen(function* () {
        let checks = 0;
        // No client starts this install: the provider update flow runs the installer itself.
        const harness = yield* makeHarness({
          installStates: [
            installed("install-1", "downloading"),
            installed("install-1", phase),
            { ...installed("install-1", phase), version: "1.5.8" },
          ],
          instance: Object.assign(instance(), {
            enabled,
            refreshModels: () =>
              Effect.sync(() => {
                checks++;
              }).pipe(
                Effect.andThen(
                  checkFails
                    ? Effect.fail(
                        new ProviderDriverError({
                          driver,
                          instanceId,
                          detail: "Sign in required.",
                        }),
                      )
                    : Effect.void,
                ),
              ),
          }),
        });
        yield* Deferred.await(harness.observed);
        assert.strictEqual(checks, expectedChecks);
        assert.deepEqual(harness.calls, expectedChecks > 0 ? ["refresh"] : []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("checks every enabled instance on the managed runtime after each install", () =>
    Effect.gen(function* () {
      const checked: string[] = [];
      const managed = (id: string, enabled: boolean) =>
        Object.assign(instance(driver, ProviderInstanceId.make(id)), {
          enabled,
          refreshModels: () =>
            Effect.sync(() => {
              checked.push(id);
            }),
        });
      const work = managed("antigravity_work", true);
      const personal = managed("antigravity_personal", true);
      const harness = yield* makeHarness({
        installStates: [installed("install-1", "succeeded"), installed("install-2", "succeeded")],
        // The disabled default instance is listed first, as server.getConfig lists it.
        instance: managed("antigravity", false),
        others: [managed("antigravity_custom", true), work, personal],
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("antigravity_custom")]: {
              driver,
              config: { binaryPath: "/external/agy" },
            },
          },
        },
      });
      yield* Deferred.await(harness.observed);
      const eachInstall = [work.instanceId, personal.instanceId];
      assert.deepEqual(checked, [...eachInstall, ...eachInstall]);
      assert.deepEqual(harness.refreshedInstances, [...eachInstall, ...eachInstall]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps external installs manual without hiding shared install status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("antigravity")]: {
              driver: ProviderDriverKind.make("antigravity"),
              config: { binaryPath: "/external/agy" },
            },
          },
        },
      });
      const start = yield* Effect.flip(harness.router.start({ instanceId }));
      const remove = yield* Effect.flip(harness.router.remove({ instanceId }));
      assert.include(start.detail, "custom executable");
      assert.include(remove.detail, "custom executable");
      const observed = yield* Stream.runCollect(harness.router.subscribe({ instanceId }));
      assert.deepEqual(Array.from(observed), [state]);
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("protects another instance's binary found through its own PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-install-route-" });
      const binary = platform === "win32" ? "agy-test.exe" : "agy-test";
      const executable = path.join(directory, binary);
      yield* fs.writeFileString(executable, "test");
      yield* fs.chmod(executable, 0o755);
      const other = ProviderInstanceId.make("antigravity-work");
      const harness = yield* makeHarness({
        settings: {
          providerInstances: {
            [other]: {
              driver,
              config: { binaryPath: binary },
              environment: [{ name: "PATH", value: directory, sensitive: false }],
            },
          },
        },
      });
      yield* harness.router.remove({ instanceId });
      assert.include(harness.protectedPaths(), executable);
      assert.deepEqual(harness.calls, ["remove", "refresh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
