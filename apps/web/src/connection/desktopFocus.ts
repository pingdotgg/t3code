import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface DesktopFocusSnapshot {
  readonly visibilityState: DocumentVisibilityState;
  readonly hasFocus: boolean;
}

export function isDesktopClientFocused(snapshot: DesktopFocusSnapshot): boolean {
  return snapshot.visibilityState === "visible" && snapshot.hasFocus;
}

function readDesktopFocus(documentTarget: Document): boolean {
  return isDesktopClientFocused({
    visibilityState: documentTarget.visibilityState,
    hasFocus: documentTarget.hasFocus(),
  });
}

/**
 * Reports an initial value and every browser focus/visibility transition.
 * Stream.changes collapses focus+visibility events that describe the same
 * effective state.
 */
export function desktopFocusChanges(
  windowTarget: Window,
  documentTarget: Document,
): Stream.Stream<boolean> {
  return Stream.callback<boolean>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const report = () => Queue.offerUnsafe(queue, readDesktopFocus(documentTarget));
        windowTarget.addEventListener("focus", report);
        windowTarget.addEventListener("blur", report);
        documentTarget.addEventListener("visibilitychange", report);
        report();
        return report;
      }),
      (report) =>
        Effect.sync(() => {
          windowTarget.removeEventListener("focus", report);
          windowTarget.removeEventListener("blur", report);
          documentTarget.removeEventListener("visibilitychange", report);
        }),
    ).pipe(Effect.asVoid),
  ).pipe(Stream.changes);
}
