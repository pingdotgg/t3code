import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";

/** How long every client must be untouched before an update may run. */
const QUIET_PERIOD = Duration.minutes(2);

/**
 * Decides when a background update may replace something without anyone
 * noticing: no client was used for 2 minutes, no run is active, and no
 * provider installer is running on this host.
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
    }) => Effect.Effect<boolean>;
    /** Runs `effect` if the window is open, otherwise returns `None` without running it. */
    readonly runIfOpen: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("t3/updates/UpdateWindow") {}

const make = Effect.gen(function* () {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const installLock = yield* ProviderInstallLock.ProviderInstallLock;

  const isOpen: UpdateWindow["Service"]["isOpen"] = Effect.fn("updates.UpdateWindow.isOpen")(
    function* (options) {
      if (Duration.isLessThan(yield* backgroundPolicy.sinceLastClientInteraction, QUIET_PERIOD)) {
        return false;
      }
      // Preparing, starting, running, or waiting on an approval or question.
      const activeThreadIds = yield* projections.getRecoveryThreadIds("active-work").pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Update window could not read active runs", { cause }),
        ),
        Effect.option,
      );
      if (Option.isNone(activeThreadIds) || activeThreadIds.value.length > 0) return false;
      if (options?.ignoreInstallLocks) return true;
      // Covers manual updates and installs started by other servers on this host.
      return !(yield* installLock.anyHeld.pipe(Effect.orElseSucceed(() => true)));
    },
  );

  const runIfOpen: UpdateWindow["Service"]["runIfOpen"] = (effect) =>
    isOpen().pipe(Effect.flatMap((open) => (open ? Effect.asSome(effect) : Effect.succeedNone)));

  return UpdateWindow.of({ isOpen, runIfOpen });
});

export const layer = Layer.effect(UpdateWindow, make);
