import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export interface DesktopShutdownShape {
  readonly request: Effect.Effect<void>;
  readonly awaitRequest: Effect.Effect<void>;
  readonly markComplete: Effect.Effect<void>;
  readonly awaitComplete: Effect.Effect<void>;
  readonly isComplete: Effect.Effect<boolean>;
}

export class DesktopShutdown extends Context.Service<DesktopShutdown, DesktopShutdownShape>()(
  "t3/desktop/Shutdown",
) {}

const makeShutdown = Effect.gen(function* () {
  const requested = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const completedRef = yield* Ref.make(false);

  return DesktopShutdown.of({
    request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
    markComplete: Ref.set(completedRef, true).pipe(
      Effect.andThen(Deferred.succeed(completed, undefined)),
      Effect.asVoid,
    ),
    awaitComplete: Deferred.await(completed),
    isComplete: Ref.get(completedRef),
  });
});

export const layerShutdown = Layer.effect(DesktopShutdown, makeShutdown);

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

export interface DesktopLifecycleShape {
  readonly relaunch: (
    reason: string,
  ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
  readonly register: Effect.Effect<void, never, Scope.Scope | DesktopLifecycleRuntimeServices>;
}

export class DesktopLifecycle extends Context.Service<DesktopLifecycle, DesktopLifecycleShape>()(
  "t3/desktop/Lifecycle",
) {}

const { logInfo: logLifecycleInfo, logError: logLifecycleError } =
  DesktopObservability.makeComponentLogger("desktop-lifecycle");

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
  function* (): Effect.fn.Return<void, never, DesktopShutdown> {
    const shutdown = yield* DesktopShutdown;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>) => Promise<A>,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
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
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait();
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).finally(() => {
    markQuitAllowed();
    void runEffect(
      Effect.gen(function* () {
        const electronApp = yield* ElectronApp.ElectronApp;
        yield* electronApp.quit;
      }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
    );
  });
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

export const layer = Layer.succeed(
  DesktopLifecycle,
  DesktopLifecycle.of({
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
        Effect.catchCause((cause) =>
          logLifecycleError("desktop relaunch failed", {
            cause: Cause.pretty(cause),
          }),
        ),
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
      let quitAllowed = false;
      yield* electronTheme.onUpdated(() => {
        void runEffect(
          desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
        );
      });
      yield* electronApp.on("before-quit", (event: Electron.Event) => {
        handleBeforeQuit(
          event,
          runEffect,
          () => quitAllowed,
          () => {
            quitAllowed = true;
          },
        );
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
  }),
);
