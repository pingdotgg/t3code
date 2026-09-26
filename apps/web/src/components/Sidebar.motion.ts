import { sidebarPinPath } from "../sidebarPinPath";

const motionTiming = { duration: 150, easing: "ease-out" };
// Rows normally ride their displaced neighbour's travel. Absent a moving
// neighbour, a row still travels on its own, clamped so a tall card does not
// slide its full height.
const rowTravel = (height: number) => Math.min(height, 40);
// A project filter change or a bulk snooze swaps a large part of the list at
// once. Fades are the expensive part: every removed row gets a deep clone and
// every clone and entering row gets its own animation, and the layout reads
// in between force synchronous reflows. Translating displaced rows is cheap,
// so only the fade count decides whether an update animates.
const MAX_FADED_ROWS_PER_UPDATE = 40;

type RowPosition = { top: number; left: number; width: number; height: number; pinned: boolean };

function progress(animation: Animation) {
  return animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

/** Animate rows between their layout positions. The list must be
 * positioned so every direct child's offsetTop has the same origin. */
export function createSidebarListMotion(parent: HTMLUListElement) {
  const viewport = parent.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  let positions: Map<HTMLElement, RowPosition> | null = null;
  let disposed = false;
  const reducedMotion = parent.ownerDocument.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const running = new Map<
    HTMLElement,
    {
      animation: Animation;
      path: { x: number; y: number; offset: number }[];
      pinVisual: boolean;
    }
  >();
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>();
  const exiting = new Map<HTMLElement, Animation>();
  // Visual tops at drag release, relative to the list, so the release
  // commit can glide every row from where dnd-kit left it into its slot.
  let released: Map<HTMLElement, number> | null = null;

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    const entry = entering.get(node);
    const enter = entry ? entry.travel * (1 - progress(entry.animation)) : 0;
    if (!current) return { x: 0, y: enter };
    const elapsed = progress(current.animation);
    const afterIndex = current.path.findIndex((point) => point.offset >= elapsed);
    const after = current.path[afterIndex === -1 ? current.path.length - 1 : afterIndex]!;
    const before = current.path[Math.max(0, afterIndex - 1)]!;
    const fraction =
      after.offset === before.offset
        ? 0
        : (elapsed - before.offset) / (after.offset - before.offset);
    return {
      x: before.x + (after.x - before.x) * fraction,
      y: before.y + (after.y - before.y) * fraction + enter,
    };
  };
  const clearFades = () => {
    for (const entry of entering.values()) entry.animation.cancel();
    for (const animation of exiting.values()) animation.cancel();
    for (const node of exiting.keys()) node.remove();
    entering.clear();
    exiting.clear();
  };
  const fadeOut = (node: HTMLElement, position: RowPosition, travel: number) => {
    if (position.height === 0) return;
    // React owns the removed row; only a noninteractive copy stays for the fade.
    const clone = node.cloneNode(true) as HTMLElement;
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          (attribute.name === "id" && element.namespaceURI !== "http://www.w3.org/2000/svg") ||
          attribute.name === "data-thread-item" ||
          attribute.name === "data-thread-selection-safe" ||
          attribute.name === "data-testid"
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    const offset = remainingOffset(node);
    Object.assign(clone.style, {
      position: "absolute",
      top: `${position.top + offset.y}px`,
      left: `${position.left + offset.x}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: "0",
      boxSizing: "border-box",
      contentVisibility: "visible",
      transform: "none",
      transition: "none",
      pointerEvents: "none",
    });
    parent.append(clone);
    const entry = entering.get(node);
    const entryProgress = entry ? progress(entry.animation) : 1;
    const animation = clone.animate(
      [
        { opacity: entryProgress, transform: "translateY(0px)" },
        { opacity: 0, transform: `translateY(${travel}px)` },
      ],
      motionTiming,
    );
    exiting.set(clone, animation);
    animation.addEventListener(
      "finish",
      () => {
        clone.remove();
        exiting.delete(clone);
      },
      { once: true },
    );
  };

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel();
    running.delete(node);
  };
  const suspend = () => {
    for (const node of running.keys()) cancel(node);
    clearFades();
    positions = null;
    released = null;
  };
  const move = (node: HTMLElement, offset: number, pinning = false, offsetX = 0) => {
    const pinVisual = pinning || (running.get(node)?.pinVisual ?? false);
    cancel(node);
    const entry = entering.get(node);
    // The newer transform supersedes entry travel; its original opacity keeps fading.
    if (entry) entry.travel = 0;
    if (offset === 0 && offsetX === 0 && !entry) return;
    // Spend the flight on the visible journey. Once the whole row clears the
    // scrollport, removing its transform lands it in the real offscreen slot.
    const viewportRect = pinVisual ? viewport?.getBoundingClientRect() : undefined;
    const rowRect = viewportRect ? node.getBoundingClientRect() : undefined;
    const targetY =
      viewport && viewportRect && rowRect
        ? Math.max(0, viewportRect.top + viewport.clientTop - rowRect.bottom)
        : 0;
    if (targetY > 0 && offset <= targetY) return;
    // Transformed rows contribute to scrollable overflow. Keep the bow within
    // the existing inset so it cannot introduce horizontal scrolling or fades.
    const bow =
      viewport && viewportRect && rowRect
        ? Math.max(
            0,
            Math.min(
              16,
              viewportRect.left + viewport.clientLeft + viewport.clientWidth - rowRect.right,
            ),
          )
        : 16;
    const path = pinning
      ? sidebarPinPath(offsetX, offset - targetY, bow).map((point) => ({
          ...point,
          y: point.y + targetY,
        }))
      : [
          { x: offsetX, y: offset, offset: 0 },
          { x: 0, y: targetY, offset: 1 },
        ];
    // A pinning row stays opaque and above its neighbours until it settles.
    const animation = node.animate(
      path.map(({ x, y, offset }) => ({
        transform: `translate(${x}px, ${y}px)`,
        offset,
        ...(pinVisual ? { zIndex: 20, backgroundColor: "var(--sidebar)" } : {}),
      })),
      pinning ? { duration: 550, easing: "cubic-bezier(.32,0,.18,1)" } : motionTiming,
    );
    running.set(node, { animation, path, pinVisual });
    animation.addEventListener(
      "finish",
      () => {
        if (running.get(node)?.animation === animation) running.delete(node);
      },
      { once: true },
    );
  };

  // A scroll can reveal a clipped endpoint. Retarget from the current visual
  // position so the row still clears the edge before its transform disappears.
  const onScroll = () => {
    for (const [node, { pinVisual }] of Array.from(running)) {
      if (!pinVisual) continue;
      const offset = remainingOffset(node);
      move(node, offset.y, false, offset.x);
    }
  };
  viewport?.addEventListener("scroll", onScroll, { passive: true });

  return {
    update(animate: boolean) {
      if (disposed) return;
      const next = new Map(
        Array.from(parent.children)
          .filter((node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node))
          .map((node) => [
            node,
            {
              top: node.offsetTop,
              left: node.offsetLeft,
              width: node.offsetWidth,
              height: node.offsetHeight,
              pinned: node.getAttribute("data-thread-pinned") === "true",
            },
          ]),
      );
      let fadeCount = 0;
      if (positions !== null) {
        for (const [node, position] of positions) {
          if (!next.has(node) && position.height > 0) fadeCount++;
        }
        for (const [node, position] of next) {
          if (!positions.has(node) && position.height > 0) fadeCount++;
        }
      }
      const shouldAnimate =
        animate &&
        positions !== null &&
        !reducedMotion?.matches &&
        fadeCount <= MAX_FADED_ROWS_PER_UPDATE;
      const movedDelta = new Map<HTMLElement, number>();
      const nextOrder = [...next.keys()];
      const oldOrder = positions === null ? [] : [...positions.keys()];
      const ridingDelta = (
        order: readonly HTMLElement[],
        index: number,
        retained: (node: HTMLElement) => boolean,
      ) => {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          const node = order[cursor]!;
          const delta = movedDelta.get(node);
          if (delta !== undefined) return delta;
          if (retained(node)) return remainingOffset(node).y;
        }
        return undefined;
      };
      if (!shouldAnimate) clearFades();
      else {
        // A shelf that opens above its collapsed anchor shifts every retained
        // row by the same amount. Entering rows take that same displacement so
        // the shelf arrives as one moving block instead of rows popping into
        // their final slots; exiting rows leave by it.
        for (const [node, position] of next) {
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined || previousTop === position.top) continue;
          movedDelta.set(node, previousTop + remainingOffset(node).y - position.top);
        }
        for (const [node, position] of positions!) {
          if (next.has(node)) continue;
          const delta = ridingDelta(oldOrder, oldOrder.indexOf(node), (n) => next.has(n));
          fadeOut(node, position, delta === undefined ? rowTravel(position.height) : -delta);
        }
      }
      for (const [node, entry] of entering) {
        if (!next.has(node)) {
          entry.animation.cancel();
          entering.delete(node);
        }
      }
      for (const node of running.keys()) {
        if (!shouldAnimate || !next.has(node)) cancel(node);
      }
      if (shouldAnimate) {
        for (const [index, node] of nextOrder.entries()) {
          const position = next.get(node)!;
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined) {
            if (position.height > 0) {
              const delta = ridingDelta(nextOrder, index, (n) => positions!.has(n));
              const travel = delta === undefined ? -rowTravel(position.height) : delta;
              const animation = node.animate(
                [
                  { opacity: 0, transform: `translateY(${travel}px)` },
                  { opacity: 1, transform: "translateY(0px)" },
                ],
                motionTiming,
              );
              entering.set(node, { animation, travel });
              animation.addEventListener(
                "finish",
                () => {
                  if (entering.get(node)?.animation === animation) entering.delete(node);
                },
                { once: true },
              );
            }
            continue;
          }
          const delta = movedDelta.get(node);
          // Computed progress includes the effect's easing. Only our own
          // translate is carried forward; dnd-kit's transforms are never read.
          // Interpolate the sampled path at the eased progress, so an
          // interrupted pin preserves its curved XY position, not a linear Y.
          if (delta !== undefined) {
            const offset = remainingOffset(node);
            move(node, delta, position.pinned && !positions!.get(node)?.pinned, offset.x);
          }
        }
      }
      if (released !== null) {
        if (!reducedMotion?.matches) {
          for (const [node, position] of next) {
            const top = released.get(node);
            if (top !== undefined) move(node, top - position.top);
          }
        }
        released = null;
      }
      positions = next;
    },
    /** Called on drag release, before the commit that clears dnd-kit's
     * transforms. Takes every row's visual top, including the lifted row
     * under the pointer and the peers holding the label gaps open, so the
     * next update glides each of them into its committed slot. */
    release() {
      suspend();
      const origin = parent.getBoundingClientRect().top;
      released = new Map(
        Array.from(parent.children)
          .filter((node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node))
          .map((node) => [node, node.getBoundingClientRect().top - origin]),
      );
    },
    suspend,
    dispose() {
      suspend();
      viewport?.removeEventListener("scroll", onScroll);
      disposed = true;
    },
  };
}
