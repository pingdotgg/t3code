import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

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

const TestLayer = ElectronMenu.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

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
    }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("inserts a destructive separator when the first destructive item starts the menu", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      yield* electronMenu.showContextMenu({
        window: {} as Electron.BrowserWindow,
        items: [
          { id: "delete-draft", label: "Delete draft", destructive: true },
          { id: "copy", label: "Copy" },
          { id: "delete-file", label: "Delete file", destructive: true },
        ],
        position: Option.none(),
      });

      const template = buildFromTemplateMock.mock.calls[0]?.[0] as
        | Electron.MenuItemConstructorOptions[]
        | undefined;
      assert.deepEqual(
        template?.map((item) => item.type ?? item.label),
        ["Delete draft", "Copy", "separator", "Delete file"],
      );
    }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves application-menu failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("application menu build failed");
      buildFromTemplateMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.setApplicationMenu([{ label: "File" }, { label: "Edit" }]),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "set-application-menu");
        assert.equal(error.platform, "linux");
        assert.isNull(error.windowId);
        assert.equal(error.itemCount, 2);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves popup-template failures with window context", () =>
    Effect.gen(function* () {
      const cause = new Error("popup failed");
      buildFromTemplateMock.mockReturnValueOnce({
        popup: () => {
          throw cause;
        },
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.popupTemplate({
          window: { id: 41 } as Electron.BrowserWindow,
          template: [{ label: "Copy" }],
        }),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "popup-template");
        assert.equal(error.windowId, 41);
        assert.equal(error.itemCount, 1);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves context-menu failures with normalized item context", () =>
    Effect.gen(function* () {
      const cause = new Error("context menu build failed");
      buildFromTemplateMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.showContextMenu({
          window: { id: 42 } as Electron.BrowserWindow,
          items: [{ id: "copy", label: "Copy" }],
          position: Option.none(),
        }),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "show-context-menu");
        assert.equal(error.windowId, 42);
        assert.equal(error.itemCount, 1);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});
