import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedError<DesktopLifecycleRelaunchError>()(
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
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

type DesktopLifecycleRegistrationServices =
  | DesktopLifecycleRuntimeServices
  | ElectronWindow.ElectronWindow;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme | ElectronWindow
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<
      void,
      never,
      Scope.Scope | DesktopLifecycleRegistrationServices
    >;
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
  function* (
    afterBoundsFlush: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<void, never, DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow> {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* afterBoundsFlush;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

interface QuitState {
  phase: "running" | "waiting" | "allowed";
  waitingSinceNanos: bigint;
}

// Longer than a backend's stop budget (SIGTERM, 5s grace, SIGKILL, 1s wait),
// so a double Cmd-Q at the start of a normal quit cannot cut the backend stop
// short and orphan it.
const SHUTDOWN_STALL_THRESHOLD = Duration.seconds(10);

const startWaitingForShutdown = Effect.fn("desktop.lifecycle.startWaitingForShutdown")(function* (
  quit: QuitState,
) {
  quit.phase = "waiting";
  quit.waitingSinceNanos = yield* Clock.monotonicTimeNanos;
});

// While a quit waits on shutdown, `quitting` makes activation open nothing. If
// that shutdown stalls, a repeated Quit or SIGTERM is the user's only way out
// short of SIGKILL.
const exitIfShutdownStalled = Effect.fn("desktop.lifecycle.exitIfShutdownStalled")(function* (
  quit: QuitState,
  source: string,
) {
  const pendingMs = Number(
    ((yield* Clock.monotonicTimeNanos) - quit.waitingSinceNanos) / 1_000_000n,
  );
  if (pendingMs < Duration.toMillis(SHUTDOWN_STALL_THRESHOLD)) {
    yield* logLifecycleInfo("quit already in progress", { source, pendingMs });
    return;
  }
  yield* logLifecycleError("desktop shutdown stalled; exiting without it", { source, pendingMs });
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.exit(0);
});

function handleBeforeQuit(
  event: Electron.Event,
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  if (quit.phase === "allowed") {
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
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, "before-quit"));
    return;
  }
  void runEffect(
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* startWaitingForShutdown(quit);
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* requestDesktopShutdownAndWait(
        electronWindow.destroyAll.pipe(
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before shutdown", { cause }),
          ),
        ),
      );
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
  ).finally(() => {
    quit.phase = "allowed";
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
  runEffect: <A, E>(
    effect: Effect.Effect<A, E, DesktopLifecycleRegistrationServices>,
  ) => Promise<A>,
  quit: QuitState,
): void {
  if (quit.phase === "waiting") {
    void runEffect(exitIfShutdownStalled(quit, signal));
    return;
  }
  void runEffect(
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* startWaitingForShutdown(quit);
      yield* logLifecycleInfo("process signal received", { signal });
      yield* requestDesktopShutdownAndWait();
      quit.phase = "allowed";
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

/** @public */
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
      // Startup already acted on the app link that launched it; passing it on replays it.
      const appLinkPrefix = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}:`;
      const args = yield* HostProcess.Arguments;
      yield* electronApp.relaunch({
        execPath: yield* HostProcess.ExecutablePath,
        args: args.slice(1).filter((arg) => !arg.toLowerCase().startsWith(appLinkPrefix)),
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
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRegistrationServices>();
    const runEffect = Effect.runPromiseWith(context);
    const quit: QuitState = { phase: "running", waitingSinceNanos: 0n };
    yield* electronTheme.onUpdated(() => {
      void runEffect(
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // Electron's updater owns the remaining quit/install/relaunch sequence.
      // Cancelling the following app "before-quit" event breaks that sequence,
      // most visibly on macOS where the native updater performs the relaunch.
      quit.phase = "allowed";
      // This event is synchronous and the updater's quit proceeds as soon as
      // the listener returns, so a forked destroyAll would race the quit
      // and windows could still be open when the process exits (visible on
      // macOS). Destroy them inline.
      Effect.runSyncWith(context)(
        electronWindow.destroyAll.pipe(
          Effect.andThen(logLifecycleInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logLifecycleError("failed to destroy windows before updater quit", { cause }),
          ),
          Effect.withSpan("desktop.lifecycle.beforeQuitForUpdate"),
        ),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(event, runEffect, quit);
    });
    yield* electronApp.on("activate", () => {
      void runEffect(
        Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          if (yield* Ref.get(state.quitting)) return;
          yield* desktopWindow.activate;
        }).pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
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
        quitFromSignal("SIGINT", runEffect, quit);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runEffect, quit);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
