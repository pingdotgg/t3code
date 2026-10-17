// Hidden kept views retain popup DOM and attributes; global checks must skip them.
export function queryShownElement(selector: string): Element | null {
  if (typeof document === "undefined") return null;
  for (const element of document.querySelectorAll(selector)) {
    const shown =
      typeof element.checkVisibility === "function"
        ? element.checkVisibility()
        : element.getClientRects().length > 0;
    if (shown) return element;
  }
  return null;
}
