import type { InterfaceLayout } from "@t3tools/contracts";

import {
  INTERFACE_SURFACES,
  type InterfaceElementDefinition,
  type InterfaceSurfaceId,
  moveSurfaceElementBefore,
  resolveSurfaceLayout,
} from "../../interfaceLayout";

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

/** Movable controls on the canvas, or every list item when measuredIds is null. */
export function resolveCustomizeMoveOrder(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  measuredIds: ReadonlySet<string> | null,
  legacySidebar: boolean,
) {
  const resolved = resolveSurfaceLayout(surface, layout);
  const definitions: ReadonlyArray<InterfaceElementDefinition> = INTERFACE_SURFACES[surface];
  return resolved.order.filter(
    (id) =>
      (measuredIds === null || (measuredIds.has(id) && !resolved.hidden.has(id))) &&
      isMovable(
        surface,
        id,
        definitions.find((definition) => definition.id === id)?.sortable === true,
        legacySidebar,
      ),
  );
}

/** Apply a keyboard or list step to the latest queued layout. */
export function moveCustomizeElementByKeyboard(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  activeId: string,
  direction: "left" | "right",
  measuredIds: ReadonlySet<string> | null,
  legacySidebar: boolean,
): InterfaceLayout {
  const order = resolveCustomizeMoveOrder(layout, surface, measuredIds, legacySidebar);
  const move = resolveKeyboardMove(order, activeId, direction);
  return move ? moveSurfaceElementBefore(layout, surface, activeId, move.beforeId) : layout;
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

function customizeFocusableControls(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex], [role="switch"]',
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled, [aria-disabled="true"], [data-disabled]') &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== "hidden" &&
      element.getClientRects().length > 0,
  );
}

/** The first visible control in an item's list row, or the row when it has none. */
export function resolveCustomizeRowTarget(row: HTMLElement): HTMLElement {
  return customizeFocusableControls(row)[0] ?? row;
}

/** Keep focus in the same list item when its arrow is disabled or its row is reinserted. */
export function resolveCustomizeFocusTarget(
  layer: HTMLElement,
  previous: HTMLElement | null,
): HTMLElement | null {
  if (previous?.isConnected && layer.contains(previous) && !previous.matches(":disabled"))
    return previous;
  const previousRow = previous?.closest<HTMLElement>("[data-customize-row]");
  if (!previousRow) return null;
  const row =
    previousRow.isConnected && layer.contains(previousRow)
      ? previousRow
      : [...layer.querySelectorAll<HTMLElement>("[data-customize-row]")].find(
          (candidate) => candidate.dataset.customizeRow === previousRow.dataset.customizeRow,
        );
  return row ? resolveCustomizeRowTarget(row) : null;
}

/** A queued hide may move focus only while the user is still on that canvas item. */
export function shouldMoveCustomizeHideFocus(active: Element | null, key: string): boolean {
  if (active === document.body) return true;
  const control = active?.closest<HTMLElement>("[data-customize-handle], [data-customize-hide]");
  return control?.dataset.customizeHandle === key || control?.dataset.customizeHide === key;
}

/** The next editing control, with handles ordered as they appear on the canvas. */
export function resolveCustomizeTabTarget(
  layer: HTMLElement,
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  const controls = customizeFocusableControls(layer).sort((a, b) => {
    const order = (element: HTMLElement) => {
      const value = element.closest<HTMLElement>("[data-customize-order]")?.dataset.customizeOrder;
      return value === undefined ? Infinity : Number(value);
    };
    return order(a) - order(b);
  });
  const index = controls.findIndex((element) => element === active);
  if (index === -1) return (backwards ? controls.at(-1) : controls[0]) ?? null;
  return controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length] ?? null;
}

/** App fields retain native editing shortcuts, including inherited contenteditable. */
export function isCustomizeEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("textarea, select")) return true;
  const input = target.closest("input");
  if (input && ["text", "search", "email", "url", "tel", "password", "number"].includes(input.type))
    return true;
  if (target instanceof HTMLElement && typeof target.isContentEditable === "boolean")
    return target.isContentEditable;
  const editor = target.closest<HTMLElement>("[contenteditable]");
  return (
    !!editor && (editor.isContentEditable ?? editor.getAttribute("contenteditable") !== "false")
  );
}

/** These controls render above the mode and keep their own event handling. */
export function isCustomizeAboveModeTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('[data-theme-editor-panel], [data-slot^="toast-"]')
  );
}

/** Editing an app field keeps its native Escape behavior; mode controls use Escape to exit. */
export function preservesNativeCustomizeEscape(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    isCustomizeEditableTarget(target) &&
    !target.closest("[data-customize-popover], [data-customize-edit]")
  );
}

/** Overlay popups own keyboard and focus handling; inline lists and panels do not. */
export function hasOpenCustomizePopup(): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [data-open][role="menu"], [data-open][role="listbox"], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([data-slot="toast-popup"])',
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

export type ShelfSide = "above" | "below" | "right" | "left";

const BADGE_OVERHANG = 12;

/**
 * Places the shelf beside the surface being edited: the first side (in
 * preference order) where it fits on screen without covering the surface,
 * otherwise the side that covers the least of it.
 */
export function placeShelf(
  root: Rect,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  sides: ReadonlyArray<ShelfSide>,
  { gap = 12, margin = 12, top = 72 }: { gap?: number; margin?: number; top?: number } = {},
): { readonly left: number; readonly top: number } {
  const clamp = (left: number, y: number) => ({
    left: Math.max(margin, Math.min(left, viewport.width - size.width - margin)),
    top: Math.max(top, Math.min(y, viewport.height - size.height - margin)),
  });
  const candidate = (side: ShelfSide) => {
    switch (side) {
      case "above":
        return { left: root.right - size.width, top: root.top - size.height - gap };
      case "below":
        return { left: root.right - size.width, top: root.bottom + gap };
      case "right":
        return { left: root.right + gap, top: root.top };
      case "left":
        return { left: root.left - size.width - gap, top: root.top };
    }
  };
  // Hide badges overhang their elements, so keep clear of them too.
  const bounds = {
    left: root.left - BADGE_OVERHANG,
    top: root.top - BADGE_OVERHANG,
    right: root.right + BADGE_OVERHANG,
    bottom: root.bottom + BADGE_OVERHANG,
  };
  const overlap = (place: { left: number; top: number }) =>
    Math.max(
      0,
      Math.min(place.left + size.width, bounds.right) - Math.max(place.left, bounds.left),
    ) *
    Math.max(0, Math.min(place.top + size.height, bounds.bottom) - Math.max(place.top, bounds.top));
  let best: { left: number; top: number } | null = null;
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (const side of sides) {
    const wanted = candidate(side);
    const place = clamp(wanted.left, wanted.top);
    const covered = overlap(place);
    if (covered === 0) return place;
    if (covered < bestOverlap) {
      best = place;
      bestOverlap = covered;
    }
  }
  return best ?? clamp((viewport.width - size.width) / 2, top);
}
