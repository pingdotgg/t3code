import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { afterEach, beforeEach, vi } from "vitest";

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

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    createFromNamedImageMock.mockReset();
    setApplicationMenuMock.mockReset();
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
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

  it.effect("uses template images for destructive macOS context menu icons", () =>
    Effect.gen(function* () {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "darwin",
      });

      const resizedIcon = {
        isEmpty: vi.fn(() => false),
        setTemplateImage: vi.fn((_template: boolean) => undefined),
      };
      const sourceIcon = {
        resize: vi.fn((_size: { width: number; height: number }) => resizedIcon),
      };
      createFromNamedImageMock.mockReturnValue(sourceIcon);
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [{ id: "delete", label: "Remove project", destructive: true }],
        position: Option.none(),
      });

      assert.equal(createFromNamedImageMock.mock.calls[0]?.[0], "trash");
      assert.deepEqual(sourceIcon.resize.mock.calls[0]?.[0], { width: 12, height: 12 });
      assert.deepEqual(resizedIcon.setTemplateImage.mock.calls[0], [true]);
      assert.strictEqual(buildFromTemplateMock.mock.calls[0]?.[0][0]?.icon, resizedIcon);
    }).pipe(Effect.provide(ElectronMenu.layer)),
  );
});
