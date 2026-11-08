import type { PointerEvent } from "react";

// The tree renders in a shadow root and exposes no row title, so the host sets it on hover.
function findTreeRow(event: PointerEvent<HTMLElement>): HTMLElement | null {
  for (const node of event.nativeEvent.composedPath()) {
    if (node instanceof HTMLElement && node.hasAttribute("data-item-path")) return node;
  }
  return null;
}

export function showFullPathOnPointerOver(event: PointerEvent<HTMLElement>): void {
  const row = findTreeRow(event);
  const path = row?.getAttribute("data-item-path");
  if (row && path) row.title = path.replace(/\/$/, "");
}

// Rows are recycled while scrolling, so a stale title would name the wrong path.
export function clearFullPathOnPointerOut(event: PointerEvent<HTMLElement>): void {
  findTreeRow(event)?.removeAttribute("title");
}
