import type { DesktopNotificationTarget } from "@t3tools/contracts";

export interface DesktopNotificationTargetDrainOptions {
  readonly consume: () => Promise<DesktopNotificationTarget | null>;
  readonly onTarget: (target: DesktopNotificationTarget) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface DesktopNotificationTargetDrain {
  /** Pulls whatever main has parked and navigates to it, if anything. */
  readonly drain: () => void;
  readonly dispose: () => void;
}

/**
 * The renderer half of signal-then-pull click routing.
 *
 * Subscribing is not enough on its own: a click can land before this code exists
 * at all — a cold start, or a window recreated after the last one closed — and
 * main parked the target for exactly that case. So the drain also runs once
 * immediately.
 *
 * A drain that resolves after disposal is dropped rather than navigated,
 * otherwise an unmounting view could yank the route out from under its
 * replacement.
 */
export function createDesktopNotificationTargetDrain(
  options: DesktopNotificationTargetDrainOptions,
): DesktopNotificationTargetDrain {
  let disposed = false;

  const drain = () => {
    void options.consume().then((target) => {
      if (disposed || target === null) return;
      options.onTarget(target);
    });
  };

  const unsubscribe = options.subscribe(drain);
  drain();

  return {
    drain,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
