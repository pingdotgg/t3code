import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vitest";

const { onMock, removeListenerMock, themeState } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn(),
  themeState: {
    shouldUseDarkColors: true,
    themeSource: "system",
  },
}));

vi.mock("electron", () => ({
  nativeTheme: {
    get shouldUseDarkColors() {
      return themeState.shouldUseDarkColors;
    },
    set themeSource(value: string) {
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
});
