import { useAutoAnimate } from "@formkit/auto-animate/react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import {
  SIDEBAR_DND_SECTIONS,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "../components/Sidebar.dnd.logic";

const EMPTY_SECTION_HEIGHT = 48;

export type SidebarThreadDragStateSetter = (
  next:
    | SidebarThreadDragTransaction
    | null
    | ((current: SidebarThreadDragTransaction | null) => SidebarThreadDragTransaction | null),
) => void;

export interface SidebarDndLayout {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly viewportOverlayRef: RefObject<HTMLDivElement | null>;
  readonly attachListRef: (node: HTMLUListElement | null) => void;
  readonly handleThreadRowNodeChange: (threadKey: string, node: HTMLElement | null) => void;
  readonly getThreadRowNode: (threadKey: string) => HTMLElement | null;
  readonly pauseLayoutMotion: () => void;
  readonly retainLayoutAnchor: (
    preferred?: HTMLElement | null,
    excludedThreadKey?: string | null,
  ) => void;
}

export function useSidebarDndLayout(input: {
  transaction: SidebarThreadDragTransaction | null;
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
  const threadRowNodesRef = useRef(new Map<string, HTMLElement>());
  const layoutAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const motionPausedRef = useRef(false);

  const handleThreadRowNodeChange = useCallback((threadKey: string, node: HTMLElement | null) => {
    if (node === null) threadRowNodesRef.current.delete(threadKey);
    else threadRowNodesRef.current.set(threadKey, node);
  }, []);
  const getThreadRowNode = useCallback(
    (threadKey: string) => threadRowNodesRef.current.get(threadKey) ?? null,
    [],
  );
  const visibleAnchor = useCallback(
    (preferred: HTMLElement | null, excludedThreadKey: string | null) => {
      const viewport = viewportRef.current;
      if (viewport === null) return null;
      const viewportRect = viewport.getBoundingClientRect();
      const isVisible = (node: HTMLElement) => {
        if (!node.isConnected || node.dataset.dndTransformed === "true") return false;
        const rect = node.getBoundingClientRect();
        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      };
      if (preferred !== null && isVisible(preferred)) return preferred;
      for (const [threadKey, node] of threadRowNodesRef.current) {
        if (threadKey !== excludedThreadKey && isVisible(node)) return node;
      }
      return null;
    },
    [],
  );
  const retainLayoutAnchor = useCallback(
    (preferred: HTMLElement | null = null, excludedThreadKey: string | null = null) => {
      const element = visibleAnchor(preferred, excludedThreadKey);
      layoutAnchorRef.current =
        element === null ? null : { element, top: element.getBoundingClientRect().top };
    },
    [visibleAnchor],
  );
  const pauseLayoutMotion = useCallback(() => {
    if (motionPausedRef.current) return;
    motionPausedRef.current = true;
    setAutoAnimateEnabled(false);
  }, [setAutoAnimateEnabled]);

  const moveEmptySectionsIntoViewport = useCallback(
    (transaction: SidebarThreadDragTransaction) => {
      if (transaction.phase !== "dragging" || transaction.viewportRailTopBySection !== null) {
        return;
      }
      const sourceIndex = SIDEBAR_DND_SECTIONS.indexOf(transaction.sourceSection);
      const sections = SIDEBAR_DND_SECTIONS.slice(0, sourceIndex).filter(
        (section) =>
          input.sectionThreadCounts[section] === 0 &&
          input.canDropThreadInSection(
            transaction.sourceThread,
            transaction.sourceSection,
            section,
          ),
      );
      if (sections.length === 0) return;
      input.setTransaction((current) =>
        current === null || current.sourceThreadKey !== transaction.sourceThreadKey
          ? current
          : {
              ...current,
              viewportRailTopBySection: new Map(
                sections.map((section, index) => [section, index * EMPTY_SECTION_HEIGHT]),
              ),
            },
      );
    },
    [input.canDropThreadInSection, input.sectionThreadCounts, input.setTransaction],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = layoutAnchorRef.current;
    if (viewport !== null && anchor !== null && anchor.element.isConnected) {
      const delta = anchor.element.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > 0.5) {
        const requestedScrollTop = viewport.scrollTop + delta;
        viewport.scrollTop = requestedScrollTop;
        if (Math.abs(viewport.scrollTop - requestedScrollTop) > 0.5 && input.transaction !== null) {
          moveEmptySectionsIntoViewport(input.transaction);
        }
      }
      layoutAnchorRef.current = {
        element: anchor.element,
        top: anchor.element.getBoundingClientRect().top,
      };
    } else if (input.transaction !== null) {
      retainLayoutAnchor();
    }

    if (input.transaction !== null || input.pinnedReorderInFlightRef.current) return;
    if (motionPausedRef.current) {
      motionPausedRef.current = false;
      setAutoAnimateEnabled(true);
    }
    layoutAnchorRef.current = null;
  });

  useEffect(() => {
    if (input.transaction === null) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const handleScroll = () => {
      const anchor = layoutAnchorRef.current;
      if (anchor === null || !anchor.element.isConnected) {
        retainLayoutAnchor();
      } else {
        layoutAnchorRef.current = {
          element: anchor.element,
          top: anchor.element.getBoundingClientRect().top,
        };
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [input.transaction, retainLayoutAnchor]);

  return {
    viewportRef,
    viewportOverlayRef,
    attachListRef: autoAnimateRef,
    handleThreadRowNodeChange,
    getThreadRowNode,
    pauseLayoutMotion,
    retainLayoutAnchor,
  };
}
