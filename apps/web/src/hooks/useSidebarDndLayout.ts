import { useAutoAnimate } from "@formkit/auto-animate/react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type {
  SidebarDndSection,
  SidebarThreadDragTransaction,
} from "../components/Sidebar.dnd.logic";
import { SIDEBAR_DND_SECTIONS } from "../components/Sidebar.dnd.logic";

const SIDEBAR_DND_EMPTY_RAIL_HEIGHT = 48;

type SidebarLayoutCorrection =
  | { readonly kind: "stable" }
  | { readonly kind: "corrected" }
  | {
      readonly kind: "clamped";
      readonly edge: "start" | "end";
      readonly missingScrollRange: number;
    };

interface SidebarScrollRangeHold {
  readonly node: HTMLUListElement;
  readonly originalMinHeight: string;
  readonly originalPaddingTop: string;
  readonly originalPaddingBottom: string;
  readonly height: number;
  readonly topInset: number;
  readonly bottomInset: number;
}

export type SidebarThreadDragStateSetter = (
  next:
    | SidebarThreadDragTransaction
    | null
    | ((current: SidebarThreadDragTransaction | null) => SidebarThreadDragTransaction | null),
) => void;

export interface SidebarDndLayout {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly viewportOverlayRef: RefObject<HTMLDivElement | null>;
  readonly viewportRailSectionsRef: RefObject<Set<SidebarDndSection>>;
  readonly attachListRef: (node: HTMLUListElement | null) => void;
  readonly handleViewportRailNodeChange: (
    section: SidebarDndSection,
    node: HTMLElement | null,
  ) => void;
  readonly handleThreadRowNodeChange: (threadKey: string, node: HTMLElement | null) => void;
  readonly getThreadRowNode: (threadKey: string) => HTMLElement | null;
  readonly pauseLayoutMotion: () => void;
  readonly holdScrollRange: () => void;
  readonly retainLayoutAnchor: (
    preferred?: HTMLElement | null,
    excludedThreadKey?: string | null,
  ) => void;
}

export function useSidebarDndLayout(input: {
  transaction: SidebarThreadDragTransaction | null;
  transactionRef: RefObject<SidebarThreadDragTransaction | null>;
  setTransaction: SidebarThreadDragStateSetter;
  pinnedReorderInFlightRef: RefObject<boolean>;
  sectionThreadCounts: Readonly<Record<SidebarDndSection, number>>;
  canDropThreadInSection: (
    thread: EnvironmentThreadShell,
    source: SidebarDndSection,
    destination: SidebarDndSection,
  ) => boolean;
}): SidebarDndLayout {
  const [autoAnimateRef, setAutoAnimateEnabled] = useAutoAnimate<HTMLUListElement>({
    duration: 150,
    easing: "ease-out",
  });
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportOverlayRef = useRef<HTMLDivElement>(null);
  const viewportRailSectionsRef = useRef(new Set<SidebarDndSection>());
  const threadListNodeRef = useRef<HTMLUListElement | null>(null);
  const scrollRangeHoldRef = useRef<SidebarScrollRangeHold | null>(null);
  const threadRowNodesRef = useRef(new Map<string, HTMLElement>());
  const autoAnimatePausedRef = useRef(false);
  const viewportOverflowAnchorRef = useRef("");
  const correctedScrollTopRef = useRef<number | null>(null);
  const retainedLayoutAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);

  const handleViewportRailNodeChange = useCallback(
    (section: SidebarDndSection, node: HTMLElement | null) => {
      if (node === null) {
        viewportRailSectionsRef.current.delete(section);
        return;
      }
      viewportRailSectionsRef.current.add(section);
    },
    [],
  );
  const handleThreadRowNodeChange = useCallback((threadKey: string, node: HTMLElement | null) => {
    if (node === null) {
      threadRowNodesRef.current.delete(threadKey);
      return;
    }
    threadRowNodesRef.current.set(threadKey, node);
  }, []);
  const getThreadRowNode = useCallback(
    (threadKey: string) => threadRowNodesRef.current.get(threadKey) ?? null,
    [],
  );
  const pauseLayoutMotion = useCallback(() => {
    if (autoAnimatePausedRef.current) return;
    autoAnimatePausedRef.current = true;
    setAutoAnimateEnabled(false);
    const viewport = viewportRef.current;
    if (viewport === null) return;
    viewportOverflowAnchorRef.current = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
  }, [setAutoAnimateEnabled]);
  const chooseLayoutAnchor = useCallback(
    (preferred: HTMLElement | null, excludedThreadKey: string | null = null) => {
      const viewport = viewportRef.current;
      if (viewport === null) return null;
      const canAnchor = (element: HTMLElement) => {
        if (!element.isConnected || element.dataset.dndTransformed === "true") return false;
        const rect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      };
      if (preferred !== null && canAnchor(preferred)) return preferred;
      for (const [threadKey, element] of threadRowNodesRef.current) {
        if (threadKey === excludedThreadKey) continue;
        if (canAnchor(element)) return element;
      }
      return null;
    },
    [],
  );
  const retainLayoutAnchor = useCallback(
    (preferred: HTMLElement | null = null, excludedThreadKey: string | null = null) => {
      const anchor = chooseLayoutAnchor(preferred, excludedThreadKey);
      retainedLayoutAnchorRef.current =
        anchor === null ? null : { element: anchor, top: anchor.getBoundingClientRect().top };
    },
    [chooseLayoutAnchor],
  );
  const correctLayoutAnchor = useCallback((): SidebarLayoutCorrection => {
    const viewport = viewportRef.current;
    const retained = retainedLayoutAnchorRef.current;
    if (
      viewport === null ||
      retained === null ||
      !retained.element.isConnected ||
      retained.element.dataset.dndTransformed === "true"
    ) {
      retainLayoutAnchor();
      return { kind: "stable" };
    }
    const nextTop = retained.element.getBoundingClientRect().top;
    const delta = nextTop - retained.top;
    if (Math.abs(delta) > 0.5) {
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const previousScrollTop = viewport.scrollTop;
      const requestedScrollTop = previousScrollTop + delta;
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, requestedScrollTop));
      viewport.scrollTop = nextScrollTop;
      const appliedScrollTop = viewport.scrollTop;
      if (Math.abs(appliedScrollTop - previousScrollTop) > 0.5) {
        correctedScrollTopRef.current = appliedScrollTop;
      }
      if (Math.abs(appliedScrollTop - requestedScrollTop) > 0.5) {
        return {
          kind: "clamped",
          edge: requestedScrollTop < 0 ? "start" : "end",
          missingScrollRange: Math.abs(appliedScrollTop - requestedScrollTop),
        };
      }
    }
    retainedLayoutAnchorRef.current = {
      element: retained.element,
      top: retained.element.getBoundingClientRect().top,
    };
    return { kind: Math.abs(delta) > 0.5 ? "corrected" : "stable" };
  }, [retainLayoutAnchor]);
  const clearScrollRangeHold = useCallback(() => {
    const hold = scrollRangeHoldRef.current;
    if (hold === null) return;
    hold.node.style.minHeight = hold.originalMinHeight;
    hold.node.style.paddingTop = hold.originalPaddingTop;
    hold.node.style.paddingBottom = hold.originalPaddingBottom;
    scrollRangeHoldRef.current = null;
  }, []);
  const holdScrollRange = useCallback(() => {
    const node = threadListNodeRef.current;
    if (node === null) return;
    const current = scrollRangeHoldRef.current;
    if (current !== null && current.node !== node) {
      current.node.style.minHeight = current.originalMinHeight;
      current.node.style.paddingTop = current.originalPaddingTop;
      current.node.style.paddingBottom = current.originalPaddingBottom;
      scrollRangeHoldRef.current = null;
    }
    const activeHold = scrollRangeHoldRef.current;
    const height = Math.max(activeHold?.height ?? 0, node.getBoundingClientRect().height);
    const next = {
      node,
      originalMinHeight: activeHold?.originalMinHeight ?? node.style.minHeight,
      originalPaddingTop: activeHold?.originalPaddingTop ?? node.style.paddingTop,
      originalPaddingBottom: activeHold?.originalPaddingBottom ?? node.style.paddingBottom,
      height,
      topInset: activeHold?.topInset ?? 0,
      bottomInset: activeHold?.bottomInset ?? 0,
    } satisfies SidebarScrollRangeHold;
    scrollRangeHoldRef.current = next;
    node.style.minHeight = `${height}px`;
    node.style.paddingTop =
      next.topInset === 0
        ? next.originalPaddingTop
        : `calc(${next.originalPaddingTop || "0px"} + ${next.topInset}px)`;
    node.style.paddingBottom =
      next.bottomInset === 0
        ? next.originalPaddingBottom
        : `calc(${next.originalPaddingBottom || "0px"} + ${next.bottomInset}px)`;
  }, []);
  const extendScrollRange = useCallback((edge: "start" | "end", missingScrollRange: number) => {
    const hold = scrollRangeHoldRef.current;
    if (hold === null || missingScrollRange <= 0.5) return false;
    const next = {
      ...hold,
      height: hold.height + missingScrollRange,
      topInset: hold.topInset + (edge === "start" ? missingScrollRange : 0),
      bottomInset: hold.bottomInset + (edge === "end" ? missingScrollRange : 0),
    } satisfies SidebarScrollRangeHold;
    scrollRangeHoldRef.current = next;
    next.node.style.minHeight = `${next.height}px`;
    next.node.style.paddingTop =
      next.topInset === 0
        ? next.originalPaddingTop
        : `calc(${next.originalPaddingTop || "0px"} + ${next.topInset}px)`;
    next.node.style.paddingBottom =
      next.bottomInset === 0
        ? next.originalPaddingBottom
        : `calc(${next.originalPaddingBottom || "0px"} + ${next.bottomInset}px)`;
    return true;
  }, []);
  const releaseScrollRangeIfSafe = useCallback(() => {
    const hold = scrollRangeHoldRef.current;
    if (hold === null) return true;
    const viewport = viewportRef.current;
    if (viewport === null || !hold.node.isConnected) {
      clearScrollRangeHold();
      return true;
    }

    const anchor = chooseLayoutAnchor(null);
    const previousAnchorTop = anchor?.getBoundingClientRect().top ?? null;
    const previousScrollTop = viewport.scrollTop;
    const previousOverflowAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = "none";
    try {
      if (hold.topInset > 0.5) {
        viewport.scrollTop = Math.max(0, previousScrollTop - hold.topInset);
      }
      hold.node.style.minHeight = hold.originalMinHeight;
      hold.node.style.paddingTop = hold.originalPaddingTop;
      hold.node.style.paddingBottom = hold.originalPaddingBottom;
      const naturalMaxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const anchorDelta =
        anchor === null || previousAnchorTop === null
          ? 0
          : anchor.getBoundingClientRect().top - previousAnchorTop;
      const requestedScrollTop = viewport.scrollTop + anchorDelta;
      const outsideNaturalRange =
        requestedScrollTop < -0.5 || requestedScrollTop > naturalMaxScrollTop + 0.5;
      const temporaryInsetReachedNaturalBoundary =
        (requestedScrollTop < -0.5 && hold.topInset > 0.5) ||
        (requestedScrollTop > naturalMaxScrollTop + 0.5 && hold.bottomInset > 0.5);
      if (outsideNaturalRange && !temporaryInsetReachedNaturalBoundary) {
        hold.node.style.minHeight = `${hold.height}px`;
        hold.node.style.paddingTop =
          hold.topInset === 0
            ? hold.originalPaddingTop
            : `calc(${hold.originalPaddingTop || "0px"} + ${hold.topInset}px)`;
        hold.node.style.paddingBottom =
          hold.bottomInset === 0
            ? hold.originalPaddingBottom
            : `calc(${hold.originalPaddingBottom || "0px"} + ${hold.bottomInset}px)`;
        viewport.scrollTop = previousScrollTop;
        return false;
      }
      viewport.scrollTop = Math.min(naturalMaxScrollTop, Math.max(0, requestedScrollTop));
      correctedScrollTopRef.current = viewport.scrollTop;
      scrollRangeHoldRef.current = null;
      return true;
    } finally {
      viewport.style.overflowAnchor = previousOverflowAnchor;
    }
  }, [chooseLayoutAnchor, clearScrollRangeHold]);
  const moveClampedEmptyRailsToViewport = useCallback(
    (transaction: SidebarThreadDragTransaction) => {
      if (transaction.phase !== "dragging" || transaction.viewportRailTopBySection !== null) {
        return false;
      }
      const sourceOrderIndex = SIDEBAR_DND_SECTIONS.indexOf(transaction.sourceSection);
      const overlaySections = SIDEBAR_DND_SECTIONS.slice(0, sourceOrderIndex).filter(
        (section) =>
          input.sectionThreadCounts[section] === 0 &&
          input.canDropThreadInSection(
            transaction.sourceThread,
            transaction.sourceSection,
            section,
          ),
      );
      if (overlaySections.length === 0) return false;
      input.setTransaction((current) => {
        if (
          current === null ||
          current.sourceThreadKey !== transaction.sourceThreadKey ||
          current.viewportRailTopBySection !== null
        ) {
          return current;
        }
        return {
          ...current,
          viewportRailTopBySection: new Map(
            overlaySections.map((section, index) => [
              section,
              index * SIDEBAR_DND_EMPTY_RAIL_HEIGHT,
            ]),
          ),
        };
      });
      return true;
    },
    [input.canDropThreadInSection, input.sectionThreadCounts, input.setTransaction],
  );
  const correctDragLayout = useCallback(
    (transaction: SidebarThreadDragTransaction) => {
      const correction = correctLayoutAnchor();
      if (correction.kind !== "clamped") return;
      if (correction.edge === "end" && moveClampedEmptyRailsToViewport(transaction)) return;
      if (!extendScrollRange(correction.edge, correction.missingScrollRange)) {
        retainLayoutAnchor();
        return;
      }
      if (correctLayoutAnchor().kind === "clamped") {
        retainLayoutAnchor();
      }
    },
    [correctLayoutAnchor, extendScrollRange, moveClampedEmptyRailsToViewport, retainLayoutAnchor],
  );
  const attachListRef = useCallback(
    (node: HTMLUListElement | null) => {
      if (threadListNodeRef.current === node) return;
      clearScrollRangeHold();
      threadListNodeRef.current = node;
      autoAnimateRef(node);
    },
    [autoAnimateRef, clearScrollRangeHold],
  );

  useLayoutEffect(() => {
    if (input.transaction !== null) {
      holdScrollRange();
      correctDragLayout(input.transaction);
      return;
    }
    if (input.pinnedReorderInFlightRef.current) return;
    if (!autoAnimatePausedRef.current) {
      releaseScrollRangeIfSafe();
      return;
    }
    correctLayoutAnchor();
    autoAnimatePausedRef.current = false;
    const viewport = viewportRef.current;
    if (viewport !== null) {
      viewport.style.overflowAnchor = viewportOverflowAnchorRef.current;
    }
    setAutoAnimateEnabled(true);
    retainedLayoutAnchorRef.current = null;
    releaseScrollRangeIfSafe();
  });
  useEffect(() => {
    if (input.transaction === null) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      const correctedScrollTop = correctedScrollTopRef.current;
      if (correctedScrollTop !== null && Math.abs(viewport.scrollTop - correctedScrollTop) <= 0.5) {
        return;
      }
      correctedScrollTopRef.current = null;
      const retained = retainedLayoutAnchorRef.current;
      if (retained === null || !retained.element.isConnected) {
        retainLayoutAnchor();
        return;
      }
      retainedLayoutAnchorRef.current = {
        element: retained.element,
        top: retained.element.getBoundingClientRect().top,
      };
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [input.transaction, retainLayoutAnchor]);
  useEffect(() => {
    if (input.transaction !== null || scrollRangeHoldRef.current === null) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      if (releaseScrollRangeIfSafe()) {
        viewport.removeEventListener("scroll", handleScroll);
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [input.transaction, releaseScrollRangeIfSafe]);
  useEffect(() => {
    if (input.transaction === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const transaction = input.transactionRef.current;
      if (transaction !== null) {
        holdScrollRange();
        correctDragLayout(transaction);
      }
    });
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    if (threadListNodeRef.current !== null) observer.observe(threadListNodeRef.current);
    return () => observer.disconnect();
  }, [correctDragLayout, holdScrollRange, input.transaction, input.transactionRef]);
  useEffect(() => () => clearScrollRangeHold(), [clearScrollRangeHold]);

  return {
    viewportRef,
    viewportOverlayRef,
    viewportRailSectionsRef,
    attachListRef,
    handleViewportRailNodeChange,
    handleThreadRowNodeChange,
    getThreadRowNode,
    pauseLayoutMotion,
    holdScrollRange,
    retainLayoutAnchor,
  };
}
