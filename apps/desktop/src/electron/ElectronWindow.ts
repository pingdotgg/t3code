import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

const ElectronWindowCreateOptions = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  minWidth: Schema.NullOr(Schema.Number),
  minHeight: Schema.NullOr(Schema.Number),
  show: Schema.NullOr(Schema.Boolean),
  modal: Schema.NullOr(Schema.Boolean),
  frame: Schema.NullOr(Schema.Boolean),
  transparent: Schema.NullOr(Schema.Boolean),
  backgroundColor: Schema.NullOr(Schema.String),
  webPreferences: Schema.Struct({
    preload: Schema.NullOr(Schema.String),
    partition: Schema.NullOr(Schema.String),
    sandbox: Schema.NullOr(Schema.Boolean),
    contextIsolation: Schema.NullOr(Schema.Boolean),
    nodeIntegration: Schema.NullOr(Schema.Boolean),
    webviewTag: Schema.NullOr(Schema.Boolean),
  }),
});

export class ElectronWindowCreateError extends Schema.TaggedErrorClass<ElectronWindowCreateError>()(
  "ElectronWindowCreateError",
  {
    options: ElectronWindowCreateOptions,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const title = this.options.title === null ? "" : ` "${this.options.title}"`;
    const dimensions =
      this.options.width === null || this.options.height === null
        ? ""
        : ` (${this.options.width}x${this.options.height})`;
    return `Failed to create Electron BrowserWindow${title}${dimensions}.`;
  }
}

export const isElectronWindowCreateError = Schema.is(ElectronWindowCreateError);

export class ElectronWindow extends Context.Service<
  ElectronWindow,
  {
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
>()("@t3tools/desktop/electron/ElectronWindow") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
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
    create: (options) => {
      const webPreferences = options.webPreferences;
      const diagnosticOptions = {
        title: options.title ?? null,
        width: options.width ?? null,
        height: options.height ?? null,
        minWidth: options.minWidth ?? null,
        minHeight: options.minHeight ?? null,
        show: options.show ?? null,
        modal: options.modal ?? null,
        frame: options.frame ?? null,
        transparent: options.transparent ?? null,
        backgroundColor: options.backgroundColor ?? null,
        webPreferences: {
          preload: webPreferences?.preload ?? null,
          partition: webPreferences?.partition ?? null,
          sandbox: webPreferences?.sandbox ?? null,
          contextIsolation: webPreferences?.contextIsolation ?? null,
          nodeIntegration: webPreferences?.nodeIntegration ?? null,
          webviewTag: webPreferences?.webviewTag ?? null,
        },
      } satisfies typeof ElectronWindowCreateOptions.Type;

      return Effect.try({
        try: () => new Electron.BrowserWindow(options),
        catch: (cause) => new ElectronWindowCreateError({ options: diagnosticOptions, cause }),
      });
    },
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

        if (platform === "darwin") {
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
