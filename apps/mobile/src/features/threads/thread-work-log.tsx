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
import { ThreadWorkGroupList } from "./thread-work-logParts2";
import { ShimmeringWorkContent } from "./thread-work-logParts3";

export const SHIMMER_WIDTH = 72;
export const SHIMMER_SWEEP_MS = 1_350;
export const SHIMMER_PAUSE_MS = 1_450;
export const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
export const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
export const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
export const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);
export type WorkContentIcon =
  | AppSymbolName
  | "browser"
  | "computer"
  | "device"
  | "t3-code"
  | "pull-request";

export function WorkLogIcon(props: {
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
  if (props.icon === "computer") {
    return (
      <BrowserAppIcon
        size={14}
        {...(colorClassName ? { colorClassName } : { color: props.color })}
      />
    );
  }
  return (
    <SymbolView
      name={
        props.icon === "pull-request"
          ? PullRequestGlyph.pullRequest
          : props.icon === "browser"
            ? { ios: "globe", android: "public" }
            : props.icon === "device"
              ? { ios: "iphone", android: "smartphone" }
              : props.icon
      }
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the chevron's Reanimated rotation value when the expanded state changes
  useLayoutEffect(() => {
    rotation.set(
      withTiming(props.expanded ? expandedAngle : 0, {
        duration: THREAD_DISCLOSURE_TRANSITION_MS,
        reduceMotion: ReduceMotion.System,
      }),
    );
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

export function ShimmerWorkContent(props: {
  readonly textClassName?: string;
  readonly compact?: boolean;
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
      {props.showIcon ? (
        <View className="h-6 w-6 shrink-0 items-center justify-center">
          {props.toolIcon && props.environmentId ? (
            <ToolActivityIconView
              environmentId={props.environmentId}
              icon={props.toolIcon}
              fallback={props.icon}
              fallbackColor={props.iconSubtleColor}
              themeAppearance={props.themeAppearance ?? "light"}
            />
          ) : (
            <WorkLogIcon
              icon={props.icon}
              color={props.iconSubtleColor}
              highlighted={props.highlighted}
            />
          )}
        </View>
      ) : null}
      <Text
        className={cn(
          "min-w-0 shrink",
          props.compact ? "text-xs" : "text-sm",
          props.highlighted ? "text-foreground" : "text-foreground-muted",
          props.textClassName,
        )}
        numberOfLines={1}
        onTextLayout={props.onTextLayout}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function workRowSymbolName(icon: ThreadFeedActivity["icon"]): WorkContentIcon {
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
      return "computer";
    case "code":
      return "chevron.left.forwardslash.chevron.right";
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "search":
      return "magnifyingglass";
    case "stop":
      return "stop.fill";
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "lock":
      return { ios: "lock", android: "lock" };
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

// Animate only fresh rows; virtualization remounts old rows during scrolling.
const FRESH_ROW_WINDOW_MS = 3_000;
export function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Match min-h-8; disable exact sizing when native accessibility scaling can exceed it.
const WORK_ROW_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;
export const WORK_ROW_GAP = 1;
const WORK_LOG_BOTTOM_MARGIN = 3.5;
export const WORK_GROUP_MAX_HEIGHT = 256;
export const WORK_GROUP_EDGE_FADE_HEIGHT = 12;

export const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;

export function workLogRowsHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  rowHeight = WORK_ROW_HEIGHT,
): number {
  return activities.length * rowHeight + Math.max(0, activities.length - 1) * WORK_ROW_GAP;
}

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  continues = false,
): number {
  const bottomMargin = continues ? 0 : WORK_LOG_BOTTOM_MARGIN;
  if (activities.length === 0) {
    return 0;
  }
  if (activities[0]?.projectedItem.item.type === "subagent") {
    return bottomMargin + WORK_ROW_HEIGHT;
  }
  const height = workLogRowsHeight(activities);
  return (
    bottomMargin +
    (activities[0]?.groupedToolDetail ? Math.min(height, WORK_GROUP_MAX_HEIGHT) : height)
  );
}

export interface ThreadWorkLogProps {
  readonly continuesWorkLog?: boolean | undefined;
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly anchorKey: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot?: string | null | undefined;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly scrollPositions: Map<string, ThreadWorkGroupScrollPosition>;
  readonly iconSubtleColor: ColorValue;
  readonly edgeFadeColor: string;
  readonly themeAppearance: "light" | "dark";
  readonly onCopyRow: (rowId: string, value: string) => void;
  /** `groupId` is the group a lone call stands in for; it opens and closes with the row. */
  readonly onToggleRow: (rowId: string, anchorKey: string, groupId?: string) => void;
  readonly renderImage: MarkdownImageRenderer;
  readonly renderReasoning: (text: string) => ReactNode;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}

export function ThreadWorkLog(props: ThreadWorkLogProps) {
  const renderRow = (row: ThreadFeedActivity) => (
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
      renderReasoning={props.renderReasoning}
      onPressPreview={props.onPressPreview}
      themeAppearance={props.themeAppearance}
    />
  );

  if (props.activities.length === 0) {
    return null;
  }

  const plan = props.activities[0]?.projectedItem.item;
  if (plan?.type === "proposed_plan") {
    return (
      <ProposedPlanCard
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        markdown={plan.markdown}
        renderMarkdown={props.renderReasoning}
      />
    );
  }

  if (props.activities[0]?.projectedItem.item.type === "subagent") {
    return <ThreadSubagentGroup {...props} />;
  }

  if (
    props.activities[0]?.groupedToolDetail &&
    props.activities.every((row) => row.projectedItem.item.type === "reasoning")
  ) {
    return (
      <WorkLogBlock continues={props.continuesWorkLog}>
        <ThreadReasoningGroup
          activities={props.activities}
          edgeFadeColor={props.edgeFadeColor}
          renderReasoning={props.renderReasoning}
        />
      </WorkLogBlock>
    );
  }

  return (
    <WorkLogBlock continues={props.continuesWorkLog}>
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
        <WorkLogRows>{props.activities.map(renderRow)}</WorkLogRows>
      )}
    </WorkLogBlock>
  );
}

function ThreadReasoningGroup(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly edgeFadeColor: string;
  readonly renderReasoning: (text: string) => ReactNode;
}) {
  const scrollOffset = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollOffset.set(event.contentOffset.y);
  });
  const bottomFadeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(
      1,
      Math.max(0, contentHeight.value - viewportHeight.value - scrollOffset.value) /
        WORK_GROUP_EDGE_FADE_HEIGHT,
    ),
  }));

  return (
    <View className="ml-7">
      <Animated.ScrollView
        nestedScrollEnabled
        className="max-h-96"
        contentContainerClassName="py-1"
        scrollEventThrottle={16}
        onScroll={onScroll}
        onLayout={(event) => {
          viewportHeight.set(event.nativeEvent.layout.height);
        }}
        onContentSizeChange={(_width, height) => {
          contentHeight.set(height);
        }}
      >
        {props.activities.map((row) => (
          <View key={row.id}>{props.renderReasoning(row.workEntry.detail ?? "")}</View>
        ))}
      </Animated.ScrollView>
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

export function EdgeFade(props: { readonly color: string; readonly direction: "up" | "down" }) {
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

export function workLogRowKey(row: ThreadFeedActivity): string {
  return row.id;
}

export function WorkspacePreparationRetryButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) {
  const retryable = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => {
      const run = thread?.projection.runs.find((candidate) => candidate.id === props.runId);
      return run?.status === "failed" && run.workspacePreparation !== undefined;
    },
  );
  const retry = useAtomCommand(threadEnvironment.retryWorkspacePreparation, "retry setup");
  const [busy, setBusy] = useState(false);
  if (!retryable) return null;
  return (
    <View className="ml-7 mt-2">
      <Button
        label="Retry"
        tone="secondary"
        accessibilityLabel="Retry workspace preparation"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void Haptics.selectionAsync();
          void retry({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, runId: props.runId },
          }).finally(() => setBusy(false));
        }}
        icon="arrow.clockwise"
      />
    </View>
  );
}

export function ReplCodeText({
  code,
  theme,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
}) {
  const lines = useMarkdownCodeHighlight({ code, language: "typescript", theme, enabled: true });
  let offset = 0;
  const highlighted = lines?.flatMap((line, lineIndex) => {
    const separator = lineIndex > 0 ? "\n" : "";
    offset += separator.length;
    return [
      separator,
      ...line.map((token) => {
        const start = offset;
        offset += token.content.length;
        return (
          <Text key={start} style={token.color ? { color: token.color } : undefined}>
            {token.content}
          </Text>
        );
      }),
    ];
  });
  return (
    <Text selectable className="font-mono text-2xs leading-normal text-foreground">
      {highlighted ?? code}
    </Text>
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

export function ToolActivityIconView(props: {
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
    <View className="h-4 w-4 items-center justify-center overflow-hidden rounded-[3px] bg-screen">
      {!loaded || failed ? <WorkLogIcon icon={props.fallback} color={props.color} /> : null}
      {!failed ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            props.themeAppearance === "light" ? { filter: [{ brightness: 0.7 }] } : undefined,
          ]}
        >
          <Image
            source={props.source}
            cachePolicy="memory-disk"
            contentFit="contain"
            style={[
              StyleSheet.absoluteFill,
              { opacity: loaded ? (props.themeAppearance === "dark" ? 0.7 : 1) : 0 },
            ]}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </View>
      ) : null}
    </View>
  );
}

export function toolGroupSummarySymbolName(kind: ToolGroupSummaryKind): AppSymbolName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return PullRequestGlyph.pullRequest;
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "thread-create":
      return { ios: "bubble.left", android: "chat" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "device":
      return { ios: "iphone", android: "smartphone" };
    case "browser":
    case "search":
      return { ios: "globe", android: "public" };
    case "code-search":
      return "magnifyingglass";
    case "other":
      return { ios: "wrench", android: "build" };
    case "reasoning":
      return { ios: "brain", android: "psychology" };
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
export * from "./thread-work-logParts3";
export * from "./thread-work-logParts4";
