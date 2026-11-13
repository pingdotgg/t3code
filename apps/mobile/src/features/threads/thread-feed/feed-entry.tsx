import type { FeedEntryRenderProps } from "./types.ts";
/**
 * Thread feed row renderer: dispatches one grouped feed entry to its row.
 */
import { ThreadContextDivider } from "../thread-context-divider";
import {
  ThreadHandoffDivider,
  ThreadHandoffRow,
  ThreadModelSwitchDivider,
} from "../thread-handoff-row";
import { ThreadGuestPendingMessage, useThreadGuestShare } from "../ThreadGuestShareBar";
import { LinkRequestCard } from "../LinkRequestCard";
import { SecretRequestCard } from "../SecretRequestCard";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
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
import { FilePreviewModal, type FilePreviewSource } from "../../../components/FilePreviewModal";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../../native/SelectableMarkdownText";
import {
  ReviewCommentCard,
  useReviewCommentColors,
  type ReviewCommentColors,
} from "../../review/ReviewCommentCard";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  type LayoutVariant,
} from "../../../lib/layout";
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
import { htmlRenderRowHeight, ThreadHtmlRender } from "../HtmlRenderWebView";
import { ThreadMcpApp } from "../McpAppWebView";
import {
  RunFoldButton,
  compactionLabel,
} from "./automation-rows.tsx";
import type {
  MarkdownLinkHandlers,
  MarkdownStyleSets,
} from "./markdown.tsx";
import {
  MessageAttachmentList,
} from "./media.tsx";
import {
  TurnDiffStat,
} from "./message-rows.tsx";
import type {
  ThreadFeedProps,
} from "./types.ts";
import { renderMessageEntry } from "./feed-entry-message.tsx";

export function renderFeedEntry(
  info: { item: ThreadFeedRow; index: number },
  props: FeedEntryRenderProps,
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "guest-pending") {
    return (
      <ThreadGuestPendingMessage
        threadRef={scopeThreadRef(props.environmentId, props.threadId)}
        guestName={entry.guestName}
        message={entry.message}
        bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
        renderAttachments={(attachments) => (
          <MessageAttachmentList
            attachments={attachments}
            environmentId={props.environmentId}
            onPressPreview={props.onPressPreview}
            onPlaybackStart={props.onPlaybackStart}
          />
        )}
      />
    );
  }

  if (entry.type === "run-fold") {
    return (
      <View className="mb-1 flex-row items-center border-b border-border-subtle px-2">
        <RunFoldButton
          key={entry.id}
          entry={entry}
          environmentId={props.environmentId}
          threadId={props.threadId}
          onToggle={props.onToggleTurnFold}
          rowSizing={props.workRowSizing}
          iconColor={iconSubtleColor}
        />
        {entry.checkpointSummary ? (
          <TurnDiffStat
            checkpoint={entry.checkpointSummary}
            onOpenTurnDiff={props.onOpenTurnDiff}
          />
        ) : null}
      </View>
    );
  }

  if (entry.type === "thinking") {
    return <ThreadThinkingRow rowSizing={props.workRowSizing} iconSubtleColor={iconSubtleColor} />;
  }

  if (entry.type === "html-render") {
    return (
      <ThreadHtmlRender
        environmentId={props.environmentId}
        threadId={props.threadId}
        render={entry.render}
        frameWidth={props.contentWidth}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "mcp-app") {
    return (
      <ThreadMcpApp
        key={entry.app.attachmentId}
        environmentId={props.environmentId}
        threadId={entry.sourceThreadId}
        conversationThreadId={props.threadId}
        itemId={entry.itemId}
        revision={entry.revision}
        app={entry.app}
        width={props.contentWidth}
      />
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        environmentId={props.environmentId}
        rowSizing={props.workRowSizing}
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        summary={entry.summary}
        summaryKind={entry.summaryKind}
        themeAppearance={props.themeAppearance}
        toolSurface={entry.toolSurface}
        toolIcon={entry.toolIcon}
        summaryToolIcon={entry.summaryToolIcon}
        hasFailure={entry.hasFailure}
        shimmer={entry.shimmer}
        thought={entry.thought}
        trailing={
          entry.checkpointSummary ? (
            <TurnDiffStat
              checkpoint={entry.checkpointSummary}
              onOpenTurnDiff={props.onOpenTurnDiff}
            />
          ) : null
        }
        onToggle={() => props.onToggleWorkGroup(entry.groupId, entry.id)}
      />
    );
  }

  if (entry.type === "activity-group" && isContextHandoffActivityGroup(entry)) {
    return (
      <ThreadHandoffRow
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
        surfaceColor={props.screenColor}
      />
    );
  }

  if (entry.type === "activity-group" && isSecretRequestActivityGroup(entry)) {
    return (
      <SecretRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isLinkRequestActivityGroup(entry)) {
    return (
      <LinkRequestCard
        environmentId={props.environmentId}
        projectedItem={entry.activities[0]!.projectedItem}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "activity-group" && isContextCompactionActivityGroup(entry)) {
    const label = entry.activities[0]!.summary;
    const item = entry.activities[0]!.projectedItem.item;
    const active =
      props.unsettledTurnId !== null &&
      entry.runId === props.unsettledTurnId &&
      item.status === "running";
    const labels = props.compactionLabelsByEntryId.get(entry.id);
    const failure =
      item.type === "compaction" && item.status === "failed" ? item.summary?.trim() : undefined;
    return (
      <ThreadContextDivider
        label={
          failure
            ? `${label} · ${failure}`
            : active && labels
              ? labels.compacting
              : compactionLabel(label, labels?.title)
        }
        icon={
          item.status === "failed" ? "exclamationmark.circle" : "arrow.down.right.and.arrow.up.left"
        }
        iconColor={iconSubtleColor}
        active={active}
        failed={item.status === "failed"}
      />
    );
  }

  if (entry.type === "message") return renderMessageEntry(entry, props);


  return (
    <ThreadWorkLog
      key={`${entry.id}:${props.workRowSizing.textSizeKey}`}
      activities={entry.activities}
      continuesWorkLog={entry.continuesWorkLog}
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      anchorKey={entry.id}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      rowSizing={props.workRowSizing}
      scrollPositions={props.workGroupScrollPositions}
      iconSubtleColor={iconSubtleColor}
      edgeFadeColor={props.screenColor}
      themeAppearance={props.themeAppearance}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      renderImage={props.renderViewedImage}
      renderReasoning={props.renderReasoning}
      onPressPreview={props.onPressPreview}
    />
  );
}



