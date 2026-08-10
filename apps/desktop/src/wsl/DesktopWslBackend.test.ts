import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslDiagnostics from "./DesktopWslDiagnostics.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";

function makeStubInstance(input: {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly label: string;
  readonly snapshot: DesktopBackendSnapshot;
  readonly start?: Effect.Effect<void>;
}): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: input.id,
    label: Effect.succeed(input.label),
    start: input.start ?? Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
    probeReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

const idleSnapshot: DesktopBackendSnapshot = {
  desiredRunning: false,
  ready: false,
  activePid: Option.none(),
  restartAttempt: 5,
  restartScheduled: false,
};

const primarySnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
};

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

describe("DesktopWslBackend", () => {
  it.effect("clears the stored preflight error when a registered WSL backend becomes ready", () => {
    let registeredSpec: DesktopBackendPool.BackendInstanceSpec | undefined;
    let resolveWslInput:
      | {
          readonly port: number;
          readonly distro: string | null;
          readonly portStrategy?: DesktopBackendConfiguration.WslBackendPortStrategy;
        }
      | undefined;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wsl = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: primarySnapshot,
    });
    const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.succeed([primary]),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          registeredSpec = spec;
          return wsl;
        }),
      unregister: () => Effect.die("unexpected unregister"),
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);
    const configurationLayer = Layer.succeed(
      DesktopBackendConfiguration.DesktopBackendConfiguration,
      {
        resolvePrimary: Effect.die("unexpected resolvePrimary"),
        resolvePrimaryLabel: Effect.succeed("Windows"),
        resolveWsl: (input) => {
          resolveWslInput = input;
          return Effect.die("configResolve should remain lazy during registration");
        },
      } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
    );

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      assert.deepEqual(resolveWslInput, {
        port: 3774,
        distro: "Ubuntu",
        portStrategy: "wsl-auto",
      });
      const spec = registeredSpec;
      assert.isDefined(spec);
      if (spec === undefined) {
        throw new Error("Expected WSL backend registration");
      }
      const recordFailure = spec.onPreflightFailed;
      const clearFailure = spec.onReady;
      assert.isDefined(recordFailure);
      assert.isDefined(clearFailure);
      if (recordFailure === undefined || clearFailure === undefined) {
        throw new Error("Expected WSL backend callbacks");
      }

      assert.isFalse(yield* recordFailure({ reason: "Node.js not found", fatal: true }));
      assert.deepEqual(yield* backend.lastPreflightError, Option.some("Node.js not found"));

      yield* clearFailure(new URL("http://127.0.0.1:41773"));
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(configurationLayer),
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
          Layer.provideMerge(DesktopWslDiagnostics.layer),
        ),
      ),
    );
  });

  it.effect("retries an unchanged WSL instance when it is idle after failed preflight", () => {
    let startCount = 0;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wsl = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: idleSnapshot,
      start: Effect.sync(() => {
        startCount += 1;
      }),
    });

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;

      assert.equal(startCount, 1);
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layer.pipe(
          Layer.provideMerge(DesktopBackendPool.layerTest([primary, wsl])),
          Layer.provideMerge(backendConfigurationLayer),
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
          Layer.provideMerge(DesktopWslDiagnostics.layer),
        ),
      ),
    );
  });
});
