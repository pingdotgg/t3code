import { type MessageId } from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";
import { Debouncer } from "@tanstack/react-pacer";
import { type LegendListRef } from "@legendapp/list/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { getAnchoredTurnMetrics, type TimelineScrollMode } from "./timelineScrollAnchoring";

const TIMELINE_SCROLL_KEYBOARD_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

const TIMELINE_SCROLL_LISTENER_SETUP_MAX_ATTEMPTS = 12;

export function isTimelineScrollKeyboardNavigationKey(key: string): boolean {
  return TIMELINE_SCROLL_KEYBOARD_NAVIGATION_KEYS.has(key);
}

export function scheduleTimelineManualNavigationListeners({
  cancelFrame = cancelAnimationFrame,
  getScrollNode,
  maxAttempts = TIMELINE_SCROLL_LISTENER_SETUP_MAX_ATTEMPTS,
  onManualNavigation,
  requestFrame = requestAnimationFrame,
}: {
  readonly cancelFrame?: (handle: number) => void;
  readonly getScrollNode: () => HTMLElement | null;
  readonly maxAttempts?: number;
  readonly onManualNavigation: () => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
}): () => void {
  let frame: number | null = null;
  let removeListeners: (() => void) | null = null;
  let cancelled = false;

  const installListeners = (scrollNode: HTMLElement) => {
    const isAnchorIgnoredEvent = (event: Event) =>
      event.target instanceof Element &&
      scrollNode.contains(event.target) &&
      event.target.closest("[data-scroll-anchor-ignore]") !== null;
    const handleManualNavigation = () => {
      onManualNavigation();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (isAnchorIgnoredEvent(event)) {
        return;
      }
      onManualNavigation();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !isTimelineScrollKeyboardNavigationKey(event.key) ||
        isAnchorIgnoredEvent(event)
      ) {
        return;
      }
      onManualNavigation();
    };
    scrollNode.addEventListener("wheel", handleManualNavigation, {
      passive: true,
    });
    scrollNode.addEventListener("touchmove", handleManualNavigation, {
      passive: true,
    });
    scrollNode.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    scrollNode.addEventListener("keydown", handleKeyDown);
    removeListeners = () => {
      scrollNode.removeEventListener("wheel", handleManualNavigation);
      scrollNode.removeEventListener("touchmove", handleManualNavigation);
      scrollNode.removeEventListener("pointerdown", handlePointerDown);
      scrollNode.removeEventListener("keydown", handleKeyDown);
    };
  };

  const scheduleSetup = (remainingAttempts: number) => {
    frame = requestFrame(() => {
      frame = null;
      if (cancelled || removeListeners !== null) {
        return;
      }

      const scrollNode = getScrollNode();
      if (!scrollNode) {
        if (remainingAttempts > 0) {
          scheduleSetup(remainingAttempts - 1);
        }
        return;
      }

      installListeners(scrollNode);
    });
  };

  scheduleSetup(maxAttempts);

  return () => {
    cancelled = true;
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    removeListeners?.();
  };
}

export function clearPendingTimelineAnchorScrollRestore({
  anchorScrollRestoreFrameRef,
  cancelFrame = cancelAnimationFrame,
  pendingAnchorScrollRestoreRef,
}: {
  readonly anchorScrollRestoreFrameRef: { current: number | null };
  readonly cancelFrame?: (handle: number) => void;
  readonly pendingAnchorScrollRestoreRef: { current: unknown | null };
}): void {
  pendingAnchorScrollRestoreRef.current = null;
  if (anchorScrollRestoreFrameRef.current !== null) {
    cancelFrame(anchorScrollRestoreFrameRef.current);
    anchorScrollRestoreFrameRef.current = null;
  }
}

export interface TimelineScrollController {
  readonly showScrollToBottom: boolean;
  readonly scrollToEnd: (animated?: boolean) => void;
  readonly cancelForManualNavigation: () => void;
  readonly onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  readonly onAnchorSizeChanged: (messageId: MessageId) => void;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly prepareAnchorForMessage: (messageId: MessageId) => void;
  readonly resetForThread: () => void;
}

export function useTimelineScrollController({
  activeThreadId,
  composerOverlayHeight,
  listRef,
  timelineEntries,
}: {
  readonly activeThreadId: string | null;
  readonly composerOverlayHeight: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly timelineEntries: readonly unknown[];
}): TimelineScrollController {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const isAtEndRef = useRef(true);
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const anchorPositionFrameRefs = useRef<Set<number>>(new Set());
  const anchorPositionCleanupRef = useRef<(() => void) | null>(null);

  const cleanupAnchorPositioning = useCallback(() => {
    for (const frame of anchorPositionFrameRefs.current) {
      cancelAnimationFrame(frame);
    }
    anchorPositionFrameRefs.current.clear();
    anchorPositionCleanupRef.current?.();
    anchorPositionCleanupRef.current = null;
  }, []);
  const clearPendingAnchorScrollRestore = useCallback(() => {
    clearPendingTimelineAnchorScrollRestore({
      anchorScrollRestoreFrameRef,
      pendingAnchorScrollRestoreRef,
    });
  }, []);

  const scheduleAnchorPositionFrame = useCallback((callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      anchorPositionFrameRefs.current.delete(frame);
      callback();
    });
    anchorPositionFrameRefs.current.add(frame);
  }, []);

  const cancelForManualNavigation = useCallback(() => {
    anchorUserScrollGenerationRef.current += 1;
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    clearPendingAnchorScrollRestore();
    cleanupAnchorPositioning();
  }, [cleanupAnchorPositioning, clearPendingAnchorScrollRestore]);
  const cancelForManualNavigationRef = useRef(cancelForManualNavigation);
  useEffect(() => {
    cancelForManualNavigationRef.current = cancelForManualNavigation;
  }, [cancelForManualNavigation]);

  const getActiveTimelineTurnMetrics = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? listRef.current;
      const anchorIndex = activeTimelineAnchorIndexRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || anchorIndex === null) {
        return null;
      }

      return getAnchoredTurnMetrics({
        state,
        anchorIndex,
        composerOverlayHeight,
        anchorOffset: CHAT_LIST_ANCHOR_OFFSET,
      });
    },
    [composerOverlayHeight, listRef],
  );
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) => {
      const resolvedList = list ?? listRef.current;
      const state = resolvedList?.getState();
      if (!resolvedList || !state || state.data.length === 0) {
        return false;
      }

      const lastRowIndex = state.data.length - 1;
      const lastRowTop = state.positionAtIndex(lastRowIndex);
      const lastRowHeight = state.sizeAtIndex(lastRowIndex);
      if (
        typeof lastRowTop !== "number" ||
        typeof lastRowHeight !== "number" ||
        !Number.isFinite(lastRowTop) ||
        !Number.isFinite(lastRowHeight)
      ) {
        return false;
      }

      const realContentBottom = lastRowTop + Math.max(1, lastRowHeight);
      const visibleScrollLength = Math.max(
        0,
        (state.scrollLength ?? 0) - composerOverlayHeight - CHAT_LIST_ANCHOR_OFFSET,
      );
      return realContentBottom > visibleScrollLength;
    },
    [composerOverlayHeight, listRef],
  );

  const scrollToEnd = useCallback(
    (animated = false) => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = null;
      positionedTimelineAnchorRef.current = null;
      settledTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      clearPendingAnchorScrollRestore();
      cleanupAnchorPositioning();
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      void listRef.current?.scrollToEnd?.({ animated });
    },
    [cleanupAnchorPositioning, clearPendingAnchorScrollRestore, listRef],
  );

  const hasTimelineEntries = timelineEntries.length > 0;
  useEffect(() => {
    return scheduleTimelineManualNavigationListeners({
      getScrollNode: () => listRef.current?.getScrollableNode() ?? null,
      onManualNavigation: () => cancelForManualNavigationRef.current(),
    });
  }, [activeThreadId, hasTimelineEntries, listRef]);

  const onAnchorReady = useCallback(
    (messageId: MessageId, anchorIndex: number) => {
      if (pendingTimelineAnchorRef.current === messageId) {
        pendingTimelineAnchorRef.current = null;
      }
      activeTimelineAnchorIndexRef.current = anchorIndex;
      if (positionedTimelineAnchorRef.current === messageId) {
        return;
      }
      cleanupAnchorPositioning();
      positionedTimelineAnchorRef.current = messageId;
      settledTimelineAnchorRef.current = null;
      const positionAnchor = (remainingAttempts: number) => {
        scheduleAnchorPositionFrame(() => {
          if (positionedTimelineAnchorRef.current !== messageId) {
            return;
          }
          const list = listRef.current;
          if (!list) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            }
            return;
          }
          const scrollNode = list.getScrollableNode();
          if (!scrollNode) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            }
            return;
          }
          let finished = false;
          let cleanup: (() => void) | null = null;
          const finishAnimatedPositioning = () => {
            if (finished) {
              return;
            }
            finished = true;
            window.clearTimeout(fallbackTimer);
            scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
            if (anchorPositionCleanupRef.current === cleanup) {
              anchorPositionCleanupRef.current = null;
            }
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            const scrollOffset = list.getState().scroll;
            void list.scrollToOffset({ offset: scrollOffset, animated: false });
            settledTimelineAnchorRef.current = messageId;
          };
          const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
          scrollNode.addEventListener("scrollend", finishAnimatedPositioning, { once: true });
          cleanup = () => {
            if (finished) {
              return;
            }
            finished = true;
            window.clearTimeout(fallbackTimer);
            scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
            if (anchorPositionCleanupRef.current === cleanup) {
              anchorPositionCleanupRef.current = null;
            }
          };
          anchorPositionCleanupRef.current = cleanup;
          void list.scrollToIndex({
            index: anchorIndex,
            animated: true,
            viewPosition: 0,
            viewOffset: CHAT_LIST_ANCHOR_OFFSET,
          });
        });
      };
      scheduleAnchorPositionFrame(() => positionAnchor(12));
    },
    [cleanupAnchorPositioning, listRef, scheduleAnchorPositionFrame],
  );

  const onAnchorSizeChanged = useCallback(
    (messageId: MessageId) => {
      if (settledTimelineAnchorRef.current !== messageId) {
        return;
      }
      if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
        return;
      }
      const scrollOffset = listRef.current?.getState().scroll;
      if (scrollOffset === undefined) {
        return;
      }
      if (pendingAnchorScrollRestoreRef.current === null) {
        pendingAnchorScrollRestoreRef.current = {
          messageId,
          offset: scrollOffset,
          userScrollGeneration: anchorUserScrollGenerationRef.current,
        };
      }
      if (anchorScrollRestoreFrameRef.current !== null) {
        return;
      }
      anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
        anchorScrollRestoreFrameRef.current = null;
        const pending = pendingAnchorScrollRestoreRef.current;
        pendingAnchorScrollRestoreRef.current = null;
        if (
          pending &&
          settledTimelineAnchorRef.current === pending.messageId &&
          pending.userScrollGeneration === anchorUserScrollGenerationRef.current
        ) {
          const list = listRef.current;
          const currentScrollOffset = list?.getState().scroll;
          if (
            typeof currentScrollOffset === "number" &&
            Math.abs(currentScrollOffset - pending.offset) <= 2
          ) {
            void list?.scrollToOffset({ offset: pending.offset, animated: false });
          }
        }
      });
    },
    [listRef],
  );

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
      return;
    }

    let secondFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (liveFollowUserScrollGenerationRef.current !== anchorUserScrollGenerationRef.current) {
          return;
        }
        if (pendingTimelineAnchorRef.current !== null) {
          return;
        }
        if (
          positionedTimelineAnchorRef.current !== null &&
          settledTimelineAnchorRef.current !== positionedTimelineAnchorRef.current
        ) {
          return;
        }
        const list = listRef.current;
        if (!list) {
          return;
        }

        if (timelineScrollModeRef.current === "anchoring-new-turn") {
          const metrics = getActiveTimelineTurnMetrics(list);
          if (!metrics) {
            return;
          }
          if (metrics.scrollDeltaToRevealEnd <= 1) {
            return;
          }

          const nextOffset = list.getState().scroll + metrics.scrollDeltaToRevealEnd;
          void list.scrollToOffset({ offset: nextOffset, animated: false });
          return;
        }

        if (timelineScrollModeRef.current !== "following-end") {
          return;
        }
        if (!timelineRealContentOverflowsViewport(list)) {
          return;
        }

        void list.scrollToEnd?.({ animated: false });
      });
    });

    return () => {
      cancelAnimationFrame(frame);
      if (secondFrame !== null) {
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    activeThreadId,
    timelineEntries,
    getActiveTimelineTurnMetrics,
    timelineRealContentOverflowsViewport,
    listRef,
  ]);

  const resetForThread = useCallback(() => {
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    clearPendingAnchorScrollRestore();
    cleanupAnchorPositioning();
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, [cleanupAnchorPositioning, clearPendingAnchorScrollRestore]);

  const prepareAnchorForMessage = useCallback(
    (messageId: MessageId) => {
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      pendingTimelineAnchorRef.current = messageId;
      activeTimelineAnchorIndexRef.current = null;
      clearPendingAnchorScrollRestore();
      cleanupAnchorPositioning();
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    },
    [cleanupAnchorPositioning, clearPendingAnchorScrollRestore],
  );

  useEffect(
    () => () => {
      cleanupAnchorPositioning();
      showScrollDebouncer.current.cancel();
      clearPendingAnchorScrollRestore();
    },
    [cleanupAnchorPositioning, clearPendingAnchorScrollRestore],
  );

  return {
    showScrollToBottom,
    scrollToEnd,
    cancelForManualNavigation,
    onAnchorReady,
    onAnchorSizeChanged,
    onIsAtEndChange,
    prepareAnchorForMessage,
    resetForThread,
  };
}
