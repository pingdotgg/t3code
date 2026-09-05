const motionTiming = { duration: 150, easing: "ease-out" };

type RowPosition = { top: number; left: number; width: number; height: number };

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
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>();
  const entering = new Map<HTMLElement, Animation>();
  const exiting = new Map<HTMLElement, Animation>();

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    return current ? current.offset * (1 - progress(current.animation)) : 0;
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
    Object.assign(clone.style, {
      position: "absolute",
      top: `${position.top + remainingOffset(node)}px`,
      left: `${position.left}px`,
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
            },
          ]),
      );
      const shouldAnimate = animate && positions !== null && !reducedMotion?.matches;
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
          // Computed progress includes the effect's easing. Only our own
          // translate is carried forward; dnd-kit's transforms are never read.
          const offset = previousTop + remainingOffset(node) - position.top;
          cancel(node);
          if (offset === 0) continue;
          const animation = node.animate(
            [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
            motionTiming,
          );
          running.set(node, { animation, offset });
          animation.addEventListener(
            "finish",
            () => {
              if (running.get(node)?.animation === animation) running.delete(node);
            },
            { once: true },
          );
        }
      }
      positions = next;
    },
    suspend,
    dispose() {
      suspend();
      disposed = true;
    },
  };
}
