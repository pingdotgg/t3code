/**
 * The reduced-motion decision, in one place so the CSS attribute, the scroll
 * helpers, and the composer transition cannot disagree.
 *
 * The setting forces it on; the OS preference can also ask for it. Nothing here
 * turns it off — asking for less motion in either place wins.
 */
export function prefersReducedMotion(reduceMotionSetting: boolean): boolean {
  if (reduceMotionSetting) return true;
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Mirrors the setting onto `<html>` so the stylesheet can react to it. */
export function syncReducedMotionAttribute(reduceMotionSetting: boolean): void {
  if (typeof document === "undefined") return;
  if (reduceMotionSetting) {
    document.documentElement.dataset.reduceMotion = "true";
  } else {
    delete document.documentElement.dataset.reduceMotion;
  }
}
