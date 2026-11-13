import { Button } from "../../components/ui/Button";
import { ThreadSubagentGroup } from "./thread-subagent-group";
import { ProposedPlanCard } from "./ProposedPlanCard";
import {
  WorkLogLabel,
  WorkLogBlock,
  WorkLogRows,
  WorkLogIconSlot,
  WorkLogPressable,
} from "./work-log-layout";
import { QuestionAnswerHistory } from "./QuestionAnswerHistory";
import { ThreadCommandOutput, useCommandOutputStreaming } from "./thread-command-output";
import {
  getQuestionAnswerPreview,
  hasQuestionAnswer,
} from "@t3tools/client-runtime/work-log/user-input";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { MaskedView } from "@expo/ui/community/masked-view";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { useIsFocused } from "@react-navigation/native";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Animated as NativeAnimated,
  type ColorValue,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  useAnimatedValue,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type EnvironmentId,
  type RunId,
  type ThreadId,
  type ToolActivityIcon,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";

import { AppText as Text } from "../../components/ui/AppText";
import { T3Wordmark } from "../../components/T3Wordmark";
import { BrowserAppIcon } from "./BrowserAppIcon";
import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { THREAD_WORK_ROW_MIN_HEIGHT, type deriveThreadWorkLogSizing } from "../../lib/layout";
import {
  formatItemFullDetail,
  type ThreadFeedActivity,
  workEntryRowLabel,
} from "../../lib/threadActivity";
import {
  toolCallLines,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { useTurnItemDetail } from "../../state/queries";
import {
  resolveThreadWorkGroupInitialScroll,
  shouldFollowThreadWorkGroupAppend,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";
import {
  resolveWorkEntryToolPresentation,
  toolGroupAction,
  type ToolGroupSummaryKind,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import { notificationChildThreadId } from "@t3tools/client-runtime/state/thread-execution";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { FilePreviewGallery } from "../../components/FilePreviewGallery";
import { ThreadMarkdownImage } from "./ThreadMarkdownImage";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useAssetUrl } from "../../state/assets";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { ThreadWorkLogRow } from "./thread-work-logParts";
import { EdgeFade, WORK_GROUP_EDGE_FADE_HEIGHT, WORK_GROUP_MAX_HEIGHT, WORK_ROW_GAP, workLogRowKey, workLogRowsHeight } from "./thread-work-log";

export function ThreadWorkGroupList(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly edgeFadeColor: string;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly groupId: string;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly scrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
  readonly renderRow: (row: ThreadFeedActivity) => ReactNode;
}) {
  const estimatedRowsHeight = workLogRowsHeight(
    props.activities,
    props.rowSizing.estimatedRowHeight,
  );
  const [initialPosition] = useState(() => {
    const position = props.scrollPositions.get(props.groupId);
    return props.activities.some((row) => row.id === position?.rowId) ? position : undefined;
  });
  const [initialScrollIndex] = useState(() =>
    resolveThreadWorkGroupInitialScroll(props.activities, initialPosition),
  );
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const loadedRef = useRef(false);
  const userScrollingRef = useRef(false);
  const pendingAppendHeightRef = useRef<number | null>(null);
  const previousContent = useRef({
    rows: props.activities,
    height: Math.max(estimatedRowsHeight, initialPosition?.contentHeight ?? 0),
    expandedRows: props.expandedRows,
  });
  const [measuredContent, setMeasuredContent] = useState(() => ({
    height: Math.max(estimatedRowsHeight, initialPosition?.contentHeight ?? 0),
    rowCount: props.activities.length,
  }));
  const contentHeight = Math.max(
    1,
    measuredContent.height +
      Math.max(0, props.activities.length - measuredContent.rowCount) *
        (props.rowSizing.estimatedRowHeight + WORK_ROW_GAP),
  );
  const height = Math.min(contentHeight, WORK_GROUP_MAX_HEIGHT);
  const scrollOffset = useSharedValue(initialPosition?.scrollOffset ?? 0);
  const sharedValues = { scrollOffset };

  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT),
  }));
  const bottomFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(
      1,
      Math.max(0, contentHeight - height - scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT,
    ),
  }));
  const rememberPosition = () => {
    if (!loadedRef.current) return;
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (!state || !position) return;
    props.scrollPositions.set(props.groupId, {
      ...position,
      contentHeight: state.contentLength,
    });
  };
  const finishPendingAppend = () => {
    const targetHeight = pendingAppendHeightRef.current;
    const state = listRef.current?.getState();
    if (
      targetHeight !== null &&
      state &&
      !userScrollingRef.current &&
      Math.abs(state.scrollLength - targetHeight) <= 1
    ) {
      pendingAppendHeightRef.current = null;
      void listRef.current?.scrollToEnd({ animated: false });
    }
  };
  // LegendList notifies from child layout effects. Effect Events see the
  // committed rows before those effects run, unlike a parent layout-effect ref.
  const onContentSizeChange = useEffectEvent((nextHeight: number) => {
    const previous = previousContent.current;
    const detailsChanged = previous.expandedRows !== props.expandedRows;
    const followAppend =
      loadedRef.current &&
      shouldFollowThreadWorkGroupAppend({
        previousRows: previous.rows,
        rows: props.activities,
        previousContentHeight: previous.height,
        contentHeight: nextHeight,
        viewportHeight: Math.min(previous.height, WORK_GROUP_MAX_HEIGHT),
        scrollOffset: scrollOffset.value,
        detailsChanged,
        userScrolling: userScrollingRef.current,
      });
    previousContent.current = {
      rows: props.activities,
      height: nextHeight,
      expandedRows: props.expandedRows,
    };
    setMeasuredContent((current) =>
      current.height === nextHeight && current.rowCount === props.activities.length
        ? current
        : { height: nextHeight, rowCount: props.activities.length },
    );
    if (followAppend) {
      pendingAppendHeightRef.current = Math.min(nextHeight, WORK_GROUP_MAX_HEIGHT);
    } else if (detailsChanged || userScrollingRef.current || previous.rows !== props.activities) {
      pendingAppendHeightRef.current = null;
    } else if (pendingAppendHeightRef.current !== null) {
      pendingAppendHeightRef.current = Math.min(nextHeight, WORK_GROUP_MAX_HEIGHT);
    }
    finishPendingAppend();
    rememberPosition();
  });
  // Native ScrollView reports size after LegendList lays out rows. Use LegendList's JS size
  // so group height and row measurements settle in the same commit.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to LegendList's totalSize state to report content height in the same commit
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const unsubscribe = list.getState().listen("totalSize", () => {
      onContentSizeChange(list.getState().contentLength);
    });
    onContentSizeChange(list.getState().contentLength);
    return unsubscribe;
  }, []);
  const getFixedItemSize = (row: ThreadFeedActivity, index: number) =>
    props.expandedRows[row.id] || props.rowSizing.fixedRowHeight === undefined
      ? undefined
      : props.rowSizing.fixedRowHeight + (index < props.activities.length - 1 ? WORK_ROW_GAP : 0);
  const renderItem = ({ item, index }: { item: ThreadFeedActivity; index: number }) => (
    <View className={index < props.activities.length - 1 ? "pb-px" : undefined}>
      {props.renderRow(item)}
    </View>
  );

  return (
    <View style={{ height, overflow: "hidden" }}>
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Nested in a fixed-height card inside the thread feed, which owns the header's scroll view. */}
      <AnimatedLegendList
        ref={listRef}
        data={props.activities}
        keyExtractor={workLogRowKey}
        estimatedItemSize={props.rowSizing.estimatedRowHeight + WORK_ROW_GAP}
        getFixedItemSize={getFixedItemSize}
        initialScrollIndex={initialScrollIndex}
        // 50px bootstrap overscan may leave expanded details unmeasured until after scroll restoration.
        alwaysRender={
          restoringPosition && initialPosition ? { keys: [initialPosition.rowId] } : undefined
        }
        recycleItems={false}
        extraData={props.renderRow}
        renderItem={renderItem}
        sharedValues={sharedValues}
        onLayout={finishPendingAppend}
        onLoad={() => {
          loadedRef.current = true;
          setRestoringPosition(false);
          rememberPosition();
        }}
        onScroll={rememberPosition}
        onScrollBeginDrag={() => {
          userScrollingRef.current = true;
          pendingAppendHeightRef.current = null;
        }}
        onScrollEndDrag={() => {
          userScrollingRef.current = false;
        }}
        onMomentumScrollBegin={() => {
          userScrollingRef.current = true;
          pendingAppendHeightRef.current = null;
        }}
        onMomentumScrollEnd={() => {
          userScrollingRef.current = false;
          rememberPosition();
        }}
        maintainVisibleContentPosition
        nestedScrollEnabled
        directionalLockEnabled
        showsVerticalScrollIndicator
        scrollsToTop={false}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        style={{ height }}
      />
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 top-0"
        style={[{ height: WORK_GROUP_EDGE_FADE_HEIGHT }, topFadeStyle]}
      >
        <EdgeFade color={props.edgeFadeColor} direction="down" />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        className="absolute inset-x-0 bottom-0"
        style={[{ height: WORK_GROUP_EDGE_FADE_HEIGHT }, bottomFadeStyle]}
      >
        <EdgeFade color={props.edgeFadeColor} direction="up" />
      </Animated.View>
    </View>
  );
}

