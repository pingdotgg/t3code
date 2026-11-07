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
import * as SubscriptionRef from "effect/SubscriptionRef";
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
    settings?: Parameters<typeof ServerSettings.layerTest>[0];
    managedPolicy?: Parameters<typeof ServerSettings.layerTest>[1];
  } = {},
) {
  const calls: string[] = [];
  const refreshed = yield* Deferred.make<void>();
  const observed = yield* Deferred.make<void>();
  const listening = yield* Deferred.make<void>();
  const installationState = yield* SubscriptionRef.make(state);
  let protectedPaths: ReadonlyArray<string> = [];
  const configured = input.instance ?? instance();
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest(input.settings, input.managedPolicy),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.succeed(id === configured.instanceId ? configured : undefined),
      listInstances: Effect.succeed([configured]),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshInstance: () =>
        Effect.sync(() => {
          calls.push("refresh");
          return [];
        }).pipe(Effect.tap(() => Deferred.succeed(refreshed, undefined))),
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
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("codex-remove");
        }),
    }),
    Layer.mock(AntigravityInstallation.AntigravityInstallation)({
      managedDirectory: "/unused-managed-runtime",
      start: Effect.sync(() => {
        calls.push("start");
        return { ...state, operationId: "install-1", phase: "downloading" as const };
      }).pipe(Effect.tap((started) => SubscriptionRef.set(installationState, started))),
      cancel: () =>
        Effect.sync(() => {
          calls.push("cancel");
          return state;
        }),
      state: Effect.succeed(state),
      changes: input.instance?.refreshModels
        ? SubscriptionRef.changes(installationState).pipe(
            Stream.tap(() => Deferred.succeed(listening, undefined)),
            Stream.ensuring(Deferred.succeed(observed, undefined)),
          )
        : Stream.succeed(state),
      remove: (paths) =>
        Effect.sync(() => {
          protectedPaths = paths ?? [];
          calls.push("remove");
        }),
    }),
  );
  const context = yield* Layer.build(ProviderInstallation.layer.pipe(Layer.provide(dependencies)));
  const connect = Effect.service(ProviderInstallation.ProviderInstallation).pipe(
    Effect.provide(context),
  );
  const router = yield* connect;
  return {
    router,
    connect,
    listening,
    calls,
    refreshed,
    observed,
    installationState,
    protectedPaths: () => protectedPaths,
  };
});

describe("provider installation routing", () => {
  it.effect.each([
    { phase: "succeeded", enabled: true, checkFails: false, expectedChecks: 1 },
    { phase: "succeeded", enabled: true, checkFails: true, expectedChecks: 1 },
    { phase: "succeeded", enabled: false, checkFails: false, expectedChecks: 0 },
    { phase: "cancelled", enabled: true, checkFails: false, expectedChecks: 0 },
    { phase: "failed", enabled: true, checkFails: false, expectedChecks: 0 },
  ] as const)(
    "checks account access once after installation is $phase, enabled=$enabled, checkFails=$checkFails",
    ({ phase, enabled, checkFails, expectedChecks }) =>
      Effect.gen(function* () {
        let checks = 0;
        const harness = yield* makeHarness({
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
        yield* Effect.gen(function* () {
          const first = yield* harness.connect;
          const second = yield* harness.connect;
          yield* Effect.all([first.start({ instanceId }), second.start({ instanceId })], {
            concurrency: "unbounded",
          });
          yield* Deferred.await(harness.listening);
        }).pipe(Effect.scoped);
        assert.isFalse(yield* Deferred.isDone(harness.observed));
        assert.strictEqual(checks, 0);
        yield* SubscriptionRef.set(harness.installationState, {
          ...state,
          operationId: "install-1",
          phase,
          installedVersion: phase === "succeeded" ? "1.5.1" : null,
        });
        yield* Deferred.await(harness.observed);
        if (expectedChecks > 0) yield* Deferred.await(harness.refreshed);
        assert.strictEqual(checks, expectedChecks);
        assert.deepEqual(
          harness.calls,
          expectedChecks > 0 ? ["start", "start", "refresh"] : ["start", "start"],
        );
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

  it.effect("refuses to install under policy but still lets users remove", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        managedPolicy: {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { providers: { installs: false } },
        },
      });
      const start = yield* Effect.flip(harness.router.start({ instanceId }));
      assert.strictEqual(
        start.detail,
        "Example Corp's policy does not allow installing or updating providers.",
      );
      assert.deepEqual(harness.calls, []);

      yield* harness.router.remove({ instanceId });
      assert.include(harness.calls, "remove");
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
