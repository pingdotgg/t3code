import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

const { buildFromTemplateMock, createFromNamedImageMock, setApplicationMenuMock } = vi.hoisted(
  () => ({
    buildFromTemplateMock: vi.fn(),
    createFromNamedImageMock: vi.fn(),
    setApplicationMenuMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  nativeImage: {
    createFromNamedImage: createFromNamedImageMock,
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    createFromNamedImageMock.mockReset();
    setApplicationMenuMock.mockReset();
  });

  it.effect("returns none without building a menu when there are no valid items", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [],
        position: Option.none(),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with the clicked leaf item id", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: () => {
            const firstItem = template[0];
            assert.isDefined(firstItem);
            const click = firstItem.click;
            if (!click) {
              throw new Error("Expected menu item to have a click handler.");
            }
            click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
          },
        }),
      );

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.none(),
      });

      assert.equal(Option.getOrNull(selectedItemId), "copy");
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("resolves with none when the menu closes without a click", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "copy", label: "Copy" }],
        position: Option.some({ x: 10.8, y: 20.2 }),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0][0], {
        label: "Copy",
        enabled: true,
        click: buildFromTemplateMock.mock.calls[0]?.[0][0].click,
      });
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );

  it.effect("defers popupTemplate side effects until the returned Effect runs", () =>
    Effect.gen(function* () {
      const popupMock = vi.fn();
      buildFromTemplateMock.mockImplementation(() => ({ popup: popupMock }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const popup = electronMenu.popupTemplate({
        window: {} as Electron.BrowserWindow,
        template: [{ label: "Copy" }],
      });

      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
      assert.equal(popupMock.mock.calls.length, 0);

      yield* popup;

      assert.equal(buildFromTemplateMock.mock.calls.length, 1);
      assert.equal(popupMock.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );
});
