import { DesktopWslStateSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { setWslBackendEnabled, setWslDistro, setWslOnly } from "./wsl.ts";

const decodeWslState = Schema.decodeUnknownEffect(DesktopWslStateSchema);

const invokeSetWslBackendEnabled = (enabled: boolean) =>
  setWslBackendEnabled.handler(enabled).pipe(Effect.flatMap(decodeWslState));
const invokeSetWslDistro = (distro: string | null) =>
  setWslDistro.handler(distro).pipe(Effect.flatMap(decodeWslState));
const invokeSetWslOnly = (enabled: boolean) =>
  setWslOnly.handler(enabled).pipe(Effect.flatMap(decodeWslState));

function makeWslBackendLayer(input: { readonly onReconcile?: Effect.Effect<void> } = {}) {
  return Layer.succeed(
    DesktopWslBackend.DesktopWslBackend,
    DesktopWslBackend.DesktopWslBackend.of({
      reconcile: input.onReconcile ?? Effect.void,
      lastPreflightError: Effect.succeed(Option.none()),
    }),
  );
}

function makeLifecycleLayer(relaunchReasons: Array<string>) {
  return Layer.succeed(
    DesktopLifecycle.DesktopLifecycle,
    DesktopLifecycle.DesktopLifecycle.of({
      relaunch: (reason) =>
        Effect.sync(() => {
          relaunchReasons.push(reason);
        }),
      register: Effect.void,
    }),
  );
}

const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of(
      {} as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
  ),
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

describe("WSL IPC", () => {
  it.effect("stages dual-backend preferences before enabling without relaunching", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: false,
        wslOnly: true,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer(),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      yield* invokeSetWslOnly(false);
      yield* invokeSetWslDistro("Debian");
      const state = yield* invokeSetWslBackendEnabled(true);

      assert.deepEqual(state, {
        enabled: true,
        distro: "Debian",
        available: true,
        wslOnly: false,
        distros: [],
        preflightError: null,
      });
      assert.deepEqual(relaunchReasons, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stages WSL-only preferences and relaunches only after enabling", () => {
    const relaunchReasons: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: false,
        wslOnly: false,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer(),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const stagedMode = yield* invokeSetWslOnly(true);
      assert.equal(stagedMode.enabled, false);
      assert.equal(stagedMode.wslOnly, true);
      assert.deepEqual(relaunchReasons, []);

      yield* invokeSetWslDistro("Debian");
      assert.deepEqual(relaunchReasons, []);

      const state = yield* invokeSetWslBackendEnabled(true);
      assert.deepEqual(state, {
        enabled: true,
        distro: "Debian",
        available: true,
        wslOnly: true,
        distros: [],
        preflightError: null,
      });
      assert.deepEqual(relaunchReasons, ["wslBackendEnabled=true"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunches when enabling the WSL backend while wsl-only is already persisted", () => {
    const relaunchReasons: Array<string> = [];
    let reconcileCount = 0;
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: false,
        wslOnly: true,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer({
        onReconcile: Effect.sync(() => {
          reconcileCount += 1;
        }),
      }),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetWslBackendEnabled(true);

      assert.deepEqual(state, {
        enabled: true,
        distro: null,
        available: true,
        wslOnly: true,
        distros: [],
        preflightError: null,
      });
      assert.equal(reconcileCount, 0);
      assert.deepEqual(relaunchReasons, ["wslBackendEnabled=true"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reconciles in dual-backend mode without relaunching", () => {
    const relaunchReasons: Array<string> = [];
    let reconcileCount = 0;
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: false,
        wslOnly: false,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer({
        onReconcile: Effect.sync(() => {
          reconcileCount += 1;
        }),
      }),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetWslBackendEnabled(true);

      assert.equal(state.enabled, true);
      assert.equal(state.wslOnly, false);
      assert.equal(reconcileCount, 1);
      assert.deepEqual(relaunchReasons, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("clears wsl-only before relaunching when disabling a WSL-only backend", () => {
    const relaunchReasons: Array<string> = [];
    let reconcileCount = 0;
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
        wslOnly: true,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer({
        onReconcile: Effect.sync(() => {
          reconcileCount += 1;
        }),
      }),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetWslBackendEnabled(false);
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      const settings = yield* appSettings.get;

      assert.deepEqual(state, {
        enabled: false,
        distro: null,
        available: true,
        wslOnly: false,
        distros: [],
        preflightError: null,
      });
      assert.equal(settings.wslBackendEnabled, false);
      assert.equal(settings.wslOnly, false);
      assert.equal(reconcileCount, 0);
      assert.deepEqual(relaunchReasons, ["wslBackendEnabled=false"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("clears dual-backend WSL without relaunching", () => {
    const relaunchReasons: Array<string> = [];
    let reconcileCount = 0;
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        wslBackendEnabled: true,
        wslOnly: false,
      }),
      DesktopWslEnvironment.layerTest({ isAvailable: true }),
      makeWslBackendLayer({
        onReconcile: Effect.sync(() => {
          reconcileCount += 1;
        }),
      }),
      makeLifecycleLayer(relaunchReasons),
      unusedLifecycleRuntimeLayer,
    );

    return Effect.gen(function* () {
      const state = yield* invokeSetWslBackendEnabled(false);

      assert.equal(state.enabled, false);
      assert.equal(state.wslOnly, false);
      assert.equal(reconcileCount, 1);
      assert.deepEqual(relaunchReasons, []);
    }).pipe(Effect.provide(layer));
  });
});
