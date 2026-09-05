import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

interface MockTrayInstance {
  icon: unknown;
  toolTip?: string;
  contextMenu?: unknown;
  listeners: Map<string, (...args: unknown[]) => void>;
  destroyed: boolean;
  destroy: () => void;
  isDestroyed: () => boolean;
  setToolTip: (tip: string) => void;
  setContextMenu: (menu: unknown) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

const { buildFromTemplateMock, createFromPathMock, trayInstances } = vi.hoisted(() => {
  const instances: MockTrayInstance[] = [];

  return {
    buildFromTemplateMock: vi.fn((template) => ({ template })),
    createFromPathMock: vi.fn((path: string) => ({
      isEmpty: () => false,
      path,
    })),
    trayInstances: instances,
  };
});

vi.mock("electron", () => {
  class MockTray {
    toolTip?: string;
    contextMenu?: unknown;
    listeners = new Map<string, (...args: unknown[]) => void>();
    destroyed = false;
    icon: unknown;

    constructor(icon: unknown) {
      this.icon = icon;
      trayInstances.push(this);
    }

    setToolTip(tip: string) {
      this.toolTip = tip;
    }

    setContextMenu(menu: unknown) {
      this.contextMenu = menu;
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener);
    }

    destroy() {
      this.destroyed = true;
    }

    isDestroyed() {
      return this.destroyed;
    }
  }

  return {
    Menu: {
      buildFromTemplate: buildFromTemplateMock,
    },
    nativeImage: {
      createFromPath: createFromPathMock,
    },
    Tray: MockTray,
  };
});

import * as ElectronTray from "./ElectronTray.ts";

const TestLayer = ElectronTray.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "win32")),
);

describe("ElectronTray", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockClear();
    createFromPathMock.mockClear();
    trayInstances.length = 0;
  });

  it.effect("creates tray with tooltip and context menu and click listeners", () =>
    Effect.gen(function* () {
      const electronTray = yield* ElectronTray.ElectronTray;
      let clicked = false;
      let doubleClicked = false;

      yield* electronTray.create({
        iconPath: "C:/path/to/icon.ico",
        tooltip: "T3 Code",
        onClick: () => {
          clicked = true;
        },
        onDoubleClick: () => {
          doubleClicked = true;
        },
        menuItems: [
          { label: "Open T3 Code", click: () => {} },
          { type: "separator" },
          { label: "Quit", click: () => {} },
        ],
      });

      assert.equal(trayInstances.length, 1);
      const instance = trayInstances[0];
      assert.isDefined(instance);
      assert.equal(instance?.toolTip, "T3 Code");
      assert.isTrue(instance?.listeners.has("click"));
      assert.isTrue(instance?.listeners.has("double-click"));
      assert.equal(buildFromTemplateMock.mock.calls.length, 1);

      instance?.listeners.get("click")?.();
      assert.isTrue(clicked);
      instance?.listeners.get("double-click")?.();
      assert.isTrue(doubleClicked);

      yield* electronTray.destroy;
      assert.isTrue(instance?.destroyed);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("destroys old tray before creating a new one", () =>
    Effect.gen(function* () {
      const electronTray = yield* ElectronTray.ElectronTray;

      yield* electronTray.create({ iconPath: "icon1.ico" });
      assert.equal(trayInstances.length, 1);
      assert.isFalse(trayInstances[0]?.destroyed);

      yield* electronTray.create({ iconPath: "icon2.ico" });
      assert.equal(trayInstances.length, 2);
      assert.isTrue(trayInstances[0]?.destroyed);
      assert.isFalse(trayInstances[1]?.destroyed);
    }).pipe(Effect.provide(TestLayer)),
  );
});
