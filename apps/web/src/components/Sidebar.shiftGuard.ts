// How long a row the list just moved ignores presses. A click that was already
// on its way when the row slid under the pointer lands within this window.
const MOVED_ROW_PRESS_DELAY_MS = 500;
// Moves this soon after the user's own press or key are theirs, such as the next
// row sliding up after Settle. Same window as Cumulative Layout Shift's
// hadRecentInput.
const OWN_INPUT_WINDOW_MS = 500;

const PRESS_FOLLOW_UPS = ["click", "auxclick", "dblclick", "contextmenu"] as const;

// Editing text cannot move rows. Enter and modified keys in a field can, such as
// sending a message or a shortcut.
function editsText(event: KeyboardEvent) {
  const target = event.target;
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement);
  return editable && event.key !== "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function readTops(list: HTMLElement) {
  const tops = new Map<Element, number>();
  for (const child of list.children) {
    if (child instanceof HTMLElement) tops.set(child, child.offsetTop);
  }
  return tops;
}

/**
 * Drops presses on rows that something other than the user just moved, so a
 * thread settling, waking or arriving above the pointer cannot hand its click
 * to the neighbouring row. Call `update` after each commit that can move rows.
 * The list must be positioned so every direct child's offsetTop shares its origin.
 */
export function createSidebarShiftGuard(list: HTMLElement) {
  const view = list.ownerDocument.defaultView;
  let tops = readTops(list);
  const movedAt = new WeakMap<Element, number>();
  let lastInputAt = Number.NEGATIVE_INFINITY;
  // Pointers still down on a dropped press. Only their own release or cancel ends the drop, so
  // a key or another pointer meanwhile cannot hand that press's click to the row.
  const heldDrops = new Set<number>();
  let pressDropped = false;

  const rowOf = (target: EventTarget | null) => {
    let node = target instanceof Node ? target : null;
    while (node !== null && node.parentNode !== list) node = node.parentNode;
    return node instanceof Element ? node : null;
  };
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event: PointerEvent) => {
    // A new press from the same pointer means its earlier release was missed.
    heldDrops.delete(event.pointerId);
    const now = performance.now();
    const row = rowOf(event.target);
    const moved = row === null ? undefined : movedAt.get(row);
    if (moved !== undefined && now - moved < MOVED_ROW_PRESS_DELAY_MS) {
      heldDrops.add(event.pointerId);
      pressDropped = true;
      swallow(event);
      return;
    }
    if (heldDrops.size === 0) pressDropped = false;
    lastInputAt = now;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (heldDrops.delete(event.pointerId)) {
      if (rowOf(event.target) !== null) swallow(event);
      return;
    }
    lastInputAt = performance.now();
  };
  const onPointerCancel = (event: PointerEvent) => {
    heldDrops.delete(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (heldDrops.size === 0) pressDropped = false;
    if (!editsText(event)) lastInputAt = performance.now();
  };
  const onPressFollowUp = (event: MouseEvent) => {
    // Keyboard activation clicks carry no click count; only pointer presses are dropped.
    if (event.type === "click" && event.detail === 0) return;
    if (pressDropped && rowOf(event.target) !== null) swallow(event);
  };

  // Window capture runs before React and dnd-kit see the press.
  view?.addEventListener("pointerdown", onPointerDown, { capture: true });
  view?.addEventListener("pointerup", onPointerUp, { capture: true });
  view?.addEventListener("pointercancel", onPointerCancel, { capture: true });
  view?.addEventListener("keydown", onKeyDown, { capture: true });
  for (const type of PRESS_FOLLOW_UPS) {
    view?.addEventListener(type, onPressFollowUp, { capture: true });
  }

  return {
    update() {
      const next = readTops(list);
      const now = performance.now();
      const ownMove = now - lastInputAt < OWN_INPUT_WINDOW_MS;
      for (const [row, top] of next) {
        if (tops.get(row) === top) continue;
        // The latest move decides: one the user caused clears an earlier mark.
        if (ownMove) movedAt.delete(row);
        else movedAt.set(row, now);
      }
      tops = next;
    },
    dispose() {
      view?.removeEventListener("pointerdown", onPointerDown, { capture: true });
      view?.removeEventListener("pointerup", onPointerUp, { capture: true });
      view?.removeEventListener("pointercancel", onPointerCancel, { capture: true });
      view?.removeEventListener("keydown", onKeyDown, { capture: true });
      for (const type of PRESS_FOLLOW_UPS) {
        view?.removeEventListener(type, onPressFollowUp, { capture: true });
      }
    },
  };
}
