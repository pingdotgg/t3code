import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  popups: [] as Array<{ callback?: () => void; frame?: unknown }>,
  popupError: undefined as Error | undefined,
  frameContents: undefined as unknown,
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: () => ({
      popup: (options: { callback?: () => void; frame?: unknown }) => {
        if (electron.popupError) throw electron.popupError;
        electron.popups.push(options);
      },
    }),
  },
  webContents: { fromFrame: () => electron.frameContents },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

function setup(options: { popupError?: Error } = {}) {
  const host = new NodeEvents.EventEmitter();
  const guest = new NodeEvents.EventEmitter();
  electron.popups = [];
  electron.popupError = options.popupError;
  electron.frameContents = guest;
  const isDropped = (contents: NodeEvents.EventEmitter, type = "mouseMove") => {
    let prevented = false;
    contents.emit(
      "before-mouse-event",
      { preventDefault: () => (prevented = true) },
      { type, x: 175, y: 175 },
    );
    return prevented;
  };
  const input = {
    window: { id: 1, webContents: host },
    template: [{ role: "copy" }],
    frame: {},
  } as unknown as ElectronMenu.ElectronMenuTemplateInput;
  return { host, guest, input, isDropped };
}

const popupTemplate = (input: ElectronMenu.ElectronMenuTemplateInput, platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    const menu = yield* ElectronMenu.make;
    yield* menu.popupTemplate(input);
  }).pipe(Effect.provideService(HostProcess.Platform, platform));

describe("ElectronMenu.popupTemplate", () => {
  it.effect("holds page mouse moves on macOS until the native menu closes", () =>
    Effect.gen(function* () {
      const { host, guest, input, isDropped } = setup();
      yield* popupTemplate(input, "darwin");

      // The frame keeps Writing Tools and Services in the native menu.
      assert.strictEqual(electron.popups[0]?.frame, input.frame);
      assert.isTrue(isDropped(host));
      assert.isTrue(isDropped(guest));
      assert.isFalse(isDropped(host, "mouseUp"));

      electron.popups[0]?.callback?.();
      assert.isFalse(isDropped(host));
      assert.isFalse(isDropped(guest));
    }),
  );

  it.effect("releases mouse moves when the native menu fails to open", () =>
    Effect.gen(function* () {
      const { host, input, isDropped } = setup({ popupError: new Error("no menu") });
      const exit = yield* Effect.exit(popupTemplate(input, "darwin"));

      assert.isTrue(exit._tag === "Failure");
      assert.isFalse(isDropped(host));
    }),
  );
});
