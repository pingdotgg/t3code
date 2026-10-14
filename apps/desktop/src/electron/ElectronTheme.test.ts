import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { beforeEach, vi } from "vite-plus/test";

const {
  onMock,
  removeListenerMock,
  accentOnMock,
  accentRemoveListenerMock,
  subscribeMock,
  unsubscribeMock,
  themeState,
} = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  accentOnMock: vi.fn(),
  accentRemoveListenerMock: vi.fn(),
  subscribeMock: vi.fn(),
  unsubscribeMock: vi.fn(),
  themeState: {
    shouldUseDarkColors: true,
    themeSource: "system",
    setSourceError: null as unknown,
    accent: "aabbccff",
    accentError: null as unknown,
  },
}));

vi.mock("electron", () => ({
  systemPreferences: {
    getAccentColor: () => {
      if (themeState.accentError !== null) throw themeState.accentError;
      return themeState.accent;
    },
    on: accentOnMock,
    removeListener: accentRemoveListenerMock,
    subscribeNotification: subscribeMock,
    unsubscribeNotification: unsubscribeMock,
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return themeState.shouldUseDarkColors;
    },
    set themeSource(value: string) {
      if (themeState.setSourceError !== null) {
        throw themeState.setSourceError;
      }
      themeState.themeSource = value;
    },
    on: onMock,
    removeListener: removeListenerMock,
  },
}));

import * as ElectronTheme from "./ElectronTheme.ts";

describe("ElectronTheme", () => {
  beforeEach(() => {
    onMock.mockClear();
    removeListenerMock.mockClear();
    accentOnMock.mockClear();
    accentRemoveListenerMock.mockClear();
    subscribeMock.mockReset();
    unsubscribeMock.mockClear();
    themeState.shouldUseDarkColors = true;
    themeState.themeSource = "system";
    themeState.setSourceError = null;
    themeState.accent = "aabbccff";
    themeState.accentError = null;
  });

  it.effect("scopes native theme update listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronTheme = yield* ElectronTheme.ElectronTheme;
          yield* electronTheme.onUpdated(listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["updated", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["updated", listener]]);
      assert.deepEqual(accentOnMock.mock.calls, [["accent-color-changed", listener]]);
      assert.deepEqual(accentRemoveListenerMock.mock.calls, [["accent-color-changed", listener]]);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("reads native appearance and normalizes the system RGBA accent", () =>
    Effect.gen(function* () {
      const electronTheme = yield* ElectronTheme.ElectronTheme;
      themeState.accent = "12AbCDef";
      assert.deepEqual(yield* electronTheme.systemTheme, { appearance: "dark", accent: "#12abcd" });
      themeState.shouldUseDarkColors = false;
      assert.deepEqual(yield* electronTheme.systemTheme, {
        appearance: "light",
        accent: "#12abcd",
      });
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("keeps native appearance when the desktop exposes no usable accent", () =>
    Effect.gen(function* () {
      const electronTheme = yield* ElectronTheme.ElectronTheme;
      themeState.accentError = new Error("not supported");
      assert.deepEqual(yield* electronTheme.systemTheme, { appearance: "dark", accent: null });
      themeState.accentError = null;
      themeState.accent = "not a color";
      assert.deepEqual(yield* electronTheme.systemTheme, { appearance: "dark", accent: null });
      themeState.accent = "ffffff00";
      assert.deepEqual(yield* electronTheme.systemTheme, { appearance: "dark", accent: null });
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("observes macOS accent notifications and unsubscribes when its scope closes", () =>
    Effect.gen(function* () {
      const listener = vi.fn();
      subscribeMock.mockReturnValueOnce(101).mockReturnValueOnce(102);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* ElectronTheme.ElectronTheme).onUpdated(listener);
          assert.deepEqual(
            subscribeMock.mock.calls.map(([name]) => name),
            ["AppleColorPreferencesChangedNotification", "AppleAquaColorVariantChanged"],
          );
          subscribeMock.mock.calls[0]![1]();
          assert.strictEqual(listener.mock.calls.length, 1);
        }),
      );
      assert.deepEqual(unsubscribeMock.mock.calls, [[101], [102]]);
    }).pipe(
      Effect.provide(ElectronTheme.layer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );

  it.effect("preserves the requested source and cause when setting the theme fails", () =>
    Effect.gen(function* () {
      const cause = new Error("theme source failed");
      themeState.setSourceError = cause;
      const electronTheme = yield* ElectronTheme.ElectronTheme;

      const error = yield* Effect.flip(electronTheme.setSource("dark"));

      assert.instanceOf(error, ElectronTheme.ElectronThemeSetSourceError);
      assert.strictEqual(error.source, "dark");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "dark");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );
});
