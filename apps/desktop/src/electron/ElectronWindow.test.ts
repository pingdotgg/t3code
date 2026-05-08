import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

const { appFocusMock, getAllWindowsMock } = vi.hoisted(() => ({
  appFocusMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

import * as ElectronWindow from "./ElectronWindow.ts";

function makeBrowserWindow(input: { readonly destroyed: boolean }) {
  return {
    isDestroyed: vi.fn(() => input.destroyed),
  } as unknown as Electron.BrowserWindow;
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  it.effect("skips windows destroyed before appearance sync runs", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ destroyed: false });
      const destroyedWindow = makeBrowserWindow({ destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(ElectronWindow.layer)),
  );
});
