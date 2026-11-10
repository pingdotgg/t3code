import type { DesktopBridge } from "@t3tools/contracts";

const SNAP_SHOT_FOCUS_EVENT = "t3code:focus-composer";

export function dispatchSnapShotComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SNAP_SHOT_FOCUS_EVENT));
}

export function subscribeSnapShotComposerFocus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SNAP_SHOT_FOCUS_EVENT, listener);
  return () => window.removeEventListener(SNAP_SHOT_FOCUS_EVENT, listener);
}

export function getDesktopSnapShotBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}
