import * as Haptics from "expo-haptics";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useId, useLayoutEffect, useState, type ComponentProps } from "react";
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

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import {
  type ToolGroupSummaryKind,
  workEntryViewedImagePath,
} from "@t3tools/client-runtime/work-log/presentation";
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

const SHIMMER_WIDTH = 72;
const SHIMMER_SWEEP_MS = 1_350;
const SHIMMER_PAUSE_MS = 1_450;
const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);

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
  readonly highlighted: boolean;
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly onTextLayout?: ComponentProps<typeof Text>["onTextLayout"];
  readonly showIcon: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="h-6 w-6 shrink-0 items-center justify-center">
        {props.showIcon ? (
          <SymbolView
            name={props.icon}
            size={14}
            weight="medium"
            {...(props.highlighted
              ? { tintColorClassName: "accent-foreground" as const }
              : { tintColor: props.iconSubtleColor })}
            type="monochrome"
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
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly showIcon: boolean;
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
        highlighted={false}
        icon={props.icon}
        iconSubtleColor={props.iconSubtleColor}
        label={props.label}
        showIcon={props.showIcon}
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
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
              />
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
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

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than text-sm at every supported base font size, so row height is
// deterministic. Values mirror the classNames below. A mismatch only costs a
// one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 32; // min-h-8

export function collapsedWorkLogHeight(activities: ReadonlyArray<ThreadFeedActivity>): number {
  const rows = activities;
  if (rows.length === 0) {
    return 0;
  }
  return WORK_LOG_BOTTOM_MARGIN + rows.length * WORK_ROW_HEIGHT + (rows.length - 1) * WORK_ROW_GAP;
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const rows = props.activities.map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <View className="gap-px">
        {rows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          const fullDetail = expanded ? row.getFullDetail() : null;
          const viewedImagePath = workEntryViewedImagePath(row.workEntry);
          const previewText = row.detail ?? row.summary;
          const displayText = expanded && row.workEntry.command?.trim() ? "Command" : previewText;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";
          const failed = row.status === "failure";
          const showIcon = !row.groupedToolDetail || iconIsDestructive || failed;

          return (
            <Animated.View
              key={row.id}
              layout={WORK_LOG_LAYOUT_TRANSITION}
              className="overflow-hidden"
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={failed ? `${previewText}, tool call failed` : previewText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    void Haptics.selectionAsync();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                className="rounded-md px-0.5 py-0 active:bg-subtle"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  {row.live ? (
                    <ShimmeringWorkContent
                      icon={workRowSymbolName(row.icon)}
                      iconSubtleColor={props.iconSubtleColor}
                      label={displayText}
                      showIcon={showIcon}
                    />
                  ) : (
                    <>
                      <View className="h-6 w-6 shrink-0 items-center justify-center">
                        {showIcon ? (
                          <SymbolView
                            name={
                              failed
                                ? { ios: "xmark", android: "close" }
                                : workRowSymbolName(row.icon)
                            }
                            size={14}
                            weight="medium"
                            tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                            type="monochrome"
                          />
                        ) : null}
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
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
                        Copied
                      </Text>
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
                    <Text
                      selectable
                      className="font-mono text-2xs leading-normal text-foreground-muted"
                    >
                      {fullDetail}
                    </Text>
                  </ScrollView>
                </Animated.View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly summary: string;
  readonly summaryKind: ToolGroupSummaryKind;
  readonly hasFailure: boolean;
  readonly shimmer: boolean;
  readonly onToggle: () => void;
}) {
  const accessibilityLabel = props.hasFailure
    ? `${props.summary}, tool call failed`
    : props.summary;
  const icon = toolGroupSummarySymbolName(props.summaryKind);

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
      >
        {props.shimmer ? (
          <ShimmeringWorkContent
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={props.summary}
            showIcon
          />
        ) : (
          <>
            <View className="h-6 w-6 items-center justify-center">
              <SymbolView
                name={icon}
                size={14}
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            </View>
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
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

function toolGroupSummarySymbolName(kind: ToolGroupSummaryKind): AppSymbolName {
  switch (kind) {
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "command":
      return { ios: "terminal", android: "terminal" };
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
