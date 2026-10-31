/** Search portaled layers only; shortcut checks must not scan the growing pane tree. */
export function findInOpenLayers(selector: string): Element | null {
  if (typeof document === "undefined") return null;
  for (const layer of document.body.children) {
    if (layer.id === "root") continue;
    if (layer.matches(selector)) return layer;
    const match = layer.querySelector(selector);
    if (match) return match;
  }
  return null;
}

/** Whether `selector` matches in a portaled layer (see `findInOpenLayers`). */
export function openLayerMatches(selector: string): boolean {
  return findInOpenLayers(selector) !== null;
}
