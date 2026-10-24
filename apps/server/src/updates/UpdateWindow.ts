import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as RestartWork from "./RestartWork.ts";

/** How long every client must be untouched before an update may run. */
const QUIET_PERIOD = Duration.minutes(2);
/** A restart disconnects every client, so it waits longer than an install. */
const RESTART_QUIET_PERIOD = Duration.minutes(5);

/**
 * Decides when a background update may replace something without anyone
 * noticing: no client was used for 2 minutes (5 before a restart), no run is
 * active, and no provider installer is running on this host. A server restart
 * also waits for restart-sensitive work and busy terminals, which an install
 * does not touch.
 */
export class UpdateWindow extends Context.Service<
  UpdateWindow,
  {
    /**
     * Whether the window is open. A failed read counts as closed: guessing
     * "idle" could cut off a run. A caller that already holds an install lock
     * passes `ignoreInstallLocks`, or its own lock would close the window.
     */
    readonly isOpen: (options?: {
      readonly ignoreInstallLocks?: boolean;
      /** The caller will restart this server: clones, workspace setup and busy terminals would be lost. */
      readonly restartsServer?: boolean;
    }) => Effect.Effect<boolean>;
    /** Runs `effect` if the window is open, otherwise returns `None` without running it. */
    readonly runIfOpen: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly restartsServer?: boolean },
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("t3/updates/UpdateWindow") {}

const make = Effect.gen(function* () {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const installLock = yield* ProviderInstallLock.ProviderInstallLock;
  const restartWork = yield* RestartWork.RestartWork;
  const terminals = yield* TerminalManager.TerminalManager;

  const isOpen: UpdateWindow["Service"]["isOpen"] = Effect.fn("updates.UpdateWindow.isOpen")(
    function* (options) {
      const quietPeriod = options?.restartsServer ? RESTART_QUIET_PERIOD : QUIET_PERIOD;
      if (Duration.isLessThan(yield* backgroundPolicy.sinceLastClientInteraction, quietPeriod)) {
        return false;
      }
      // Includes native background work that outlives its parent run.
      const activeThreadIds = yield* projections.getRecoveryThreadIds("active-work").pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read active runs", { cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(activeThreadIds) || activeThreadIds.value.length > 0) return false;
      if (options?.restartsServer) {
        if ((yield* restartWork.count) > 0 || (yield* terminals.hasBusyTerminals)) return false;
      }
      if (options?.ignoreInstallLocks) return true;
      // Covers manual updates and installs started by other servers on this host.
      return !(yield* installLock.anyHeld.pipe(Effect.orElseSucceed(() => true)));
    },
  );

  const runIfOpen: UpdateWindow["Service"]["runIfOpen"] = (effect, options) =>
    isOpen(options).pipe(
      Effect.flatMap((open) => (open ? Effect.asSome(effect) : Effect.succeedNone)),
    );

  return UpdateWindow.of({ isOpen, runIfOpen });
});

export const layer = Layer.effect(UpdateWindow, make);
