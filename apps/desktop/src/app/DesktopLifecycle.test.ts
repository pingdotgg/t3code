import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

type AppListeners = Map<string, (...args: readonly unknown[]) => void>;

const mainWindow = { id: 1 } as Electron.BrowserWindow;

interface Harness {
  readonly listeners: AppListeners;
  readonly quitCalls: Array<string>;
  readonly messageBoxes: Array<{
    readonly options: Electron.MessageBoxOptions;
    readonly owner: Option.Option<Electron.BrowserWindow>;
  }>;
  readonly revealedWindows: Array<Electron.BrowserWindow>;
}

// The before-quit handler resolves through promise callbacks, so tests wait a
// macrotask for the confirmation and shutdown chain to settle.
const settle = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
);

function makeElectronAppLayer(harness: Harness) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
    quit: Effect.sync(() => {
      harness.quitCalls.push("quit");
    }),
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          harness.listeners.set("before-quit-for-update", listener);
        }),
        () =>
          Effect.sync(() => {
            harness.listeners.delete("before-quit-for-update");
          }),
      ).pipe(Effect.asVoid),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          harness.listeners.set(
            eventName,
            listener as unknown as (...args: readonly unknown[]) => void,
          );
        }),
        () =>
          Effect.sync(() => {
            harness.listeners.delete(eventName);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

function makeLayer(input: {
  readonly harness: Harness;
  readonly platform: NodeJS.Platform;
  readonly confirmResponse: number;
  readonly hasWindow: boolean;
  readonly clientSettings: ClientSettings;
}) {
  const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
    shouldUseDarkColors: Effect.succeed(false),
    setSource: () => Effect.void,
    onUpdated: () => Effect.void,
  });

  const electronDialogLayer = Layer.succeed(
    ElectronDialog.ElectronDialog,
    ElectronDialog.ElectronDialog.of({
      pickFolder: () => Effect.succeed(Option.none()),
      pickFiles: () => Effect.succeed([]),
      confirm: () => Effect.succeed(false),
      showMessageBox: (options, owner = Option.none()) =>
        Effect.sync(() => {
          input.harness.messageBoxes.push({ options, owner });
          return { response: input.confirmResponse, checkboxChecked: false };
        }),
      showErrorBox: () => Effect.void,
    }),
  );

  const electronWindowLayer = Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      currentMainOrFirst: Effect.succeed(input.hasWindow ? Option.some(mainWindow) : Option.none()),
      reveal: (window) =>
        Effect.sync(() => {
          input.harness.revealedWindows.push(window);
        }),
    } as ElectronWindow.ElectronWindow["Service"]),
  );

  const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: () => Effect.void,
    zoomMain: () => Effect.void,
    syncAppearance: Effect.void,
  });

  const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform: input.platform,
    isDevelopment: false,
  } as DesktopEnvironment.DesktopEnvironment["Service"]);

  const shutdownLayer = Layer.succeed(
    DesktopShutdown.DesktopShutdown,
    DesktopShutdown.DesktopShutdown.of({
      request: Effect.void,
      awaitRequest: Effect.void,
      markComplete: Effect.void,
      awaitComplete: Effect.void,
      isComplete: Effect.succeed(true),
    }),
  );

  return DesktopLifecycle.layer.pipe(
    Layer.provideMerge(makeElectronAppLayer(input.harness)),
    Layer.provideMerge(electronThemeLayer),
    Layer.provideMerge(electronDialogLayer),
    Layer.provideMerge(electronWindowLayer),
    Layer.provideMerge(desktopWindowLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(shutdownLayer),
    Layer.provideMerge(DesktopClientSettings.layerTest(Option.some(input.clientSettings))),
    Layer.provideMerge(DesktopState.layer),
  );
}

function makeHarness(): Harness {
  return { listeners: new Map(), quitCalls: [], messageBoxes: [], revealedWindows: [] };
}

function emitBeforeQuit(listeners: AppListeners): boolean {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  } as Electron.Event;
  listeners.get("before-quit")?.(event);
  return prevented;
}

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const harness = makeHarness();
      const layer = makeLayer({
        harness,
        platform,
        confirmResponse: 0,
        hasWindow: true,
        clientSettings: DEFAULT_CLIENT_SETTINGS,
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          harness.listeners.get("before-quit-for-update")?.();
          const prevented = emitBeforeQuit(harness.listeners);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.deepEqual(harness.messageBoxes, []);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }

  it.effect("keeps the app running when the quit confirmation is dismissed", () => {
    const harness = makeHarness();
    const layer = makeLayer({
      harness,
      platform: "darwin",
      confirmResponse: 0,
      hasWindow: true,
      clientSettings: DEFAULT_CLIENT_SETTINGS,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        assert.isTrue(emitBeforeQuit(harness.listeners));
        yield* settle;

        assert.lengthOf(harness.messageBoxes, 1);
        assert.deepEqual(harness.messageBoxes[0]?.owner, Option.some(mainWindow));
        assert.deepEqual(harness.revealedWindows, [mainWindow]);
        assert.deepEqual(harness.quitCalls, []);
        const state = yield* DesktopState.DesktopState;
        assert.isFalse(yield* Ref.get(state.quitting));
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("shuts down and quits once the confirmation is accepted", () => {
    const harness = makeHarness();
    const layer = makeLayer({
      harness,
      platform: "darwin",
      confirmResponse: 1,
      hasWindow: true,
      clientSettings: DEFAULT_CLIENT_SETTINGS,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        assert.isTrue(emitBeforeQuit(harness.listeners));
        yield* settle;

        assert.lengthOf(harness.messageBoxes, 1);
        assert.deepEqual(harness.quitCalls, ["quit"]);
        const state = yield* DesktopState.DesktopState;
        assert.isTrue(yield* Ref.get(state.quitting));
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("quits without asking when the confirmation setting is off", () => {
    const harness = makeHarness();
    const layer = makeLayer({
      harness,
      platform: "darwin",
      confirmResponse: 0,
      hasWindow: true,
      clientSettings: { ...DEFAULT_CLIENT_SETTINGS, confirmQuit: false },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        assert.isTrue(emitBeforeQuit(harness.listeners));
        yield* settle;

        assert.deepEqual(harness.messageBoxes, []);
        assert.deepEqual(harness.quitCalls, ["quit"]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("quits without asking when no window is open", () => {
    const harness = makeHarness();
    const layer = makeLayer({
      harness,
      platform: "win32",
      confirmResponse: 0,
      hasWindow: false,
      clientSettings: DEFAULT_CLIENT_SETTINGS,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        assert.isTrue(emitBeforeQuit(harness.listeners));
        yield* settle;

        assert.deepEqual(harness.messageBoxes, []);
        assert.deepEqual(harness.quitCalls, ["quit"]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("quits without asking again when the user insists mid-confirmation", () => {
    const harness = makeHarness();
    const layer = makeLayer({
      harness,
      platform: "darwin",
      confirmResponse: 0,
      hasWindow: true,
      clientSettings: DEFAULT_CLIENT_SETTINGS,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        assert.isTrue(emitBeforeQuit(harness.listeners));
        assert.isTrue(emitBeforeQuit(harness.listeners));
        yield* settle;

        assert.lengthOf(harness.messageBoxes, 1);
        assert.deepEqual(harness.quitCalls, ["quit"]);
        const state = yield* DesktopState.DesktopState;
        assert.isTrue(yield* Ref.get(state.quitting));
      }),
    ).pipe(Effect.provide(layer));
  });
});
