/**
 * Whether a key goes to a shortcut recorder (`data-keybinding-capture`).
 * Window-level shortcut handlers yield to it, so the chord is recorded
 * instead of run.
 */
export function isKeybindingCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-keybinding-capture]") !== null;
}
