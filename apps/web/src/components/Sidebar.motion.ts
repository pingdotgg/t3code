const motionTiming = { duration: 150, easing: "ease-out" };
// A drop lands every reordered row in one move; longer than list motion so a cross-row path reads.
const settleTiming = { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };
const SETTLING_ATTRIBUTE = "data-sidebar-settling";
const LEAD_ATTRIBUTE = "data-sidebar-motion-lead";
const MOVING_ATTRIBUTE = "data-sidebar-motion-moving";
/** Matches a list that is dragging (Sidebar sets the attribute) or landing a drop. */
export const SIDEBAR_SORTING_SELECTOR = `[data-sidebar-dragging], [${SETTLING_ATTRIBUTE}]`;
const rowTravel = (height: number) => Math.min(height, 40);
const EXIT_FADE_END = 0.4;
const ENTRY_FADE_START = 0.6;
const MAX_SLIDE_ROWS = 1.5;
// Fades clone removed rows and animate clones and entries; intervening layout reads force reflows.
const MAX_FADED_ROWS_PER_UPDATE = 40;

type RowPosition = { top: number; left: number; width: number; height: number };
const centerDelta = (from: RowPosition, to: RowPosition, listWidth: number) => ({
  x: Math.max(0, Math.min(from.left + (from.width - to.width) / 2, listWidth - to.width)) - to.left,
  y: from.top + from.height / 2 - (to.top + to.height / 2),
});
// Pinning or unpinning remounts a row as a tile or card; its thread key carries it across.
const threadKeyOf = (node: HTMLElement) => node.dataset.threadItem;

function progress(animation: Animation) {
  return animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

function entryOpacity(animation: Animation) {
  return Math.max(0, (progress(animation) - ENTRY_FADE_START) / (1 - ENTRY_FADE_START));
}

function crossingRows(order: readonly HTMLElement[], previousIndex: Map<HTMLElement, number>) {
  const retained = order.filter((node) => previousIndex.has(node));
  const tails: number[] = [];
  const previous: number[] = [];
  for (const [index, node] of retained.entries()) {
    const value = previousIndex.get(node)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (previousIndex.get(retained[tails[middle]!]!)! < value) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const ordered = new Set<HTMLElement>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) {
    ordered.add(retained[index]!);
  }
  return new Set(retained.filter((node) => !ordered.has(node)));
}

/** Animates the list's direct children, and the children of any `data-sidebar-motion-group`. */
export function createSidebarListMotion(parent: HTMLUListElement) {
  let positions: Map<HTMLElement, RowPosition> | null = null;
  let previousWidth: number | null = null;
  let disposed = false;
  const reducedMotion = parent.ownerDocument.defaultView?.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const running = new Map<HTMLElement, { animation: Animation; offset: number; offsetX: number }>();
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>();
  const exiting = new Map<HTMLElement, Animation>();
  let released: {
    nodes: Map<HTMLElement, RowPosition>;
    threads: Map<string, RowPosition>;
    activeKey: string | undefined;
  } | null = null;
  let settleGeneration = 0;

  const rows = () =>
    Array.from(parent.children)
      .flatMap((node) =>
        node instanceof HTMLElement && node.hasAttribute("data-sidebar-motion-group")
          ? Array.from(node.children)
          : [node],
      )
      .filter((node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node));
  // Grouped rows may sit in a nested offsetParent; measure every row from the list.
  const offsetInParent = (node: HTMLElement) => {
    let top = 0;
    let left = 0;
    let current: Element | null = node;
    while (current instanceof HTMLElement && current !== parent) {
      top += current.offsetTop;
      left += current.offsetLeft;
      current = current.offsetParent;
    }
    return { top, left };
  };

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    const run = current ? current.offset * (1 - progress(current.animation)) : 0;
    const entry = entering.get(node);
    const enter = entry ? entry.travel * (1 - progress(entry.animation)) : 0;
    return run + enter;
  };
  const remainingOffsetX = (node: HTMLElement) => {
    const current = running.get(node);
    return current ? current.offsetX * (1 - progress(current.animation)) : 0;
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
      left: `${position.left + remainingOffsetX(node)}px`,
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
      [
        { opacity: entry ? entryOpacity(entry.animation) : 1, transform: "translateY(0px)" },
        { opacity: 0, offset: EXIT_FADE_END },
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
    node.removeAttribute(LEAD_ATTRIBUTE);
    node.removeAttribute(MOVING_ATTRIBUTE);
  };
  const suspend = () => {
    for (const node of running.keys()) cancel(node);
    clearFades();
    positions = null;
    released = null;
    settleGeneration++;
    parent.removeAttribute(SETTLING_ATTRIBUTE);
  };
  const move = (
    node: HTMLElement,
    offset: number,
    offsetX: number,
    timing = motionTiming,
    lead = false,
  ) => {
    const isLead = lead || node.hasAttribute(LEAD_ATTRIBUTE);
    cancel(node);
    const entry = entering.get(node);
    if (entry) entry.travel = 0;
    if (offset === 0 && offsetX === 0 && !entry) return undefined;
    if (isLead) node.setAttribute(LEAD_ATTRIBUTE, "");
    node.setAttribute(MOVING_ATTRIBUTE, "");
    const animation = node.animate(
      [{ transform: `translate(${offsetX}px, ${offset}px)` }, { transform: "translate(0px, 0px)" }],
      timing,
    );
    running.set(node, { animation, offset, offsetX });
    animation.addEventListener(
      "finish",
      () => {
        if (running.get(node)?.animation === animation) {
          running.delete(node);
          node.removeAttribute(LEAD_ATTRIBUTE);
          node.removeAttribute(MOVING_ATTRIBUTE);
        }
      },
      { once: true },
    );
    return animation;
  };

  let frame = 0;
  let frameAnimates = false;
  const view = parent.ownerDocument.defaultView;

  const api = {
    /** Read every row's position and animate rows that moved. Reads layout. */
    update(animate: boolean) {
      if (disposed) return;
      const width = parent.clientWidth;
      const widthUnchanged = previousWidth === width;
      previousWidth = width;
      const next = new Map(
        rows().map((node) => [
          node,
          { ...offsetInParent(node), width: node.offsetWidth, height: node.offsetHeight },
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
      const nextOrder = [...next.keys()];
      const oldOrder = positions === null ? [] : [...positions.keys()];
      const crossing = crossingRows(nextOrder, new Map(oldOrder.map((n, i) => [n, i] as const)));
      for (const [node, position] of next) {
        const previousTop = positions?.get(node)?.top;
        if (
          previousTop !== undefined &&
          position.height > 0 &&
          Math.abs(previousTop + remainingOffset(node) - position.top) >
            position.height * MAX_SLIDE_ROWS
        ) {
          crossing.add(node);
        }
      }
      fadeCount += crossing.size * 2;
      const shouldAnimate =
        animate &&
        widthUnchanged &&
        positions !== null &&
        !reducedMotion?.matches &&
        fadeCount <= MAX_FADED_ROWS_PER_UPDATE;
      const movedDelta = new Map<HTMLElement, number>();
      const movedDeltaX = new Map<HTMLElement, number>();
      const remounted = new Map<string, RowPosition>();
      const nextThreadKeys = new Set(nextOrder.map(threadKeyOf));
      const landing: Animation[] = [];
      const stays = (node: HTMLElement) => next.has(node) && !crossing.has(node);
      const ridingDelta = (
        order: readonly HTMLElement[],
        index: number,
        retained: (node: HTMLElement) => boolean,
      ) => {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          const node = order[cursor]!;
          const delta = movedDelta.get(node);
          if (delta !== undefined) return delta;
          if (retained(node)) return remainingOffset(node);
        }
        return undefined;
      };
      if (!shouldAnimate) clearFades();
      else {
        for (const [node, position] of next) {
          const previous = positions!.get(node);
          if (
            previous === undefined ||
            (previous.top === position.top && previous.left === position.left) ||
            crossing.has(node)
          )
            continue;
          movedDelta.set(node, previous.top + remainingOffset(node) - position.top);
          movedDeltaX.set(
            node,
            Math.max(0, Math.min(previous.left + remainingOffsetX(node), width - position.width)) -
              position.left,
          );
        }
        for (const [node, position] of positions!) {
          if (stays(node)) continue;
          const key = threadKeyOf(node);
          if (!next.has(node) && key !== undefined && nextThreadKeys.has(key)) {
            remounted.set(key, {
              ...position,
              top: position.top + remainingOffset(node),
              left: position.left + remainingOffsetX(node),
            });
            continue;
          }
          const delta = ridingDelta(oldOrder, oldOrder.indexOf(node), stays);
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
          if (previousTop === undefined || crossing.has(node)) {
            cancel(node);
            entering.get(node)?.animation.cancel();
            entering.delete(node);
            const key = threadKeyOf(node);
            const from = key === undefined ? undefined : remounted.get(key);
            if (from !== undefined && position.height > 0) {
              const delta = centerDelta(from, position, width);
              const animation = move(node, delta.y, delta.x, motionTiming, true);
              if (animation) landing.push(animation);
            } else if (position.height > 0) {
              const delta = ridingDelta(
                nextOrder,
                index,
                (n) => positions!.has(n) && !crossing.has(n),
              );
              const travel = delta === undefined ? -rowTravel(position.height) : delta;
              const animation = node.animate(
                [
                  { opacity: 0, transform: `translateY(${travel}px)` },
                  { opacity: 0, offset: ENTRY_FADE_START },
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
          // Computed progress includes easing; carry forward only our translation, never dnd-kit's
          // transforms.
          if (delta !== undefined) move(node, delta, movedDeltaX.get(node) ?? 0);
        }
      }
      if (released !== null) {
        if (!reducedMotion?.matches) {
          for (const [node, position] of next) {
            const key = threadKeyOf(node);
            const origin =
              released.nodes.get(node) ??
              (key === undefined ? undefined : released.threads.get(key));
            if (origin === undefined) continue;
            const delta = centerDelta(origin, position, width);
            const animation = move(
              node,
              delta.y,
              delta.x,
              settleTiming,
              key !== undefined && key === released.activeKey,
            );
            if (animation) landing.push(animation);
          }
        }
        released = null;
      }
      if (landing.length > 0) {
        const generation = ++settleGeneration;
        parent.setAttribute(SETTLING_ATTRIBUTE, "");
        void Promise.allSettled(landing.map((animation) => animation.finished)).then(() => {
          if (generation === settleGeneration) parent.removeAttribute(SETTLING_ATTRIBUTE);
        });
      }
      positions = next;
    },
    /** `update` in the next frame, before it paints, so a commit's own layout
     * pass is the one read instead of a forced one mid-commit. A chat
     * mounting in the same commit made that forced layout expensive. Calls
     * before the frame coalesce; the last one decides whether rows animate. */
    scheduleUpdate(animate: boolean) {
      if (disposed || !view) return;
      frameAnimates = animate;
      if (frame !== 0) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        api.update(frameAnimates);
      });
    },
    release(activeKey?: string) {
      suspend();
      const origin = parent.getBoundingClientRect();
      const nodes = new Map<HTMLElement, RowPosition>();
      const threads = new Map<string, RowPosition>();
      for (const node of rows()) {
        const rect = node.getBoundingClientRect();
        const position = {
          top: rect.top - origin.top,
          left: rect.left - origin.left,
          width: rect.width,
          height: rect.height,
        };
        nodes.set(node, position);
        const key = threadKeyOf(node);
        if (key !== undefined) threads.set(key, position);
      }
      released = { nodes, threads, activeKey };
    },
    suspend,
    dispose() {
      suspend();
      if (frame !== 0) view?.cancelAnimationFrame(frame);
      disposed = true;
    },
  };
  return api;
}
