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
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
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
    beforeInstallStart?: Effect.Effect<void>;
    instance?: ProviderInstance;
    others?: ReadonlyArray<ProviderInstance>;
    settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) {
  const calls: string[] = [];
  const refreshed = yield* Deferred.make<void>();
  const lastRefreshes = yield* Queue.unbounded<void>();
  const observed = yield* Deferred.make<void>();
  const listening = yield* Deferred.make<void>();
  const installationState = yield* SubscriptionRef.make(state);
  let protectedPaths: ReadonlyArray<string> = [];
  const configured = input.instance ?? instance();
  const all = [configured, ...(input.others ?? [])];
  const refreshedInstances: ProviderInstanceId[] = [];
  let watches = 0;
  const startOperation = Effect.gen(function* () {
    calls.push("start");
    yield* input.beforeInstallStart ?? Effect.void;
    const current = yield* SubscriptionRef.get(installationState);
    if (current.phase === "downloading") return { state: current, owned: false };
    const started = {
      ...state,
      operationId: "install-1",
      phase: "downloading",
      message: "Downloading.",
    } satisfies ProviderInstallState;
    yield* SubscriptionRef.set(installationState, started);
    return { state: started, owned: true };
  });
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
        }).pipe(
          Effect.tap(() => Deferred.succeed(refreshed, undefined)),
          Effect.tap(() =>
            id === all.at(-1)?.instanceId ? Queue.offer(lastRefreshes, undefined) : Effect.void,
          ),
        ),
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
        return {
          ...state,
          operationId: "install-1",
          phase: "downloading" as const,
          message: "Downloading.",
        };
      }).pipe(Effect.tap((started) => SubscriptionRef.set(installationState, started))),
      startOperation: () => startOperation,
      cancel: () =>
        Effect.sync(() => {
          calls.push("cancel");
          return state;
        }),
      state: SubscriptionRef.get(installationState),
      changes: all.some((entry) => entry.refreshModels)
        ? SubscriptionRef.changes(installationState).pipe(
            Stream.onStart(
              Effect.sync(() => {
                watches++;
              }),
            ),
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
    lastRefreshes,
    watches: () => watches,
    observed,
    installationState,
    refreshedInstances,
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

  it.effect(
    "checks every enabled instance on the managed runtime once, whichever instance started the install",
    () =>
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
        yield* Effect.gen(function* () {
          const first = yield* harness.connect;
          const second = yield* harness.connect;
          yield* Effect.all(
            [first.start({ instanceId }), second.start({ instanceId: personal.instanceId })],
            { concurrency: "unbounded" },
          );
          yield* Deferred.await(harness.listening);
        }).pipe(Effect.scoped);
        yield* SubscriptionRef.set(harness.installationState, {
          ...state,
          operationId: "install-1",
          phase: "succeeded",
          installedVersion: "1.5.8",
        });
        yield* Deferred.await(harness.observed);
        // Instances refresh in list order, so the last one's refresh ends a watch's pass.
        yield* Queue.take(harness.lastRefreshes);
        assert.deepEqual(checked, [work.instanceId, personal.instanceId]);
        // Let every other watch of this install finish its pass; none may refresh again.
        yield* Queue.takeN(harness.lastRefreshes, harness.watches() - 1);
        assert.deepEqual(checked, [work.instanceId, personal.instanceId]);
        assert.deepEqual(harness.refreshedInstances, [work.instanceId, personal.instanceId]);
        assert.strictEqual(harness.watches(), 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const watched = () => Object.assign(instance(), { refreshModels: () => Effect.void });
  const running = {
    ...state,
    operationId: "install-1",
    phase: "downloading",
    message: "Downloading.",
  } satisfies ProviderInstallState;

  it.effect.each([
    { phase: "succeeded", message: null, error: null },
    {
      phase: "failed",
      message: "Could not download Antigravity from Google.",
      error: "Could not download Antigravity from Google.",
    },
    { phase: "cancelled", message: null, error: "The installation did not finish." },
  ] as const)("runs an install until it is $phase", ({ phase, message, error }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ instance: watched() });
      const progress: string[] = [];
      const reported = yield* Deferred.make<void>();
      const run = yield* harness.router
        .run({ instanceId }, (line) =>
          Effect.sync(() => progress.push(line)).pipe(
            Effect.andThen(Deferred.succeed(reported, undefined)),
          ),
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(reported);
      // Download progress keeps the message, so it is reported once.
      yield* SubscriptionRef.set(harness.installationState, { ...running, downloadedBytes: 1 });
      yield* SubscriptionRef.set(harness.installationState, { ...running, phase, message });
      const result = yield* Fiber.join(run);
      assert.deepEqual(progress, ["Downloading."]);
      assert.strictEqual(result._tag === "Failure" ? result.failure.detail : null, error);
      assert.deepEqual(harness.calls, ["start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { name: "cancels the install it started", joined: false, calls: ["start", "cancel"] },
    { name: "leaves an install it joined running", joined: true, calls: ["start"] },
  ])("an interrupted run $name", ({ joined, calls }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ instance: watched() });
      if (joined) yield* SubscriptionRef.set(harness.installationState, running);
      const reported = yield* Deferred.make<void>();
      const run = yield* harness.router
        .run({ instanceId }, () => Deferred.succeed(reported, undefined))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reported);
      yield* Fiber.interrupt(run);
      assert.deepEqual(harness.calls, calls);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a setup install running when it starts during the update's lookup", () =>
    Effect.gen(function* () {
      const lookingUp = yield* Deferred.make<void>();
      const resumeLookup = yield* Deferred.make<void>();
      const reported = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        instance: watched(),
        beforeInstallStart: Deferred.succeed(lookingUp, undefined).pipe(
          Effect.andThen(Deferred.await(resumeLookup)),
        ),
      });
      const run = yield* harness.router
        .run({ instanceId }, () => Deferred.succeed(reported, undefined))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lookingUp);
      yield* SubscriptionRef.set(harness.installationState, running);
      yield* Deferred.succeed(resumeLookup, undefined);
      yield* Deferred.await(reported);
      yield* Fiber.interrupt(run);
      assert.deepEqual(harness.calls, ["start"]);
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
