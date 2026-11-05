import { assert, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopLoginItem from "../app/DesktopLoginItem.ts";
import * as DesktopTray from "../app/DesktopTray.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopClientPreferences from "./DesktopClientPreferences.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

function setup(initial: ClientSettings = DEFAULT_CLIENT_SETTINGS) {
  const state = {
    saved: Option.some(initial),
    loginEnabled: initial.openAtLogin,
    trayEnabled: initial.keepRunningInBackground,
    loginWrites: [] as boolean[],
    storageWrites: 0,
    snapShots: [] as ClientSettings[],
    failure: null as "login" | "tray" | "storage" | null,
    beforeSave: Effect.void as Effect.Effect<void>,
  };
  const layer = DesktopClientPreferences.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.sync(() => state.saved),
          set: (settings) =>
            Effect.gen(function* () {
              yield* state.beforeSave;
              if (state.failure === "storage") {
                state.failure = null;
                return yield* new DesktopClientSettings.DesktopClientSettingsWriteError({
                  operation: "replace-settings-file",
                  path: "/test/client-settings.json",
                  cause: new Error("Read-only settings file"),
                });
              }
              state.saved = Option.some(settings);
              state.storageWrites += 1;
            }),
        }),
        Layer.mock(DesktopLoginItem.DesktopLoginItem, {
          supported: true,
          getEnabled: Effect.sync(() => state.loginEnabled),
          configure: (enabled) =>
            Effect.gen(function* () {
              state.loginWrites.push(enabled);
              state.loginEnabled = enabled;
              if (state.failure === "login") {
                state.failure = null;
                return yield* new DesktopLoginItem.DesktopLoginItemError({
                  reason: "Login registration was rejected",
                });
              }
            }),
        }),
        Layer.mock(DesktopTray.DesktopTray, {
          configure: (enabled) =>
            Effect.gen(function* () {
              state.trayEnabled = enabled;
              if (state.failure === "tray") {
                state.failure = null;
                return yield* new DesktopTray.DesktopTrayError({
                  cause: new Error("Tray unavailable"),
                });
              }
            }),
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot, {
          configure: (settings) =>
            Effect.sync(() => {
              assert.deepEqual(state.saved, Option.some(settings));
              state.snapShots.push(settings);
            }),
        }),
      ),
    ),
  );
  return { state, layer };
}

it.effect.each([false, true])(
  "reconciles external login state %s without registering it again on an unrelated edit",
  (enabled) => {
    const { state, layer } = setup({ ...DEFAULT_CLIENT_SETTINGS, openAtLogin: !enabled });
    state.loginEnabled = enabled;
    return Effect.gen(function* () {
      const preferences = yield* DesktopClientPreferences.DesktopClientPreferences;
      const reconciled = Option.getOrThrow(yield* preferences.get);
      assert.equal(reconciled.openAtLogin, enabled);
      assert.deepEqual(state.saved, Option.some(reconciled));
      assert.deepEqual(state.loginWrites, []);
      assert.deepEqual(state.snapShots, []);

      const edited = { ...reconciled, wordWrap: !reconciled.wordWrap };
      yield* preferences.set(edited);
      assert.deepEqual(state.saved, Option.some(edited));
      assert.equal(state.loginEnabled, enabled);
      assert.deepEqual(state.loginWrites, []);
      assert.deepEqual(state.snapShots, [edited]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("enables and disables login explicitly while retaining other preferences", () => {
  const { state, layer } = setup();
  return Effect.gen(function* () {
    const preferences = yield* DesktopClientPreferences.DesktopClientPreferences;
    const enabled = {
      ...DEFAULT_CLIENT_SETTINGS,
      openAtLogin: true,
      keepRunningInBackground: true,
      wordWrap: !DEFAULT_CLIENT_SETTINGS.wordWrap,
    };
    yield* preferences.set(enabled);
    assert.isTrue(state.loginEnabled);
    assert.isTrue(state.trayEnabled);
    assert.deepEqual(yield* preferences.get, Option.some(enabled));

    const disabled = { ...enabled, openAtLogin: false };
    yield* preferences.set(disabled);
    assert.isFalse(state.loginEnabled);
    assert.isTrue(state.trayEnabled);
    assert.deepEqual(yield* preferences.get, Option.some(disabled));
    assert.deepEqual(state.loginWrites, [true, false]);
    assert.deepEqual(state.snapShots, [enabled, disabled]);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { failure: "login", initiallyEnabled: false, nativeEnabled: false },
  { failure: "login", initiallyEnabled: true, nativeEnabled: true },
  { failure: "tray", initiallyEnabled: false, nativeEnabled: false },
  { failure: "tray", initiallyEnabled: true, nativeEnabled: true },
  { failure: "storage", initiallyEnabled: false, nativeEnabled: false },
  { failure: "storage", initiallyEnabled: true, nativeEnabled: true },
  { failure: "login", initiallyEnabled: true, nativeEnabled: false },
  { failure: "tray", initiallyEnabled: true, nativeEnabled: false },
  { failure: "storage", initiallyEnabled: true, nativeEnabled: false },
] as const)(
  "restores state after $failure fails with saved login $initiallyEnabled and native login $nativeEnabled",
  ({ failure, initiallyEnabled, nativeEnabled }) => {
    const initial = {
      ...DEFAULT_CLIENT_SETTINGS,
      openAtLogin: initiallyEnabled,
      keepRunningInBackground: initiallyEnabled,
    };
    const { state, layer } = setup(initial);
    state.loginEnabled = nativeEnabled;
    state.failure = failure;
    return Effect.gen(function* () {
      const preferences = yield* DesktopClientPreferences.DesktopClientPreferences;
      const error = yield* preferences
        .set({
          ...initial,
          openAtLogin: !initiallyEnabled,
          keepRunningInBackground: !initiallyEnabled,
        })
        .pipe(Effect.flip);
      assert.equal(
        error._tag,
        failure === "login"
          ? "DesktopLoginItemError"
          : failure === "tray"
            ? "DesktopTrayError"
            : "DesktopClientSettingsWriteError",
      );
      assert.equal(state.loginEnabled, nativeEnabled);
      assert.equal(state.trayEnabled, initiallyEnabled);
      assert.deepEqual(state.saved, Option.some(initial));
      assert.deepEqual(state.snapShots, []);
      if (failure === "tray") assert.deepEqual(state.loginWrites, []);

      const reconciled = Option.getOrThrow(yield* preferences.get);
      const edited = { ...reconciled, wordWrap: !reconciled.wordWrap };
      const registrationCount = state.loginWrites.length;
      yield* preferences.set(edited);
      assert.deepEqual(state.saved, Option.some(edited));
      assert.equal(state.loginEnabled, nativeEnabled);
      assert.equal(state.trayEnabled, initiallyEnabled);
      assert.equal(state.loginWrites.length, registrationCount);
      assert.deepEqual(state.snapShots, [edited]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "reads wait for an in-flight save instead of reconciling partially applied native state",
  () => {
    const { state, layer } = setup();
    return Effect.gen(function* () {
      const preferences = yield* DesktopClientPreferences.DesktopClientPreferences;
      const saving = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      let firstSave = true;
      state.beforeSave = Effect.gen(function* () {
        if (!firstSave) return;
        firstSave = false;
        yield* Deferred.succeed(saving, undefined);
        yield* Deferred.await(releaseSave);
      });
      const edited = {
        ...DEFAULT_CLIENT_SETTINGS,
        openAtLogin: true,
        wordWrap: !DEFAULT_CLIENT_SETTINGS.wordWrap,
      };
      const write = yield* Effect.forkChild(preferences.set(edited));
      yield* Deferred.await(saving);
      const read = yield* Effect.forkChild(preferences.get, { startImmediately: true });
      yield* Deferred.succeed(releaseSave, undefined);
      yield* Fiber.join(write);
      assert.deepEqual(yield* Fiber.join(read), Option.some(edited));
      assert.deepEqual(state.saved, Option.some(edited));
      assert.equal(state.storageWrites, 1);
      assert.deepEqual(state.snapShots, [edited]);
    }).pipe(Effect.provide(layer));
  },
);
