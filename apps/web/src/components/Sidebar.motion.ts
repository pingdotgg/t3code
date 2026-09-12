import { sidebarPinPath } from "../sidebarPinPath";

const motionTiming = { duration: 150, easing: "ease-out" };
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
  const entering = new Map<HTMLElement, Animation>();
  const exiting = new Map<HTMLElement, Animation>();
  // Visual tops at drag release, relative to the list, so the release
  // commit can glide every row from where dnd-kit left it into its slot.
  let released: Map<HTMLElement, number> | null = null;

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    if (!current) return { x: 0, y: 0 };
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
      y: before.y + (after.y - before.y) * fraction,
    };
  };
  const clearFades = () => {
    for (const animation of [...entering.values(), ...exiting.values()]) animation.cancel();
    for (const node of exiting.keys()) node.remove();
    entering.clear();
    exiting.clear();
  };
  const fadeOut = (node: HTMLElement, position: RowPosition) => {
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
    const animation = clone.animate(
      [{ opacity: entry ? progress(entry) : 1 }, { opacity: 0 }],
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
    if (offset === 0 && offsetX === 0) return;
    const path = pinning
      ? sidebarPinPath(offsetX, offset)
      : [
          { x: offsetX, y: offset, offset: 0 },
          { x: 0, y: 0, offset: 1 },
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
      if (!shouldAnimate) clearFades();
      else {
        for (const [node, position] of positions!) {
          if (!next.has(node)) fadeOut(node, position);
        }
      }
      for (const [node, animation] of entering) {
        if (!next.has(node)) {
          animation.cancel();
          entering.delete(node);
        }
      }
      for (const node of running.keys()) {
        if (!shouldAnimate || !next.has(node)) cancel(node);
      }
      if (shouldAnimate) {
        for (const [node, position] of next) {
          const previousTop = positions?.get(node)?.top;
          if (previousTop === undefined) {
            if (position.height > 0) {
              const animation = node.animate([{ opacity: 0 }, { opacity: 1 }], motionTiming);
              entering.set(node, animation);
              animation.addEventListener(
                "finish",
                () => {
                  if (entering.get(node) === animation) entering.delete(node);
                },
                { once: true },
              );
            }
            continue;
          }
          if (previousTop === position.top) continue;
          // Interpolate our sampled path at the effect's eased progress, so
          // an interrupted pin preserves its curved XY position, not a linear Y.
          // dnd-kit's transforms are never read.
          const offset = remainingOffset(node);
          move(
            node,
            previousTop + offset.y - position.top,
            position.pinned && !positions?.get(node)?.pinned,
            offset.x,
          );
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
      disposed = true;
    },
  };
}
