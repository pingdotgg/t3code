// @effect-diagnostics globalDate:off globalTimers:off -- Synchronous before-input-event handler; key events must be timed and the watchdog scheduled outside any Effect runtime.

import type { QuitConfirmationMode, QuitShortcutHintEvent } from "@t3tools/contracts";

export const QUIT_HOLD_DURATION_MS = 1200;
export const QUIT_DOUBLE_PRESS_MS = 500;
// "Still held" is proven by auto-repeat keydowns, not by the absence of a
// release: macOS suppresses a letter keyUp while the command key is down, so a
// tap release can go completely unseen and a release-based timer would quit
// anyway. Once held, quitting waits for Q keyUp or a quiet grace period after
// repeats stop so they cannot reach the next app.
const QUIT_HOLD_RELEASE_GRACE_MS = 600;
// A slow repeat rate can exceed the fixed grace. Waiting for two observed
// cadences keeps the timer behind the next repeat without slowing normal rates.
const QUIT_HOLD_REPEAT_CADENCE_MULTIPLIER = 2;

export interface QuitHoldKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

export interface QuitShortcutOptions {
  readonly platform: NodeJS.Platform;
  readonly getMode: () => Promise<QuitConfirmationMode>;
  readonly notify: (event: QuitShortcutHintEvent) => void;
  readonly concealWindow: () => void;
  readonly quit: () => void;
}

export function makeQuitShortcutHandler(
  options: QuitShortcutOptions,
): (event: { preventDefault: () => void }, input: QuitHoldKeyInput) => void {
  const modifierKey = options.platform === "darwin" ? "meta" : "control";
  let watchdog: NodeJS.Timeout | undefined;
  let holding = false;
  let mode: QuitConfirmationMode | undefined;
  let notified = false;
  let armed = false;
  let quitOnRelease = false;
  let heldSince = 0;
  let lastPressAt = 0;
  let lastRepeatAt = 0;
  let repeatCadenceMs = 0;
  // Incremented when a press is superseded or explicitly cancelled. A plain
  // key release does not invalidate its pending mode read: a direct-mode
  // press must still quit after that read settles.
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const release = (cancelPendingMode = true, keepDoublePressHint = false) => {
    if (cancelPendingMode) generation += 1;
    if (!holding && !notified) return;
    const keepHint = keepDoublePressHint && mode === "double-click" && notified;
    holding = false;
    armed = false;
    quitOnRelease = false;
    lastRepeatAt = 0;
    repeatCadenceMs = 0;
    if (keepHint) return;

    mode = undefined;
    clearWatchdog();
    if (notified) {
      notified = false;
      options.notify({ state: "up" });
    }
  };

  const quitNow = () => {
    release();
    lastPressAt = 0;
    options.quit();
  };

  const quitAfterQuietPeriod = () => {
    clearWatchdog();
    const quietPeriodMs = Math.max(
      QUIT_HOLD_RELEASE_GRACE_MS,
      repeatCadenceMs * QUIT_HOLD_REPEAT_CADENCE_MULTIPLIER,
    );
    watchdog = setTimeout(quitNow, quietPeriodMs);
  };

  return (event, input) => {
    const key = input.key.toLowerCase();
    if (input.type === "keyUp") {
      if (key === "q") {
        const shouldQuit = quitOnRelease;
        release(false, true);
        if (shouldQuit) options.quit();
      } else if (key === modifierKey) {
        if (!quitOnRelease) {
          release(false, true);
        } else {
          quitAfterQuietPeriod();
        }
      }
      return;
    }
    if (input.type !== "keyDown") return;

    const modifierDown = options.platform === "darwin" ? input.meta : input.control;
    if (input.isAutoRepeat && modifierDown && key === "q") {
      const now = Date.now();
      repeatCadenceMs = now - (lastRepeatAt === 0 ? heldSince : lastRepeatAt);
      lastRepeatAt = now;
    }
    if (quitOnRelease) {
      event.preventDefault();
      if (key === "q") quitAfterQuietPeriod();
      return;
    }

    if (!modifierDown || input.alt || input.shift || key !== "q") {
      if (key === modifierKey && !input.alt && !input.shift) return;

      // Keep this separate from release(), which also runs when a fresh Q
      // keydown follows a keyUp that macOS did not deliver.
      if (!input.isAutoRepeat) {
        lastPressAt = 0;
        release();
      }
      return;
    }

    event.preventDefault();

    if (input.isAutoRepeat) {
      if (mode === "hold" && armed && Date.now() - heldSince >= QUIT_HOLD_DURATION_MS) {
        armed = false;
        quitOnRelease = true;
        options.concealWindow();
        quitAfterQuietPeriod();
      }
      return;
    }

    const now = Date.now();
    const previousPressAt = lastPressAt;
    lastPressAt = now;
    if (holding || notified) release();

    generation += 1;
    if (previousPressAt !== 0 && now - previousPressAt <= QUIT_DOUBLE_PRESS_MS) {
      quitNow();
      return;
    }

    const pressGeneration = generation;
    holding = true;
    heldSince = now;
    void options.getMode().then(
      (resolvedMode) => {
        if (generation !== pressGeneration) return;
        if (resolvedMode === "direct") {
          quitNow();
          return;
        }
        if (resolvedMode === "double-click") {
          const remainingMs = QUIT_DOUBLE_PRESS_MS - (Date.now() - now);
          if (remainingMs <= 0) {
            release();
            return;
          }
          mode = resolvedMode;
          notified = true;
          options.notify({ state: "down", mode: resolvedMode });
          watchdog = setTimeout(release, remainingMs);
          return;
        }

        if (!holding) return;

        mode = resolvedMode;
        notified = true;
        options.notify({ state: "down", mode: resolvedMode });

        armed = true;
        watchdog = setTimeout(() => {
          watchdog = undefined;
          release();
        }, QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
      },
      () => {
        if (generation !== pressGeneration) return;
        quitNow();
      },
    );
  };
}
