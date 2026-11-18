// Bridges the board-only embed to the T3 Code window that frames it as a right-panel tab.
import {
  highlightRegion,
  hoverRegion,
  onBoardReady,
  onRefToChat,
  type HoverOrigin,
} from "./bridge";

const toParent = (message: { type: string; ref?: string }) =>
  window.parent.postMessage(message, location.origin);

const isOrigin = (value: unknown): value is HoverOrigin =>
  typeof value === "object" &&
  value !== null &&
  Number.isFinite((value as HoverOrigin).x) &&
  Number.isFinite((value as HoverOrigin).y);

export function startPanelHost(): void {
  let ready = false;
  // A highlight sent before the board can frame it waits here; only the latest counts.
  let pendingHighlight: string | undefined;

  onBoardReady(() => {
    if (ready) return;
    ready = true;
    if (pendingHighlight !== undefined) highlightRegion(pendingHighlight);
    pendingHighlight = undefined;
    toParent({ type: "wb-ready" });
  });

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      window.parent === window ||
      event.source !== window.parent ||
      event.origin !== location.origin ||
      typeof event.data !== "object" ||
      event.data === null
    )
      return;
    const { type, ref, origin } = event.data as { type?: unknown; ref?: unknown; origin?: unknown };
    if (type === "wb-highlight" && typeof ref === "string") {
      if (ready) highlightRegion(ref);
      else pendingHighlight = ref;
    }
    if (type === "wb-hover" && (typeof ref === "string" || ref === null))
      hoverRegion(ref, isOrigin(origin) ? origin : undefined);
  });

  onRefToChat((ref) => toParent({ type: "wb-insert-ref", ref }));
}
