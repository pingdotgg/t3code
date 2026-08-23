import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

const electronMocks = vi.hoisted(() => {
  interface FakeTray {
    iconPath: string;
    listeners: Map<string, () => Promise<void>>;
    setContextMenu: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    on: (eventName: string, listener: () => Promise<void>) => void;
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
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

function makeLayer(input: {
  readonly iconPath: Option.Option<string>;
  readonly backgroundModeChanges: boolean[];
  readonly activations: string[];
  readonly quits: string[];
  readonly activate?: Effect.Effect<void, DesktopWindow.DesktopWindowError>;
  readonly quitting?: boolean;
}) {
  const window = {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate:
      input.activate ??
      Effect.sync(() => {
        input.activations.push("activate");
      }),
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    setBackgroundModeEnabled: (enabled: boolean) => {
      input.backgroundModeChanges.push(enabled);
    },
    prepareForQuit: () => undefined,
    resetQuitPreparation: () => undefined,
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
        Layer.effect(
          DesktopState.DesktopState,
          Effect.all({
            backendReady: Ref.make(false),
            quitting: Ref.make(input.quitting ?? false),
          }),
        ),
      ),
    ),
  );
}

describe("DesktopTray", () => {
  it.effect("routes Windows tray opens through the backend-ready activation gate", () => {
    const backgroundModeChanges: boolean[] = [];
    const activations: string[] = [];
    const quits: string[] = [];
    const layer = makeLayer({
      iconPath: Option.some("C:\\T3 Code\\icon.ico"),
      backgroundModeChanges,
      activations,
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
        const openItem = template?.find((item) => item.label === "Open T3 Code");
        const quitItem = template?.find((item) => item.label === "Quit T3 Code");
        openItem?.click?.(
          {} as Electron.MenuItem,
          undefined as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent,
        );
        quitItem?.click?.(
          {} as Electron.MenuItem,
          undefined as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent,
        );
        yield* Effect.yieldNow;
        assert.deepEqual(activations, ["activate", "activate"]);
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

  it.effect("ignores tray opens while the app is quitting", () => {
    const activations: string[] = [];
    const layer = makeLayer({
      iconPath: Option.some("C:\\T3 Code\\icon.ico"),
      backgroundModeChanges: [],
      activations,
      quits: [],
      quitting: true,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const trayService = yield* DesktopTray.DesktopTray;
        yield* trayService.configure;

        const tray = electronMocks.trays.at(-1);
        assert.isDefined(tray);
        const trayClick = tray.listeners.get("click")?.();
        assert.isDefined(trayClick);

        const template = electronMocks.buildFromTemplate.mock.calls.at(-1)?.[0];
        const openItem = template?.find((item) => item.label === "Open T3 Code");
        openItem?.click?.(
          {} as Electron.MenuItem,
          undefined as unknown as Electron.BaseWindow,
          {} as Electron.KeyboardEvent,
        );

        yield* Effect.promise(() => trayClick);
        yield* Effect.yieldNow;
        assert.deepEqual(activations, []);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("contains failures from tray activation callbacks", () => {
    const layer = makeLayer({
      iconPath: Option.some("C:\\T3 Code\\icon.ico"),
      backgroundModeChanges: [],
      activations: [],
      quits: [],
      activate: Effect.die("activation failed"),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const trayService = yield* DesktopTray.DesktopTray;
        yield* trayService.configure;

        const tray = electronMocks.trays.at(-1);
        assert.isDefined(tray);
        const activation = tray.listeners.get("click")?.();
        assert.isDefined(activation);
        yield* Effect.promise(() => activation);
      }).pipe(Effect.provide(layer)),
    );
  });
});
