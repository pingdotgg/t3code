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
import type { WorkContentIcon } from "./thread-work-log";
import { SHIMMER_ICON_AND_GAP_WIDTH, SHIMMER_PAUSE_MS, SHIMMER_SWEEP_MS, SHIMMER_WIDTH, ShimmerWorkContent } from "./thread-work-log";

export function ShimmeringWorkContent(props: {
  readonly className?: string;
  readonly textClassName?: string;
  readonly compact?: boolean;
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
  const appIsActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const screenIsFocused = useIsFocused();
  const progress = useAnimatedValue(0);
  const gradientId = `work-shimmer-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(
    availableWidth,
    (props.showIcon ? SHIMMER_ICON_AND_GAP_WIDTH : 0) + Math.ceil(textWidth),
  );

  // Runs on React Native's native driver instead of Reanimated, whose
  // per-frame commits starve React's while commit pausing is disabled
  // (package.json). See docs/internals/performance-regressions.md.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the native-driver shimmer loop while visible and active, and stops it on cleanup
  useEffect(() => {
    progress.setValue(0);
    if (contentWidth <= 0 || reducedMotion || !appIsActive || !screenIsFocused) return;

    const loop = NativeAnimated.loop(
      NativeAnimated.timing(progress, {
        toValue: 1,
        duration: SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [appIsActive, contentWidth, progress, reducedMotion, screenIsFocused]);

  // One timing covers the sweep and the pause, so the native driver can loop it.
  // The React Compiler memoizes these, so re-renders don't rebuild the native
  // animation nodes.
  const inputRange = [0, SHIMMER_SWEEP_MS / (SHIMMER_SWEEP_MS + SHIMMER_PAUSE_MS), 1];
  const sweepTranslateX = progress.interpolate({
    inputRange,
    outputRange: [-SHIMMER_WIDTH, contentWidth, contentWidth],
  });
  const counterSweepTranslateX = progress.interpolate({
    inputRange,
    outputRange: [SHIMMER_WIDTH, -contentWidth, -contentWidth],
  });

  return (
    <View
      className={cn("min-w-0 flex-1 overflow-hidden", props.className)}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <ShimmerWorkContent
        textClassName={props.textClassName}
        compact={props.compact}
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
        <NativeAnimated.View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            overflow: "hidden",
            width: SHIMMER_WIDTH,
            transform: [{ translateX: sweepTranslateX }],
          }}
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
            <NativeAnimated.View
              style={{ width: availableWidth, transform: [{ translateX: counterSweepTranslateX }] }}
            >
              <ShimmerWorkContent
                textClassName={props.textClassName}
                compact={props.compact}
                environmentId={props.environmentId}
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
                themeAppearance={props.themeAppearance}
                toolIcon={props.toolIcon}
              />
            </NativeAnimated.View>
          </MaskedView>
        </NativeAnimated.View>
      ) : null}
    </View>
  );
}

