import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const electronMocks = vi.hoisted(() => {
  interface FakeTray {
    iconPath: string;
    listeners: Map<string, () => void>;
    setContextMenu: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: (eventName: string, listener: () => void) => void;
  }

  const trays: FakeTray[] = [];
  const Tray = vi.fn(function TrayMock(this: FakeTray, iconPath: string) {
    this.iconPath = iconPath;
    this.listeners = new Map();
    this.setContextMenu = vi.fn();
    this.setToolTip = vi.fn();
    this.destroy = vi.fn();
    this.on = (eventName, listener) => {
      this.listeners.set(eventName, listener);
    };
    trays.push(this);
  });
  const buildFromTemplate = vi.fn(
    (template: readonly Electron.MenuItemConstructorOptions[]) => template,
  );
  return { buildFromTemplate, Tray, trays };
});

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  Menu: { buildFromTemplate: electronMocks.buildFromTemplate },
  Tray: electronMocks.Tray,
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

function makeLayer(input: {
  readonly iconPath: Option.Option<string>;
  readonly backgroundModeChanges: boolean[];
  readonly opens: string[];
  readonly quits: string[];
}) {
  const window = {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.sync(() => {
      input.opens.push("open");
      return {} as Electron.BrowserWindow;
    }),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    setBackgroundModeEnabled: (enabled: boolean) => {
      input.backgroundModeChanges.push(enabled);
    },
    prepareForQuit: () => undefined,
    dispatchMenuAction: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"];

  return DesktopTray.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "win32",
          displayName: "T3 Code",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(DesktopAssets.DesktopAssets, {
          iconPaths: Effect.succeed({
            ico: input.iconPath,
            icns: Option.none(),
            png: Option.none(),
          }),
          resolveResourcePath: () => Effect.succeed(Option.none()),
        }),
        Layer.succeed(ElectronApp.ElectronApp, {
          quit: Effect.sync(() => {
            input.quits.push("quit");
          }),
        } as ElectronApp.ElectronApp["Service"]),
        Layer.succeed(DesktopWindow.DesktopWindow, window),
      ),
    ),
  );
}

describe("DesktopTray", () => {
  it.effect("keeps Windows background mode active for the tray lifetime", () => {
    const backgroundModeChanges: boolean[] = [];
    const opens: string[] = [];
    const quits: string[] = [];
    const layer = makeLayer({
      iconPath: Option.some("C:\\T3 Code\\icon.ico"),
      backgroundModeChanges,
      opens,
      quits,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const trayService = yield* DesktopTray.DesktopTray;
        yield* trayService.configure;

        const tray = electronMocks.trays.at(-1);
        assert.isDefined(tray);
        assert.equal(tray.iconPath, "C:\\T3 Code\\icon.ico");
        assert.deepEqual(backgroundModeChanges, [true]);

        tray.listeners.get("click")?.();
        const template = electronMocks.buildFromTemplate.mock.calls.at(-1)?.[0];
        const quitItem = template?.find((item) => item.label === "Quit T3 Code");
        quitItem?.click?.(
          {} as Electron.MenuItem,
          undefined as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent,
        );
        yield* Effect.yieldNow;
        assert.deepEqual(opens, ["open"]);
        assert.deepEqual(quits, ["quit"]);
      }).pipe(Effect.provide(layer)),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          assert.deepEqual(backgroundModeChanges, [true, false]);
          assert.equal(electronMocks.trays.at(-1)?.destroy.mock.calls.length, 1);
        }),
      ),
    );
  });
});
