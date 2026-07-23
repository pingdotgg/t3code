import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { onMock, removeListenerMock, themeState } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  themeState: {
    shouldUseDarkColors: true,
    themeSource: "system",
    setSourceError: null as unknown,
  },
}));

vi.mock("electron", () => ({
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
    themeState.shouldUseDarkColors = true;
    themeState.themeSource = "system";
    themeState.setSourceError = null;
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
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );

  it.effect("preserves the requested source and cause when setting the theme fails", () =>
    Effect.gen(function* () {
      const cause = new Error("theme source failed");
      themeState.setSourceError = cause;
      const electronTheme = yield* ElectronTheme.ElectronTheme;

      const error = yield* Effect.flip(electronTheme.setSource("dark"));

      assert.instanceOf(error, ElectronTheme.ElectronThemeSetSourceError);
      assert.isTrue(ElectronTheme.isElectronThemeSetSourceError(error));
      assert.strictEqual(error.source, "dark");
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "dark");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronTheme.layer)),
  );
});
