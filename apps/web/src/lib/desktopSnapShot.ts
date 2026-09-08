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

type SnapShotMethods =
  | "requestSnapShotPermissions"
  | "getSnapShotState"
  | "checkSnapShotShortcut"
  | "setSnapShotShortcutSuppressed"
  | "listPendingSnapShots"
  | "readSnapShot"
  | "acknowledgeSnapShot"
  | "onSnapShotEvent";

export type DesktopSnapShotBridge = DesktopBridge & Required<Pick<DesktopBridge, SnapShotMethods>>;

export function getDesktopSnapShotBridge(): DesktopSnapShotBridge | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (
    typeof bridge?.requestSnapShotPermissions !== "function" ||
    typeof bridge?.getSnapShotState !== "function" ||
    typeof bridge.checkSnapShotShortcut !== "function" ||
    typeof bridge.setSnapShotShortcutSuppressed !== "function" ||
    typeof bridge.listPendingSnapShots !== "function" ||
    typeof bridge.readSnapShot !== "function" ||
    typeof bridge.acknowledgeSnapShot !== "function" ||
    typeof bridge.onSnapShotEvent !== "function"
  ) {
    return undefined;
  }

  return bridge as DesktopSnapShotBridge;
}
