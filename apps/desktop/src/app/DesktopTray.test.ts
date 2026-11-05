import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

const native = vi.hoisted(() => ({
  createTray: vi.fn(),
  createFromPath: vi.fn(),
  createFromDataURL: vi.fn(),
  buildFromTemplate: vi.fn(),
}));

vi.mock("electron", () => ({
  Tray: function (image: unknown) {
    return native.createTray(image);
  },
  nativeImage: {
    createFromPath: native.createFromPath,
    createFromDataURL: native.createFromDataURL,
  },
  Menu: { buildFromTemplate: native.buildFromTemplate },
}));

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

function setup(platform: NodeJS.Platform) {
  vi.resetAllMocks();
  const image = { isEmpty: () => false, resize: vi.fn() };
  image.resize.mockReturnValue(image);
  const badgeImage = { isEmpty: () => false };
  const tray = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn(),
  };
  native.createTray.mockReturnValue(tray);
  native.createFromPath.mockReturnValue(image);
  native.createFromDataURL.mockReturnValue(badgeImage);
  native.buildFromTemplate.mockImplementation(
    (template: Electron.MenuItemConstructorOptions[]) => template,
  );
  const quit = vi.fn();
  const open = vi.fn();
  const layer = DesktopTray.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: Option.some("icon.ico"),
            png: Option.some("icon.png"),
            icns: Option.none(),
          }),
        }),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform,
          displayName: "T3 Code",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.mock(ElectronApp.ElectronApp, { quit: Effect.sync(quit) }),
      ),
    ),
    Layer.provideMerge(DesktopState.layer),
  );
  return { layer, tray, image, badgeImage, open, quit };
}

it.effect.each(["win32", "darwin", "linux"] satisfies NodeJS.Platform[])(
  "retains and reopens the window only while the tray is available on %s",
  (platform) => {
    const harness = setup(platform);
    return Effect.scoped(
      Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        const state = yield* DesktopState.DesktopState;
        assert.isFalse(yield* tray.shouldHideOnClose);
        yield* tray.configure(false);
        assert.equal(native.createTray.mock.calls.length, 0);
        yield* tray.initialize(Effect.sync(harness.open));
        yield* tray.updateBadge({ count: 2, image: "badge" });
        yield* tray.configure(true);
        yield* tray.configure(true);
        assert.equal(native.createTray.mock.calls.length, 1);
        assert.isTrue(yield* tray.shouldHideOnClose);
        assert.equal(
          harness.tray.setImage.mock.lastCall?.[0],
          platform === "darwin" ? harness.image : harness.badgeImage,
        );
        assert.equal(
          harness.tray.setToolTip.mock.lastCall?.[0],
          "T3 Code: 2 threads with new notifications",
        );
        if (platform === "darwin") assert.equal(harness.tray.setTitle.mock.lastCall?.[0], "2");
        const menu = native.buildFromTemplate.mock.results[0]!
          .value as Electron.MenuItemConstructorOptions[];
        const invoke = (index: number) => {
          const click = menu[index]!.click as (() => void) | undefined;
          click?.();
        };
        invoke(0);
        assert.equal(harness.open.mock.calls.length, 1);
        invoke(2);
        assert.equal(harness.quit.mock.calls.length, 1);
        yield* Ref.set(state.quitting, true);
        assert.isFalse(yield* tray.shouldHideOnClose);
        invoke(0);
        assert.equal(harness.open.mock.calls.length, 1);
        yield* Ref.set(state.quitting, false);
        yield* tray.updateBadge({ count: 0, image: null });
        assert.equal(harness.tray.setImage.mock.lastCall?.[0], harness.image);
        assert.equal(harness.tray.setToolTip.mock.lastCall?.[0], "T3 Code");
        if (platform === "darwin") assert.equal(harness.tray.setTitle.mock.lastCall?.[0], "");
        yield* tray.configure(false);
        assert.equal(harness.open.mock.calls.length, 2);
        assert.equal(harness.tray.destroy.mock.calls.length, 1);
        assert.isFalse(yield* tray.shouldHideOnClose);
        yield* tray.configure(true);
      }).pipe(Effect.provide(harness.layer)),
    ).pipe(
      Effect.andThen(Effect.sync(() => assert.equal(harness.tray.destroy.mock.calls.length, 2))),
    );
  },
);

it.effect("keeps ordinary close behavior after tray creation fails and permits retry", () => {
  const harness = setup("win32");
  native.createTray.mockImplementationOnce(() => {
    throw new Error("No tray host");
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.initialize(Effect.sync(harness.open));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(tray.configure(true))));
      assert.isFalse(yield* tray.shouldHideOnClose);
      yield* tray.configure(true);
      assert.isTrue(yield* tray.shouldHideOnClose);
    }).pipe(Effect.provide(harness.layer)),
  );
});
