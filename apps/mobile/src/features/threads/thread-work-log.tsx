import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { MaskedView } from "@expo/ui/community/masked-view";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { useIsFocused } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  AppState,
  type ColorValue,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { EnvironmentId, ToolActivityIcon } from "@t3tools/contracts";
import { toolActivityFaviconUrl } from "@t3tools/shared/favicon";

import { AppText as Text } from "../../components/AppText";
import { T3Wordmark } from "../../components/T3Wordmark";
import { cn } from "../../lib/cn";
import { THREAD_WORK_ROW_MIN_HEIGHT, type deriveThreadWorkLogSizing } from "../../lib/layout";
import { type ThreadFeedActivity, workEntryRowLabel } from "../../lib/threadActivity";
import {
  resolveThreadWorkGroupInitialScroll,
  shouldFollowThreadWorkGroupAppend,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";
import {
  resolveWorkEntryToolPresentation,
  type ToolGroupSummaryKind,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useAssetUrl } from "../../state/assets";

const SHIMMER_WIDTH = 72;
const SHIMMER_SWEEP_MS = 1_350;
const SHIMMER_PAUSE_MS = 1_450;
const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);
type WorkContentIcon = AppSymbolName | "browser" | "t3-code";

function WorkLogIcon(props: {
  readonly icon: WorkContentIcon;
  readonly color: ColorValue;
  readonly colorClassName?: string;
  readonly highlighted?: boolean;
}) {
  const colorClassName = props.highlighted ? "accent-foreground" : props.colorClassName;
  if (props.icon === "t3-code") {
    return (
      <T3Wordmark height={10} {...(colorClassName ? { colorClassName } : { color: props.color })} />
    );
  }
  return (
    <SymbolView
      name={props.icon === "browser" ? { ios: "globe", android: "public" } : props.icon}
      size={14}
      weight="medium"
      {...(colorClassName ? { tintColorClassName: colorClassName } : { tintColor: props.color })}
      type="monochrome"
    />
  );
}

export function ThreadDisclosureChevron(props: {
  readonly expanded: boolean;
  readonly collapsedDirection: "right" | "down";
  readonly size: number;
  readonly tintColor: ColorValue;
}) {
  const expandedAngle = props.collapsedDirection === "right" ? 90 : 180;
  const rotation = useSharedValue(props.expanded ? expandedAngle : 0);

  useLayoutEffect(() => {
    rotation.value = withTiming(props.expanded ? expandedAngle : 0, {
      duration: THREAD_DISCLOSURE_TRANSITION_MS,
      reduceMotion: ReduceMotion.System,
    });
  }, [expandedAngle, props.expanded, rotation]);

  const rotationStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[{ width: props.size, height: props.size }, rotationStyle]}
    >
      <SymbolView
        name={props.collapsedDirection === "right" ? "chevron.right" : "chevron.down"}
        size={props.size}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Animated.View>
  );
}

function ShimmerWorkContent(props: {
  readonly environmentId?: EnvironmentId;
  readonly highlighted: boolean;
  readonly icon: WorkContentIcon;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly onTextLayout?: ComponentProps<typeof Text>["onTextLayout"];
  readonly showIcon: boolean;
  readonly themeAppearance?: "light" | "dark";
  readonly toolIcon?: ToolActivityIcon;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="h-6 w-6 shrink-0 items-center justify-center">
        {props.showIcon && props.toolIcon && props.environmentId ? (
          <ToolActivityIconView
            environmentId={props.environmentId}
            icon={props.toolIcon}
            fallback={props.icon}
            fallbackColor={props.iconSubtleColor}
            themeAppearance={props.themeAppearance ?? "light"}
          />
        ) : props.showIcon ? (
          <WorkLogIcon
            icon={props.icon}
            color={props.iconSubtleColor}
            highlighted={props.highlighted}
          />
        ) : null}
      </View>
      <Text
        className={cn(
          "min-w-0 shrink text-sm",
          props.highlighted ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
        onTextLayout={props.onTextLayout}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function ShimmeringWorkContent(props: {
  readonly environmentId?: EnvironmentId;
  readonly icon: WorkContentIcon;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly showIcon: boolean;
  readonly themeAppearance?: "light" | "dark";
  readonly toolIcon?: ToolActivityIcon;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const [reducedMotion, setReducedMotion] = useState(true);
  const screenIsFocused = useIsFocused();
  const progress = useSharedValue(0);
  const gradientId = `work-shimmer-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(availableWidth, SHIMMER_ICON_AND_GAP_WIDTH + Math.ceil(textWidth));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (contentWidth <= 0 || reducedMotion || !appIsActive || !screenIsFocused) return;

    progress.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: SHIMMER_SWEEP_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        withDelay(
          SHIMMER_PAUSE_MS,
          withTiming(0, { duration: 0, reduceMotion: ReduceMotion.Never }),
        ),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [appIsActive, contentWidth, progress, reducedMotion, screenIsFocused]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -SHIMMER_WIDTH + progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));
  const counterSweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SHIMMER_WIDTH - progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));

  return (
    <View
      className="min-w-0 flex-1 overflow-hidden"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <ShimmerWorkContent
        environmentId={props.environmentId}
        highlighted={false}
        icon={props.icon}
        iconSubtleColor={props.iconSubtleColor}
        label={props.label}
        showIcon={props.showIcon}
        themeAppearance={props.themeAppearance}
        toolIcon={props.toolIcon}
        onTextLayout={(event) => setTextWidth(event.nativeEvent.lines[0]?.width ?? 0)}
      />
      {!reducedMotion && appIsActive && screenIsFocused && contentWidth > 0 ? (
        <Animated.View
          className="absolute inset-y-0 left-0 overflow-hidden"
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ width: SHIMMER_WIDTH }, sweepStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <Animated.View style={[{ width: availableWidth }, counterSweepStyle]}>
              <ShimmerWorkContent
                environmentId={props.environmentId}
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
                themeAppearance={props.themeAppearance}
                toolIcon={props.toolIcon}
              />
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "browser":
      return { ios: "safari", android: "public" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "computer":
      return { ios: "desktopcomputer", android: "desktop_windows" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// The minimum matches min-h-8 below. Exact sizing is disabled when native
// accessibility scaling can make the single-line text taller than that minimum.
const WORK_ROW_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_BOTTOM_MARGIN = 3.5; // mb-1 with the mobile 14px rem
const WORK_GROUP_MAX_HEIGHT = 256;
const WORK_GROUP_EDGE_FADE_HEIGHT = 12;

export const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;

function workLogRowsHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  rowHeight = WORK_ROW_HEIGHT,
): number {
  return activities.length * rowHeight + Math.max(0, activities.length - 1) * WORK_ROW_GAP;
}

export function collapsedWorkLogHeight(activities: ReadonlyArray<ThreadFeedActivity>): number {
  if (activities.length === 0) {
    return 0;
  }
  const height = workLogRowsHeight(activities);
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (activities[0]?.groupedToolDetail ? Math.min(height, WORK_GROUP_MAX_HEIGHT) : height)
  );
}

interface ThreadWorkLogProps {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly anchorKey: string;
  readonly environmentId: EnvironmentId;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly scrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
  readonly iconSubtleColor: ColorValue;
  /** Feed background, painted as the scroll-edge fade over a long group. */
  readonly edgeFadeColor: string;
  readonly themeAppearance: "light" | "dark";
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
  readonly renderImage: MarkdownImageRenderer;
}

export function ThreadWorkLog(props: ThreadWorkLogProps) {
  const renderRow = useCallback(
    (row: ThreadFeedActivity) => (
      <ThreadWorkLogRow
        key={row.id}
        row={row}
        anchorKey={props.anchorKey}
        copied={props.copiedRowId === row.id}
        expanded={props.expandedRows[row.id] ?? false}
        environmentId={props.environmentId}
        iconSubtleColor={props.iconSubtleColor}
        onCopyRow={props.onCopyRow}
        onToggleRow={props.onToggleRow}
        renderImage={props.renderImage}
        themeAppearance={props.themeAppearance}
      />
    ),
    [
      props.anchorKey,
      props.copiedRowId,
      props.expandedRows,
      props.environmentId,
      props.iconSubtleColor,
      props.onCopyRow,
      props.onToggleRow,
      props.renderImage,
      props.themeAppearance,
    ],
  );

  if (props.activities.length === 0) {
    return null;
  }

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      {props.activities[0]?.groupedToolDetail ? (
        <ThreadWorkGroupList
          activities={props.activities}
          edgeFadeColor={props.edgeFadeColor}
          expandedRows={props.expandedRows}
          groupId={props.anchorKey}
          rowSizing={props.rowSizing}
          scrollPositions={props.scrollPositions}
          renderRow={renderRow}
        />
      ) : (
        <View className="gap-px">{props.activities.map(renderRow)}</View>
      )}
    </View>
  );
}

function ThreadWorkGroupList(props: {
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
  const sharedValues = useMemo(() => ({ scrollOffset }), [scrollOffset]);

  // Each edge fades only while content continues past it. Scroll offset stays
  // on the UI thread; only content-size changes update React state.
  const topFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT),
  }));
  const bottomFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(
      1,
      Math.max(0, contentHeight - height - scrollOffset.value) / WORK_GROUP_EDGE_FADE_HEIGHT,
    ),
  }));
  const rememberPosition = useCallback(() => {
    if (!loadedRef.current) return;
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (!state || !position) return;
    props.scrollPositions.set(props.groupId, {
      ...position,
      contentHeight: state.contentLength,
    });
  }, [props.groupId, props.scrollPositions]);
  const finishPendingAppend = useCallback(() => {
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
  }, []);
  const onContentSizeChange = useCallback(
    (nextHeight: number) => {
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
      // Follow new calls only, never a detail toggle or a growing tool result.
      if (followAppend) {
        pendingAppendHeightRef.current = Math.min(nextHeight, WORK_GROUP_MAX_HEIGHT);
      } else if (detailsChanged || userScrollingRef.current || previous.rows !== props.activities) {
        pendingAppendHeightRef.current = null;
      } else if (pendingAppendHeightRef.current !== null) {
        pendingAppendHeightRef.current = Math.min(nextHeight, WORK_GROUP_MAX_HEIGHT);
      }
      // A short group can grow its viewport on this append. Wait for that
      // layout before calculating the end offset, rather than jumping twice.
      finishPendingAppend();
      rememberPosition();
    },
    [props.activities, props.expandedRows, scrollOffset, finishPendingAppend, rememberPosition],
  );
  // The native ScrollView reports its content size a frame or more after
  // LegendList has laid the rows out, so a detail toggle rendered the group
  // at its old height while the rows below already moved. Read the size
  // LegendList computes on the JS thread instead; it settles in the same
  // commit as the row measurement that changed it.
  const onContentSizeChangeRef = useRef(onContentSizeChange);
  useLayoutEffect(() => {
    onContentSizeChangeRef.current = onContentSizeChange;
  }, [onContentSizeChange]);
  const subscribeToContentSize = useCallback((list: LegendListRef | null) => {
    listRef.current = list;
    if (!list) return;
    const unsubscribe = list.getState().listen("totalSize", () => {
      onContentSizeChangeRef.current(list.getState().contentLength);
    });
    onContentSizeChangeRef.current(list.getState().contentLength);
    return unsubscribe;
  }, []);
  const getFixedItemSize = useCallback(
    (row: ThreadFeedActivity, index: number) =>
      props.expandedRows[row.id] || props.rowSizing.fixedRowHeight === undefined
        ? undefined
        : props.rowSizing.fixedRowHeight + (index < props.activities.length - 1 ? WORK_ROW_GAP : 0),
    [props.activities.length, props.expandedRows, props.rowSizing.fixedRowHeight],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: ThreadFeedActivity; index: number }) => (
      <View className={index < props.activities.length - 1 ? "pb-px" : undefined}>
        {props.renderRow(item)}
      </View>
    ),
    [props.activities.length, props.renderRow],
  );

  return (
    <View style={{ height, overflow: "hidden" }}>
      <AnimatedLegendList
        ref={subscribeToContentSize}
        data={props.activities}
        keyExtractor={workLogRowKey}
        estimatedItemSize={props.rowSizing.estimatedRowHeight + WORK_ROW_GAP}
        getFixedItemSize={getFixedItemSize}
        initialScrollIndex={initialScrollIndex}
        // Bootstrap overscan is only 50px. An offset inside expanded detail can
        // otherwise leave its own row unmeasured until after scroll restoration.
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

/** A screen-colored gradient painted over the list edge that still has content past it. */
function EdgeFade(props: { readonly color: string; readonly direction: "up" | "down" }) {
  const gradientId = `work-group-fade-${useId().replaceAll(":", "")}`;
  return (
    <Svg width="100%" height="100%">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" x2="0%" y1="0%" y2="100%">
          <Stop
            offset={0}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 1 : 0}
          />
          <Stop
            offset={1}
            stopColor={props.color}
            stopOpacity={props.direction === "down" ? 0 : 1}
          />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

function workLogRowKey(row: ThreadFeedActivity): string {
  return row.id;
}

const ThreadWorkLogRow = memo(function ThreadWorkLogRow(
  props: Omit<
    ThreadWorkLogProps,
    | "activities"
    | "copiedRowId"
    | "edgeFadeColor"
    | "expandedRows"
    | "rowSizing"
    | "scrollPositions"
  > & {
    readonly row: ThreadFeedActivity;
    readonly copied: boolean;
    readonly expanded: boolean;
  },
) {
  const { row, expanded } = props;
  const canExpand = row.canExpand;
  const fullDetail = expanded ? row.getFullDetail() : null;
  const viewedImagePath = workEntryViewedImagePath(row.workEntry);
  const toolPresentation = resolveWorkEntryToolPresentation(row.workEntry);
  const previewText = workEntryRowLabel(row.workEntry);
  const displayText =
    !toolPresentation && expanded && row.workEntry.command?.trim() ? "Command" : previewText;
  const iconIsDestructive = row.icon === "alert" || row.icon === "warning";
  const failed = row.status === "failure";
  const toolIcon = row.workEntry.toolIcon ?? row.workEntry.toolSource?.icon;
  const icon = toolPresentation?.icon ?? workRowSymbolName(row.icon);

  return (
    <Animated.View
      layout={WORK_LOG_LAYOUT_TRANSITION}
      className="overflow-hidden"
      {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
    >
      <Pressable
        accessibilityRole={canExpand ? "button" : undefined}
        accessibilityLabel={failed ? `${previewText}, tool call failed` : previewText}
        accessibilityHint={
          canExpand ? "Double tap to show full details. Long press to copy." : "Long press to copy."
        }
        accessibilityState={canExpand ? { expanded } : undefined}
        hitSlop={4}
        onPress={() => {
          if (canExpand) {
            void Haptics.selectionAsync();
            props.onToggleRow(row.id, props.anchorKey);
          }
        }}
        onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
        className="rounded-md px-0.5 py-0 active:bg-subtle"
      >
        <View className="min-h-8 flex-row items-center gap-1.5">
          {row.live ? (
            <ShimmeringWorkContent
              environmentId={props.environmentId}
              icon={icon}
              iconSubtleColor={props.iconSubtleColor}
              label={displayText}
              showIcon
              themeAppearance={props.themeAppearance}
              toolIcon={toolIcon}
            />
          ) : (
            <>
              <View className="h-6 w-6 shrink-0 items-center justify-center">
                {toolIcon ? (
                  <ToolActivityIconView
                    environmentId={props.environmentId}
                    icon={toolIcon}
                    fallback={icon}
                    fallbackColor={props.iconSubtleColor}
                    themeAppearance={props.themeAppearance}
                  />
                ) : (
                  <WorkLogIcon
                    icon={icon}
                    color={props.iconSubtleColor}
                    colorClassName={
                      iconIsDestructive
                        ? "accent-adaptive-rose-600-400"
                        : failed
                          ? "accent-danger-foreground/40"
                          : undefined
                    }
                  />
                )}
              </View>
              <Text
                className={cn(
                  "min-w-0 flex-1 text-sm text-foreground-muted",
                  iconIsDestructive && "font-t3-medium text-adaptive-rose-600-400",
                )}
                numberOfLines={1}
              >
                {displayText}
              </Text>
            </>
          )}

          <View className="shrink-0 flex-row items-center gap-px">
            {props.copied ? (
              <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
                Copied
              </Text>
            ) : null}
            {failed && toolIcon !== undefined ? (
              <View
                className="h-4 w-4 items-center justify-center"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <SymbolView
                  name="xmark"
                  size={11}
                  tintColorClassName="accent-danger-foreground/40"
                  type="monochrome"
                />
              </View>
            ) : null}
            <View className="h-4 w-4 items-center justify-center">
              {canExpand ? (
                <ThreadDisclosureChevron
                  expanded={expanded}
                  collapsedDirection="down"
                  size={11}
                  tintColor={props.iconSubtleColor}
                />
              ) : null}
            </View>
          </View>
        </View>
      </Pressable>

      {fullDetail ? (
        <Animated.View
          entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
          exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
          layout={WORK_LOG_LAYOUT_TRANSITION}
          className="ml-7 border-l border-adaptive-neutral-300-a60-white-a12 pb-1 pl-3 pt-0.5"
        >
          {viewedImagePath ? (
            <View className="pb-1.5">
              {props.renderImage({ href: viewedImagePath, alt: null, title: null })}
            </View>
          ) : null}
          <ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            className="max-h-60"
            contentContainerStyle={{ paddingRight: 8 }}
          >
            <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
              {fullDetail}
            </Text>
          </ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
});

export function ThreadWorkGroupToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly summary: string;
  readonly summaryKind: ToolGroupSummaryKind;
  readonly summaryToolIcon?: "browser" | "t3-code";
  readonly themeAppearance: "light" | "dark";
  readonly toolSurface?: import("@t3tools/contracts").ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
  readonly hasFailure: boolean;
  readonly shimmer: boolean;
  readonly onToggle: () => void;
}) {
  const accessibilityLabel = props.hasFailure
    ? `${props.summary}, tool call failed`
    : props.summary;
  const icon =
    props.summaryToolIcon ??
    (props.toolSurface
      ? workRowSymbolName(props.toolSurface)
      : toolGroupSummarySymbolName(props.summaryKind));

  return (
    <View className="-mx-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} ${props.hiddenCount} tool ${props.hiddenCount === 1 ? "call" : "calls"}.`}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0 active:bg-subtle"
        style={{ minHeight: props.rowSizing.estimatedRowHeight }}
      >
        {props.shimmer ? (
          <ShimmeringWorkContent
            key={props.rowSizing.textSizeKey}
            environmentId={props.environmentId}
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={props.summary}
            showIcon
            themeAppearance={props.themeAppearance}
            toolIcon={props.toolIcon}
          />
        ) : (
          <>
            <View className="h-6 w-6 items-center justify-center">
              <ToolActivityIconView
                environmentId={props.environmentId}
                icon={props.toolIcon}
                fallback={icon}
                fallbackColor={props.iconSubtleColor}
                themeAppearance={props.themeAppearance}
              />
            </View>
            <Text
              key={props.rowSizing.textSizeKey}
              className="min-w-0 flex-1 text-sm text-foreground-muted"
              numberOfLines={1}
            >
              {props.summary}
            </Text>
          </>
        )}
        <ThreadDisclosureChevron
          expanded={props.expanded}
          collapsedDirection="down"
          size={11}
          tintColor={props.iconSubtleColor}
        />
      </Pressable>
    </View>
  );
}

export function ThreadThinkingRow(props: {
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly iconSubtleColor: ColorValue;
}) {
  return (
    <View
      accessible
      accessibilityLabel="Thinking"
      className="-mx-1 min-h-8 flex-row items-center px-1.5 py-0"
      style={{ minHeight: props.rowSizing.estimatedRowHeight }}
    >
      <ShimmeringWorkContent
        key={props.rowSizing.textSizeKey}
        icon="brain"
        iconSubtleColor={props.iconSubtleColor}
        label="Thinking"
        showIcon
      />
    </View>
  );
}

function ToolActivityIconView(props: {
  readonly environmentId: EnvironmentId;
  readonly icon?: ToolActivityIcon;
  readonly fallback: WorkContentIcon;
  readonly fallbackColor: ColorValue;
  readonly themeAppearance: "light" | "dark";
}) {
  if (!props.icon) {
    return <WorkLogIcon icon={props.fallback} color={props.fallbackColor} />;
  }
  if (props.icon._tag === "website") {
    const source = toolActivityFaviconUrl(props.icon, props.themeAppearance, 32);
    return source ? (
      <ToolActivityImage
        key={source}
        source={source}
        fallback={props.fallback}
        color={props.fallbackColor}
        themeAppearance={props.themeAppearance}
      />
    ) : (
      <WorkLogIcon icon={props.fallback} color={props.fallbackColor} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const source =
      props.themeAppearance === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImage
        key={source}
        source={source}
        fallback={props.fallback}
        color={props.fallbackColor}
        themeAppearance={props.themeAppearance}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      environmentId={props.environmentId}
      app={props.icon.app}
      fallback={props.fallback}
      color={props.fallbackColor}
      themeAppearance={props.themeAppearance}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  readonly environmentId: EnvironmentId;
  readonly app: Extract<ToolActivityIcon, { readonly _tag: "native-app" }>["app"];
  readonly fallback: WorkContentIcon;
  readonly color: ColorValue;
  readonly themeAppearance: "light" | "dark";
}) {
  const source = useAssetUrl(props.environmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  return source ? (
    <ToolActivityImage
      key={source}
      source={source}
      fallback={props.fallback}
      color={props.color}
      themeAppearance={props.themeAppearance}
    />
  ) : (
    <WorkLogIcon icon={props.fallback} color={props.color} />
  );
}

function ToolActivityImage(props: {
  readonly source: string;
  readonly fallback: WorkContentIcon;
  readonly color: ColorValue;
  readonly themeAppearance: "light" | "dark";
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <View className="h-4 w-4 items-center justify-center overflow-hidden rounded-[3px] bg-background">
      {!loaded || failed ? <WorkLogIcon icon={props.fallback} color={props.color} /> : null}
      {!failed ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            props.themeAppearance === "light" ? { filter: [{ brightness: 0.6 }] } : undefined,
          ]}
        >
          <Image
            source={props.source}
            cachePolicy="memory-disk"
            contentFit="contain"
            style={[StyleSheet.absoluteFill, { opacity: loaded ? 0.7 : 0 }]}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </View>
      ) : null}
    </View>
  );
}

function toolGroupSummarySymbolName(kind: ToolGroupSummaryKind): AppSymbolName {
  switch (kind) {
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "browser":
    case "search":
      return { ios: "globe", android: "public" };
    case "code-search":
      return "magnifyingglass";
    case "other":
      return { ios: "wrench", android: "build" };
    case "agent-tool":
      return { ios: "sparkles", android: "auto_awesome" };
    case "tone-tool":
      return { ios: "bolt", android: "bolt" };
    case "dynamic-tool":
    case "update":
    case "mixed":
      return { ios: "hammer", android: "construction" };
  }
}
