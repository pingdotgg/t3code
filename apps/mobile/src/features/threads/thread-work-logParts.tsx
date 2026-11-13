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
import type { ThreadWorkLogProps } from "./thread-work-log";
import { ReplCodeText, ShimmeringWorkContent, ThreadDisclosureChevron, ToolActivityIconView, WORK_LOG_DETAIL_ENTER_TRANSITION, WORK_LOG_DETAIL_EXIT_TRANSITION, WORK_LOG_LAYOUT_TRANSITION, WorkLogIcon, WorkspacePreparationRetryButton, isFreshRow, workRowSymbolName } from "./thread-work-log";

export const ThreadWorkLogRow = function ThreadWorkLogRow(
  props: Omit<
    ThreadWorkLogProps,
    | "continuesWorkLog"
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
  const openLinkedThread = useOpenLinkedThread();
  const streamsOutput =
    useCommandOutputStreaming(props.environmentId) &&
    row.projectedItem.item.type === "command_execution";
  const fetchedDetail = useTurnItemDetail(
    expanded && row.fetchesDetail && !streamsOutput
      ? { environmentId: props.environmentId, row: row.projectedItem }
      : null,
  );
  const failureItem = row.projectedItem.item;
  if (failureItem.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const timestamp = new Date(row.createdAt);
    const resetAt = failureItem.failure.resetAt;
    // The reset time is the viewer's local time; naming the zone keeps it unambiguous.
    const resetTime = resetAt
      ? `${new Date(resetAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })} (${new Intl.DateTimeFormat().resolvedOptions().timeZone})`
      : null;
    const label = warning
      ? `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`
      : row.summary;
    return (
      <WorkLogPressable
        accessibilityLabel={warning ? label : `${row.summary}: ${failureItem.failure.message}`}
        accessibilityHint="Long press to copy."
        onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
      >
        <View className="flex-1 py-1">
          <View className="flex-row items-center gap-1.5">
            <WorkLogIconSlot>
              <WorkLogIcon
                icon="exclamationmark.circle"
                color={props.iconSubtleColor}
                colorClassName={warning ? "accent-warning-foreground" : "accent-danger-foreground"}
              />
            </WorkLogIconSlot>
            <Text
              className={
                warning
                  ? "min-w-0 flex-1 font-t3-medium text-sm text-warning-foreground"
                  : "min-w-0 flex-1 font-t3-medium text-sm text-adaptive-rose-600-400"
              }
            >
              {label}
            </Text>
            {props.copied ? (
              <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
                Copied
              </Text>
            ) : null}
            <Text
              accessibilityLabel={timestamp.toLocaleString()}
              className="shrink-0 text-xs text-foreground-subtle"
            >
              {timestamp.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
          {!warning ? (
            <Text selectable className="ml-7 text-sm text-foreground">
              {failureItem.failure.message}
            </Text>
          ) : null}
          {failureItem.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
          failureItem.runId !== null ? (
            <WorkspacePreparationRetryButton
              environmentId={props.environmentId}
              threadId={failureItem.threadId}
              runId={failureItem.runId}
            />
          ) : null}
        </View>
      </WorkLogPressable>
    );
  }
  const notifiedSubagentThreadId =
    row.projectedItem.item.type === "notification"
      ? notificationChildThreadId(row.projectedItem.item.source)
      : undefined;
  const canExpand = row.canExpand && notifiedSubagentThreadId === undefined;
  const reasoning = row.projectedItem.item.type === "reasoning" ? row.projectedItem.item : null;
  const fetchedItem = fetchedDetail.data?.item ?? null;
  const isRead = toolGroupAction(row.workEntry) === "read";
  const shownItem = fetchedItem ?? row.projectedItem.item;
  const call =
    expanded && !isRead && shownItem.type === "command_execution"
      ? toolCallLines({ command: shownItem.input })
      : expanded && !isRead && shownItem.type === "dynamic_tool"
        ? toolCallLines({ args: shownItem.input })
        : expanded && shownItem.type === "file_search"
          ? toolCallLines({ args: { pattern: shownItem.pattern } })
          : expanded && shownItem.type === "web_search"
            ? toolCallLines({ args: { query: shownItem.patterns?.join(", ") } })
            : null;
  const failedExitCode =
    call && shownItem.type === "command_execution" && shownItem.exitCode
      ? shownItem.exitCode
      : null;
  const fullDetail =
    expanded && !reasoning && !call
      ? fetchedItem && !isRead
        ? formatItemFullDetail(row.projectedItem, fetchedItem)
        : row.getFullDetail()
      : null;
  const outputImages = expanded && fetchedItem ? turnItemOutputImages(fetchedItem) : [];
  const viewedImagePath = workEntryViewedImagePath(row.workEntry);
  const fetchedOutput =
    !expanded || streamsOutput
      ? null
      : shownItem.type === "file_search" || shownItem.type === "web_search"
        ? turnItemOutputText(shownItem)
        : fetchedItem
          ? (turnItemOutputText(fetchedItem) ??
            (outputImages.length > 0 || viewedImagePath ? null : "No output."))
          : fetchedDetail.error
            ? `Couldn't load output: ${fetchedDetail.error}`
            : row.fetchesDetail
              ? fetchedDetail.data
                ? "Output is no longer available."
                : "Loading output…"
              : null;
  const exitLine =
    failedExitCode === null ? null : (
      <Text className="mt-1.5 font-mono text-2xs leading-normal text-danger-foreground">
        exit {failedExitCode}
      </Text>
    );
  const toolPresentation = resolveWorkEntryToolPresentation(row.workEntry);
  const previewText = row.groupStandIn?.label ?? workEntryRowLabel(row.workEntry);
  const answerPreview = row.workEntry.questionAnswer
    ? getQuestionAnswerPreview(row.workEntry.questionAnswer)
    : null;
  const accessiblePreview = [previewText, answerPreview].filter(Boolean).join(": ");
  const displayText = row.groupStandIn?.label ?? workEntryRowLabel(row.workEntry, expanded);
  const isSystemNotice = row.projectedItem.item.type === "system_notice";
  const isUsageLimit =
    row.projectedItem.item.type === "error" &&
    row.projectedItem.item.failure.class === "usage_limit" &&
    row.projectedItem.item.status !== "completed";
  const iconIsDestructive =
    !isSystemNotice && !isUsageLimit && (row.icon === "alert" || row.icon === "warning");
  const failed = row.status === "failure";
  const toolIcon = row.workEntry.toolIcon ?? row.workEntry.toolSource?.icon;
  const icon = reasoning ? "brain" : (toolPresentation?.icon ?? workRowSymbolName(row.icon));

  return (
    <Animated.View
      layout={WORK_LOG_LAYOUT_TRANSITION}
      className="overflow-hidden"
      {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
    >
      <WorkLogPressable
        accessibilityRole={
          notifiedSubagentThreadId !== undefined ? "link" : canExpand ? "button" : undefined
        }
        accessibilityLabel={failed ? `${accessiblePreview}, tool call failed` : accessiblePreview}
        accessibilityHint={
          notifiedSubagentThreadId !== undefined
            ? "Opens this agent's thread. Long press to copy."
            : canExpand
              ? `Double tap to ${expanded ? "hide" : "show"} full details. Long press to copy.`
              : "Long press to copy."
        }
        accessibilityState={canExpand ? { expanded } : undefined}
        onPress={() => {
          if (notifiedSubagentThreadId !== undefined) {
            openLinkedThread({
              environmentId: String(props.environmentId),
              threadId: String(notifiedSubagentThreadId),
            });
            return;
          }
          if (canExpand) {
            void Haptics.selectionAsync();
            props.onToggleRow(row.id, props.anchorKey, row.groupStandIn?.groupId);
          }
        }}
        onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
      >
        {row.live && !expanded ? (
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
            <WorkLogIconSlot>
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
                    isUsageLimit
                      ? "accent-warning-foreground"
                      : iconIsDestructive
                        ? "accent-adaptive-rose-600-400"
                        : failed
                          ? "accent-danger-foreground/40"
                          : undefined
                  }
                />
              )}
            </WorkLogIconSlot>
            <WorkLogLabel
              tone={isUsageLimit ? "warning" : iconIsDestructive ? "danger" : "default"}
            >
              {displayText}
              {answerPreview ? (
                <Text
                  className={
                    !expanded &&
                    row.workEntry.questionAnswer &&
                    hasQuestionAnswer(row.workEntry.questionAnswer)
                      ? "text-foreground"
                      : "text-foreground-subtle"
                  }
                >{`  ${answerPreview}`}</Text>
              ) : null}
            </WorkLogLabel>
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
      </WorkLogPressable>

      {expanded &&
      (reasoning ||
        fullDetail ||
        call ||
        fetchedOutput ||
        viewedImagePath ||
        outputImages.length > 0 ||
        row.workEntry.questionAnswer) ? (
        <Animated.View
          entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
          exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
          layout={WORK_LOG_LAYOUT_TRANSITION}
          className={reasoning ? "ml-7 py-1" : "pb-1 pt-0.5"}
        >
          {row.workEntry.questionAnswer ? (
            <QuestionAnswerHistory
              environmentId={props.environmentId}
              answer={row.workEntry.questionAnswer}
            />
          ) : null}
          {viewedImagePath ? (
            <View className="pb-1.5">
              {props.renderImage({ href: viewedImagePath, alt: null, title: null })}
            </View>
          ) : null}
          <FilePreviewGallery
            value={outputImages.map((resource) => ({
              kind: "image",
              environmentId: props.environmentId,
              resource,
            }))}
          >
            {outputImages.map((resource) => (
              <View key={resource.index} className="pb-1.5">
                <ThreadMarkdownImage
                  environmentId={props.environmentId}
                  resource={resource}
                  alt={null}
                  onPressPreview={props.onPressPreview}
                />
              </View>
            ))}
          </FilePreviewGallery>
          <ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            className="max-h-60"
            contentContainerStyle={{ paddingRight: 8 }}
          >
            {reasoning ? (
              props.renderReasoning(reasoning.text)
            ) : call ? (
              [
                call.command,
                ...(call.args ?? []).map(([key, value]) =>
                  key === "code" &&
                  shownItem.type === "dynamic_tool" &&
                  isJavaScriptReplTool(shownItem.toolName) ? (
                    <View key={key}>
                      <Text className="font-mono text-2xs leading-normal text-foreground-muted">
                        {key}
                      </Text>
                      <ReplCodeText code={value} theme={props.themeAppearance} />
                    </View>
                  ) : (
                    `${key} ${value}`
                  ),
                ),
                call.argsText,
              ]
                .filter((line) => Boolean(line))
                .map(
                  (line, index) =>
                    /* oxlint-disable react/no-array-index-key -- Log lines are stateless positions within this output. */ typeof line ===
                    "string" ? (
                      <Text
                        key={`${index}:${line}`}
                        selectable
                        className="font-mono text-2xs leading-normal text-foreground"
                      >
                        {line}
                      </Text>
                    ) : (
                      line
                    ) /* oxlint-enable react/no-array-index-key */,
                )
            ) : fullDetail ? (
              <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
                {fullDetail}
              </Text>
            ) : null}
            {fetchedOutput ? (
              <Text
                selectable
                className={cn(
                  "font-mono text-2xs leading-normal text-foreground-muted",
                  (!call || call.command || call.args || call.argsText) && "mt-1.5",
                )}
              >
                {fetchedOutput}
              </Text>
            ) : null}
            {streamsOutput ? null : exitLine}
          </ScrollView>
          {streamsOutput ? (
            <>
              <ThreadCommandOutput
                environmentId={props.environmentId}
                threadId={row.projectedItem.sourceThreadId}
                itemId={row.projectedItem.sourceItemId}
                themeAppearance={props.themeAppearance}
              />
              {exitLine}
            </>
          ) : null}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
};

