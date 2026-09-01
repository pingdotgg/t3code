// @effect-diagnostics globalDate:off globalTimers:off -- Synchronous before-input-event handler; key events must be timed and the watchdog scheduled outside any Effect runtime.

import type { QuitConfirmationMode } from "@t3tools/contracts";

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

export type QuitHoldState = "down" | "up";

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
  readonly notify: (state: QuitHoldState) => void;
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
  // Incremented on every new press and every release/quit so a pending
  // getMode() resolution from a superseded press cannot arm (or quit for)
  // the current one.
  let generation = 0;

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };

  const release = () => {
    if (!holding) return;
    generation += 1;
    holding = false;
    mode = undefined;
    armed = false;
    quitOnRelease = false;
    clearWatchdog();
    if (notified) {
      notified = false;
      options.notify("up");
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
        release();
        if (shouldQuit) options.quit();
      } else if (key === modifierKey) {
        if (!quitOnRelease) {
          release();
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
      // Any other key (or an extra modifier) pressed mid-hold breaks the
      // gesture; without this the hold timer keeps running through the
      // interruption and the next qualifying repeat would quit early. The
      // interrupted press also stops counting toward a double press, but only
      // here, not in release(), which runs mid-restart on an unseen-release
      // re-press and must not wipe that press's own tap timestamp.
      if (holding && !input.isAutoRepeat) {
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
    // A fresh keydown while "holding" means the key came back down after a
    // release macOS never delivered.
    if (holding) release();

    generation += 1;
    const pressGeneration = generation;
    holding = true;
    heldSince = now;
    void options.getMode().then(
      (resolvedMode) => {
        if (generation !== pressGeneration) return;
        mode = resolvedMode;
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

        notified = true;
        options.notify("down");
        if (resolvedMode === "double-click") {
          watchdog = setTimeout(release, QUIT_DOUBLE_PRESS_MS);
          return;
        }

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
