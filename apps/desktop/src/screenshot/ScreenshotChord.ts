// @effect-diagnostics globalDate:off -- Synchronous flags handler; debounce timing lives outside any Effect runtime.

// Both-Command-keys screenshot chord. The helper process reports raw
// left/right ⌘ state (see native/screenshot-helper/main.swift); this decides
// when that state means "capture". A chord fires once when both keys become
// held, and both must be fully released before it can fire again, so holding
// the pair never repeats and a one-sided re-press is not a new chord.
export const SCREENSHOT_CHORD_REFIRE_MS = 500;

export interface ScreenshotChordFlags {
  readonly left: boolean;
  readonly right: boolean;
}

export interface ScreenshotChordOptions {
  readonly isEnabled: () => Promise<boolean>;
  readonly capture: () => void;
}

export function makeScreenshotChordHandler(
  options: ScreenshotChordOptions,
): (flags: ScreenshotChordFlags) => void {
  let armed = true;
  let lastFireAt = 0;
  // Incremented on every fire so a pending isEnabled() resolution from a
  // superseded chord cannot capture for a later one.
  let generation = 0;

  return (flags) => {
    if (!flags.left && !flags.right) {
      armed = true;
      return;
    }
    if (!flags.left || !flags.right) return;
    // Disarm on the first both-down report: duplicate flags events (e.g.
    // another modifier toggling mid-chord) must not fire twice.
    if (!armed) return;
    armed = false;
    const now = Date.now();
    if (now - lastFireAt < SCREENSHOT_CHORD_REFIRE_MS) return;
    lastFireAt = now;
    generation += 1;
    const chordGeneration = generation;
    void options.isEnabled().then(
      (enabled) => {
        if (generation !== chordGeneration) return;
        if (enabled) options.capture();
      },
      // A failed settings read captures nothing.
      () => {},
    );
  };
}
