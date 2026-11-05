import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  popups: [] as Array<{ callback?: () => void; frame?: unknown }>,
  popupError: undefined as Error | undefined,
  frameContents: undefined as unknown,
  cursor: { x: 1030, y: 330 },
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
  screen: { getCursorScreenPoint: () => electron.cursor },
  webContents: { fromFrame: () => electron.frameContents },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

function setup(options: { popupError?: Error } = {}) {
  const host = new NodeEvents.EventEmitter();
  const guest = new NodeEvents.EventEmitter();
  electron.popups = [];
  electron.popupError = options.popupError;
  electron.frameContents = guest;
  electron.cursor = { x: 1030, y: 330 };
  const isDropped = (contents: NodeEvents.EventEmitter, type = "mouseMove") => {
    let prevented = false;
    contents.emit(
      "before-mouse-event",
      { preventDefault: () => (prevented = true) },
      { type, x: 70, y: 330 },
    );
    return prevented;
  };
  const listeners = () =>
    host.listenerCount("before-mouse-event") + guest.listenerCount("before-mouse-event");
  const input = {
    window: { id: 1, webContents: host },
    template: [{ role: "copy" }],
    frame: {},
  } as unknown as ElectronMenu.ElectronMenuTemplateInput;
  return { host, guest, input, isDropped, listeners };
}

const popupTemplate = (input: ElectronMenu.ElectronMenuTemplateInput, platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    const menu = yield* ElectronMenu.make;
    yield* menu.popupTemplate(input);
    return menu;
  }).pipe(Effect.provideService(HostProcess.Platform, platform));

describe("ElectronMenu.popupTemplate", () => {
  it.effect("holds page mouse moves on macOS until the cursor moves after the menu", () =>
    Effect.gen(function* () {
      const { host, guest, input, isDropped, listeners } = setup();
      yield* popupTemplate(input, "darwin");

      assert.isTrue(isDropped(host));
      assert.isTrue(isDropped(guest));
      assert.isFalse(isDropped(host, "mouseUp"));

      // macOS can send the misplaced move just after the menu's callback.
      electron.popups[0]?.callback?.();
      assert.isTrue(isDropped(host));
      assert.isTrue(isDropped(guest));

      electron.cursor = { x: 1031, y: 330 };
      assert.isFalse(isDropped(host));
      assert.strictEqual(listeners(), 0);
      electron.cursor = { x: 1030, y: 330 };
      assert.isFalse(isDropped(guest));
    }),
  );

  it.effect("releases mouse moves on a fresh click, destroyed contents, or a failed popup", () =>
    Effect.gen(function* () {
      const clicked = setup();
      yield* popupTemplate(clicked.input, "darwin");
      electron.popups[0]?.callback?.();
      assert.isFalse(clicked.isDropped(clicked.host, "mouseDown"));
      assert.strictEqual(clicked.listeners(), 0);

      const destroyed = setup();
      yield* popupTemplate(destroyed.input, "darwin");
      destroyed.guest.emit("destroyed");
      assert.strictEqual(destroyed.listeners(), 0);

      const failed = setup({ popupError: new Error("no menu") });
      const exit = yield* Effect.exit(popupTemplate(failed.input, "darwin"));
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual(failed.listeners(), 0);
    }),
  );

  it.effect("a new menu replaces the previous menu's hold", () =>
    Effect.gen(function* () {
      const { host, input, isDropped, listeners } = setup();
      const menu = yield* popupTemplate(input, "darwin");
      yield* menu.popupTemplate(input);
      assert.strictEqual(listeners(), 2);

      // The first menu's late callback must not release the second menu's hold.
      electron.popups[0]?.callback?.();
      electron.cursor = { x: 1031, y: 330 };
      assert.isTrue(isDropped(host));
    }),
  );
});
