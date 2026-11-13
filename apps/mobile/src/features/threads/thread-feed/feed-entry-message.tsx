/**
 * Thread feed message row: the user/assistant message bubble and its fold.
 */
import { ThreadContextDivider } from "../thread-context-divider";
import { GuestBubbleTint, GuestMessageName } from "../guestMessageStyle";
import {
  IDLE_COMPACTING_LABELS,
  resolveUserMessageFileCards,
  resolveUserMessagePresentation,
} from "@t3tools/client-runtime/user-message";
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
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import {
  parseComposerContextHref,
  collectComposerContextReferences,
  replaceComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";
import { writeComposerContextClipboard } from "../../../lib/composerContextClipboard";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
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
import { composerImageGallery } from "../../../lib/composerImageGallery";
import Animated, { FadeIn, FadeInDown, type SharedValue } from "react-native-reanimated";
import { hasWideMarkdownBlock } from "../../../lib/wideMarkdownBlocks";
import { AppText as Text } from "../../../components/ui/AppText";
import { CopyTextButton } from "../CopyTextButton";
import { cn } from "../../../lib/cn";
import {
  appendGuestPendingMessages,
  appendPendingThreadMessages,
  createThreadFeedGrouping,
  isCompactionCommandFeedEntry,
  type GroupedThreadFeedRow,
  type ThreadFeedRow,
} from "../pending-thread-feed";
import { ThreadWorkflowOpening, useWorkflowOpening } from "../thread-workflow-opening";
import { resolveUserMessageIntentBadge } from "../userMessageIntentBadge";
import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "../ThreadMarkdownImage";
import { MessageAttachmentFile } from "../ThreadFeedParts";
import {
  ThreadAutomationMessageRow,
} from "./automation-rows.tsx";
import {
  AssistantMarkdownContent,
  WIDE_MARKDOWN_BLOCK_OPTIONS,
} from "./markdown.tsx";
import {
  MessageAttachmentImage,
  MessageAttachmentList,
  MessageAttachmentUnknown,
  UserMessageMedia,
  isFileAttachment,
  isImageAttachment,
  isMediaAttachment,
} from "./media.tsx";
import {
  AgentMessageFoldHeader,
  AssistantForkButton,
  OpenSenderThreadButton,
  TurnDiffStat,
  UserMessageContent,
  UserMessageCopyButton,
} from "./message-rows.tsx";
import {
  USER_BUBBLE_HORIZONTAL_PADDING,
  formatMessageTime,
  isFreshTimestamp,
} from "./placeholder.tsx";
import type { FeedEntryRenderProps } from "./types.ts";

export function renderMessageEntry(
  entry: Extract<ThreadFeedRow, { type: "message" }>,
  props: FeedEntryRenderProps,
): ReactNode {
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;
    const { message } = entry;
    const isUser = message.role === "user";
    const presentation = resolveUserMessagePresentation(message);
    const renderedText = renderAssistantCitationsAsText(presentation.text);
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = presentation.text.includes("<review_comment");
    // Android does not reposition children after maxWidth clamps bubbles; definite width prevents wide-block overlap.
    const hasWideBlock = hasWideMarkdownBlock(renderedText, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.runId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser && props.workflowOpening?.messageId === message.id) {
      return (
        <ThreadWorkflowOpening
          environmentId={props.environmentId}
          threadId={props.threadId}
          opening={props.workflowOpening}
        />
      );
    }
    if (isCompactionCommandFeedEntry(entry)) {
      // Stands in for the compaction item until the provider reports it.
      const active = props.unsettledTurnId !== null && message.runId === props.unsettledTurnId;
      const reason = idleCompactionOf(message);
      return (
        <ThreadContextDivider
          label={
            !active
              ? "Context compaction"
              : reason === undefined
                ? "Compacting context"
                : IDLE_COMPACTING_LABELS[reason]
          }
          icon="arrow.down.right.and.arrow.up.left"
          iconColor={iconSubtleColor}
          active={active}
        />
      );
    }
    if (isUser && presentation.attribution === "automation") {
      const rowId = `automation:${message.id}`;
      return (
        <ThreadAutomationMessageRow
          environmentId={props.environmentId}
          text={presentation.text}
          context={message.context}
          scheduledTaskId={presentation.scheduledTaskId}
          timestampLabel={timestampLabel}
          expanded={props.expandedWorkRows[rowId] ?? false}
          onToggle={() => props.onToggleWorkRow(rowId, entry.id)}
          bubbleColor={userBubbleColor}
          bubbleMaxWidth={props.duoColumns ? "85%" : props.userBubbleMaxWidth}
          contentMaxWidth={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
          iconSubtleColor={iconSubtleColor}
          markdownStyles={markdownStyles.user}
          reviewCommentColors={props.reviewCommentColors}
          skills={props.skills}
          linkHandlers={props.markdownLinkHandlers}
          renderImage={props.renderMarkdownImage}
        />
      );
    }
    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      const foldRowId = presentation.attribution === "agent" ? `agent:${message.id}` : null;
      const foldExpanded = foldRowId !== null && (props.expandedWorkRows[foldRowId] ?? false);
      const bubbleBodyVisible = foldRowId === null || foldExpanded;
      const intentBadge = props.userMessageGrouping.continuesSteer
        ? null
        : resolveUserMessageIntentBadge(message.inputIntent);
      const referenceIds = new Set(
        collectComposerContextReferences(message.text).map((reference) => reference.contextId),
      );
      const inlineAttachmentIds = new Set(
        message.context?.records.flatMap((record) =>
          "attachmentId" in record && referenceIds.has(record.contextId)
            ? [record.attachmentId]
            : [],
        ),
      );
      const standaloneMedia = foldRowId === null && presentation.attribution !== "guest";
      const mediaAttachments = standaloneMedia ? attachments.filter(isMediaAttachment) : [];
      const visibleAttachments = attachments.filter(
        (attachment) =>
          !(standaloneMedia && isMediaAttachment(attachment)) &&
          (isImageAttachment(attachment) || !inlineAttachmentIds.has(attachment.id)),
      );
      const pendingAttachments = entry.pendingMessage?.attachments ?? [];
      const pendingMedia = standaloneMedia ? pendingAttachments.filter(isMediaAttachment) : [];
      const pendingBubbleAttachments = standaloneMedia
        ? pendingAttachments.filter(
            (attachment) =>
              !isMediaAttachment(attachment) && !inlineAttachmentIds.has(attachment.id),
          )
        : pendingAttachments;
      const fileCards = standaloneMedia
        ? resolveUserMessageFileCards({
            text: presentation.text,
            attachments: attachments.length > 0 ? attachments : pendingAttachments,
            context: message.context,
          })
        : null;
      const hasBubble =
        fileCards === null &&
        (foldRowId !== null ||
          presentation.text.trim().length > 0 ||
          visibleAttachments.length + pendingBubbleAttachments.length > 0);
      return (
        <Animated.View
          className={cn("items-end", props.userMessageGrouping.groupedWithNext ? "mb-1" : "mb-5")}
          {...(enterAnimated ? { entering: FadeInDown.duration(220) } : {})}
        >
          {presentation.attribution === "t3code" ? (
            <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
              Sent by T3 Code
            </Text>
          ) : null}
          {presentation.guestName !== undefined ? (
            <GuestMessageName name={presentation.guestName} />
          ) : null}
          {mediaAttachments.length + pendingMedia.length > 0 ? (
            <View
              className={hasBubble ? "mb-2" : undefined}
              style={{ width: props.duoColumns ? "85%" : props.userBubbleMaxWidth }}
            >
              <UserMessageMedia
                attachments={mediaAttachments}
                pendingAttachments={pendingMedia}
                environmentId={props.environmentId}
                maxWidth={props.userBubbleMaxWidth}
                onPressPreview={props.onPressPreview}
                onPlaybackStart={props.onPlaybackStart}
              />
            </View>
          ) : null}
          {fileCards ? (
            <View
              className="items-end"
              style={{ maxWidth: props.duoColumns ? "85%" : props.userBubbleMaxWidth }}
            >
              {fileCards.map((file) => {
                const pendingFile = pendingAttachments.find(
                  (attachment) => attachment.id === file.id,
                );
                return (
                  <MessageAttachmentFile
                    key={file.id}
                    environmentId={props.environmentId}
                    attachment={
                      pendingFile?.uploadedAttachmentId
                        ? { ...file, id: pendingFile.uploadedAttachmentId }
                        : file
                    }
                    available={
                      pendingFile === undefined || pendingFile.uploadedAttachmentId !== undefined
                    }
                    onPressPreview={props.onPressPreview}
                    onPlaybackStart={props.onPlaybackStart}
                    standaloneFile
                  />
                );
              })}
            </View>
          ) : null}
          {hasBubble ? (
            <View
              className="min-w-0 rounded-[20px]"
              style={{
                backgroundColor: userBubbleColor,
                maxWidth: props.duoColumns ? "85%" : props.userBubbleMaxWidth,
                ...(!bubbleBodyVisible
                  ? null
                  : hasReviewCommentContext
                    ? { width: props.reviewCommentBubbleWidth }
                    : hasWideBlock || foldExpanded
                      ? { width: props.duoColumns ? "85%" : props.userBubbleMaxWidth }
                      : null),
              }}
            >
              {presentation.attribution === "guest" ? <GuestBubbleTint /> : null}
              {foldRowId !== null ? (
                <AgentMessageFoldHeader
                  environmentId={props.environmentId}
                  senderThreadId={message.senderThreadId}
                  summary={
                    replaceComposerContextReferences(presentation.text, (ref) => ref.label)
                      .split(/\r?\n/)
                      .find((line) => line.trim().length > 0)
                      ?.trim() ?? ""
                  }
                  expanded={foldExpanded}
                  onToggle={() => props.onToggleWorkRow(foldRowId, entry.id)}
                  iconSubtleColor={iconSubtleColor}
                />
              ) : null}
              {bubbleBodyVisible ? (
                <View className={cn("gap-2 px-3.5 pb-2.5", foldRowId === null && "pt-2.5")}>
                  {pendingBubbleAttachments.map((attachment) =>
                    attachment.type === "image" && attachment.uploadedAttachmentId ? (
                      <MessageAttachmentImage
                        key={attachment.id}
                        environmentId={props.environmentId}
                        attachmentId={attachment.uploadedAttachmentId}
                        name={attachment.name}
                        mimeType={attachment.mimeType}
                        className="h-[140px] w-[180px] rounded-[14px]"
                        onPressPreview={props.onPressPreview}
                      />
                    ) : attachment.type === "image" ? (
                      <Pressable
                        key={attachment.id}
                        accessibilityRole="imagebutton"
                        accessibilityLabel={`Open ${attachment.name}`}
                        onPress={() => {
                          const source = composerImageGallery([attachment])[0];
                          if (source)
                            props.onPressPreview({
                              ...source,
                              gallery: composerImageGallery(
                                entry.pendingMessage?.attachments ?? [],
                                props.environmentId,
                              ),
                            });
                        }}
                      >
                        <Image
                          source={{ uri: attachment.previewUri }}
                          style={{ width: 180, height: 140, borderRadius: 14 }}
                        />
                      </Pressable>
                    ) : (
                      <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                    ),
                  )}
                  {/* An empty container still takes a gap, which pads every attachment-free bubble. */}
                  {visibleAttachments.length > 0 ? (
                    <View
                      className={inlineAttachmentIds.size ? "flex-row flex-wrap gap-2" : "gap-2"}
                    >
                      {visibleAttachments.map((attachment) => {
                        return isImageAttachment(attachment) ? (
                          <MessageAttachmentImage
                            key={attachment.id}
                            environmentId={props.environmentId}
                            attachmentId={attachment.id}
                            name={attachment.name}
                            mimeType={attachment.mimeType}
                            className={
                              inlineAttachmentIds.size
                                ? "h-24 w-24 rounded-[14px] bg-user-bubble-foreground/15"
                                : "aspect-[1.3] w-full rounded-[14px] bg-user-bubble-foreground/15"
                            }
                            onPressPreview={props.onPressPreview}
                          />
                        ) : isFileAttachment(attachment) ? (
                          <MessageAttachmentFile
                            key={attachment.id}
                            environmentId={props.environmentId}
                            attachment={attachment}
                            onPressPreview={props.onPressPreview}
                            onPlaybackStart={props.onPlaybackStart}
                          />
                        ) : (
                          <MessageAttachmentUnknown key={attachment.id} name={attachment.name} />
                        );
                      })}
                    </View>
                  ) : null}
                  {presentation.text.trim().length > 0 ? (
                    <MarkdownImageAvailableWidthContext
                      value={props.userBubbleMaxWidth - USER_BUBBLE_HORIZONTAL_PADDING * 2}
                    >
                      <UserMessageContent
                        text={renderedText}
                        environmentId={props.environmentId}
                        context={message.context}
                        markdownStyles={styles}
                        reviewCommentColors={props.reviewCommentColors}
                        skills={props.skills}
                        linkHandlers={props.markdownLinkHandlers}
                        renderImage={props.renderMarkdownImage}
                      />
                    </MarkdownImageAvailableWidthContext>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {bubbleBodyVisible ? (
            <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
              {foldRowId !== null && message.senderThreadId ? (
                <OpenSenderThreadButton
                  environmentId={props.environmentId}
                  senderThreadId={message.senderThreadId}
                />
              ) : null}
              {intentBadge ? (
                <View
                  accessible
                  accessibilityLabel={intentBadge.accessibilityLabel}
                  className="flex-row items-center gap-1"
                >
                  <SymbolView name="arrow.uturn.forward" size={12} tintColor={iconSubtleColor} />
                  <Text className="font-t3-medium text-xs text-foreground-secondary">
                    {intentBadge.label}
                  </Text>
                </View>
              ) : null}
              {intentBadge ? (
                <Text
                  accessible={false}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  className="font-t3-medium text-xs text-foreground-secondary"
                >
                  ·
                </Text>
              ) : null}
              <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
                {entry.pendingMessage && !entry.acknowledged ? "Pending" : timestampLabel}
              </Text>
              {props.onEditPendingMessage !== null &&
              entry.pendingMessage &&
              !entry.acknowledged &&
              !entry.pendingMessage.creation &&
              entry.pendingMessage.messageId !== props.dispatchingMessageId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Edit pending message"
                  hitSlop={8}
                  className="size-7 items-center justify-center"
                  onPress={() => {
                    if (entry.pendingMessage && props.onEditPendingMessage) {
                      props.onEditPendingMessage(entry.pendingMessage);
                    }
                  }}
                >
                  <SymbolView name="pencil" size={14} tintColor={iconSubtleColor} />
                </Pressable>
              ) : null}
              {presentation.text.trim().length > 0 ? (
                <UserMessageCopyButton
                  text={presentation.text}
                  onCopy={
                    message.context && presentation.attribution !== "guest"
                      ? () =>
                          writeComposerContextClipboard(message.text, {
                            version: 1,
                            source: { environmentId: props.environmentId, messageId: message.id },
                            records: message.context!.records,
                          })
                      : undefined
                  }
                  tintColor={iconSubtleColor}
                />
              ) : null}
            </View>
          ) : null}
        </Animated.View>
      );
    }

    if (renderedText.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(
          showAssistantMeta && !(message.runId && props.failedRunIds.has(message.runId))
            ? "mb-5 px-1"
            : "mb-1 px-1",
          hasWideBlock && "w-full",
        )}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {renderedText.trim().length > 0 ? (
          <MarkdownImageAvailableWidthContext value={props.markdownContentWidth}>
            <AssistantMarkdownContent
              markdown={renderedText}
              environmentId={props.environmentId}
              markdownStyles={styles}
              linkHandlers={props.markdownLinkHandlers}
              onUseArtifactTemplate={props.onUseArtifactTemplate}
              renderImage={props.renderMarkdownImage}
              skills={props.skills}
            />
          </MarkdownImageAvailableWidthContext>
        ) : null}
        <MessageAttachmentList
          attachments={attachments}
          environmentId={props.environmentId}
          onPressPreview={props.onPressPreview}
          onPlaybackStart={props.onPlaybackStart}
        />
        {showAssistantMeta && message.checkpointSummary ? (
          <TurnDiffStat
            checkpoint={message.checkpointSummary}
            onOpenTurnDiff={props.onOpenTurnDiff}
          />
        ) : null}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={renderedText}
              tintColor={iconSubtleColor}
              buttonSize={props.replyActionSize.button}
              iconSize={props.replyActionSize.icon}
            />
            {message.projectedItem ? (
              <AssistantForkButton
                environmentId={props.environmentId}
                iconColor={iconSubtleColor}
                buttonSize={props.replyActionSize.button}
                iconSize={props.replyActionSize.icon}
                projectedItem={message.projectedItem}
                sourceTitle={props.threadTitle}
              />
            ) : null}
            <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
}
