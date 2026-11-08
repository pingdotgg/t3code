import type { PointerEvent } from "react";

// The tree renders in a shadow root and exposes no row title, so the host sets it on hover.
// Only a cut-off name gets one; a title on a fully visible name would repeat what the row shows.
function findTreeRow(event: PointerEvent<HTMLElement>): HTMLElement | null {
  for (const node of event.nativeEvent.composedPath()) {
    if (node instanceof HTMLElement && node.hasAttribute("data-item-path")) return node;
  }
  return null;
}

function isNameCutOff(row: HTMLElement): boolean {
  return Array.from(row.querySelectorAll<HTMLElement>("[data-truncate-content='visible']")).some(
    (text) => text.scrollWidth > text.clientWidth,
  );
}

export function showFullPathOnPointerOver(
  event: PointerEvent<HTMLElement>,
  toDisplayPath: (modelPath: string) => string = (modelPath) => modelPath,
): void {
  const row = findTreeRow(event);
  const path = row?.getAttribute("data-item-path");
  if (!row || !path) return;
  if (isNameCutOff(row)) row.title = toDisplayPath(path.replace(/\/$/, ""));
  else row.removeAttribute("title");
}

// Rows are recycled while scrolling, so a stale title would name the wrong path.
export function clearFullPathOnPointerOut(event: PointerEvent<HTMLElement>): void {
  findTreeRow(event)?.removeAttribute("title");
}
