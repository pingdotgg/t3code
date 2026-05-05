export function isElementFixed(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    const position = window.getComputedStyle(current).position;
    if (position === "fixed" || position === "sticky") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

export function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  return {
    left: Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160),
    top: Math.min(Math.max(rect.bottom + 12, 12), window.innerHeight - 240),
  };
}
