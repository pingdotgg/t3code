// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only service resolves its bundled helper beside the Electron entrypoint.

import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import {
  activateWindowsForeground,
  isWindowsShellHostedForeground,
  loadWindowsForegroundApi,
} from "./WindowsForeground.ts";
import { startWindowsForegroundFocusThread } from "./WindowsForegroundFocusThread.ts";

function windowsForegroundFocusTarget(window: Electron.BrowserWindow) {
  return {
    windowId: window.id,
    processId: process.pid,
    title: window.getTitle(),
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
  };
}

async function isWindowsBrowserWindowForeground(window: Electron.BrowserWindow): Promise<boolean> {
  const foreground = await loadWindowsForegroundApi()
    .then((api) => api.getForegroundWindow())
    .catch(() => undefined);
  if (window.isDestroyed() || foreground === undefined || foreground === 0n) return false;
  const handle = window.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  return foreground === hwnd;
}

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
    backgroundThrottling: Schema.NullOr(Schema.Boolean),
    sandbox: Schema.NullOr(Schema.Boolean),
    contextIsolation: Schema.NullOr(Schema.Boolean),
    nodeIntegration: Schema.NullOr(Schema.Boolean),
    webviewTag: Schema.NullOr(Schema.Boolean),
  }),
});

const ElectronWindowOperation = Schema.Literals([
  "list-windows",
  "get-focused-window",
  "inspect-window",
  "reveal-window",
  "send-window-message",
  "destroy-window",
]);

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

export class ElectronWindowOperationError extends Schema.TaggedErrorClass<ElectronWindowOperationError>()(
  "ElectronWindowOperationError",
  {
    operation: ElectronWindowOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    const channel = this.channel === null ? "" : ` on channel ${JSON.stringify(this.channel)}`;
    return `Electron window operation ${JSON.stringify(this.operation)} failed${window}${channel} on ${this.platform}.`;
  }
}

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
    readonly prepareReveal: (window: Electron.BrowserWindow) => Effect.Effect<boolean>;
    readonly reveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly sendAll: (channel: string, ...args: readonly unknown[]) => Effect.Effect<void>;
    readonly destroyAll: Effect.Effect<void>;
    readonly syncAllAppearance: <E, R>(
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E, R>;
  }
>()("@t3tools/desktop/electron/ElectronWindow") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  // The focus worker loads a native accessibility module. Start it on the first
  // capture reveal so users who never capture pay nothing at launch.
  let windowsForegroundFocus: ReturnType<typeof startWindowsForegroundFocusThread> | undefined;
  const ensureWindowsForegroundFocus = () => {
    windowsForegroundFocus ??= startWindowsForegroundFocusThread(
      NodePath.join(__dirname, "electron", "WindowsForegroundFocusWorker.cjs"),
    );
    return windowsForegroundFocus;
  };
  // Tracks a capture reveal in flight. Ordinary reveals keep Electron's native path.
  const captureRevealWindows = new Set<number>();
  yield* Effect.addFinalizer(() => Effect.sync(() => windowsForegroundFocus?.close()));
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  const listWindows = Effect.try({
    try: () => Electron.BrowserWindow.getAllWindows(),
    catch: (cause) =>
      new ElectronWindowOperationError({
        operation: "list-windows",
        platform,
        windowId: null,
        channel: null,
        cause,
      }),
  }).pipe(Effect.orDie);

  const isWindowDestroyed = (window: Electron.BrowserWindow) =>
    Effect.try({
      try: () => window.isDestroyed(),
      catch: (cause) =>
        new ElectronWindowOperationError({
          operation: "inspect-window",
          platform,
          windowId: window.id,
          channel: null,
          cause,
        }),
    }).pipe(Effect.orDie);

  const liveMain = Effect.gen(function* () {
    const main = yield* Ref.get(mainWindowRef);
    if (Option.isNone(main) || (yield* isWindowDestroyed(main.value))) {
      return Option.none<Electron.BrowserWindow>();
    }
    return main;
  });

  const currentMainOrFirst = Effect.gen(function* () {
    const main = yield* liveMain;
    if (Option.isSome(main)) {
      return main;
    }

    const first = Option.fromNullishOr((yield* listWindows)[0] ?? null);
    if (Option.isNone(first) || (yield* isWindowDestroyed(first.value))) {
      return Option.none<Electron.BrowserWindow>();
    }
    return first;
  });

  const focusedMainOrFirst = Effect.gen(function* () {
    const focused = yield* Effect.try({
      try: () => Option.fromNullishOr(Electron.BrowserWindow.getFocusedWindow() ?? null),
      catch: (cause) =>
        new ElectronWindowOperationError({
          operation: "get-focused-window",
          platform,
          windowId: null,
          channel: null,
          cause,
        }),
    }).pipe(Effect.orDie);
    if (Option.isSome(focused) && !(yield* isWindowDestroyed(focused.value))) {
      return focused;
    }
    return yield* currentMainOrFirst;
  });

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
          backgroundThrottling: webPreferences?.backgroundThrottling ?? null,
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
    prepareReveal: (window) =>
      Effect.promise(async () => {
        if (platform !== "win32" || window.isDestroyed()) {
          return false;
        }
        captureRevealWindows.add(window.id);
        return ensureWindowsForegroundFocus()
          .prepare(windowsForegroundFocusTarget(window))
          .catch(() => false);
      }),
    reveal: (window) =>
      Effect.tryPromise({
        try: async () => {
          if (window.isDestroyed()) {
            return;
          }

          // Only a capture reveal fights another process for the foreground, which
          // needs Win32 calls that load native modules. Everything else stays native.
          const captureReveal = platform === "win32" && captureRevealWindows.delete(window.id);
          const shellHostedForeground =
            captureReveal && (await isWindowsShellHostedForeground().catch(() => false));

          if (window.isMinimized()) {
            window.restore();
          }

          if (captureReveal) {
            Electron.app.focus();
          }

          if (captureReveal || !window.isVisible()) {
            window.show();
          }

          if (captureReveal) {
            window.moveTop();
          }

          if (platform === "darwin") {
            Electron.app.focus({ steal: true });
          }

          window.focus();

          if (captureReveal) {
            if (shellHostedForeground) {
              await windowsForegroundFocus
                ?.focus(windowsForegroundFocusTarget(window))
                .catch(() => false);
            }
            try {
              await activateWindowsForeground(window.getNativeWindowHandle());
            } catch {
              const needsFocus = !(await isWindowsBrowserWindowForeground(window));
              if (needsFocus && !window.isDestroyed()) {
                await windowsForegroundFocus
                  ?.focus(windowsForegroundFocusTarget(window))
                  .catch(() => false);
              }
              if (!window.isDestroyed()) {
                await activateWindowsForeground(window.getNativeWindowHandle());
              }
            }
          }
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "reveal-window",
            platform,
            windowId: window.id,
            channel: null,
            cause,
          }),
      }).pipe(Effect.orDie),
    sendAll: (channel, ...args) =>
      Effect.gen(function* () {
        for (const window of yield* listWindows) {
          if (yield* isWindowDestroyed(window)) {
            continue;
          }
          yield* Effect.try({
            try: () => window.webContents.send(channel, ...args),
            catch: (cause) =>
              new ElectronWindowOperationError({
                operation: "send-window-message",
                platform,
                windowId: window.id,
                channel,
                cause,
              }),
          }).pipe(Effect.orDie);
        }
      }),
    destroyAll: Effect.gen(function* () {
      let firstFailure: Cause.Cause<never> | undefined;
      for (const window of yield* listWindows) {
        const exit = yield* Effect.exit(
          Effect.try({
            try: () => window.destroy(),
            catch: (cause) =>
              new ElectronWindowOperationError({
                operation: "destroy-window",
                platform,
                windowId: window.id,
                channel: null,
                cause,
              }),
          }).pipe(Effect.orDie),
        );
        if (Exit.isFailure(exit)) {
          firstFailure ??= exit.cause;
        }
      }
      if (firstFailure !== undefined) {
        return yield* Effect.failCause(firstFailure);
      }
    }),
    syncAllAppearance: Effect.fn("desktop.electron.window.syncAllAppearance")(function* <E, R>(
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void, E, R>,
    ) {
      const windows = yield* listWindows;
      for (const window of windows) {
        if (yield* isWindowDestroyed(window)) {
          continue;
        }
        yield* sync(window);
      }
    }),
  });
});

export const layer = Layer.effect(ElectronWindow, make);
