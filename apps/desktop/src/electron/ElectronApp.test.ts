import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { getSystemLocaleMock } = vi.hoisted(() => ({
  getSystemLocaleMock: vi.fn(() => "en-GB"),
}));

vi.mock("electron", () => ({
  app: {
    getSystemLocale: getSystemLocaleMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

describe("ElectronApp", () => {
  it.effect("normalizes POSIX-style locale identifiers that Intl rejects", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "en_GB");
      const electronApp = yield* ElectronApp.ElectronApp;

      assert.strictEqual(yield* electronApp.systemLocale, "en-GB");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
