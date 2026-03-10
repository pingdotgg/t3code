export interface SidebarReorderDelta<T extends string = string> {
  id: T;
  deltaY: number;
}

export const SIDEBAR_REORDER_TRANSITION = "transform 200ms ease-out";

interface SidebarAnimatableElement {
  style: {
    transition: string;
    transform: string;
    willChange: string;
  };
  getBoundingClientRect(): { top: number };
}

interface SidebarAnimationScheduler {
  requestAnimationFrame: (callback: () => void) => void;
  setTimeout: (callback: () => void, delayMs: number) => void;
}

const activeSidebarAnimationTokenByElement = new WeakMap<SidebarAnimatableElement, number>();

export function hasSidebarReorderChanged<T extends string>(
  previousOrder: ReadonlyArray<T>,
  nextOrder: ReadonlyArray<T>,
): boolean {
  if (previousOrder.length !== nextOrder.length) {
    return true;
  }

  return previousOrder.some((id, index) => id !== nextOrder[index]);
}

export function buildSidebarReorderDeltas<T extends string>(
  previousTops: ReadonlyMap<T, number>,
  nextTops: ReadonlyMap<T, number>,
): Array<SidebarReorderDelta<T>> {
  const deltas: Array<SidebarReorderDelta<T>> = [];

  for (const [id, nextTop] of nextTops.entries()) {
    const previousTop = previousTops.get(id);
    if (previousTop === undefined) {
      continue;
    }

    const deltaY = previousTop - nextTop;
    if (Math.abs(deltaY) < 0.5) {
      continue;
    }

    deltas.push({ id, deltaY });
  }

  return deltas;
}

export function collectElementTopPositions<T extends string>(
  elements: ReadonlyMap<T, SidebarAnimatableElement>,
): Map<T, number> {
  return new Map(
    [...elements.entries()].map(([id, element]) => [id, element.getBoundingClientRect().top] as const),
  );
}

export function animateSidebarReorder<T extends string>(
  elements: ReadonlyMap<T, SidebarAnimatableElement>,
  deltas: ReadonlyArray<SidebarReorderDelta<T>>,
  scheduler?: SidebarAnimationScheduler,
): void {
  if (deltas.length === 0) {
    return;
  }

  const resolvedScheduler = scheduler ?? {
    requestAnimationFrame: (callback: () => void) => window.requestAnimationFrame(callback),
    setTimeout: (callback: () => void, delayMs: number) => {
      window.setTimeout(callback, delayMs);
    },
  };

  for (const { id, deltaY } of deltas) {
    const element = elements.get(id);
    if (!element) {
      continue;
    }

    const nextToken = (activeSidebarAnimationTokenByElement.get(element) ?? 0) + 1;
    activeSidebarAnimationTokenByElement.set(element, nextToken);

    element.style.transition = "none";
    element.style.transform = `translateY(${deltaY}px)`;
    element.style.willChange = "transform";
    element.getBoundingClientRect();

    const cleanup = () => {
      if (activeSidebarAnimationTokenByElement.get(element) !== nextToken) {
        return;
      }

      element.style.transition = "";
      element.style.transform = "";
      element.style.willChange = "";
      activeSidebarAnimationTokenByElement.delete(element);
    };

    resolvedScheduler.requestAnimationFrame(() => {
      if (activeSidebarAnimationTokenByElement.get(element) !== nextToken) {
        return;
      }

      element.style.transition = SIDEBAR_REORDER_TRANSITION;
      element.style.transform = "translateY(0)";
      resolvedScheduler.setTimeout(cleanup, 220);
    });
  }
}
