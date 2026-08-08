import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedErrorClass<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopClientSettings.DesktopClientSettings
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopClientSettings | DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronDialog | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<void, never, Scope.Scope | DesktopLifecycleRuntimeServices>;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  makeComponentLogger("desktop-lifecycle");

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (): Effect.fn.Return<
    void,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

const QUIT_BUTTON_INDEX = 1;

// Quits that no user asked for (a second instance handing over to the running
// one, the last window closing on Windows/Linux, a failed startup) leave no
// window behind, and a prompt there could strand the app with no way back.
const confirmQuitRequested = Effect.fn("desktop.lifecycle.confirmQuitRequested")(
  function* (): Effect.fn.Return<
    boolean,
    never,
    | DesktopClientSettings.DesktopClientSettings
    | ElectronApp.ElectronApp
    | ElectronDialog.ElectronDialog
    | ElectronWindow.ElectronWindow
  > {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const owner = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(owner)) {
      return true;
    }

    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const settings = yield* clientSettings.get;
    const confirmQuit = Option.match(settings, {
      onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
      onSome: (value) => value.confirmQuit,
    });
    if (!confirmQuit) {
      yield* logLifecycleInfo("quit confirmation disabled, quitting");
      return true;
    }

    const electronApp = yield* ElectronApp.ElectronApp;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const appName = yield* electronApp.name;
    // The dialog is window-modal: a hidden or minimized owner would hide it
    // too, leaving a prompt nobody can answer and an app that won't quit.
    yield* electronWindow.reveal(owner.value);
    const result = yield* electronDialog
      .showMessageBox(
        {
          type: "question",
          title: `Quit ${appName}`,
          message: `Quit ${appName}?`,
          detail: "Running agents and terminals will be stopped.",
          buttons: ["Cancel", "Quit"],
          defaultId: QUIT_BUTTON_INDEX,
          cancelId: 0,
          noLink: true,
        },
        owner,
      )
      .pipe(
        Effect.catch((error: ElectronDialog.ElectronDialogShowMessageBoxError) =>
          logLifecycleError("quit confirmation dialog failed", { error }).pipe(
            Effect.as({ response: QUIT_BUTTON_INDEX, checkboxChecked: false }),
          ),
        ),
      );
    return result.response === QUIT_BUTTON_INDEX;
  },
);

interface QuitGate {
  allowed: boolean;
  updaterAllowed: boolean;
  confirming: boolean;
}

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  gate: QuitGate,
): void {
  if (gate.allowed || gate.updaterAllowed) {
    void runEffect(
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  // Quitting again while a confirmation is still up means the user is
  // insisting, so honour it instead of asking twice. Swallowing the request
  // would strand the app for good if the prompt is never answered.
  const skipConfirmation = gate.confirming;
  gate.confirming = true;

  const quitAfterShutdown = () => {
    gate.allowed = true;
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* logLifecycleInfo("shutdown finished, quitting");
        yield* electronApp.quit;
      }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
    );
  };

  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.get(state.quitting);
      if (!skipConfirmation && !wasQuitting && !(yield* confirmQuitRequested())) {
        yield* logLifecycleInfo("quit cancelled from confirmation dialog");
        return false;
      }
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait();
      return true;
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).then(
    (shouldQuit) => {
      gate.confirming = false;
      if (shouldQuit) {
        quitAfterShutdown();
      }
    },
    () => {
      gate.confirming = false;
      quitAfterShutdown();
    },
  );
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
): void {
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      yield* requestDesktopShutdownAndWait();
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.relaunch({
        execPath: process.execPath,
        args: process.argv.slice(1),
      });
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRuntimeServices>();
    const runEffect = Effect.runPromiseWith(context);
    const quitGate: QuitGate = { allowed: false, updaterAllowed: false, confirming: false };
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      quitGate.updaterAllowed = true;
      void runEffect(
        logLifecycleInfo("allowing updater-controlled quit").pipe(
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(event, runEffect, quitGate);
    });
    yield* electronApp.on("activate", () => {
      void runEffect(desktopWindow.activate.pipe(Effect.withSpan("desktop.lifecycle.activate")));
    });
    yield* electronApp.on("window-all-closed", () => {
      void runEffect(
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runEffect);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
