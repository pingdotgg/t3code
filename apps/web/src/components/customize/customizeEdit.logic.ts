/**
 * Geometry for editing a surface in place: where a dragged element would
 * land, and where the arrow keys move it. Elements on every editable surface
 * sit in one horizontal row, so only their horizontal extents matter.
 */

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PlacedElement {
  readonly id: string;
  readonly rect: Rect;
}

export interface DropTarget {
  /** The element the dragged one lands before, or null for the end. */
  readonly beforeId: string | null;
  /** Where to draw the insertion caret. */
  readonly caretX: number;
}

/** Elements left to right, as they appear. */
const byPosition = (elements: ReadonlyArray<PlacedElement>) =>
  [...elements].toSorted((a, b) => a.rect.left - b.rect.left);

/**
 * The drop destination for `activeId` with the pointer at `pointerX`: before
 * the first other element whose centre lies past the pointer.
 */
export function resolveDropTarget(
  elements: ReadonlyArray<PlacedElement>,
  activeId: string,
  pointerX: number,
): DropTarget | null {
  const others = byPosition(elements.filter((element) => element.id !== activeId));
  if (others.length === 0) return null;
  const index = others.findIndex(
    (element) => (element.rect.left + element.rect.right) / 2 >= pointerX,
  );
  if (index === -1) {
    return { beforeId: null, caretX: others.at(-1)!.rect.right + 3 };
  }
  const before = others[index]!;
  const previous = others[index - 1];
  return {
    beforeId: before.id,
    caretX: previous ? (previous.rect.right + before.rect.left) / 2 : before.rect.left - 3,
  };
}

/**
 * Where an arrow key moves `activeId` one step through `order`, the surface's
 * current order: before its left neighbour, or past its right neighbour.
 * Working from the saved order rather than measured positions keeps quick
 * repeated presses correct before the page has re-laid out. Null at an edge.
 */
export function resolveKeyboardMove(
  order: ReadonlyArray<string>,
  activeId: string,
  direction: "left" | "right",
): { beforeId: string | null } | null {
  const index = order.indexOf(activeId);
  if (index === -1) return null;
  if (direction === "left") {
    const neighbour = order[index - 1];
    return neighbour ? { beforeId: neighbour } : null;
  }
  if (index === order.length - 1) return null;
  return { beforeId: order[index + 2] ?? null };
}

/** The smallest rect holding every non-empty rect, or null when all are empty. */
export function unionRect(rects: ReadonlyArray<Rect>): Rect | null {
  const visible = rects.filter((rect) => rect.right - rect.left > 0 && rect.bottom - rect.top > 0);
  if (visible.length === 0) return null;
  return {
    left: Math.min(...visible.map((rect) => rect.left)),
    top: Math.min(...visible.map((rect) => rect.top)),
    right: Math.max(...visible.map((rect) => rect.right)),
    bottom: Math.max(...visible.map((rect) => rect.bottom)),
  };
}

/** Group near-aligned controls into rows before sorting each row left to right. */
export function readingOrder<T extends PlacedElement>(elements: ReadonlyArray<T>): T[] {
  const pending = [...elements].sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
  );
  const ordered: T[] = [];
  while (pending.length > 0) {
    const top = pending[0]!.rect.top;
    const end = pending.findIndex((element) => element.rect.top > top + 8);
    const row = pending.splice(0, end === -1 ? pending.length : end);
    ordered.push(...row.sort((a, b) => a.rect.left - b.rect.left));
  }
  return ordered;
}

/** The next editing control, with handles ordered as they appear on the canvas. */
export function resolveCustomizeTabTarget(
  layer: HTMLElement,
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  const controls = [
    ...layer.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
  ]
    .filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled, [aria-disabled="true"]') &&
        !element.closest("[hidden], [inert]") &&
        getComputedStyle(element).visibility !== "hidden" &&
        element.getClientRects().length > 0,
    )
    .sort((a, b) => {
      const order = (element: HTMLElement) => {
        const value =
          element.closest<HTMLElement>("[data-customize-order]")?.dataset.customizeOrder;
        return value === undefined ? Infinity : Number(value);
      };
      return order(a) - order(b);
    });
  const index = controls.findIndex((element) => element === active);
  if (index === -1) return (backwards ? controls.at(-1) : controls[0]) ?? null;
  return controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length] ?? null;
}

/** Editing an app field keeps its native Escape behavior; mode controls use Escape to exit. */
export function preservesNativeCustomizeEscape(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      "input:not([type=range]), textarea, select, [contenteditable]:not([contenteditable=false])",
    ) &&
    !target.closest("[data-customize-popover], [data-customize-edit]")
  );
}

/** Overlay popups own keyboard and focus handling; inline lists and panels do not. */
export function hasOpenCustomizePopup(): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [data-open][role="menu"], [data-open][role="listbox"], [data-slot$="-popup"]:not([data-slot="tooltip-popup"])',
    ),
  ].some((element) => {
    if (element.matches("[data-customize-popover]")) return false;
    if (element.closest('[hidden], [inert], [data-closed], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  });
}

/**
 * Whether an element can be reordered where it renders. The legacy sidebar
 * keeps the pull request badge in its leading slot, so moving it there would
 * change nothing visible.
 */
export function isMovable(
  surface: string,
  id: string,
  sortable: boolean,
  legacySidebar: boolean,
): boolean {
  return sortable && !(legacySidebar && surface === "threadRow" && id === "pullRequest");
}
