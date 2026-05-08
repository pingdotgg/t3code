import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

export class ElectronWindowCreateError extends Data.TaggedError("ElectronWindowCreateError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Failed to create Electron BrowserWindow.";
  }
}

export interface ElectronWindowShape {
  readonly create: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Effect.Effect<Electron.BrowserWindow, ElectronWindowCreateError>;
  readonly main: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly currentMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly focusedMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  readonly setMain: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly clearMain: (window: Option.Option<Electron.BrowserWindow>) => Effect.Effect<void>;
  readonly reveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly sendAll: (channel: string, ...args: readonly unknown[]) => Effect.Effect<void>;
  readonly destroyAll: Effect.Effect<void>;
  readonly syncAllAppearance: <E, R>(
    sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, E, R>;
}

export class ElectronWindow extends Context.Service<ElectronWindow, ElectronWindowShape>()(
  "t3/desktop/electron/Window",
) {}

const make = Effect.gen(function* () {
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  const liveMain = Ref.get(mainWindowRef).pipe(
    Effect.map(Option.filter((value) => !value.isDestroyed())),
  );

  const currentMainOrFirst = Effect.gen(function* () {
    const main = yield* liveMain;
    if (Option.isSome(main)) {
      return main;
    }

    return Option.fromNullishOr(Electron.BrowserWindow.getAllWindows()[0] ?? null).pipe(
      Option.filter((window) => !window.isDestroyed()),
    );
  });

  const focusedMainOrFirst = Effect.sync(() =>
    Option.fromNullishOr(Electron.BrowserWindow.getFocusedWindow() ?? null).pipe(
      Option.filter((window) => !window.isDestroyed()),
    ),
  ).pipe(
    Effect.flatMap((focused) =>
      Option.isSome(focused) ? Effect.succeed(focused) : currentMainOrFirst,
    ),
  );

  return ElectronWindow.of({
    create: (options) =>
      Effect.try({
        try: () => new Electron.BrowserWindow(options),
        catch: (cause) => new ElectronWindowCreateError({ cause }),
      }),
    main: liveMain,
    currentMainOrFirst,
    focusedMainOrFirst,
    setMain: (window) => Ref.set(mainWindowRef, Option.some(window)),
    clearMain: (window) =>
      Ref.update(mainWindowRef, (current) => {
        if (Option.isNone(current)) {
          return current;
        }
        if (Option.isSome(window) && current.value !== window.value) {
          return current;
        }
        return Option.none();
      }),
    reveal: (window) =>
      Effect.sync(() => {
        if (window.isDestroyed()) {
          return;
        }

        if (window.isMinimized()) {
          window.restore();
        }

        if (!window.isVisible()) {
          window.show();
        }

        if (process.platform === "darwin") {
          Electron.app.focus({ steal: true });
        }

        window.focus();
      }),
    sendAll: (channel, ...args) =>
      Effect.sync(() => {
        for (const window of Electron.BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) {
            continue;
          }
          window.webContents.send(channel, ...args);
        }
      }),
    destroyAll: Effect.sync(() => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        window.destroy();
      }
    }),
    syncAllAppearance: Effect.fn("desktop.electron.window.syncAllAppearance")(function* <E, R>(
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
    ) {
      const windows = Electron.BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (window.isDestroyed()) {
          continue;
        }
        yield* sync(window);
      }
    }),
  });
});

export const layer = Layer.effect(ElectronWindow, make);
