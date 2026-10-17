import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Placeholder heights of the two row variants, which the first mount budget also counts. */
export const SIDEBAR_ROW_HEIGHT_REM = { card: 5.125, slim: 2.25 } as const;
const ROW_OBSERVER_MARGIN_PX = 240;

let initialRowBudgetRem: number | null = null;

/** Mount the initial viewport before the observer's first report. */
export function sidebarInitialRowBudgetRem(): number {
  if (initialRowBudgetRem === null) {
    if (typeof window === "undefined") return 0;
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    initialRowBudgetRem = (window.innerHeight + ROW_OBSERVER_MARGIN_PX) / rootPx;
  }
  return initialRowBudgetRem;
}

const observers = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, (visible: boolean) => void>;
  }
>();
// Boot uses the budget; rows added to a painted list need their actual position.
const paintedRoots = new WeakSet<Element>();

/** Share viewport observation across row slots; expensive content mounts only nearby. */
export function useSidebarRowViewport(node: HTMLElement | null, initiallyVisible: boolean) {
  const [visible, setVisible] = useState(
    initiallyVisible || typeof IntersectionObserver === "undefined",
  );
  const placedRef = useRef(false);
  useLayoutEffect(() => {
    // An opened shelf can join a scrolled list; mount its visible rows before paint.
    if (!node || placedRef.current) return;
    placedRef.current = true;
    const root = node.closest('[data-slot="scroll-area-viewport"]');
    if (visible || !root || !paintedRoots.has(root)) return;
    const bounds = root.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    if (
      bounds.height > 0 &&
      box.bottom > bounds.top - ROW_OBSERVER_MARGIN_PX &&
      box.top < bounds.bottom + ROW_OBSERVER_MARGIN_PX
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- The slot must render its row before the first paint.
      setVisible(true);
    }
  }, [node, visible]);
  useEffect(() => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    const root = node.closest('[data-slot="scroll-area-viewport"]');
    let group = observers.get(root);
    if (!group) {
      const listeners = new Map<Element, (visible: boolean) => void>();
      const observer = new IntersectionObserver(
        (entries) => {
          if (root) paintedRoots.add(root);
          for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
        },
        { root, rootMargin: `${ROW_OBSERVER_MARGIN_PX}px 0px` },
      );
      group = { observer, listeners };
      observers.set(root, group);
    }
    group.listeners.set(node, setVisible);
    group.observer.observe(node);
    return () => {
      group.listeners.delete(node);
      group.observer.unobserve(node);
      if (group.listeners.size === 0) {
        group.observer.disconnect();
        observers.delete(root);
      }
    };
  }, [node]);
  return [visible, setVisible] as const;
}
