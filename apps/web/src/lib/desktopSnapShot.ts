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

const pendingSnapShotContexts = new Map<string, Promise<void>>();

/** Captures land before their window text; sends wait here so the text still goes out with them. */
export function trackSnapShotContext(id: string, filled: Promise<void>): void {
  const tracked: Promise<void> = filled
    .catch(() => undefined)
    .finally(() => {
      if (pendingSnapShotContexts.get(id) === tracked) pendingSnapShotContexts.delete(id);
    });
  pendingSnapShotContexts.set(id, tracked);
}

export function waitForSnapShotContexts(ids: ReadonlyArray<string>): Promise<void> | null {
  const pending = ids.flatMap((id) => pendingSnapShotContexts.get(id) ?? []);
  return pending.length > 0 ? Promise.all(pending).then(() => undefined) : null;
}
