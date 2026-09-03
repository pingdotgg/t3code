import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { layerTest as settingsLayerTest } from "../serverSettings.ts";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { makeProviderInstallation } from "./providerInstallation.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

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

function instance(kind = driver): ProviderInstance {
  return {
    instanceId,
    driverKind: kind,
    enabled: false,
    displayName: undefined,
    continuationIdentity: { driverKind: kind, continuationKey: instanceId },
    get adapter(): never {
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
    settings?: Parameters<typeof settingsLayerTest>[0];
  } = {},
) {
  const calls: string[] = [];
  let protectedPaths: ReadonlyArray<string> = [];
  const configured = input.instance ?? instance();
  const router = yield* makeProviderInstallation().pipe(
    Effect.provide(
      Layer.mergeAll(
        settingsLayerTest(input.settings),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(id === configured.instanceId ? configured : undefined),
          listInstances: Effect.succeed([configured]),
        }),
        Layer.mock(ProviderRegistry)({
          refreshInstance: () =>
            Effect.sync(() => {
              calls.push("refresh");
              return [];
            }),
        }),
        Layer.mock(AntigravityInstallation)({
          managedDirectory: "/unused-managed-runtime",
          start: Effect.sync(() => {
            calls.push("start");
            return state;
          }),
          cancel: () =>
            Effect.sync(() => {
              calls.push("cancel");
              return state;
            }),
          state: Effect.succeed(state),
          changes: Stream.succeed(state),
          remove: (paths) =>
            Effect.sync(() => {
              protectedPaths = paths ?? [];
              calls.push("remove");
            }),
        }),
      ),
    ),
  );
  return { router, calls, protectedPaths: () => protectedPaths };
});

describe("provider installation routing", () => {
  it.effect("allows explicit installation while the provider is disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.router.start({ instanceId });
      assert.deepEqual(harness.calls, ["start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects another driver and unknown instances before installation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ instance: instance(ProviderDriverKind.make("codex")) });
      const wrongDriver = yield* Effect.flip(harness.router.start({ instanceId }));
      const missing = yield* Effect.flip(
        harness.router.start({ instanceId: ProviderInstanceId.make("missing") }),
      );
      assert.equal(wrongDriver._tag, "ProviderSetupError");
      assert.equal(missing._tag, "ProviderSetupError");
      assert.deepEqual(harness.calls, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps external installs manual without hiding shared install status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        settings: { providers: { antigravity: { binaryPath: "/external/agy" } } },
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
      const platform = yield* HostProcessPlatform;
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
