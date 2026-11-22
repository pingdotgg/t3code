import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as ElectronTypes from "electron";
import { vi } from "vite-plus/test";

const { showMessageBoxMock } = vi.hoisted(() => ({ showMessageBoxMock: vi.fn() }));

vi.mock("electron", () => ({
  dialog: { showMessageBox: showMessageBoxMock },
}));

import * as ElectronDialog from "./ElectronDialog.ts";

const openBoxSignal = () => {
  const options = showMessageBoxMock.mock.lastCall?.at(-1) as ElectronTypes.MessageBoxOptions;
  return options.signal as AbortSignal;
};

describe("ElectronDialog.showMessageBox", () => {
  it.effect("closes the box on the caller's signal and on interruption", () => {
    const dismiss = new AbortController();
    return Effect.gen(function* () {
      showMessageBoxMock.mockReset();
      showMessageBoxMock.mockReturnValue(new Promise(() => {}));
      const dialog = yield* ElectronDialog.ElectronDialog;

      yield* dialog
        .showMessageBox({ message: "a", signal: dismiss.signal })
        .pipe(Effect.forkChild({ startImmediately: true }));
      dismiss.abort();
      assert.isTrue(openBoxSignal().aborted);

      const fiber = yield* dialog
        .showMessageBox({ message: "b" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(fiber);
      assert.isTrue(openBoxSignal().aborted);
    }).pipe(Effect.provide(ElectronDialog.layer));
  });
});
