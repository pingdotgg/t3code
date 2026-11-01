// `dismiss` settles on the keyboard's hide event; don't leave the feed paused if that never comes.
const KEYBOARD_CLOSE_TIMEOUT_MS = 1_000;

export interface ThreadEndRepinDeps {
  readonly canFollowEnd: () => boolean;
  readonly scrollToEnd: (animated: boolean) => Promise<void>;
  readonly onScrollFailed: () => void;
  readonly isKeyboardOpen: () => boolean;
  readonly blurComposer: () => void;
  readonly dismissKeyboard: () => Promise<void>;
  readonly nextFrame: () => Promise<void>;
  readonly onKeyboardClosingChange: (closing: boolean) => void;
}

/**
 * Pins a followed feed to its end without colliding with a keyboard close.
 *
 * A pin freezes keyboard-driven inset updates, so a close that starts during one is swallowed and
 * leaves a phantom bottom inset. The two take turns: a close waits for a running pin to finish, pins
 * that come due during the close are dropped, and the close ends with one pin of its own.
 */
export function createThreadEndRepin() {
  let activePin: Promise<void> | null = null;
  let activeClose: Promise<boolean> | null = null;

  const repin = (deps: ThreadEndRepinDeps, animated = false) => {
    if (activeClose !== null || !deps.canFollowEnd()) return;
    const pin: Promise<void> = deps
      .scrollToEnd(animated)
      .catch(deps.onScrollFailed)
      .then(() => {
        if (activePin === pin) activePin = null;
      });
    activePin = pin;
  };

  const runClose = async (deps: ThreadEndRepinDeps, animated: boolean) => {
    deps.onKeyboardClosingChange(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (activePin !== null) await activePin;
      // The feed must stop following before the close starts.
      await deps.nextFrame();
      deps.blurComposer();
      await Promise.race([
        deps.dismissKeyboard(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, KEYBOARD_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      activeClose = null;
      deps.onKeyboardClosingChange(false);
    }
    // A row measured during the close is still below the composer; bring it into view.
    repin(deps, animated);
    return true;
  };

  /** Resolves to whether the feed was pinned, which only happens when a keyboard had to close. */
  const closeKeyboard = (deps: ThreadEndRepinDeps, animated: boolean): Promise<boolean> => {
    if (activeClose !== null) return activeClose;
    // With no keyboard to wait for, the feed must keep following the row being added.
    if (!deps.isKeyboardOpen()) {
      deps.blurComposer();
      return Promise.resolve(false);
    }
    activeClose = runClose(deps, animated);
    return activeClose;
  };

  return { repin, closeKeyboard };
}
