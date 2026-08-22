import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { buildFromTemplateMock, createFromPathMock, trayInstances, TrayMock } = vi.hoisted(() => {
  class FakeTray {
    readonly listeners = new Map<string, () => void>();
    readonly icon: unknown;
    tooltip: string | null = null;
    destroyed = false;
    poppedMenus: unknown[] = [];
    constructor(icon: unknown) {
      this.icon = icon;
      trayInstances.push(this);
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
      return this;
    }
    setToolTip(tooltip: string) {
      this.tooltip = tooltip;
    }
    popUpContextMenu(menu: unknown) {
      this.poppedMenus.push(menu);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const trayInstances: FakeTray[] = [];
  return {
    buildFromTemplateMock: vi.fn((template: unknown) => ({ template })),
    createFromPathMock: vi.fn((path: string) => ({
      path,
      templateImage: false,
      setTemplateImage(value: boolean) {
        this.templateImage = value;
      },
    })),
    trayInstances,
    TrayMock: FakeTray,
  };
});

vi.mock("electron", () => ({
  Tray: TrayMock,
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
  },
  nativeImage: {
    createFromPath: createFromPathMock,
  },
}));

import * as ElectronTray from "./ElectronTray.ts";

const TestLayer = ElectronTray.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
);

describe("ElectronTray", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockClear();
    createFromPathMock.mockClear();
    trayInstances.length = 0;
  });

  it.effect("creates a template-image tray and destroys it with the scope", () =>
    Effect.gen(function* () {
      const electronTray = yield* ElectronTray.ElectronTray;
      const onClick = vi.fn();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* electronTray.create({ iconPath: "/tray.png", tooltip: "T3 Code", onClick });
          const tray = trayInstances[0];
          assert.isDefined(tray);
          assert.equal(tray?.tooltip, "T3 Code");
          assert.isTrue((tray?.icon as { templateImage: boolean } | undefined)?.templateImage);
          tray?.listeners.get("click")?.();
          tray?.listeners.get("right-click")?.();
          assert.equal(onClick.mock.calls.length, 2);
          assert.isFalse(tray?.destroyed);
        }),
      );
      assert.isTrue(trayInstances[0]?.destroyed);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pops up a menu built from the template on the live tray", () =>
    Effect.gen(function* () {
      const electronTray = yield* ElectronTray.ElectronTray;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* electronTray.create({ iconPath: "/tray.png", tooltip: "T3 Code", onClick: () => {} });
          yield* electronTray.popUpMenu([{ label: "Open" }]);
          const tray = trayInstances[0];
          assert.equal(buildFromTemplateMock.mock.calls.length, 1);
          assert.deepEqual(buildFromTemplateMock.mock.calls[0]?.[0], [{ label: "Open" }]);
          assert.equal(tray?.poppedMenus.length, 1);
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores popUpMenu when no tray exists", () =>
    Effect.gen(function* () {
      const electronTray = yield* ElectronTray.ElectronTray;
      yield* electronTray.popUpMenu([{ label: "Open" }]);
      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
