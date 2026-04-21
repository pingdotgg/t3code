export type RevealSubscription = (listener: () => void) => void;

/**
 * Wire a reveal callback to fire exactly once, on whichever of the provided
 * event subscribers fires first. Each subscriber is responsible for binding
 * its own event source.
 *
 * Used by the desktop main window's first-paint reveal logic. The standard
 * Electron pattern is to wait for `ready-to-show` before calling `show()`,
 * but on Linux/Wayland with `show: false`, `ready-to-show` only fires after
 * `show()` is called, deadlocking that pattern. Subscribing to both
 * `ready-to-show` and `did-finish-load` (or any other "renderer is alive"
 * signal) lets the window surface reliably across platforms.
 */
export function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}
