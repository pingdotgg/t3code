// @effect-diagnostics globalDate:off globalTimers:off -- Synchronous before-input-event handler; key events must be timed and the watchdog scheduled outside any Effect runtime.

import type { QuitConfirmationMode, QuitShortcutHintEvent } from "@t3tools/contracts";

// The quit accelerator is intercepted in before-input-event, which runs
// before the native menu accelerator. Quitting from the application menu is
// untouched and always quits immediately.
export const QUIT_HOLD_DURATION_MS = 1200;
export const QUIT_DOUBLE_PRESS_MS = 500;
// "Still held" is proven by auto-repeat keydowns, not by the absence of a
// release: macOS suppresses a letter keyUp while the command key is down, so a
// tap release can go completely unseen and a release-based timer would quit
// anyway. Once held, quitting waits for Q keyUp or a quiet grace period after
// modifier keyUp so repeats cannot reach the next app. Keyboards with
// auto-repeat disabled fall back to the application menu Quit action.
export const QUIT_HOLD_RELEASE_GRACE_MS = 600;

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
  // Set once getMode resolves to hold; auto-repeats may only complete the hold when armed.
  let armed = false;
  let quitOnRelease = false;
  let heldSince = 0;
  let lastPressAt = 0;
  // Incremented when a press is superseded or explicitly cancelled. A plain
  // key release does not invalidate its pending mode read: direct mode and a
  // completed second press must still be honored after that read settles.
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const release = (cancelPendingMode = true, keepDoublePressHint = false) => {
    if (!holding && !notified) return;
    const keepHint = keepDoublePressHint && mode === "double-click" && notified;
    if (cancelPendingMode) generation += 1;
    holding = false;
    armed = false;
    quitOnRelease = false;
    if (keepHint) return;

    mode = undefined;
    clearWatchdog();
    if (notified) {
      notified = false;
      options.notify({ state: "up" });
    }
  };

  // Dismisses any overlay first so a cancelled quit cannot leave a stale hint.
  const quitNow = () => {
    release();
    options.quit();
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
          watchdog = setTimeout(quitNow, QUIT_HOLD_RELEASE_GRACE_MS);
        }
      }
      return;
    }
    if (input.type !== "keyDown") return;

    if (quitOnRelease && input.isAutoRepeat && key === "q") {
      event.preventDefault();
      clearWatchdog();
      return;
    }

    const modifierDown = options.platform === "darwin" ? input.meta : input.control;
    if (!modifierDown || input.alt || input.shift || key !== "q") {
      // Re-pressing the platform modifier is the first half of a second full
      // quit shortcut, so it must not cancel an active double-press window.
      if (key === modifierKey && !input.alt && !input.shift) return;

      // Any other key (or an extra modifier) pressed mid-hold breaks the
      // gesture; without this the hold timer keeps running through the
      // interruption and the next qualifying repeat would quit early. The
      // interrupted press also stops counting toward a double press, but only
      // here, not in release(), which runs mid-restart on an unseen-release
      // re-press and must not wipe that press's own tap timestamp.
      if ((holding || notified) && !input.isAutoRepeat) {
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
        clearWatchdog();
      }
      return;
    }

    const now = Date.now();
    const previousPressAt = lastPressAt;
    lastPressAt = now;
    // A fresh keydown supersedes the current physical hold or the hint kept
    // alive after a detected release.
    if (holding || notified) release();

    generation += 1;
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
        if (
          resolvedMode === "double-click" &&
          previousPressAt !== 0 &&
          now - previousPressAt <= QUIT_DOUBLE_PRESS_MS
        ) {
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

        // A hold cannot be armed after its physical press has ended.
        if (!holding) return;

        mode = resolvedMode;
        notified = true;
        options.notify({ state: "down", mode: resolvedMode });

        armed = true;
        // No auto-repeat by then means the key was released (possibly with a
        // suppressed keyUp) or repeat is disabled; either way, don't quit.
        watchdog = setTimeout(() => {
          watchdog = undefined;
          release();
        }, QUIT_HOLD_DURATION_MS + QUIT_HOLD_RELEASE_GRACE_MS);
      },
      // A failed settings read must never strand the quit request.
      () => {
        if (generation !== pressGeneration) return;
        quitNow();
      },
    );
  };
}
