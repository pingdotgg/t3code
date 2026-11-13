/**
 * Thread feed list state: scrolling, anchoring, reflow and row interaction handlers.
 */
import { useViewabilityAmount, type LegendListRef } from "@legendapp/list/react-native";
import {
  AuthFilesystemReadScope,
  idleCompactionOf,
  type OrchestrationMessageContext,
  ThreadId,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  type ScheduledTaskId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type ComponentPropsWithRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import {
  createThreadFeedCache,
  threadFeedCompactionLabels,
  failedFeedRunIds,
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  isContextCompactionActivityGroup,
  isContextHandoffActivityGroup,
  isLinkRequestActivityGroup,
  isSecretRequestActivityGroup,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  messageFoldRunId,
} from "../../../lib/threadActivity";
import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedReflowAnchor,
  resolveThreadFeedReflowOffset,
  resolveThreadFeedReflowScroll,
  type ThreadFeedLiveFollowEvent,
  type ThreadFeedReflowAnchor,
  type ThreadWorkGroupScrollPosition,
} from "../thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadDisclosureChevron,
  THREAD_DISCLOSURE_TRANSITION_MS,
  ThreadWorkGroupToggle,
  ThreadThinkingRow,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "../thread-work-log";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import { resolveThreadFeedFixedItemSize } from "../thread-feed-item-size";
import { htmlRenderFrameHeight } from "@t3tools/shared/htmlRender";
import { htmlRenderRowHeight, ThreadHtmlRender } from "../HtmlRenderWebView";
import {
  DISCLOSURE_DETAIL_DELAY_MS,
  DISCLOSURE_DETAIL_FADE_MS,
} from "./message-rows.tsx";
import {
  FEED_PADDING_TOP,
  FEED_REFLOW_HOLD_MS,
  FEED_REFLOW_SETTLE_MS,
  useThreadFeedPresentation,
} from "./placeholder.tsx";
import type { ThreadFeedHandle, ThreadFeedProps } from "./types.ts";
import type { ThreadFeedView } from "./use-thread-feed-view.tsx";
import type { ThreadFeedMarkdown } from "./use-thread-feed-markdown.tsx";

export function useThreadFeedList(
  props: ThreadFeedProps,
  ref: Ref<ThreadFeedHandle> | undefined,
  view: ThreadFeedView & ThreadFeedMarkdown,
) {
  const {
    listRef,
    onHeaderMaterialVisibilityChange,
    workflowOpening,
    guestShare,
    themeAppearance,
    copyFeedbackTimeoutRef,
    disclosureSettleFrameRef,
    disclosureSettleSecondFrameRef,
    disclosureAnchorKeyRef,
    userScrollSettleTimerRef,
    headerMaterialVisibleRef,
    workRowSizing,
    measuredViewportWidth,
    setViewportWidth,
    viewportWidth,
    viewportHeight,
    setViewportHeight,
    setDisclosureToggleSettling,
    disclosureLayout,
    setDisclosureLayout,
    disclosureMotionRef,
    disclosureMotionTimer,
    reduceMotion,
    headerEndRef,
    lastFeedId,
    setDisclosureGap,
    disclosureTopSpace,
    endFollowEnabled,
    endFollowEnabledRef,
    userScrollSessionRef,
    setEndFollow,
    transitionEndFollow,
    reflowAnchorRef,
    reflowAnchorsSizeChanges,
    setReflowFollowsEnd,
    reflowSettleTimerRef,
    listHeaderSizeRef,
    loadedListKeyRef,
    cancelReflow,
    setInteractionState,
    copiedRowId,
    expandedWorkGroups,
    expandedWorkRows,
    expandedTurnIds,
    contentWidth,
    anchorTopInset,
    iconSubtleColor,
    userBubbleColor,
    markdownStyles,
    reviewCommentColors,
    unsettledTurnId,
  } = view;
  const listAppearanceData = {
    disclosureLayout,
    reduceMotion,
    worktreeSetup: props.worktreeSetup,
    setupWorkingStartedAt: props.setupWorkingStartedAt,
    dispatchingMessageId: props.dispatchingMessageId,
    unsettledTurnId,
    copiedRowId,
    expandedWorkGroups,
    expandedWorkRows,
    workRowSizing,
    iconSubtleColor,
    markdownStyles,
    reviewCommentColors,
    themeAppearance,
    userBubbleColor,
    viewportWidth,
    contentWidth,
    skills: props.skills,
    workflowOpening,
  };
  const reportHeaderMaterialVisibility = (visible: boolean) => {
    if (headerMaterialVisibleRef.current === visible) {
      return;
    }
    headerMaterialVisibleRef.current = visible;
    onHeaderMaterialVisibilityChange?.(visible);
  };
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
    // Re-arm follow only at the actual end; the broader threshold can reclaim upward drags during streaming.
    const listState = listRef.current?.getState();
    if (listState) {
      transitionEndFollow({
        type: "scroll",
        isAtEnd: listState.isAtEnd,
        userScrollSessionActive: userScrollSessionRef.current,
      });
    }
  };
  const clearUserScrollSettle = () => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  };
  const handleScrollBeginDrag = () => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    cancelReflow();
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  };
  const finishUserScroll = (releaseIsAtEnd?: boolean) => {
    clearUserScrollSettle();
    const userScrollSessionActive = userScrollSessionRef.current;
    userScrollSessionRef.current = false;
    transitionEndFollow({
      type: "user-scroll-end",
      // Without momentum, retain release position; stream growth during detection must not disable follow.
      isAtEnd: releaseIsAtEnd ?? listRef.current?.getState().isAtEnd ?? false,
      userScrollSessionActive,
    });
  };
  // Zero release velocity may still produce momentum; wait for native detection before ending the session.
  const handleScrollEndDrag = () => {
    clearUserScrollSettle();
    const releaseIsAtEnd = listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  };
  const handleMomentumScrollBegin = () => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  };
  const handleMomentumScrollEnd = () => {
    finishUserScroll();
  };

  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);
  const workGroupScrollPositions = new Map<string, ThreadWorkGroupScrollPosition>();
  // ThreadDetailScreen remounts the feed per thread, so only a send resets following.
  useImperativeHandle(ref, () => ({
    resetEndFollow: () => {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      setDisclosureGap(null);
      cancelReflow();
      transitionEndFollow({ type: "reset" });
    },
  }));

  // Opening at a message: once the filled list has loaded, the render that sees
  // the jump unfolds a run hiding the message and stops following the end, so
  // the committed list holds the target row with end maintenance off.
  const [loadedListKey, setLoadedListKey] = useState<string | null>(null);
  const { jumpToMessageId } = props;
  const jumpReady = !!jumpToMessageId && loadedListKey === `${feedThreadKey}:filled`;
  const presentedFeed = appendGuestPendingMessages(
    useThreadFeedPresentation(props, expandedTurnIds, expandedWorkGroups),
    guestShare,
  );
  const jumpRunId =
    jumpReady &&
    !presentedFeed.some((entry) => entry.type === "message" && entry.id === jumpToMessageId)
      ? messageFoldRunId(props.feed, jumpToMessageId)
      : null;
  if (jumpRunId && !expandedTurnIds.has(jumpRunId)) {
    setInteractionState((current) => ({
      ...current,
      expandedTurnIds: new Set(current.expandedTurnIds).add(jumpRunId),
    }));
  }
  const setupAnchorIndex = presentedFeed.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  const [groupFeed] = useState(createThreadFeedGrouping);
  const groupedFeed = groupFeed(presentedFeed, {
    workflowOpeningMessageId: workflowOpening?.messageId,
    setupAnchorIndex:
      props.worktreeSetup || props.setupWorkingStartedAt ? setupAnchorIndex : undefined,
  });
  // The empty↔filled key below remounts the list and resets its imperative
  // content-inset override. Seed each fresh instance as it attaches with the
  // current overlay height before the scroll integration's next reaction;
  // on Android the declarative contentInset floor covers this same window.
  const listMountKey = `${feedThreadKey}:${presentedFeed.some((entry) => entry.type !== "thinking") ? "filled" : "empty"}`;
  const { contentInsetEndAdjustment } = props;
  const attachList = (list: LegendListRef | null) => {
    listRef.current = list;
    const bottom = contentInsetEndAdjustment.get();
    if (list && bottom > 0) list.reportContentInset({ bottom });
  };
  const jumpIndex = jumpReady
    ? presentedFeed.findIndex((entry) => entry.type === "message" && entry.id === jumpToMessageId)
    : null;
  const followsEnd = endFollowEnabled && !jumpReady;
  const landJump = useEffectEvent((index: number) => {
    if (index !== -1) {
      setEndFollow(false);
      void listRef.current?.scrollToIndex({ index, viewPosition: 0.2, animated: false });
    }
    props.onJumpedToMessage?.();
  });
  // Z: a native list scroll after the commit that rendered its target row. The
  // row is often already measured, so no LegendList callback fires for that
  // commit, and setEndFollow notifies the parent, so it can't run during render.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the native list to the jump target after the commit that rendered its row
  useEffect(() => {
    if (jumpIndex !== null) landJump(jumpIndex);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Jumping to a different message whose row index is unchanged must still land the jump.
  }, [jumpToMessageId, jumpIndex]);

  const reflowLayout = () => ({
    rowsTop: FEED_PADDING_TOP + listHeaderSizeRef.current,
    headerInset: anchorTopInset,
  });
  const settleReflow = () => {
    reflowSettleTimerRef.current = null;
    const anchor = reflowAnchorRef.current;
    cancelReflow();
    const list = listRef.current;
    if (reflowAnchorsSizeChanges || !anchor || anchor === "end" || !list) return;
    if (userScrollSessionRef.current) return;
    if (loadedListKeyRef.current !== listMountKey) return;
    const target = resolveThreadFeedReflowScroll(anchor, list.getState(), reflowLayout());
    if (target) void list.scrollToIndex({ ...target, viewPosition: 0, animated: false });
  };
  const beginReflow = () => {
    // Until the list loads, its own initial end positioning owns the offset.
    if (loadedListKeyRef.current !== listMountKey) return;
    if (reflowAnchorRef.current === undefined) {
      const listState = listRef.current?.getState();
      const anchor =
        listState && !userScrollSessionRef.current
          ? resolveThreadFeedReflowAnchor(listState, reflowLayout(), endFollowEnabledRef.current)
          : null;
      reflowAnchorRef.current = anchor;
      if (anchor === "end" && !reflowAnchorsSizeChanges) {
        // The list may already have judged the first new sizes against its own threshold, so
        // pin the end once; the lifted threshold keeps it there as later rows re-measure.
        setReflowFollowsEnd(true);
        void listRef.current?.scrollToEnd({ animated: false });
      }
    }
    // Every re-measure restarts the countdown.
    if (reflowSettleTimerRef.current !== null) clearTimeout(reflowSettleTimerRef.current);
    reflowSettleTimerRef.current = setTimeout(
      settleReflow,
      reflowAnchorsSizeChanges ? FEED_REFLOW_HOLD_MS : FEED_REFLOW_SETTLE_MS,
    );
  };

  const holdReflowAnchor = () => {
    const anchor = reflowAnchorRef.current;
    if (anchor === "end") return Number.POSITIVE_INFINITY;
    const list = listRef.current;
    return anchor && list
      ? resolveThreadFeedReflowOffset(anchor, list.getState(), reflowLayout())
      : undefined;
  };

  const handleViewportLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    // A native resize re-wraps the rows before JS hears of it. This event reaches JS ahead
    // of the row measurements it caused, since layout events are sent parent first.
    if (Math.abs(measuredViewportWidth - nextWidth) > 1) beginReflow();
    if (
      Math.abs(measuredViewportWidth - nextWidth) > 1 ||
      Math.abs(viewportHeight - nextHeight) > 1
    ) {
      setDisclosureGap(null);
    }
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  };

  const anchoredEndSpace = resolveChatListAnchoredEndSpace(
    presentedFeed,
    props.anchorMessageId,
    (entry) => (entry.type === "message" ? entry.id : null),
    { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
  );
  const failedRunIds = failedFeedRunIds(props.feed, props.latestRun);
  const terminalAssistantMessageIds = (() => {
    const terminalIdsByTurn = new Map<RunId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
        terminalIdsByTurn.set(entry.message.runId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  })();
  // An interrupted run unfolds; a run that is no longer latest folds back.
  const [previousLatestRun, setPreviousLatestRun] = useState(props.latestRun);
  if (previousLatestRun !== props.latestRun) {
    setPreviousLatestRun(props.latestRun);
    const latest = props.latestRun;
    const previous = previousLatestRun;
    if (latest && previous) {
      if (latest.runId !== previous.runId) {
        if (expandedTurnIds.has(previous.runId)) {
          setInteractionState((current) => {
            const next = new Set(current.expandedTurnIds);
            next.delete(previous.runId);
            return { ...current, expandedTurnIds: next };
          });
        }
      } else if (previous.status === "running" && latest.status === "interrupted") {
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(latest.runId),
        }));
      }
    }
  }

  // Timers and frames the feed schedules die with it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the feed's scroll, reflow and copy timers and disclosure animation frames on unmount
  useEffect(
    () => () => {
      if (userScrollSettleTimerRef.current !== null) clearTimeout(userScrollSettleTimerRef.current);
      if (reflowSettleTimerRef.current !== null) clearTimeout(reflowSettleTimerRef.current);
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
      if (disclosureMotionTimer.current !== null) clearTimeout(disclosureMotionTimer.current);
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    },
    [],
  );

  const settleDisclosureAfterLayout = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        const listState = listRef.current?.getState();
        if (listState) {
          transitionEndFollow({
            type: "disclosure-settled",
            isAtEnd: listState.isAtEnd,
            userScrollSessionActive: userScrollSessionRef.current,
          });
        }
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        const motion = disclosureMotionRef.current;
        if (motion && !motion.playing) {
          const playing = { ...motion, playing: true };
          disclosureMotionRef.current = playing;
          setDisclosureLayout(playing);
          disclosureMotionTimer.current = setTimeout(
            () => {
              disclosureMotionRef.current = null;
              setDisclosureLayout(null);
              disclosureMotionTimer.current = null;
            },
            DISCLOSURE_DETAIL_DELAY_MS + DISCLOSURE_DETAIL_FADE_MS + 16,
          );
        }
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  };

  // The quiet-frame countdown's first frame lands after the disclosure's commit.
  // Every measured item-size change restarts it, so end maintenance cannot
  // wake between the data mutation and LegendList's final layout correction.
  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string | null) => {
    cancelReflow();
    const list = listRef.current;
    if (list && anchorKey && !reduceMotion) {
      const state = list.getState();
      const anchorIndex = state.indexByKey(anchorKey);
      if (anchorIndex !== undefined) {
        const anchor = state.positionAtIndex(anchorIndex);
        const anchorTop = state.elementAtIndex(anchorIndex)?.getBoundingClientRect().top;
        const positions = new Map<string, number>();
        for (let i = state.startBuffered; i <= state.endBuffered; i++) {
          const item = groupedFeed[i];
          if (!item) continue;
          const displayed =
            disclosureMotionRef.current &&
            state.elementAtIndex(i)?.firstElementChild?.getBoundingClientRect().top;
          positions.set(
            item.id,
            displayed != null && anchorTop !== undefined
              ? displayed - anchorTop
              : state.positionAtIndex(i) - anchor,
          );
        }
        const motion = {
          positions,
          anchorIndex,
          list,
          playing: false,
        };
        if (disclosureMotionTimer.current !== null) clearTimeout(disclosureMotionTimer.current);
        disclosureMotionRef.current = motion;
        setDisclosureLayout(motion);
      }
    }
    // Keep a short feed's bottom-alignment gap through collapse too; replacing it mid-frame moves the tap target.
    const first = list?.getState().elementAtIndex(0);
    if (first && headerEndRef.current) {
      const gap =
        first.getBoundingClientRect().top - headerEndRef.current.getBoundingClientRect().bottom;
      if (gap > 1) setDisclosureGap({ space: disclosureTopSpace + gap, tail: lastFeedId });
    }
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    settleDisclosureAfterLayout();
  };

  const handleItemSizeChanged = () => {
    if (disclosureAnchorKeyRef.current !== null) {
      settleDisclosureAfterLayout();
    }
  };

  const shouldRestoreVisibleContentPosition = (entry: ThreadFeedRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  };

  const maintainVisibleContentPosition = {
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  };

  const onCopyWorkRow = (rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  };

  const onToggleWorkGroup = (groupId: string, anchorKey?: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey ?? `work-toggle:${groupId}`);
    setInteractionState((current) => ({
      ...current,
      expandedWorkGroups: {
        ...current.expandedWorkGroups,
        [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
      },
    }));
  };

  // Lone rows share their group's disclosure state so opened details survive a second call joining.
  const onToggleWorkRow = (rowId: string, anchorKey?: string, groupId?: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey ?? null);
    setInteractionState((current) => {
      const expanded = !(current.expandedWorkRows[rowId] ?? false);
      return {
        ...current,
        expandedWorkRows: { ...current.expandedWorkRows, [rowId]: expanded },
        ...(groupId === undefined
          ? {}
          : { expandedWorkGroups: { ...current.expandedWorkGroups, [groupId]: expanded } }),
      };
    });
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`run-fold:${runId}`);
    setInteractionState((current) => {
      const next = new Set(current.expandedTurnIds);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return { ...current, expandedTurnIds: next };
    });
  };



  // Without this, every row above the viewport is assumed to be
  // estimatedItemSize tall, and scrolling up through unmeasured content
  // corrects each row's height as it mounts — the feed visibly jumps.
  const getFixedItemSize = (entry: ThreadFeedRow) => {
    if (entry.type === "guest-pending") return undefined;
    if (entry.type === "html-render") {
      return htmlRenderRowHeight(htmlRenderFrameHeight(entry.render, contentWidth));
    }
    if (workRowSizing.fixedRowHeight === undefined || entry.checkpointSummary) {
      return undefined;
    }
    switch (entry.type) {
      case "run-fold":
        return resolveThreadFeedFixedItemSize(entry.type);
      case "work-toggle":
        return entry.thought ? undefined : WORK_GROUP_TOGGLE_HEIGHT;
      case "thinking":
        return WORK_GROUP_TOGGLE_HEIGHT;
      case "activity-group":
        if (entry.activities[0]?.projectedItem.item.type === "subagent") {
          return undefined;
        }
        if (isContextCompactionActivityGroup(entry) || isContextHandoffActivityGroup(entry)) {
          return undefined;
        }
        if (
          entry.activities[0]?.groupedToolDetail &&
          entry.activities.every((activity) => activity.workEntry.itemType === "reasoning")
        ) {
          return undefined;
        }
        return entry.activities.some(
          (activity) => activity.prominent || expandedWorkRows[activity.id],
        )
          ? undefined
          : collapsedWorkLogHeight(entry.activities, entry.continuesWorkLog);
      default:
        return undefined;
    }
  };
  // Row geometry inputs mostly arrive as props with no handler here. LegendList
  // reads getFixedItemSize only when it renders, so its size cache is cleared
  // after the commit that hands it rows at the new geometry; clearing earlier
  // re-caches old sizes.
  const { textSizeKey } = workRowSizing;
  const hasHtmlRenders = presentedFeed.some((entry) => entry.type === "html-render");
  const previousRowGeometry = useRef({ textSizeKey, contentWidth });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears LegendList size caches and starts a reflow after the commit that brings new row geometry
  useLayoutEffect(() => {
    const previous = previousRowGeometry.current;
    if (previous.textSizeKey === textSizeKey && previous.contentWidth === contentWidth) return;
    previousRowGeometry.current = { textSizeKey, contentWidth };
    // Rows re-rendered at this width are measured in the next commit, after this effect.
    if (previous.contentWidth !== contentWidth) beginReflow();
    if (previous.textSizeKey !== textSizeKey || hasHtmlRenders) {
      listRef.current?.clearCaches({ mode: "sizes" });
    }
  }, [textSizeKey, contentWidth, hasHtmlRenders, beginReflow, listRef]);


  return {
    getFixedItemSize,
    listAppearanceData,
    reportHeaderMaterialVisibility,
    handleScroll,
    clearUserScrollSettle,
    handleScrollBeginDrag,
    finishUserScroll,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
    feedThreadKey,
    workGroupScrollPositions,
    loadedListKey,
    setLoadedListKey,
    jumpToMessageId,
    jumpReady,
    presentedFeed,
    jumpRunId,
    setupAnchorIndex,
    groupFeed,
    groupedFeed,
    listMountKey,
    contentInsetEndAdjustment,
    attachList,
    jumpIndex,
    followsEnd,
    landJump,
    reflowLayout,
    settleReflow,
    beginReflow,
    holdReflowAnchor,
    handleViewportLayout,
    anchoredEndSpace,
    failedRunIds,
    terminalAssistantMessageIds,
    previousLatestRun,
    setPreviousLatestRun,
    settleDisclosureAfterLayout,
    suspendEndScrollMaintenanceForDisclosure,
    handleItemSizeChanged,
    shouldRestoreVisibleContentPosition,
    maintainVisibleContentPosition,
    onCopyWorkRow,
    onToggleWorkGroup,
    onToggleWorkRow,
    onToggleTurnFold,
  };
}

export type ThreadFeedList = ReturnType<typeof useThreadFeedList>;
