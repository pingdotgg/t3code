import { type MessageId, type OrchestrationThreadMessageHistory } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

type HistoryPageDirection = "before" | "after";

interface HistoryPageRequest {
  readonly direction: HistoryPageDirection;
}

interface HistoryPositioningTarget {
  readonly id: MessageId;
}

interface UseProgressiveTimelineHistoryInput {
  readonly contentInsetEndAdjustment: number;
  readonly historyTargetMessageId: MessageId | null;
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly latestMessagesRequest: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapStripMap: Map<string, HTMLSpanElement>;
  readonly onHistoryTargetReady: (() => void) | undefined;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onLoadNextMessages: (() => Promise<boolean>) | undefined;
  readonly onLoadPreviousMessages: (() => Promise<boolean>) | undefined;
  readonly onManualNavigation: (cancelHistoryLoad: boolean) => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly routeThreadKey: string;
  readonly rowIndexOffset: number;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

export function useProgressiveTimelineHistory({
  contentInsetEndAdjustment,
  historyTargetMessageId,
  isLoadingNextMessages,
  isLoadingPreviousMessages,
  latestMessagesRequest,
  listRef,
  messageHistory,
  minimapStripMap,
  onHistoryTargetReady,
  onIsAtEndChange,
  onLoadNextMessages,
  onLoadPreviousMessages,
  onManualNavigation,
  onSelectHistoryMessage,
  routeThreadKey,
  rowIndexOffset,
  rows,
}: UseProgressiveTimelineHistoryInput) {
  const pageRequestRef = useRef<HistoryPageRequest | null>(null);
  const initializedThreadRef = useRef<string | null>(null);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const latestPositionPendingRef = useRef(false);
  const positioningTargetRef = useRef<HistoryPositioningTarget | null>(null);
  const minimapFrameRef = useRef<number | null>(null);
  const visibleMinimapIdsRef = useRef<ReadonlySet<string>>(new Set());

  const rowIndexByMessageId = useMemo(() => {
    const indexes = new Map<MessageId, number>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.kind === "message") {
        indexes.set(row.message.id, index + rowIndexOffset);
      }
    }
    return indexes;
  }, [rowIndexOffset, rows]);

  const requestPage = useCallback(
    (direction: HistoryPageDirection) => {
      if (messageHistory === undefined || pageRequestRef.current !== null) {
        return;
      }
      const isBefore = direction === "before";
      if (
        (isBefore && (!messageHistory.hasMoreBefore || isLoadingPreviousMessages)) ||
        (!isBefore && (!messageHistory.hasMoreAfter || isLoadingNextMessages))
      ) {
        return;
      }
      const load = isBefore ? onLoadPreviousMessages : onLoadNextMessages;
      if (load === undefined) {
        return;
      }

      const request = { direction };
      pageRequestRef.current = request;
      void load().finally(() => {
        if (pageRequestRef.current === request) {
          pageRequestRef.current = null;
        }
      });
    },
    [
      isLoadingNextMessages,
      isLoadingPreviousMessages,
      messageHistory,
      onLoadNextMessages,
      onLoadPreviousMessages,
    ],
  );

  const loadPreviousPage = useCallback(() => {
    requestPage("before");
  }, [requestPage]);

  const loadNextPage = useCallback(() => {
    requestPage("after");
  }, [requestPage]);

  const updateMinimap = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode === null || scrollNode === undefined) {
      return;
    }
    const viewport = scrollNode.getBoundingClientRect();
    const visibleMessageIds = new Set<string>();
    for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = element.getBoundingClientRect();
      const messageId = element.dataset.messageId;
      if (messageId !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        visibleMessageIds.add(messageId);
      }
    }
    for (const messageId of visibleMinimapIdsRef.current) {
      if (!visibleMessageIds.has(messageId)) {
        const strip = minimapStripMap.get(messageId);
        if (strip !== undefined) {
          strip.dataset.inView = "false";
        }
      }
    }
    for (const messageId of visibleMessageIds) {
      const strip = minimapStripMap.get(messageId);
      if (strip !== undefined) {
        strip.dataset.inView = "true";
      }
    }
    visibleMinimapIdsRef.current = visibleMessageIds;
  }, [listRef, minimapStripMap]);

  const scheduleMinimapUpdate = useCallback(() => {
    if (minimapFrameRef.current !== null) {
      return;
    }
    minimapFrameRef.current = requestAnimationFrame(() => {
      minimapFrameRef.current = null;
      updateMinimap();
    });
  }, [updateMinimap]);

  const positionHistoryTarget = useCallback(
    (id: MessageId, rowIndex: number, animated: boolean, onReady?: () => void) => {
      const list = listRef.current;
      if (list === null) {
        return;
      }
      const target = { id };
      positioningTargetRef.current = target;
      void list
        .scrollToIndex({
          index: rowIndex,
          animated,
          viewPosition: 0.5,
        })
        .then(() => {
          if (positioningTargetRef.current !== target) {
            return;
          }
          positioningTargetRef.current = null;
          scheduleMinimapUpdate();
          onReady?.();
        });
    },
    [listRef, scheduleMinimapUpdate],
  );

  const beginUserNavigation = useCallback(() => {
    scheduleMinimapUpdate();
    if (positioningTargetRef.current !== null) {
      positioningTargetRef.current = null;
    }
    if (historyTargetMessageId !== null) {
      onHistoryTargetReady?.();
    }
    onManualNavigation(true);
  }, [historyTargetMessageId, onHistoryTargetReady, onManualNavigation, scheduleMinimapUpdate]);

  const handleScroll = useCallback(() => {
    const localIsAtEnd = resolveTimelineIsAtEnd(
      listRef.current?.getState(),
      contentInsetEndAdjustment,
    );
    if (localIsAtEnd !== undefined) {
      onIsAtEndChange(
        messageHistory === undefined ? localIsAtEnd : localIsAtEnd && !messageHistory.hasMoreAfter,
      );
    }
    scheduleMinimapUpdate();
  }, [contentInsetEndAdjustment, listRef, messageHistory, onIsAtEndChange, scheduleMinimapUpdate]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      onManualNavigation(false);
      const rowIndex = rowIndexByMessageId.get(item.id);
      if (rowIndex !== undefined) {
        positionHistoryTarget(item.id, rowIndex, true);
        return;
      }
      onSelectHistoryMessage?.(item.id);
    },
    [onManualNavigation, onSelectHistoryMessage, positionHistoryTarget, rowIndexByMessageId],
  );

  useLayoutEffect(() => {
    updateMinimap();
  }, [rows, updateMinimap]);

  useLayoutEffect(() => {
    if (
      historyTargetMessageId === null ||
      positioningTargetRef.current?.id === historyTargetMessageId
    ) {
      return;
    }
    const rowIndex = rowIndexByMessageId.get(historyTargetMessageId);
    if (rowIndex === undefined) {
      return;
    }
    positionHistoryTarget(historyTargetMessageId, rowIndex, false, onHistoryTargetReady);
  }, [historyTargetMessageId, onHistoryTargetReady, positionHistoryTarget, rowIndexByMessageId]);

  useLayoutEffect(() => {
    if (initializedThreadRef.current === routeThreadKey) {
      return;
    }
    initializedThreadRef.current = routeThreadKey;
    for (const messageId of visibleMinimapIdsRef.current) {
      const strip = minimapStripMap.get(messageId);
      if (strip !== undefined) {
        strip.dataset.inView = "false";
      }
    }
    visibleMinimapIdsRef.current = new Set();
    pageRequestRef.current = null;
    positioningTargetRef.current = null;
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    latestPositionPendingRef.current = false;
  }, [latestMessagesRequest, minimapStripMap, routeThreadKey]);

  useLayoutEffect(() => {
    if (handledLatestMessagesRequestRef.current === latestMessagesRequest) {
      return;
    }
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    latestPositionPendingRef.current = true;
    pageRequestRef.current = null;
    positioningTargetRef.current = null;
  }, [latestMessagesRequest]);

  useLayoutEffect(() => {
    if (
      messageHistory === undefined ||
      messageHistory.hasMoreAfter ||
      !latestPositionPendingRef.current
    ) {
      return;
    }
    latestPositionPendingRef.current = false;
    void listRef.current?.scrollToEnd({ animated: false }).then(scheduleMinimapUpdate);
  }, [listRef, messageHistory, rows, scheduleMinimapUpdate]);

  useEffect(() => {
    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (
        !["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key) ||
        (document.activeElement !== document.body && !scrollNode?.contains(document.activeElement))
      ) {
        return;
      }
      beginUserNavigation();
    };
    window.addEventListener("keydown", handleKeyboardNavigation, true);
    return () => {
      window.removeEventListener("keydown", handleKeyboardNavigation, true);
    };
  }, [beginUserNavigation, listRef]);

  useEffect(
    () => () => {
      if (minimapFrameRef.current !== null) {
        cancelAnimationFrame(minimapFrameRef.current);
        minimapFrameRef.current = null;
      }
    },
    [],
  );

  return useMemo(
    () => ({
      beginUserNavigation,
      handleScroll,
      loadNextPage,
      loadPreviousPage,
      selectHistoryTarget,
    }),
    [beginUserNavigation, handleScroll, loadNextPage, loadPreviousPage, selectHistoryTarget],
  );
}
