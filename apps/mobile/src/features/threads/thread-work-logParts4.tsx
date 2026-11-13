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
import { ThreadDisclosureChevron, ToolActivityIconView, WorkLogIcon, toolGroupSummarySymbolName, workRowSymbolName } from "./thread-work-log";

export function ThreadWorkGroupToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly rowSizing: ReturnType<typeof deriveThreadWorkLogSizing>;
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly summary: string;
  readonly summaryKind: ToolGroupSummaryKind;
  readonly summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request" | "brain";
  readonly themeAppearance: "light" | "dark";
  readonly toolSurface?: import("@t3tools/contracts").ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
  readonly hasFailure: boolean;
  readonly shimmer: boolean;
  readonly thought?: string | undefined;
  readonly trailing?: ReactNode;
  readonly onToggle: () => void;
}) {
  const statusLabel = props.hasFailure ? `${props.summary}, tool call failed` : props.summary;
  const accessibilityLabel = props.thought ? `${props.thought} ${statusLabel}` : statusLabel;
  const icon =
    props.summaryToolIcon ??
    (props.toolSurface
      ? workRowSymbolName(props.toolSurface)
      : toolGroupSummarySymbolName(props.summaryKind));

  return (
    <WorkLogBlock layout="group-header">
      {props.thought ? (
        <Pressable
          accessible={false}
          onPress={props.onToggle}
          className="flex-row items-start gap-1.5 rounded-md px-0.5 active:bg-subtle"
        >
          <WorkLogIconSlot>
            <WorkLogIcon icon="brain" color={props.iconSubtleColor} />
          </WorkLogIconSlot>
          <Text
            key={props.rowSizing.textSizeKey}
            selectable={false}
            numberOfLines={4}
            ellipsizeMode="tail"
            className="min-w-0 flex-1 py-0.5 text-sm text-foreground-muted"
          >
            {props.thought}
          </Text>
        </Pressable>
      ) : null}
      <View className="flex-row items-center">
        <View className="min-w-0 flex-1">
          <WorkLogPressable
            accessibilityRole="button"
            accessibilityState={{ expanded: props.expanded }}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} ${props.hiddenCount} tool ${props.hiddenCount === 1 ? "call" : "calls"}.`}
            onPress={() => {
              void Haptics.selectionAsync();
              props.onToggle();
            }}
            rowSizing={props.rowSizing}
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
                <WorkLogIconSlot>
                  <ToolActivityIconView
                    environmentId={props.environmentId}
                    icon={props.toolIcon}
                    fallback={icon}
                    fallbackColor={props.iconSubtleColor}
                    themeAppearance={props.themeAppearance}
                  />
                </WorkLogIconSlot>
                <WorkLogLabel key={props.rowSizing.textSizeKey}>{props.summary}</WorkLogLabel>
              </>
            )}
            <ThreadDisclosureChevron
              expanded={props.expanded}
              collapsedDirection="down"
              size={11}
              tintColor={props.iconSubtleColor}
            />
          </WorkLogPressable>
        </View>
        {props.trailing}
      </View>
    </WorkLogBlock>
  );
}

