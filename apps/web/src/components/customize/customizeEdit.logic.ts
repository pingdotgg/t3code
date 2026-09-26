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
